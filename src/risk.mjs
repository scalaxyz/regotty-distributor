// Headless recognition / Content-ID risk score — the Node port of the app's
// trackAnalysis (chroma fingerprint + raw-waveform correlation + segment
// coverage + tempo/duration). Decodes audio to mono f32 PCM via ffmpeg instead
// of Web Audio, then runs the identical DSP. Low score = distinct from source.

import { spawn } from 'node:child_process';

const TARGET_RATE = 11025;
const FRAME = 4096, HOP = 1024;

// Decode any audio file to a mono Float32Array at `rate` via ffmpeg.
function decodePcm(file, rate = TARGET_RATE) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
      '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

function hammingWin(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi, nwi = cwr * wi + cwi * wr; cwr = nwr; cwi = nwi;
      }
    }
  }
}
function computeChromaFrames(sig, sr, frameSize, hop) {
  const win = hammingWin(frameSize), frames = [], A4 = 440, half = frameSize >> 1;
  for (let s = 0; s + frameSize <= sig.length; s += hop) {
    const re = new Float32Array(frameSize), im = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i++) re[i] = sig[s + i] * win[i];
    fft(re, im);
    const ch = new Float32Array(12);
    for (let bin = 1; bin < half; bin++) {
      const freq = (bin * sr) / frameSize;
      if (freq < 27.5 || freq > 4200) continue;
      const pc = ((Math.round(69 + 12 * Math.log2(freq / A4)) % 12) + 12) % 12;
      const mag = Math.hypot(re[bin], im[bin]);
      ch[pc] += mag * mag;
    }
    let norm = 0; for (let p = 0; p < 12; p++) norm += ch[p] * ch[p];
    norm = Math.sqrt(norm) || 1; for (let p = 0; p < 12; p++) ch[p] /= norm;
    frames.push(ch);
  }
  return frames;
}
function meanChroma(frames) {
  const m = new Float32Array(12);
  for (const f of frames) for (let p = 0; p < 12; p++) m[p] += f[p];
  let n = 0; for (let p = 0; p < 12; p++) n += m[p] * m[p];
  n = Math.sqrt(n) || 1; for (let p = 0; p < 12; p++) m[p] /= n;
  return m;
}
const dot = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

function compareChroma(A, B) {
  if (!A.length || !B.length) return { combined: 0, perFrame: [] };
  const g = Math.max(0, dot(meanChroma(A), meanChroma(B)));
  const maxLag = Math.min(120, Math.floor(Math.min(A.length, B.length) * 0.1));
  const minReq = Math.min(A.length, B.length) * 0.3;
  let best = -1, bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0, c = 0;
    for (let i = 0; i < A.length; i++) { const j = i + lag; if (j < 0 || j >= B.length) continue; s += Math.max(0, dot(A[i], B[j])); c++; }
    if (c < minReq) continue;
    const cand = s / c; if (cand > best) { best = cand; bestLag = lag; }
  }
  if (best < 0) best = 0;
  const perFrame = [];
  for (let i = 0; i < A.length; i++) { const j = i + bestLag; perFrame.push(j < 0 || j >= B.length ? null : Math.max(0, dot(A[i], B[j]))); }
  return { combined: 0.4 * g + 0.6 * best, perFrame };
}
function detectBPM(sig, sr) {
  const fs = 512, hop = 256, win = hammingWin(fs), half = fs >> 1, onsets = [];
  let prev = null;
  for (let s = 0; s + fs <= sig.length; s += hop) {
    const re = new Float32Array(fs), im = new Float32Array(fs);
    for (let i = 0; i < fs; i++) re[i] = sig[s + i] * win[i];
    fft(re, im);
    const mag = new Float32Array(half);
    for (let b = 0; b < half; b++) mag[b] = Math.hypot(re[b], im[b]);
    if (prev) { let flux = 0; for (let b = 0; b < half; b++) flux += Math.max(0, mag[b] - prev[b]); onsets.push(flux); } else onsets.push(0);
    prev = mag;
  }
  const ht = hop / sr, minLag = Math.max(1, Math.round(60 / (200 * ht))), maxLag = Math.round(60 / (55 * ht));
  const mean = onsets.reduce((a, v) => a + v, 0) / onsets.length;
  const corr = (lag) => { const n = onsets.length - lag; if (n < 20) return null; let c = 0; for (let i = 0; i < n; i++) c += (onsets[i] - mean) * (onsets[i + lag] - mean); return c / n; };
  const lags = []; let raw = -Infinity, rawLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) { const c = corr(lag); if (c === null) continue; lags.push(lag); if (c > raw) { raw = c; rawLag = lag; } }
  const pw = (bpm) => { const d = Math.log(bpm) - Math.log(120); return Math.exp(-(d * d) / (2 * 0.7 * 0.7)); };
  let bestLag = rawLag, bs = -Infinity;
  for (const lag of lags) { const sc = corr(lag) * pw(60 / (lag * ht)); if (sc > bs) { bs = sc; bestLag = lag; } }
  return 60 / (bestLag * ht);
}
const rms = (sig) => { let s = 0; for (let i = 0; i < sig.length; i++) s += sig[i] * sig[i]; return 20 * Math.log10(Math.sqrt(s / sig.length) + 1e-9); };
const statusFor = (v, warn, bad, hi = false) => (hi ? v >= bad : v <= bad) ? 'red' : (hi ? v >= warn : v <= warn) ? 'yellow' : 'green';

