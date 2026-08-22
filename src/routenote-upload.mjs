// RouteNote upload flow — takes a ready release package (6 MP3s + cover +
// metadata) and an authenticated CookieJar (from routenote.mjs browserLogin)
// and drives the 8-step Drupal upload:
//
//   1. create_album              -> new album, returns the UPC/album id
//   2. spotify_uri + editalbum   -> album metadata (artist, composer, ©/℗, date)
//   3. addaudiomp3 + cloud_upload -> upload the 6 audio files
//   4. trackmetadata             -> per-track metadata (ISRC is server-assigned)
//   5. confirm_upload            -> "I'm Finished"
//   6. addart                    -> cover image
//   7. addstore                  -> pick the 9 target stores
//   8. edit_album (finalize)     -> submit for distribution   [only when publish:true]
//
// Reverse-engineered from capture-2026-08-20T12-25-09-191Z.jsonl. Each Drupal
// form POST needs a fresh form_build_id/form_token scraped from the preceding
// GET, so every step is GET-then-POST.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jarFetch, ensureSession, CookieJar, refreshSession } from './routenote.mjs';

const base = (cfg) => (cfg.routenote.baseUrl || 'https://www.routenote.com').replace(/\/$/, '');
const log = (...a) => console.log('   [rn]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTML parsing
/** Decode the handful of HTML entities that appear in form values. */
const unent = (s) => String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Grab an attribute from a tag string. */
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')); return m ? unent(m[1]) : null; };

/** Pull { form_build_id, form_token, form_id } out of a page's HTML. */
function formTokens(html) {
  const pick = (name) => { const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`)) || html.match(new RegExp(`value="([^"]*)"[^>]*name="${name}"`)); return m ? unent(m[1]) : ''; };
  return { form_build_id: pick('form_build_id'), form_token: pick('form_token'), form_id: pick('form_id') };
}

/** Return just the <form>…</form> block containing `marker` (a form_id value or
 *  a field name), so we scrape only that form's fields — not the whole page. */
function formBlock(html, marker) {
  const idx = html.indexOf(marker);
  if (idx < 0) return html;
  const start = html.lastIndexOf('<form', idx);
  const end = html.indexOf('</form>', idx);
  return start >= 0 && end >= 0 ? html.slice(start, end + 7) : html;
}

/** Only hidden inputs on the page (safe for forms where stray text/checkbox
 *  inputs from other page forms would otherwise be swept in). */
function hiddenPairs(html) {
  const out = [];
  for (const m of html.matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) {
    const name = attr(m[0], 'name');
    if (name) out.push([name, attr(m[0], 'value') ?? '']);
  }
  return out;
}

/** All hidden/text input name=value pairs on the page (ordered, deduped-last-wins off). */
function inputPairs(html) {
  const out = [];
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = attr(tag, 'name');
    if (!name) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'file') continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;
    out.push([name, attr(tag, 'value') ?? '']);
  }
  return out;
}

