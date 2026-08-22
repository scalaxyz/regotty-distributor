// Cover generation via the regotty backend automation API. Queues a song, runs
// it, waits for the take, and returns the cover + its source (for the risk gate).

import { writeFile } from 'node:fs/promises';

async function api(cfg, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`regotty ${method} ${pathname} -> ${res.status} ${t.slice(0, 160)}`);
  }
  return res.json();
}

const abs = (cfg, url) => (url && url.startsWith('/') ? `${cfg.baseUrl.replace(/\/$/, '')}${url}` : url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate a cover for (artist, song). Resolves when the take is ready.
 * Returns { itemId, coverUrl, sourceUrl }. Throws on failure/timeout.
 */
export async function generateCover(cfg, artist, song, { retention, instrumental = false, timeoutMs = 20 * 60_000, pollMs = 5000 } = {}) {
  // instrumental:true => backend YouTube'da "<artist> <song> instrumental" arar ve
  // ACE-Step'e --instrumental verir (sözsüz üretir). Ayrı bir vokal-ayırma gerekmez.
  const { item } = await api(cfg, '/api/automation/queue', {
    method: 'POST',
    body: { artist, title: song, instrumental, sourcePref: instrumental ? 'auto' : 'lyrics' },
  });
  const id = item.id;
  await api(cfg, '/api/automation/run', {
    method: 'POST',
    body: { itemIds: [id], mode: 'selected', retention: retention ?? cfg.retention, semantic: cfg.semantic, model: cfg.model },
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const { items } = await api(cfg, '/api/automation/queue');
    const row = items.find((x) => x.id === id);
    if (!row) throw new Error('kuyruk öğesi kayboldu');
    if (row.status === 'review' && row.last_audio_url) {
      return { itemId: id, coverUrl: abs(cfg, row.last_audio_url), sourceUrl: abs(cfg, row.last_source_url) };
    }
    if (row.status === 'failed') throw new Error(`üretim başarısız: ${row.error || '?'}`);
  }
  throw new Error('üretim zaman aşımı');
}

/** Ask the backend to regenerate the current take (optionally with new params). */
export async function retryCover(cfg, itemId, override) {
  await api(cfg, `/api/automation/queue/${itemId}/retry`, { method: 'POST', body: override || {} });
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const { items } = await api(cfg, '/api/automation/queue');
    const row = items.find((x) => x.id === itemId);
    if (row?.status === 'review' && row.last_audio_url) return { coverUrl: abs(cfg, row.last_audio_url), sourceUrl: abs(cfg, row.last_source_url) };
    if (row?.status === 'failed') throw new Error(`tekrar üretim başarısız: ${row.error || '?'}`);
  }
  throw new Error('tekrar üretim zaman aşımı');
}

/** Remove the queue item once we've grabbed its audio (we don't use the library). */
export async function cleanupItem(cfg, itemId) {
  await api(cfg, `/api/automation/queue/${itemId}`, { method: 'DELETE' }).catch(() => {});
}

/** Download an audio URL to a local file. */
export async function downloadAudio(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ses indirilemedi ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}