function xcorrAt(A, B, aStart, len, lag, step) {
  let num = 0, da = 0, db = 0, c = 0;
  for (let i = aStart; i < aStart + len && i < A.length; i += step) { const j = i + lag; if (j < 0 || j >= B.length) continue; const a = A[i], b = B[j]; num += a * b; da += a * a; db += b * b; c++; }
  if (c < 64 || da <= 0 || db <= 0) return -Infinity;
  return Math.abs(num / Math.sqrt(da * db));
}
function rawXcorr(A, B, aStart, len, center, search) {
  let best = -Infinity, bestLag = center; const cStep = 8, sStep = 4; const cand = [];
  for (let lag = center - search; lag <= center + search; lag += cStep) cand.push({ lag, score: xcorrAt(A, B, aStart, len, lag, sStep) });
  cand.sort((a, b) => b.score - a.score); best = -Infinity;
  const ref = cand.slice(0, 12);
  if (!ref.some((c) => Math.abs(c.lag - center) <= cStep)) ref.push({ lag: center, score: xcorrAt(A, B, aStart, len, center, sStep) });
  for (const cd of ref) {
    const from = Math.max(center - search, cd.lag - cStep), to = Math.min(center + search, cd.lag + cStep);
    for (let lag = from; lag <= to; lag++) { const sc = xcorrAt(A, B, aStart, len, lag, 1); if (sc > best + 1e-9 || (Math.abs(sc - best) <= 1e-9 && Math.abs(lag - center) < Math.abs(bestLag - center))) { best = sc; bestLag = lag; } }
  }
  return { lag: bestLag, corr: best > -Infinity ? best : 0 };
}
function analyzeAlignment(A, B, sr) {
  const total = Math.min(A.length, B.length);
  if (total < sr * 2) return { startOffsetMs: 0, driftMs: 0, recordingCorr: 0, reliable: false };
  const chunk = Math.min(Math.round(1.5 * sr), Math.floor(total * 0.2)), search = Math.round(0.25 * sr);
  const rS = rawXcorr(A, B, Math.floor(total * 0.08), chunk, 0, search);
  const rM = rawXcorr(A, B, Math.floor(total * 0.46), chunk, 0, search);
  const rE = rawXcorr(A, B, total - chunk - Math.floor(total * 0.08), chunk, 0, search);
  const rec = [rS.corr, rM.corr, rE.corr].sort((a, b) => a - b)[1];
  return { startOffsetMs: rS.lag / sr * 1000, driftMs: (rE.lag - rS.lag) / sr * 1000, recordingCorr: rec, reliable: rec >= 0.25 };
}
function segmentCoverage(perFrame, hopTime, windowSec, thr) {
  const fpw = Math.max(1, Math.round(windowSec / hopTime)), wins = [];
  for (let w = 0; w * fpw < perFrame.length; w++) {
    let s = 0, c = 0;
    for (let i = w * fpw; i < (w + 1) * fpw && i < perFrame.length; i++) { const v = perFrame[i]; if (v == null) continue; s += v; c++; }
    wins.push({ tEnd: Math.min(perFrame.length, (w + 1) * fpw) * hopTime, tStart: w * fpw * hopTime, sim: c ? s / c : 0 });
  }
  let longest = 0, cur = null;
  for (const w of wins) { if (w.sim < thr) { if (cur === null) cur = w.tStart; if (w.tEnd - cur > longest) longest = w.tEnd - cur; } else cur = null; }
  const matched = wins.filter((w) => w.sim >= thr).length;
  return { coverage: wins.length ? matched / wins.length : 0, longestUnmatchedSec: longest };
}