// Every RouteNote form page ships a submit handler that sets one or more
// browser-check cookies via `document.cookie = "NAME= " + browser` right before
// posting (e.g. brow_type_create_album=true). The POST is served the bot-stub
// unless those cookies are present. We don't run the JS, so we scrape the cookie
// names from the page and assert them ourselves (only if not already set, so we
// never clobber value-carrying cookies like ty8_YytK_Hge_MO0=Chrome).
function assertPageCookies(jar, html) {
  // brow_type_* cookies are per-page and the browser scopes them by path, so it
  // never sends e.g. brow_type_create_album to /rn/addart/. We ignore paths, so
  // drop stale ones before setting this page's — otherwise a leaked brow_type
  // cookie breaks a later form POST (notably artwork upload).
  for (const k of [...jar.jar.keys()]) if (/^brow_type_/.test(k)) jar.jar.delete(k);
  for (const m of html.matchAll(/document\.cookie\s*=\s*["']([A-Za-z0-9_]+)=\s*["']\s*\+\s*browser/g)) {
    if (!jar.jar.has(m[1])) jar.jar.set(m[1], 'true');
  }
}

// ---- session resilience ------------------------------------------------------
// RouteNote sessions expire / can be dropped mid-run. Detect a "logged out"
// response and transparently re-login (browser), refreshing the shared jar in
// place, then retry the same request once — so a release upload resumes rather
// than failing. A logged-out request is NOT processed server-side (it returns
// the login page), so retrying after re-login performs the action exactly once.
let REAUTHING = false;
function loggedOut(location, text) {
  if (location && /\/rn\/login/i.test(location)) return true;               // 302 to login
  if (text && /in_signin_button|q=user\/login/i.test(text)) return true;    // login form
  if (text && text.length < 1500 && /window\.stop\(\)/.test(text) && /platform\.name/.test(text)) return true; // browser-check stub
  return false;
}
async function reauth(cfg, jar) {
  if (REAUTHING) return;
  REAUTHING = true;
  log('⚠ oturum düşmüş — otomatik yeniden giriş yapılıyor…');
  try { await refreshSession(cfg, jar); log('✔ yeniden giriş tamam, işleme kaldığı yerden devam ediliyor'); }
  catch (e) { log('yeniden giriş hatası: ' + e.message); }
  finally { REAUTHING = false; }
}
/** Run a request-producing fn; if it comes back logged out, re-login once + retry. */
async function withReauth(cfg, jar, fn) {
  let r = await fn();
  if (!REAUTHING && loggedOut(r.location, r.text)) { await reauth(cfg, jar); r = await fn(); }
  return r;
}

// ------------------------------------------------------------- request helpers
async function GET(jar, cfg, url, referer) {
  const once = async () => {
    let res = await jarFetch(jar, url.startsWith('http') ? url : `${base(cfg)}${url}`, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(referer ? { Referer: referer } : {}) },
    });
    let location = res.headers.get('location');
    // follow a single redirect (Drupal forms 302 to the next page)
    if (res.status >= 300 && res.status < 400 && location) {
      res = await jarFetch(jar, location.startsWith('http') ? location : `${base(cfg)}${location}`, {
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: url },
      });
      location = res.headers.get('location');
    }
    const text = await res.text().catch(() => '');
    return { res, text, location };
  };
  const r = await withReauth(cfg, jar, once);
  assertPageCookies(jar, r.text); // set this page's submit-time browser cookies
  return { res: r.res, html: r.text, url: r.res.url || url };
}

// Most RouteNote form submits are full-page navigations (302 to the next step);
// only cloud_upload/validation calls are true XHR. Sending X-Requested-With on a
// navigation makes Drupal answer with a partial and no redirect, so it's opt-in.
const navHeaders = (cfg, referer, url, xhr) => ({
  Accept: xhr ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  ...(xhr ? { 'X-Requested-With': 'XMLHttpRequest' } : { 'Upgrade-Insecure-Requests': '1' }),
  Origin: base(cfg), Referer: referer || url,
});

/** POST application/x-www-form-urlencoded from an ordered [k,v][] (dupes allowed). */
async function POSTform(jar, cfg, url, pairs, referer, { xhr = false } = {}) {
  const body = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`).join('&');
  const once = async () => {
    const res = await jarFetch(jar, `${base(cfg)}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...navHeaders(cfg, referer, `${base(cfg)}${url}`, xhr) },
      body,
    });
    const location = res.headers.get('location');
    const text = res.status >= 300 && res.status < 400 ? '' : await res.text().catch(() => '');
    return { res, location, text };
  };
  return withReauth(cfg, jar, once);
}

