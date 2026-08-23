// Minimal CSV reader (handles quoted fields) + persistent rotation state so the
// pipeline resumes where it left off across restarts.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

function parseLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export async function readCsv(file) {
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const header = parseLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = parseLine(l);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

// ---- rotation state ----------------------------------------------------------

async function loadState(stateDir) {
  const f = path.join(stateDir, 'rotation.json');
  if (!existsSync(f)) return { artistIndex: 0, done: [] };
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return { artistIndex: 0, done: [] }; }
}

/** Stable identity for a queue row — survives reordering/editing of input.csv. */
export const songKey = (s) => `${String(s?.artist || '').trim().toLowerCase()}|${String(s?.song || '').trim().toLowerCase()}`;

/** Local calendar day (YYYY-MM-DD) — daemon's daily target rolls over on this. */
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function saveState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'rotation.json'), JSON.stringify(state, null, 2));
}

/**
 * Rotation over input.csv (songs, in order, resuming) and artists.csv (round-robin).
 * `next()` returns { song, artist } and advances + persists both cursors.
 */
export async function createRotation({ inputCsv, artistsCsv, stateDir }) {
  const songs = await readCsv(inputCsv);
  const artists = await readCsv(artistsCsv);
  const state = await loadState(stateDir);
  // Track processed songs by IDENTITY (artist+song), not by position — so the queue
  // can be edited/reordered freely without wrongly skipping newly-added songs or
  // re-doing others. Old positional state (inputIndex) can't be mapped to the
  // current (possibly edited) list, so it's dropped.
  if (!Array.isArray(state.done)) state.done = [];
  if (state.inputIndex != null) delete state.inputIndex;
  const doneSet = new Set(state.done);
  const firstPending = () => songs.findIndex((s) => !doneSet.has(songKey(s)));

  return {
    songsCount: songs.length,
    artistsCount: artists.length,
    doneKeys: () => [...doneSet],
    hasNext: () => firstPending() >= 0 && artists.length > 0,
    /** First not-yet-done song (list order) + current artist, WITHOUT advancing —
     *  so an interrupted/crashed release is retried from the same spot, not skipped. */
    peek() {
      const i = firstPending();
      if (i < 0 || artists.length === 0) return null;
      return { song: songs[i], artist: artists[state.artistIndex % artists.length] };
    },
    /** Mark the current song done. Advance the artist round-robin ONLY when a
     *  release was actually produced — a skipped/failed song must not "use up" an
     *  artist, so the next song keeps the same artist. */
    async commit(released = true) {
      const i = firstPending();
      if (i >= 0) doneSet.add(songKey(songs[i]));
      state.done = [...doneSet];
      if (released) state.artistIndex = artists.length ? (state.artistIndex + 1) % artists.length : 0;
      await saveState(stateDir, state);
    },
    /** peek + commit (legacy convenience). */
    async next() { const it = this.peek(); if (!it) return null; await this.commit(); return it; },
    /** Releases actually produced TODAY (auto-resets when the calendar day changes). */
    releasedToday() { return state.day === localDay() ? (state.dayCount || 0) : 0; },
    /** Record one produced release (drives the daemon's per-day target). Persisted
     *  so a crash + auto-restart resumes today's count instead of restarting at 0. */
    async markReleased() {
      const today = localDay();
      if (state.day !== today) { state.day = today; state.dayCount = 0; }
      state.dayCount = (state.dayCount || 0) + 1;
      await saveState(stateDir, state);
    },
  };
}
