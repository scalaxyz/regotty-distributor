// Vocal / lyrics intelligibility check — is the cover actually singing the words
// clearly, or are they muffled / swallowed / garbled?
//
// Two layers:
//   1. ffmpeg "muffle" heuristic (always available): compares high-band (>4 kHz)
//      energy to the whole mix — a big drop means dull/muffled vocals.
//   2. Whisper ASR (optional, if a `whisper` CLI is on PATH or configured):
//      transcribes the take and scores intelligibility from Whisper's own
//      confidence signals — words/min (swallowed words), no_speech_prob (vocals
//      buried), avg_logprob (garbled), compression_ratio (repetition/hallucination).
//
// If Whisper isn't installed it degrades gracefully to the muffle heuristic and
// says so, so the pipeline never blocks on a missing dependency.

import { spawn } from 'node:child_process';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ code: -1, out, err: err + e.message, error: e }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

/** High-band vs whole-mix loudness: a large drop => muffled/dull (vocals boğuk). */
async function muffleMetrics(file) {
  const mean = (r) => { const m = (r.out + r.err).match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/); return m ? parseFloat(m[1]) : null; };
  const all = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const hi = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'highpass=f=4000,volumedetect', '-f', 'null', '-']);
  const overallDb = mean(all), highDb = mean(hi);
  return { overallDb, highDb, hfDropDb: (overallDb != null && highDb != null) ? +(overallDb - highDb).toFixed(1) : null };
}

/** mean + peak loudness (dB) of a file, via ffmpeg volumedetect. */
async function loudness(file) {
  const r = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const t = r.out + r.err;
  const g = (re) => { const m = t.match(re); return m ? parseFloat(m[1]) : null; };
  return { mean: g(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/), max: g(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/) };
}
async function audioDuration(file) {
  const r = await run('ffmpeg', ['-hide_banner', '-i', file]);
  const m = (r.out + r.err).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) : 0;
}

/**
 * The RELIABLE buried-vocal check: separate the vocal stem from the beat
 * (demucs) and measure how loud the vocal is vs the accompaniment. Whisper only
 * tells us if words are *decodable* (and it hallucinates lyrics on buried takes),
 * not whether the vocal actually sits up in the mix. Needs `pip install demucs`
 * (reuses the torch that Whisper already pulled in). Null if not installed.
 * Runs on a 40s excerpt for speed — prominence is consistent across the track.
 */