/** POST multipart/form-data. `pairs`: [k,v][]; `files`: {name, filename, buf, type}[]. */
async function POSTmultipart(jar, cfg, url, pairs, files, referer, { xhr = false } = {}) {
  const full = url.startsWith('http') ? url : `${base(cfg)}${url}`;
  const once = async () => {
    const fd = new FormData();
    for (const [k, v] of pairs) fd.append(k, v ?? '');
    for (const f of files || []) fd.append(f.name, new Blob([f.buf], { type: f.type || 'application/octet-stream' }), f.filename);
    const res = await jarFetch(jar, full, {
      method: 'POST',
      headers: navHeaders(cfg, referer, full, xhr), // no Content-Type: fetch sets the boundary
      body: fd,
    });
    const location = res.headers.get('location');
    const text = res.status >= 300 && res.status < 400 ? '' : await res.text().catch(() => '');
    return { res, location, text };
  };
  return withReauth(cfg, jar, once);
}

// -------------------------------------------------------------- helper: fields
const today = () => { const d = new Date(); return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };

/** Resolve a Spotify artist id from a profile URL (…/artist/<id>). */
const spotifyArtistId = (url) => { const m = String(url || '').match(/artist\/([A-Za-z0-9]+)/); return m ? m[1] : ''; };

// ------------------------------------------------------------------ the steps

/** 1. Create the album shell; returns the album/UPC id. */
async function createAlbum(jar, cfg, release) {
  const { html } = await GET(jar, cfg, '/rn/create_album', `${base(cfg)}/rn/user/${cfg.routenote.uid}`);
  const t = formTokens(html);
  const { res, location, text } = await POSTform(jar, cfg, '/rn/create_album', [
    ['edit_album_info_upc', ''],
    ['edit_album_info_release', release.releaseTitle],
    ['album_save', 'Create Release'],
    ['tersawsas', 'true'],
    ['form_build_id', t.form_build_id],
    ['form_token', t.form_token],
    ['form_id', 'create_album_form'],
  ], `${base(cfg)}/rn/create_album`);
  // redirects to /rn/edit_album/<albumId>
  const id = (location && location.match(/edit_album\/(\d+)/)) || (text && text.match(/edit_album\/(\d+)/));
  if (!id) {
    log(`create_album debug: status=${res.status} tokens=${t.form_build_id ? 'ok' : 'YOK'} bodyLen=${(text || '').length}`);
    throw new Error('create_album: album id alınamadı (location: ' + (location || '-') + ')');
  }
  log('album oluşturuldu:', id[1]);
  return id[1];
}