/** Compute the risk/match score (0-100) of a cover against its source. Low = safe. */
export async function computeRisk(sourceFile, coverFile) {
  const [sigA, sigB] = await Promise.all([decodePcm(sourceFile), decodePcm(coverFile)]);
  const durA = sigA.length / TARGET_RATE, durB = sigB.length / TARGET_RATE;
  const chroma = compareChroma(computeChromaFrames(sigA, TARGET_RATE, FRAME, HOP), computeChromaFrames(sigB, TARGET_RATE, FRAME, HOP));
  const align = analyzeAlignment(sigA, sigB, TARGET_RATE);
  const seg = segmentCoverage(chroma.perFrame, HOP / TARGET_RATE, 3, 0.6);
  const durDiffMs = Math.abs(durA - durB) * 1000;

  const bpmA = detectBPM(sigA, TARGET_RATE);
  let bpmB = detectBPM(sigB, TARGET_RATE);
  if (align.reliable && align.recordingCorr >= 0.35 && Math.abs(align.driftMs) <= 40 && durDiffMs <= 300) bpmB = bpmA;
  const bpmDiff = Math.abs(bpmA - bpmB);

  const chromaPct = chroma.combined * 100;
  const coveragePct = seg.coverage * 100;
  const recordingPct = Math.max(0, Math.min(100, align.recordingCorr * 100));
  const offMag = Math.abs(align.startOffsetMs), drMag = Math.abs(align.driftMs);
  const chromaNorm = Math.max(0, Math.min(100, chromaPct / 68 * 100));
  const durScore = Math.max(0, 100 - durDiffMs / 5);
  const bpmScore = Math.max(0, 100 - bpmDiff * 14);
  let penalty = 0;
  if (align.reliable && offMag > 60) penalty += Math.min(20, (offMag - 60) / 20);
  if (align.reliable && drMag > 40) penalty += Math.min(20, (drMag - 40) / 15);
  if (seg.longestUnmatchedSec > 2) penalty += Math.min(25, (seg.longestUnmatchedSec - 2) * 5);
  const base = recordingPct * 0.45 + chromaNorm * 0.15 + coveragePct * 0.15 + durScore * 0.15 + bpmScore * 0.10;
  const score = Math.round(Math.max(0, Math.min(100, base - penalty)));

  return { score, recordingPct, chromaPct, coveragePct, bpmA, bpmB, durDiffMs, loudA: rms(sigA), loudB: rms(sigB) };
}

// CLI: node src/risk.mjs <source> <cover>
if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [src, cov] = process.argv.slice(2);
  if (!src || !cov) { console.error('usage: node src/risk.mjs <source> <cover>'); process.exit(1); }
  console.log(await computeRisk(src, cov));
}