async function demucsMetrics(file, cfg) {
  const parts = cfg.demucsCmd && cfg.demucsCmd !== 'auto' ? cfg.demucsCmd.split(' ') : ['demucs'];
  const model = cfg.demucsModel || 'htdemucs';
  const dir = path.join(tmpdir(), 'dm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  await mkdir(dir, { recursive: true });
  try {
    const dur = await audioDuration(file);
    const start = dur > 60 ? Math.floor(dur * 0.25) : 0;                 // skip intro
    const exc = path.join(dir, 'exc.wav');
    const cut = await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(start), '-t', '40', '-i', file, '-ac', '2', '-ar', '44100', exc]);
    if (cut.code !== 0) return null;
    const r = await run(parts[0], [...parts.slice(1), '-n', model, '--two-stems', 'vocals', '-o', dir, exc]);
    if (r.code !== 0) return null;                                       // demucs not installed / failed
    const stem = path.join(dir, model, 'exc');
    const v = await loudness(path.join(stem, 'vocals.wav'));
    const a = await loudness(path.join(stem, 'no_vocals.wav'));
    if (v.mean == null || a.mean == null) return null;
    return {
      vocalDb: v.mean, vocalPeakDb: v.max, accompDb: a.mean, accompPeakDb: a.max,
      vocalRatioDb: +(v.mean - a.mean).toFixed(1),          // vocal vs beat (mean RMS); very negative => buried
      vocalPeakRatioDb: v.max != null && a.max != null ? +(v.max - a.max).toFixed(1) : null,
    };
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Transcribe with Whisper and derive intelligibility metrics; null if unavailable. */
async function whisperMetrics(file, cfg) {
  const cmd = cfg.whisperCmd && cfg.whisperCmd !== 'auto' ? cfg.whisperCmd : 'whisper';
  const dir = path.join(tmpdir(), 'vc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  await mkdir(dir, { recursive: true });
  // --temperature 0 => greedy, DETERMINISTIC. Without it Whisper uses a random
  // temperature-fallback schedule, so a borderline/buried take can pass one run
  // and fail the next. --condition_on_previous_text False stops it from
  // hallucinating/repeating lyrics it didn't actually hear.
  const r = await run(cmd, [file, '--model', cfg.model || 'base', '--language', cfg.language || 'en',
    '--output_format', 'json', '--output_dir', dir, '--fp16', 'False', '--verbose', 'False',
    '--temperature', '0', '--condition_on_previous_text', 'False']);
  if (r.code !== 0) { await rm(dir, { recursive: true, force: true }).catch(() => {}); return null; } // whisper not installed / failed
  let data;
  try { data = JSON.parse(await readFile(path.join(dir, path.basename(file).replace(/\.[^.]+$/, '') + '.json'), 'utf8')); }
  catch { await rm(dir, { recursive: true, force: true }).catch(() => {}); return null; }
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  const segs = data.segments || [];
  const text = (data.text || '').trim();
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const dur = segs.length ? (segs[segs.length - 1].end || 0) : 0;
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    words,
    wpm: dur > 0 ? +(words / (dur / 60)).toFixed(1) : 0,
    noSpeech: +avg(segs.map((s) => s.no_speech_prob || 0)).toFixed(3),
    logprob: +avg(segs.map((s) => s.avg_logprob || 0)).toFixed(3),
    maxComp: +Math.max(0, ...segs.map((s) => s.compression_ratio || 0)).toFixed(2),
    text,
  };
}

/**
 * Decide whether the vocals read the lyrics clearly.
 * Returns { pass, reasons[], metrics, source: 'whisper'|'heuristic'|'off' }.
 */
export async function checkVocals(file, cfg = {}, { origPeak = null } = {}) {
  if (cfg.enabled === false) return { pass: true, skipped: true, reasons: [], metrics: {}, source: 'off' };
  const reasons = [];

  const muf = await muffleMetrics(file);
  const maxDrop = cfg.maxMuffleDropDb ?? 30;
  if (muf.hfDropDb != null && muf.hfDropDb > maxDrop) reasons.push(`vokal boğuk/muffled (HF düşüşü ${muf.hfDropDb}dB > ${maxDrop})`);

  const sources = [];

  // Demucs — the reliable "is the vocal buried under the beat" measure. Peak ratio
  // is the robust discriminator: the MEAN is dragged down by pauses between phrases,
  // but at its loudest the vocal should sit near the beat. A buried vocal peaks well
  // below it.
  const dem = await demucsMetrics(file, cfg).catch(() => null);
  if (dem) {
    sources.push('demucs');
    const cover = dem.vocalPeakRatioDb;
    const minMean = cfg.minVocalRatioDb ?? -18;
    const tol = cfg.vocalToleranceDb ?? 4;
    if (origPeak != null) {
      // RELATIVE gate: judge against the ORIGINAL's own vocal level. A song whose
      // original vocal is naturally quiet shouldn't be rejected for matching it —
      // only reject if the cover buries the vocal much MORE than the original (absurd).
      dem.origPeak = origPeak;
      if (cover != null && cover < origPeak - tol)
        reasons.push(`vokal orijinalinden çok daha dipte (cover ${cover}dB, orijinal ${origPeak}dB, fark >${tol})`);
    } else {
      // No reference (source unavailable) -> fixed floor.
      const minPeak = cfg.minVocalPeakRatioDb ?? -4;
      if (cover != null && cover < minPeak)
        reasons.push(`vokal beatin altında/dipte (tepe ${cover}dB < ${minPeak})`);
    }
    // Absolute "almost no vocal" backstop, regardless of the reference.
    if (dem.vocalRatioDb != null && dem.vocalRatioDb < minMean)
      reasons.push(`vokal neredeyse yok (ort ${dem.vocalRatioDb}dB < ${minMean})`);
  }

  // Whisper — OFF by default (opt in with vocalCheck.useWhisper). demucs already
  // catches buried vocals reliably; whisper is slow AND hallucinates lyrics on a
  // buried take, so it's an optional extra signal, not the primary check.
  const asr = cfg.useWhisper ? await whisperMetrics(file, cfg).catch(() => null) : null;
  if (asr) {
    sources.push('whisper');
    if (asr.wpm < (cfg.minWordsPerMin ?? 12)) reasons.push(`çok az kelime okunuyor (${asr.wpm}/dk) — sözler yutuluyor olabilir`);
    if (asr.noSpeech > (cfg.maxNoSpeech ?? 0.5)) reasons.push(`vokal gömülü/zayıf (no-speech ${asr.noSpeech})`);
    if (asr.logprob < (cfg.minLogprob ?? -1.0)) reasons.push(`sözler net değil (güven ${asr.logprob})`);
    if (asr.maxComp > (cfg.maxCompression ?? 2.6)) reasons.push(`tekrar/bozuk vokal (comp ${asr.maxComp})`);
  }

  const source = sources.length ? sources.join('+') : 'heuristic';
  return { pass: reasons.length === 0, reasons, metrics: { ...muf, ...(dem || {}), ...(asr || {}) }, source };
}

/** The ORIGINAL/source track's vocal-peak ratio (demucs) — the reference the cover
 *  is judged against. null if demucs isn't installed / fails. */
export async function sourceVocalPeak(file, cfg = {}) {
  const dem = await demucsMetrics(file, cfg).catch(() => null);
  return dem?.vocalPeakRatioDb ?? null;
}

// CLI: node src/vocalcheck.mjs <file>
if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node src/vocalcheck.mjs <audio>'); process.exit(1); }
  let vc = { enabled: true, whisperCmd: 'auto', model: 'base' };
  try { vc = { ...vc, ...(JSON.parse(await readFile(path.resolve(path.dirname(process.argv[1]), '../config/config.json'), 'utf8')).vocalCheck || {}) }; } catch {}
  const r = await checkVocals(file, vc);
  console.log(JSON.stringify(r, null, 2));
  if (!/demucs/.test(r.source)) console.log('\n(ÖNERİ: `pip install demucs` — vokalin beatin altında kalıp kalmadığını KESİN ölçen kontrol. Whisper sadece kelime çözer, dipteki vokalde lyrics uydurabilir.)');
  if (!/whisper/.test(r.source)) console.log('(not: Whisper bulunamadı — kelime kontrolü için `pip install -U openai-whisper`.)');
}