/** 2. Album metadata (spotify_uri probe + editalbum form). */
async function editAlbum(jar, cfg, albumId, release) {
  const artistUri = release.spotifyUrl || '';
  const artistId = spotifyArtistId(artistUri);
  // spotify_uri.php probe (best-effort; failure is non-fatal)
  await jarFetch(jar, `${base(cfg)}/rn/spotify_uri.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: `${base(cfg)}/rn/editalbum/${albumId}` },
    body: `uid=${encodeURIComponent(cfg.routenote.uid)}&artist2=${encodeURIComponent(release.artistName)}&upc=${albumId}&suri=${encodeURIComponent(artistUri)}`,
  }).catch(() => {});

  const { html } = await GET(jar, cfg, `/rn/editalbum/${albumId}`, `${base(cfg)}/rn/edit_album/${albumId}`);
  const t = formTokens(html);
  const sp = release.spotifyArtist || {};
  const comp = release.composer || {};
  const cLine = release.clineName || release.coverArtist || '';       // original artist STAGE name(s)
  const pLine = String(cfg.routenote.pLine || '').replace('{artist}', release.artistName);
  const year = String(cfg.routenote.copyrightYear || new Date().getFullYear());
  // Ordered field list mirroring the captured working submit (dupes intentional).
  const pairs = [
    ['edit_album_info_language', release.language || cfg.routenote.language],
    ['edit_album_info_title', release.releaseTitle],
    ['album_version', ''],
    ['coverversion', '1'],
    ['Yes2', 'yes'], ['No', '1'], ['compilevalue', 'No'],
    ['nohid', ''], ['hidden_count', '0'], ['del_id', ''], ['arr_cnt', '500'], ['table_count', ''],
    ['role', 'Primary'],
    ['edit_album_info_artist', release.artistName],
    ['p_spotify_artist_id', sp.id || artistId],
    ['p_spotify_artist_name', sp.name || release.artistName],
    ['p_spotify_artist_uri', sp.uri || artistUri],
    ['p_spotify_artist_followers', String(sp.followers ?? '')],
    ['p_spotify_artist_image', sp.image || ''],
    ['primary_spotifyuri', sp.uri || artistUri],
    ['srole[]', 'Primary'], ['second_art[]', ''], ['sec_spotifyuri[]', ''],
    ['role', 'Composer'],
    ['composer_value', comp.first ? `${comp.first},` : ''],
    ['composer2_value', comp.last ? `${comp.last},` : ''],
    ['edit_album_first_composer', comp.first || ''],
    ['edit_album_last_composer', comp.last || ''],
    ['No1', '0'],
    ['role', 'Lyricist'],
    ['lyricist_value', ''], ['lyricist2_value', ''],
    ['edit_album_info_first_lyricist', ''], ['edit_album_info_last_lyricist', ''],
    ['contributors_role', 'Producer,'],
    ['contributors_name', `${release.artistName},`],
    ['srole1[]', 'Producer'],
    ['edit_album_first_contributor', release.artistName],
    ['edit_album_info_genre', release.genre || cfg.routenote.genre],
    ['edit_album_info_sec_genre', 'None'],
    ['cpy_year', year], ['cpy_name', cLine],                          // © C-line = original artist
    ['edit_album_info_pcopyyear', year], ['edit_album_info_pcopyname', pLine], // ℗ P-line
    ['edit_album_info_label', cfg.routenote.label],
    ['edit_album_info_org_date', today()],
    ['cal_date_hid2', '0'], ['edit_album_info_pre_date', ''], ['cal_date_hid1', '0'],
    ['edit_album_info_sale_date', ''], ['cal_date_hid', '0'], ['appt', ''], ['select-profession', ''],
    ['edit_album_info_explicit', release.explicit || cfg.routenote.explicit || 'Not Explicit'],
    ['chkbx_clkd', 'NO'], ['chkbx_clck', ''],
    ['album_save', 'Save and Continue'],
    ['tersawsas', 'true'],
    ['form_build_id', t.form_build_id], ['form_token', t.form_token], ['form_id', 'editalbum_form'],
  ];
  await POSTform(jar, cfg, `/rn/editalbum/${albumId}`, pairs, `${base(cfg)}/rn/editalbum/${albumId}`);
  log('albüm bilgileri kaydedildi');
}

/** 3. Upload the 6 audio files via cloud_upload, then map track#->file. */
async function addTracks(jar, cfg, albumId, tracks) {
  const formUrl = `${base(cfg)}/rn/addaudiomp3/form/${albumId}`;
  const { html } = await GET(jar, cfg, `/rn/addaudiomp3/form/${albumId}`, `${base(cfg)}/rn/edit_album/${albumId}`);
  const t = formTokens(html);
  const up = html.match(/cloud_upload\/([a-f0-9]{32})\//);
  if (!up) throw new Error('addaudiomp3: cloud_upload id sayfada bulunamadı');
  const uploadId = up[1];
  log('cloud_upload id:', uploadId);

  const mapPairs = [['name', '']];
  const added = [];
  for (let i = 0; i < tracks.length; i++) {
    const trk = tracks[i];
    const n = i + 1;
    const trackId = `edit-Origin${n}`;
    const buf = await readFile(path.isAbsolute(trk.file) ? trk.file : path.join(trk.dir || '', trk.file));
    const filename = path.basename(trk.file);
    // prep: tell the server which slot we're filling
    await jarFetch(jar, `${base(cfg)}/rn/cloud_upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: formUrl },
      body: `remove_trackid=${trackId}&upc_nos=${encodeURIComponent(formUrl)}`,
    }).catch(() => {});
    // upload the file (field name is "file")
    const url = `${base(cfg)}/rn/cloud_upload/${uploadId}/?track_id=${trackId}&title=${encodeURIComponent(formUrl)}`;
    const { text } = await POSTmultipart(jar, cfg, url, [], [{ name: 'file', filename, buf, type: 'audio/mpeg' }], formUrl, { xhr: true });
    if (!/success/i.test(text || '')) log(`uyarı: ${trackId} yükleme cevabı: ${(text || '').slice(0, 60)}`);
    else log(`yüklendi ${n}/${tracks.length}: ${filename}`);
    // duplicate check (best-effort)
    await jarFetch(jar, `${base(cfg)}/rn/find_track_duplicate.php?upcidd=${albumId}`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: formUrl } }).catch(() => {});
    mapPairs.push([`tracknio${n}`, trk.title]);
    mapPairs.push([`files[Origin${n}]`, filename]);
    added.push(String(n));
    await sleep(300);
  }
  // finalize the track list — `added` + `op` + the addmp3_form tokens are what
  // actually creates the track records (without them the upload is discarded).
  mapPairs.push(['tracknio', ''], ['files[Origin]', '']);
  mapPairs.push(['op', 'Save and continue']);
  mapPairs.push(['added', added.join(',')]);
  mapPairs.push(['tersawsas', 'true']);
  mapPairs.push(['form_build_id', t.form_build_id], ['form_token', t.form_token], ['form_id', 'addmp3_form']);
  await POSTform(jar, cfg, `/rn/addaudiomp3/form/${albumId}`, mapPairs, formUrl);
  log('parça listesi kaydedildi');
}

