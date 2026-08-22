// Composer/writer lookup via Spotify — search the track, then read its
// track-credits (writers/composers). Reuses the token from spotify-metadata-tools
// (token_cache.json: { accessToken, clientToken }).

import { readFile } from 'node:fs/promises';

const isValid = (t) => t && typeof t.accessToken === 'string' && t.accessToken.length > 100 && t.clientToken;

// Fresh tokens come from the token server (mints a live Spotify access +
// client token); fall back to the cached token_cache.json if it's unreachable.
async function loadTokens({ tokenServerUrl, tokenCachePath } = {}) {
  if (tokenServerUrl) {
    for (const ep of ['/read-tokens', '/tokens']) {
      try {
        const r = await fetch(`${tokenServerUrl.replace(/\/$/, '')}${ep}`);
        if (r.ok) { const t = await r.json(); if (isValid(t)) return t; }
      } catch { /* try next / fallback */ }
    }
  }
  if (tokenCachePath) {
    const raw = JSON.parse(await readFile(tokenCachePath, 'utf8'));
    if (isValid(raw)) return raw;
  }
  throw new Error('Spotify token alınamadı (token server ulaşılamıyor + cache geçersiz).');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch with a couple of retries on 429 (Spotify's public search rate-limits).
async function fetchRetry(url, headers, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers });
    if (res.status !== 429) return res;
    const wait = Math.min(60, Number(res.headers.get('retry-after')) || (i + 1) * 5);
    if (i < tries - 1) await sleep(wait * 1000);
    else return res;
  }
}

