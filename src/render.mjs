// Headless 6-version renderer — the ffmpeg equivalent of the browser Distribute
// flow. Produces MP3 320 kbps / 44.1 kHz for each release version.
//
// Note: "slowed/sped up" use asetrate (pitch+tempo shift, matching the browser's
// playbackRate), reverb is an aecho approximation (ffmpeg has no freeverb), 8D is
// apulsator auto-pan. Close in character to the in-app Distribute output.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const R = 44100;
// speed<1 = slowed (lower+slower), >1 = sped up. `extra` appends more filters.
const rate = (speed, extra = '') => `aresample=${R},asetrate=${Math.round(R * speed)},aresample=${R}${extra}`;

// 90% muffle cutoff, same geometric mapping as the app (20kHz -> ~500 Hz).
const MUFFLE_CUTOFF = Math.round(20000 * Math.pow(400 / 20000, 0.9)); // ~500

// suffix matches the RouteNote track naming exactly (see docs/routenote-flow.md).
export const VERSIONS = [
  { suffix: '', label: 'Original', filter: '' },
  { suffix: ' - Slowed', label: 'Slowed', filter: rate(0.8, ',aecho=0.85:0.75:60|90:0.35|0.22') },
  { suffix: ' - Ultra Slowed', label: 'Ultra Slowed', filter: rate(0.6, ',aecho=0.85:0.8:80|130:0.45|0.3') },
  { suffix: ' - Slowed but Muffled', label: 'Slowed but Muffled', filter: rate(0.75, `,aecho=0.85:0.7:60|90:0.3|0.2,lowpass=f=${MUFFLE_CUTOFF}`) },
  { suffix: ' - Sped Up', label: 'Sped Up', filter: rate(1.2) },
  { suffix: ' - 8D Audio', label: '8D Audio', filter: 'apulsator=mode=sine:hz=0.13:width=0.9' },
];

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
}

async function renderOne(input, output, filter) {
  const args = ['-i', input];
  if (filter) args.push('-filter:a', filter);
  args.push('-map_metadata', '-1', '-vn', '-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '44100', output);
  await runFfmpeg(args);
}

// Sanitise a base name for use as a filename.
const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 140) || 'track';

/**
 * Render all 6 versions of `input` into `outDir`, named "<baseName><suffix>.mp3".
 * Returns [{ title, file, path }] in RouteNote track order.
 */
export async function renderPack(input, baseName, outDir) {
  await mkdir(outDir, { recursive: true });
  const base = safe(baseName);
  const out = [];
  for (const v of VERSIONS) {
    const title = `${base}${v.suffix}`;
    const file = `${title}.mp3`;
    const p = path.join(outDir, file);
    await renderOne(input, p, v.filter);
    out.push({ title, file, path: p, label: v.label });
  }
  return out;
}

// CLI test: node src/render.mjs <input-audio> [baseName] [outDir]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, baseName = 'test', outDir = 'output/_render_test'] = process.argv.slice(2);
  if (!input) { console.error('usage: node src/render.mjs <input-audio> [baseName] [outDir]'); process.exit(1); }
  renderPack(input, baseName, outDir)
    .then((r) => { console.log('rendered:'); r.forEach((x) => console.log('  -', x.file)); })
    .catch((e) => { console.error('render failed:', e.message); process.exit(1); });
}