/** 4. Per-track metadata: scrape the form (server-assigned ISRC etc.) + resubmit. */
async function trackMetadata(jar, cfg, albumId, release) {
  const url = `/rn/?q=trackmetadata/form/${albumId}`;
  const { html } = await GET(jar, cfg, url, `${base(cfg)}/rn/addaudiomp3/form/${albumId}`);
  // Skip rather than risk clobbering the tracks if the form isn't populated.
  if (!/audio_tags0\[title\]/.test(html)) { log('trackmetadata: parça alanları yok, atlanıyor (albüm bazlı besteci kullanılıyor)'); return; }
  // Scrape only this form's inputs (carries per-track ISRC, playtime, tokens…),
  // then override the composer/title/artist fields per track from our metadata.
  const pairs = inputPairs(formBlock(html, 'audio_tags0[title]'));
  const t = formTokens(html);
  const comp = release.composer || {};
  const artistUri = (release.spotifyArtist && release.spotifyArtist.uri) || release.spotifyUrl || '';
  const set = (name, val) => { const p = pairs.find(([k]) => k === name); if (p) p[1] = val; else pairs.push([name, val]); };
  for (let i = 0; i < release.tracks.length; i++) {
    set(`audio_tags${i}[title]`, release.tracks[i].title);
    set(`audio_tags${i}[role]`, 'Primary');
    set(`audio_tags${i}[artist]`, release.artistName);
    set(`Yes${i}`, 'yes');   // "Is this track a cover version?" = Yes (album coverversion=1 ile eşleşmeli;
    set(`dflt${i}`, 'No');   //  yoksa RouteNote finalde "identify the cover versions" uyarısı verir)
    set(`composer_value${i}`, comp.first ? `${comp.first},` : '');
    set(`composer2_value${i}`, comp.last ? `${comp.last},` : '');
    // Producer/contributor: RouteNote renders the chip via
    // value.slice(0, value.lastIndexOf(",")) — WITHOUT a trailing comma
    // lastIndexOf returns -1 → slice(0,-1) drops the name's LAST letter
    // ("Monday Ocean" -> "Monday Ocea"). The per-track form is pre-filled without
    // a comma (album's stored value), so add one here (RouteNote strips it on save).
    set(`contributors_name${i}`, release.artistName ? `${release.artistName},` : '');
    set(`contributors_role${i}`, 'Producer,');
    set(`edit_album_info_explicit${i}`, release.explicit || cfg.routenote.explicit || 'Not Explicit');
    set(`edit_album_info_language${i}`, release.language || cfg.routenote.language);
  }
  if (t.form_build_id) set('form_build_id', t.form_build_id);
  if (t.form_token) set('form_token', t.form_token);
  set('form_id', 'trackmetadata_form');
  // multipart in the browser, but no files here (files already uploaded) -> urlencoded is accepted
  await POSTmultipart(jar, cfg, url, pairs, [], `${base(cfg)}${url}`);
  log('parça metadataları kaydedildi');
}

