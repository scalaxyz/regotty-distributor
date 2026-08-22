// Audio quality gate — ffmpeg-based sanity checks so a broken/silent/clipped
// take never reaches distribution.

import { spawn } from 'node:child_process';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', () => resolve(out + err)); // volumedetect/astats print to stderr
  });
}

/**
 * Inspect one audio file and decide if it's fit to publish.
 * Returns { pass, reasons: string[], metrics: { durationSec, meanDb, maxDb, flatFactor } }.
 */
export async function checkQuality(file, opts = {}) {
  const {
    minDurationSec = 30,
    minLoudnessDb = -20,
    maxLoudnessDb = -6,
    silenceFloorDb = -45,
    requireNotSilent = true,
  } = opts;

  const log = await run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect,astats=metadata=0', '-f', 'null', '-']);

  const num = (re) => { const m = log.match(re); return m ? parseFloat(m[1]) : null; };
  const durText = log.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  const durationSec = durText ? (+durText[1]) * 3600 + (+durText[2]) * 60 + (+durText[3]) : null;
  const meanDb = num(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  const maxDb = num(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  const flatFactor = num(/Flat factor:\s*(-?\d+(?:\.\d+)?)/);

  const reasons = [];
  if (durationSec != null && durationSec < minDurationSec) reasons.push(`süre çok kısa (${durationSec?.toFixed(1)}s < ${minDurationSec}s)`);
  if (requireNotSilent && meanDb != null && meanDb < silenceFloorDb) reasons.push(`neredeyse sessiz (mean ${meanDb} dB)`);
  if (meanDb != null && meanDb < minLoudnessDb) reasons.push(`çok kısık (mean ${meanDb} dB < ${minLoudnessDb})`);
  if (meanDb != null && meanDb > maxLoudnessDb) reasons.push(`çok yüksek (mean ${meanDb} dB > ${maxLoudnessDb})`);
  // Sustained clipping: peak at 0 dBFS AND a high flat factor (long flat runs).
  if (maxDb != null && maxDb >= 0 && flatFactor != null && flatFactor > 5) reasons.push(`clipping (peak ${maxDb} dB, flat ${flatFactor})`);

  return { pass: reasons.length === 0, reasons, metrics: { durationSec, meanDb, maxDb, flatFactor } };
}

// CLI: node src/quality.mjs <file>
if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node src/quality.mjs <file>'); process.exit(1); }
  console.log(await checkQuality(file));
}
