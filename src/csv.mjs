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
  if (!existsSync(f)) return { inputIndex: 0, artistIndex: 0, done: [] };
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return { inputIndex: 0, artistIndex: 0, done: [] }; }
}

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

  return {
    songsCount: songs.length,
    artistsCount: artists.length,
    hasNext: () => state.inputIndex < songs.length && artists.length > 0,
    /** Current (song, artist) WITHOUT advancing — so an interrupted/crashed
     *  release is retried from the same spot on the next run, not skipped. */
    peek() {
      if (state.inputIndex >= songs.length || artists.length === 0) return null;
      return { song: songs[state.inputIndex], artist: artists[state.artistIndex % artists.length] };
    },
    /** Advance + persist the cursor. Call only once a release is fully handled. */
    async commit() {
      state.inputIndex += 1;
      state.artistIndex = (state.artistIndex + 1) % artists.length;
      await saveState(stateDir, state);
    },
    /** peek + commit (legacy convenience). */
    async next() { const it = this.peek(); if (!it) return null; await this.commit(); return it; },
  };
}
