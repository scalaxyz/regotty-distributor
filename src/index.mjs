// Orchestrator: for each (song, artist) — generate a cover, gate it on risk +
// quality, render the 6-version pack, look up the composer, consume a cover
// image, and write a ready-to-upload release package. RouteNote upload is the
// final step (src/routenote.mjs) and runs here once a session is configured.

import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRotation, localDay } from './csv.mjs';
import { pickCover, consumeCover } from './covers.mjs';
import { generateCover, retryCover, cleanupItem, downloadAudio } from './regotty.mjs';
import { computeRisk } from './risk.mjs';
import { checkQuality } from './quality.mjs';
import { checkVocals } from './vocalcheck.mjs';
import { getComposer } from './credits.mjs';
import { renderPack } from './render.mjs';
import { ensureSession } from './routenote.mjs';
import { uploadRelease } from './routenote-upload.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.resolve(ROOT, p);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track';

async function loadConfig() {
  const p = rel('config/config.json');
  if (!existsSync(p)) throw new Error('config/config.json yok — config.example.json’dan kopyala + doldur.');
  return JSON.parse(await readFile(p, 'utf8'));
}

/** Produce one ready release package. Returns { dir, manifest } or { skipped, reason }. */
async function runOne(cfg) {
  const rotation = await runOne._rotation;
  if (!rotation.hasNext()) return { skipped: true, reason: 'input.csv bitti (sıradaki şarkı yok)' };

  // peek (don't advance) — the cursor is committed only once the release is
  // fully handled, so a crash/interruption resumes this song instead of skipping.
  const { song, artist } = rotation.peek();
  const artistName = artist.artist_name;
  const title = song.song;
  // Instrumental release? (queue checkbox / input.csv "instrumental" column) —
  // strip the vocal from the generated cover and ship the instrumental pack.
  const instrumental = /^(1|yes|true|evet|x|on|✓)$/i.test(String(song.instrumental || '').trim());
  log(`▶ ${artistName} — ${title} (${song.artist} cover)${instrumental ? ' [INSTRUMENTAL]' : ''}`);

  const cover = await pickCover(rel(cfg.paths.covers));
  if (!cover) return { skipped: true, reason: 'covers/ boş — kapak ekle' }; // no commit: retry when a cover is added

  const tmp = path.join(tmpdir(), `rd-${Date.now()}`);
  await mkdir(tmp, { recursive: true });

  // 1. generate + gate: land the risk score in the [minRisk, maxRisk) window by
  //    sweeping retention low->high (start low = distinct from source; raise it
  //    toward the source until risk enters the window), and require quality + a
  //    clear vocal/lyrics read.
  const rMin = cfg.quality.minRiskScore ?? 20;
  const rMax = cfg.quality.maxRiskScore ?? 35;
  const retMin = cfg.regotty.retentionMin ?? 0.19;
  const retMax = cfg.regotty.retentionMax ?? 0.30;
  const retStep = cfg.regotty.retentionStep ?? 0.03;
  const maxRetries = cfg.quality.maxRetries ?? 5;
  // start at retentionStart (default 0.22) and let the mechanism raise/lower it
  // toward the risk window; source-closeness (semantic) stays fixed at full.
  let retention = Math.min(retMax, Math.max(retMin, cfg.regotty.retentionStart ?? cfg.regotty.retention ?? 0.22));
  let gen = await generateCover(cfg.regotty, song.artist, song.song, { retention, instrumental });
  let coverFile = path.join(tmp, 'cover_src.mp3');
  let sourceFile = path.join(tmp, 'source.mp3');
  let passed = false, lastRisk = null, lastQ = null, lastV = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await downloadAudio(gen.coverUrl, coverFile);
    await downloadAudio(gen.sourceUrl, sourceFile).catch(() => { sourceFile = null; });
    lastRisk = sourceFile ? await computeRisk(sourceFile, coverFile) : { score: 0 };
    lastQ = await checkQuality(coverFile, cfg.quality);
    const riskOk = lastRisk.score >= rMin && lastRisk.score < rMax;
    // Only run the SLOW vocal check (demucs+whisper, ~1-1.5 min) when risk+quality
    // already pass — otherwise we're re-rolling this take anyway, so skip it.
    if (riskOk && lastQ.pass) {
      lastV = instrumental
        ? { pass: true, reasons: [], metrics: {}, source: 'instrumental (vokal atlandı)' }
        : await checkVocals(coverFile, cfg.vocalCheck || {});
    } else {
      lastV = { pass: false, reasons: [], metrics: {}, source: 'atlandı' };
    }
    log(`  risk=${lastRisk.score} (hedef ${rMin}-${rMax}) ret=${retention.toFixed(2)} kalite=${lastQ.pass ? 'ok' : 'X'} vokal=${lastV.source === 'atlandı' ? '—' : (lastV.pass ? 'ok' : 'X')}(${lastV.source})`);
    if (!lastQ.pass) log(`    kalite: ${lastQ.reasons.join('; ')}`);
    if (!lastV.pass && lastV.reasons.length) log(`    vokal: ${lastV.reasons.join('; ')}`);
    if (riskOk && lastQ.pass && lastV.pass) { passed = true; break; }
    if (attempt < maxRetries) {
      if (lastRisk.score < rMin) retention = Math.min(retMax, +(retention + retStep).toFixed(3));       // too different -> nudge toward source
      else if (lastRisk.score >= rMax) retention = Math.max(retMin, +(retention - retStep).toFixed(3)); // too similar -> away from source
      log(`  tekrar üret (retention=${retention.toFixed(2)}${riskOk ? ', kalite/vokal için yeni take' : ', risk penceresine yaklaştır'})`);
      gen = { itemId: gen.itemId, ...(await retryCover(cfg.regotty, gen.itemId, { retention, semantic: cfg.regotty.semantic })) };
    }
  }
  if (!passed) { await cleanupItem(cfg.regotty, gen.itemId); await rm(tmp, { recursive: true, force: true }).catch(() => {}); await rotation.commit(); return { skipped: true, reason: `pencereye giremedi (risk=${lastRisk?.score}, ${[...(lastQ?.reasons || []), ...(lastV?.reasons || [])].join('; ') || 'ok'})` }; } // commit: unusable, move on

  // 2. release folder + 6-version pack. For an instrumental release the cover is
  //    already vocal-free (backend pulled the YouTube instrumental + ACE-Step
  //    --instrumental), so just name it "<title> - Instrumental" (versions ->
  //    "... - Instrumental - Slowed").
  const renderBase = instrumental ? `${title} - Instrumental` : title;
  const dir = rel(path.join(cfg.paths.output, `${Date.now()}_${safe(artistName)}_${safe(renderBase)}`));
  await mkdir(dir, { recursive: true });
  const tracks = await renderPack(coverFile, renderBase, dir);

  // 3. composer + explicit (Spotify credits/track)
  let composer = { writers: [], first: '', last: '', second: null, explicit: false, trackId: null };
  try { composer = await getComposer(song.artist, song.song, cfg.spotifyCredits, song.url); }
  catch (e) { log('  composer alınamadı:', e.message); }
  // explicit: kaynak şarkı Spotify'da explicit ise cover'ı da öyle işaretle;
  // bulunamazsa config default'una düş.
  const explicit = composer.trackId ? (composer.explicit ? 'Explicit' : 'Not Explicit') : (cfg.routenote.explicit || 'Not Explicit');
  if (composer.trackId) log(`  explicit: ${explicit}${composer.explicit ? ' (kaynak explicit)' : ''}`);

  // 4. consume the cover image
  const coverDest = await consumeCover(cover, dir);

  // 5. write the ready-to-upload manifest
  const today = new Date();
  const manifest = {
    releaseTitle: renderBase,
    artistName,
    spotifyUrl: artist.spotify_url,
    spotifyArtist: { id: (String(artist.spotify_url || '').match(/artist\/([A-Za-z0-9]+)/) || [])[1] || '', name: artistName, uri: artist.spotify_url || '', followers: '', image: '' },
    coverSong: `${song.artist} — ${song.song}`,
    clineName: song.artist,                          // © C-line = original artist stage name
    language: cfg.routenote.language,
    genre: cfg.routenote.genre,
    explicit: instrumental ? 'Not Explicit' : explicit,   // instrumental = sözsüz
    label: cfg.routenote.label,
    copyrightYear: cfg.routenote.copyrightYear,
    pLine: String(cfg.routenote.pLine || '').replace('{artist}', artistName),
    releaseDate: `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`,
    composer: { first: composer.first, last: composer.last, second: composer.second, writers: composer.writers },
    producer: artistName,
    cover: path.basename(coverDest),
    coverPath: coverDest,
    tracks: tracks.map((t) => ({ title: t.title, file: t.file, dir, label: t.label })),
    risk: lastRisk?.score,
  };
  await writeFile(path.join(dir, 'release.json'), JSON.stringify(manifest, null, 2));
  await cleanupItem(cfg.regotty, gen.itemId);
  log(`✔ paket hazır: ${path.relative(ROOT, dir)}  (risk ${lastRisk?.score}, ${tracks.length} track, besteci ${composer.first} ${composer.last})`);

  // 6. distribute to RouteNote (draft unless routenote.autoSubmit / --publish).
  //    Session drops mid-upload are auto-recovered inside uploadRelease (re-login
  //    + retry the request), so the release resumes in place rather than failing.
  //    A hard crash here leaves the cursor un-committed -> retried on next run.
  let distributed = null;
  try {
    const jar = await ensureSession(cfg);            // reuse saved session; browser-login only if expired
    const publish = cfg.routenote.autoSubmit === true || process.argv.includes('--publish');
    distributed = await uploadRelease(cfg, jar, manifest, { publish });
    manifest.routenote = distributed;
    await writeFile(path.join(dir, 'release.json'), JSON.stringify(manifest, null, 2));
    log(`  ↳ RouteNote: ${distributed.url}  ${publish ? '(yayına gönderildi)' : '(taslak)'}`);
  } catch (e) {
    log('  ↳ RouteNote yükleme hatası:', e.message);
  }
  await rm(tmp, { recursive: true, force: true }).catch(() => {}); // temp indirilenleri temizle
  await rotation.commit(); // release handled (uploaded or gave up) — advance the queue
  return { dir, manifest, distributed };
}