// Public Web API (api.spotify.com) — Bearer only; a Client-Token here 400s.
async function publicGet(url, tokens) {
  return fetchRetry(url, { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' });
}
// Internal client API (spclient) — needs the client token + web-player headers.
async function spclientGet(url, tokens) {
  return fetchRetry(url, {
    Authorization: `Bearer ${tokens.accessToken}`,
    'Client-Token': tokens.clientToken,
    Accept: 'application/json',
    'App-Platform': 'WebPlayer',
    Origin: 'https://open.spotify.com',
    Referer: 'https://open.spotify.com/',
    'User-Agent': 'Mozilla/5.0',
  });
}

/** Best-match Spotify track for "artist - song" — the full item {id, explicit, …}. */
export async function searchTrack(artist, song, tokens) {
  const q = encodeURIComponent(`${song} ${artist}`);
  const res = await publicGet(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=1`, tokens);
  if (res.status === 401) throw new Error('Spotify token süresi doldu — token_cache.json yenilenmeli.');
  if (!res.ok) return null;
  const j = await res.json();
  return j?.tracks?.items?.[0] || null;
}
/** Best-match Spotify track id for "artist - song". */
export async function searchTrackId(artist, song, tokens) { const t = await searchTrack(artist, song, tokens); return t?.id || null; }

/** Writer/composer names for a track id (may be empty if Spotify has no credits). */
export async function getWriters(trackId, tokens) {
  const res = await spclientGet(`https://spclient.wg.spotify.com/track-credits-view/v0/experimental/${trackId}/credits`, tokens);
  if (!res.ok) return [];
  const j = await res.json().catch(() => null);
  const writers = [];
  for (const rc of j?.roleCredits || []) {
    const role = rc.roleTitle || '';
    if (/writer|composer/i.test(role)) for (const a of rc.artists || []) if (a.name) writers.push(a.name);
  }
  return [...new Set(writers)];
}

const splitName = (full) => {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
};

// ---- spclient (internal) track lookup — NO public-API rate limit ------------
// The public /v1/search rate-limits per IP; the web-player's spclient metadata
// endpoint does not. It's keyed by the 32-hex `gid`, which is the base62 track
// id decoded to hex (same conversion spotify-metadata-tools uses).
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function base62ToHex(id) {
  let n = 0n;
  for (const ch of String(id)) {
    const idx = B62.indexOf(ch);
    if (idx < 0) throw new Error('geçersiz Spotify track id: ' + id);
    n = n * 62n + BigInt(idx);
  }
  return n.toString(16).padStart(32, '0');
}

/** Pull a base62 track id out of a URL / URI / bare id. */
export function parseTrackId(input) {
  const s = String(input || '').trim();
  let m = s.match(/track[:/]([A-Za-z0-9]{22})/);           // open.spotify.com/track/… or spotify:track:…
  if (m) return m[1];
  if (/^[A-Za-z0-9]{22}$/.test(s)) return s;               // bare id
  return null;
}

/**
 * Full track metadata via spclient (no rate limit). Returns
 * { trackId, gid, name, artist, artists[], album, label, explicit, hasLyrics,
 *   isrc, durationMs, coverUrl, writers[], first, last, second }.
 */
export async function getTrackMeta(urlOrId, tokenCfg) {
  const id = parseTrackId(urlOrId);
  if (!id) throw new Error('Spotify track linki/ID çözümlenemedi: ' + urlOrId);
  const tokens = await loadTokens(tokenCfg);
  const gid = base62ToHex(id);
  const res = await spclientGet(`https://spclient.wg.spotify.com/metadata/4/track/${gid}?market=from_token`, tokens);
  if (res.status === 401) throw new Error('Spotify token süresi doldu — token yenilenmeli.');
  if (!res.ok) throw new Error(`spclient metadata alınamadı (HTTP ${res.status})`);
  const t = await res.json();
  const writers = await getWriters(id, tokens).catch(() => []);
  const isrc = (t.external_id || []).find((x) => x.type === 'isrc')?.id || '';
  const cover = (t.album?.cover_group?.image || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  const primary = writers[0] ? splitName(writers[0]) : { first: '', last: '' };
  const second = writers[1] ? splitName(writers[1]) : null;
  return {
    trackId: id, gid,
    name: t.name || '',
    artist: (t.artist || [])[0]?.name || '',
    artists: (t.artist || []).map((a) => a.name).filter(Boolean),
    album: t.album?.name || '',
    label: t.album?.label || '',
    explicit: !!t.explicit,
    hasLyrics: !!t.has_lyrics,
    isrc,
    durationMs: t.duration || 0,
    coverUrl: cover ? `https://i.scdn.co/image/${cover.file_id}` : '',
    writers, first: primary.first, last: primary.last, second,
  };
}

/**
 * Resolve composer + explicit metadata for a song. Returns
 * { trackId, explicit: bool, writers: string[], first, last, second: {first,last}|null }.
 * `writers` empty => caller should decide (skip or fall back).
 */
export async function getComposer(artist, song, tokenCfg, url) {
  // A Spotify link (from the queue) resolves via spclient — no public-API rate
  // limit, and it's an exact match. Fall back to name search if there's no link
  // (or the link lookup fails).
  if (parseTrackId(url)) {
    try {
      const m = await getTrackMeta(url, tokenCfg);
      return { trackId: m.trackId, explicit: m.explicit, writers: m.writers, first: m.first, last: m.last, second: m.second };
    } catch { /* fall back to name search */ }
  }
  const tokens = await loadTokens(tokenCfg);
  const track = await searchTrack(artist, song, tokens);
  if (!track?.id) return { trackId: null, explicit: false, writers: [], first: '', last: '', second: null };
  const writers = await getWriters(track.id, tokens);
  const primary = writers[0] ? splitName(writers[0]) : { first: '', last: '' };
  const second = writers[1] ? splitName(writers[1]) : null;
  return { trackId: track.id, explicit: !!track.explicit, writers, first: primary.first, last: primary.last, second };
}

// CLI:
//   node src/credits.mjs "<spotify track link/id>"        -> full spclient meta
//   node src/credits.mjs "<artist>" "<song>" [tokenServer] -> composer via name search
if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const tokenServerUrl = process.env.SPOTIFY_TOKEN_SERVER || 'http://127.0.0.1:3000';
  if (args.length === 1 && parseTrackId(args[0])) {
    console.log(await getTrackMeta(args[0], { tokenServerUrl }));
  } else {
    const [artist, song, ts = tokenServerUrl] = args;
    if (!artist || !song) { console.error('usage: node src/credits.mjs "<link|id>"  |  "<artist>" "<song>" [tokenServer]'); process.exit(1); }
    console.log(await getComposer(artist, song, { tokenServerUrl: ts }));
  }
}