/** 5. Confirm the upload ("I'm Finished"). */
async function confirmUpload(jar, cfg, albumId) {
  const { html } = await GET(jar, cfg, `/rn/confirm_upload/form/${albumId}`, `${base(cfg)}/rn/edit_album/${albumId}`);
  const t = formTokens(html);
  await POSTform(jar, cfg, `/rn/confirm_upload/form/${albumId}`, [
    ['op', "I'm Finished"], ['tersawsas', 'true'],
    ['form_build_id', t.form_build_id], ['form_token', t.form_token], ['form_id', 'confirm_upload_form'],
  ], `${base(cfg)}/rn/confirm_upload/form/${albumId}`);
  log('yükleme onaylandı');
}

/** 6. Cover artwork upload. File field is "audio_images"; RouteNote wants a
 *  3000×3000 RGB JPEG (colortype.php validates color mode/type/size).
 *  NB: this replicates a known-good raw request exactly — plain jarFetch (no
 *  Upgrade-Insecure-Requests header) and RAW hidden values (no HTML-unescaping),
 *  both of which the generic POST helper changed enough to make the POST no-op. */
export async function addArt(jarIn, cfg, albumId, coverPath) {
  const B = base(cfg);
  const formUrl = `${B}/rn/addart/form/${albumId}`;
  // Use a fresh session jar: the artwork POST is sensitive to the cookie churn
  // (cloud_art / usercockval) that the track-upload steps cause in the shared
  // jar, but works cleanly from the login snapshot (same SESS => same account).
  let jar = jarIn;
  try {
    const { readFile: rf } = await import('node:fs/promises');
    const sf = path.resolve(cfg.paths?.state || 'state', 'routenote-session.json');
    jar = CookieJar.from(JSON.parse(await rf(sf, 'utf8')));
  } catch { jar = jarIn; }
  const g = await jarFetch(jar, formUrl, { headers: { Accept: 'text/html' } });
  const html = await g.text();
  // Add-only (do NOT delete brow_type_* here): the artwork POST needs any
  // brow cookie the page sets, and deleting them makes it silently no-op.
  for (const m of html.matchAll(/document\.cookie\s*=\s*["']([A-Za-z0-9_]+)=\s*["']\s*\+\s*browser/g)) if (!jar.jar.has(m[1])) jar.jar.set(m[1], 'true');
  const buf = await readFile(coverPath);
  const type = path.extname(coverPath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  // Use a clean upload filename — RouteNote rejects messy names (spaces, parens,
  // double extensions like ".jpg.jpeg") with a silent 200 no-op.
  const filename = `cover.${type === 'image/png' ? 'png' : 'jpg'}`;
  // color/type/size validation call (the server validates too)
  const fd1 = new FormData();
  fd1.append('image', new Blob([buf], { type }), filename);
  await jarFetch(jar, `${B}/rn/colortype.php`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: formUrl }, body: fd1 }).catch(() => {});
  // submit the artwork form: whole-page hidden inputs (raw) + audio_images file
  const fd2 = new FormData();
  for (const m of html.matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) {
    const n = (m[0].match(/name="([^"]*)"/) || [])[1];
    const v = (m[0].match(/value="([^"]*)"/) || [, ''])[1];
    if (n) fd2.append(n, v);
  }
  fd2.append('addart_savbtn', 'Save and Continue');
  fd2.append('audio_images', new Blob([buf], { type }), filename);
  const ap = await jarFetch(jar, formUrl, { method: 'POST', headers: { Accept: 'text/html', Referer: formUrl, Origin: B }, body: fd2 });
  if (ap.status < 300 || ap.status >= 400) log(`uyarı: kapak POST beklenmedik durum ${ap.status} (kapak eklenmemiş olabilir)`);
  else log('kapak yüklendi');
}

/** 7. Store selection — keep the form's defaults, force our 9 stores on. */
export async function addStore(jar, cfg, albumId) {
  const { html } = await GET(jar, cfg, `/rn/addstore/form/${albumId}`, `${base(cfg)}/rn/edit_album/${albumId}`);
  const t = formTokens(html);
  // The store form needs its full field set (territory/pricing checkboxes,
  // ter/do_id/ms2, …) to persist; scrape the whole page's inputs, override dids.
  const pairs = inputPairs(html).filter(([k]) => !/^form_build_id$|^form_token$|^form_id$/.test(k));
  const set = (name, val) => { const p = pairs.find(([k]) => k === name); if (p) p[1] = val; else pairs.push([name, val]); };
  const dids = Object.keys(cfg.routenote.stores || {});
  for (const d of dids) set(`did${d}`, '1');
  set('genie_status', '1'); set('beatport_status', '0'); set('twt_status', '0');
  set('album_save', 'Save and Continue'); set('tersawsas', 'true');
  pairs.push(['form_build_id', t.form_build_id], ['form_token', t.form_token], ['form_id', 'addstore_form']);
  await POSTmultipart(jar, cfg, `/rn/addstore/form/${albumId}`, pairs, [], `${base(cfg)}/rn/addstore/form/${albumId}`);
  log(`mağazalar seçildi (${dids.length})`);
}

/** 8. Finalize / submit for distribution. */
export async function finalize(jar, cfg, albumId) {
  await GET(jar, cfg, `/rn/edit_album/${albumId}`, `${base(cfg)}/rn/addstore/form/${albumId}`);
  await jarFetch(jar, `${base(cfg)}/rn/edit_album/${albumId}/artist_validation`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${base(cfg)}/rn/edit_album/${albumId}` } }).catch(() => {});
  await POSTform(jar, cfg, `/rn/edit_album/${albumId}`, [['submit_chk', 'on'], ['predist', '1']], `${base(cfg)}/rn/edit_album/${albumId}`);
  log('yayına gönderildi (finalize)');
}

/**
 * Upload one release. `release` is the manifest from index.mjs augmented with:
 *   clineName (original artist stage name(s)), spotifyArtist {id,name,uri,followers,image}
 *   tracks[i].dir (folder holding the mp3s), coverPath (absolute path to the cover).
 * With { publish:false } (default) it stops before finalize, leaving a draft.
 */
export async function uploadRelease(cfg, jar, release, { publish = false } = {}) {
  const albumId = await createAlbum(jar, cfg, release);
  await editAlbum(jar, cfg, albumId, release);
  await addTracks(jar, cfg, albumId, release.tracks);
  await trackMetadata(jar, cfg, albumId, release);
  await confirmUpload(jar, cfg, albumId);
  // Cover after tracks (matches the site flow; artwork needs the album populated).
  // addArt uses a fresh session jar so the track-upload cookie churn doesn't
  // affect it.
  if (release.coverPath) await addArt(jar, cfg, albumId, release.coverPath);
  await addStore(jar, cfg, albumId);
  if (publish) await finalize(jar, cfg, albumId);
  else log('DRAFT modu: finalize atlandı (yayınlanmadı). Kontrol için: /rn/edit_album/' + albumId);
  return { albumId, published: publish, url: `${base(cfg)}/rn/edit_album/${albumId}` };
}

// ------------------------------------------------------------------------ CLI
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };

/** Build a release object from a folder: release.json if present, else from the
 *  mp3s + a cover image + --title/--artist/--orig flags. */
async function buildRelease(dir, cfg) {
  const abs = path.resolve(dir);
  if (existsSync(path.join(abs, 'release.json'))) {
    const r = JSON.parse(await readFile(path.join(abs, 'release.json'), 'utf8'));
    r.tracks.forEach((t) => { t.dir = abs; });
    if (r.cover) r.coverPath = path.join(abs, r.cover);
    r.clineName = r.clineName || (r.coverSong ? r.coverSong.split(/—|-/)[0].trim() : r.artistName);
    r.spotifyArtist = r.spotifyArtist || { id: (String(r.spotifyUrl || '').match(/artist\/([A-Za-z0-9]+)/) || [])[1] || '', name: r.artistName, uri: r.spotifyUrl || '', followers: '', image: '' };
    return r;
  }
  // assemble from raw files — order by the canonical 6-version sequence.
  const VERSIONS = ['', 'Slowed', 'Ultra Slowed', 'Slowed but Muffled', 'Sped Up', '8D Audio'];
  const files = await readdir(abs);
  const mp3s = files.filter((f) => /\.mp3$/i.test(f));
  const cover = files.find((f) => /^(cover|art|artwork|folder)\./i.test(f)) || files.find((f) => /\.(jpe?g|png)$/i.test(f));
  if (!mp3s.length) throw new Error(`${abs} içinde mp3 yok`);
  // derive the base title from the un-suffixed file (e.g. "drop dead.mp3")
  const versionOf = (f) => { const b = path.basename(f, path.extname(f)); const m = b.match(/^(.*?)\s*-\s*(.+)$/); return m ? { base: m[1].trim(), ver: m[2].trim() } : { base: b.trim(), ver: '' }; };
  const parsed = mp3s.map((f) => ({ f, ...versionOf(f) }));
  const base0 = (parsed.find((p) => p.ver === '') || parsed[0]).base;
  const title = arg('--title') || base0;
  const artist = arg('--artist') || null; // resolved from Spotify if omitted
  const orig = arg('--orig');
  if (!orig) throw new Error('C-line için --orig (orijinal sanatçı sahne adı) gerekli');
  const spUrl = arg('--spotify') || '';
  // sort tracks into canonical order (unknown versions go last, keeping name)
  const idx = (v) => { const i = VERSIONS.findIndex((x) => x.toLowerCase() === v.toLowerCase()); return i < 0 ? 99 : i; };
  parsed.sort((a, b) => idx(a.ver) - idx(b.ver));
  return {
    releaseTitle: title, artistName: artist, clineName: orig,
    coverSong: orig, language: cfg.routenote.language, genre: cfg.routenote.genre,
    explicit: cfg.routenote.explicit, label: cfg.routenote.label,
    copyrightYear: cfg.routenote.copyrightYear, pLine: cfg.routenote.pLine,
    spotifyUrl: spUrl, spotifyArtist: { id: (spUrl.match(/artist\/([A-Za-z0-9]+)/) || [])[1] || '', name: artist, uri: spUrl, followers: '', image: '' },
    composer: { first: arg('--composer-first') || '', last: arg('--composer-last') || '' },
    coverPath: cover ? path.join(abs, cover) : null,
    tracks: parsed.map((p) => ({ title: p.ver ? `${title} - ${p.ver}` : title, file: p.f, dir: abs })),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) { console.error('kullanım: node src/routenote-upload.mjs <releaseDir> [--publish] [--title T --artist A --orig O [--spotify URL]]'); process.exit(1); }
  const publish = process.argv.includes('--publish');
  const cfgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  cfg.paths = cfg.paths || {};
  const release = await buildRelease(dir, cfg);
  console.log(`Release: "${release.releaseTitle}" — ${release.artistName} | © ${release.clineName} | ${release.tracks.length} parça | ${publish ? 'YAYINLA' : 'DRAFT'}`);
  const jar = await ensureSession(cfg);
  const out = await uploadRelease(cfg, jar, release, { publish });
  console.log('SONUÇ:', out);
}