async function main() {
  let cfg = await loadConfig();
  // Reload config + rebuild the rotation before each release so panel edits (queue
  // songs, daily target, thresholds, autoSubmit) apply live without a restart.
  const rebuild = async () => {
    const rot = await createRotation({
      inputCsv: rel(cfg.paths.input),
      artistsCsv: rel(cfg.paths.artists),
      stateDir: rel(cfg.paths.state),
    });
    runOne._rotation = rot;
    return rot;
  };

  const daemon = process.argv.includes('--daemon');
  const ci = process.argv.indexOf('--count');
  const count = ci >= 0 ? Math.max(1, parseInt(process.argv[ci + 1], 10) || 1) : 1;

  if (daemon) {
    // Daemon: do `releasesPerDay` releases back-to-back (no stagger), then wait
    // until the next calendar day and continue — until the queue empties. Runs
    // until stopped. Today's count is persisted, so a crash+restart resumes the
    // day's tally instead of starting over.
    log('=== daemon başladı — günlük hedef kadar sırayla, sonra ertesi gün (durdurana kadar) ===');
    // eslint-disable-next-line no-constant-condition
    while (true) {
      cfg = await loadConfig().catch(() => cfg);
      const rot = await rebuild();
      const per = Math.max(1, cfg.schedule?.releasesPerDay ?? 10);
      if (rot.releasedToday() >= per) {
        const d = localDay();
        log(`bugünkü hedef doldu (${per}/${per}) — ertesi gün bekleniyor…`);
        while (localDay() === d) await sleep(10 * 60_000); // wake when the day rolls over
        continue;
      }
      if (!rot.hasNext()) { log('kuyruk boş — 60 sn sonra tekrar bakılacak (yeni şarkı eklenebilir)'); await sleep(60_000); continue; }
      let r; try { r = await runOne(cfg); } catch (e) { log('hata:', e.message); await sleep(10_000); continue; }
      if (r?.skipped) { log(`atlandı: ${r.reason}`); if (/boş/.test(r.reason)) await sleep(60_000); }
      else { await rot.markReleased(); log(`bugün ${rot.releasedToday()}/${per} tamamlandı`); }
    }
  }

  // Finite batch: `count` successful releases back-to-back, then STOP cleanly
  // (the process exits; the panel keeps running and logs "işlem bitti").
  log(`=== ${count} release (sırayla) ===`);
  let done = 0;
  while (done < count) {
    cfg = await loadConfig().catch(() => cfg);
    const rot = await rebuild();
    if (!rot.hasNext()) { log('kuyrukta işlenecek şarkı kalmadı — erken bitti'); break; }
    let r; try { r = await runOne(cfg); } catch (e) { log('hata:', e.message); continue; }
    if (r?.skipped) { log(`atlandı: ${r.reason}`); if (/boş/.test(r.reason)) break; } // covers/queue empty -> stop
    else done++;
  }
  log(`✔ işlem bitti — ${done}/${count} release tamamlandı`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // Set exitCode and let the event loop drain instead of a forced process.exit()
  // — an abrupt exit while fetch/undici sockets are open trips a libuv assertion
  // on Windows (uv async.c). Draining exits cleanly.
  main().catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; });
}
