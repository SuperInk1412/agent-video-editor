// Beat / onset analysis in pure JS (no native deps).
// Decode via ffmpeg -> mono f32 -> STFT spectral flux -> peaks -> tempo.
import { spawn } from 'node:child_process';
import { findBin } from './media.js';

const SR = 22050;
const WIN = 1024;
const HOP = 512;

/** decode any media file to mono Float32Array at SR */
export function decodePcm(file) {
  return new Promise(async (resolve, reject) => {
    let ffmpeg;
    try { ffmpeg = await findBin('ffmpeg'); } catch (e) { return reject(e); }
    const p = spawn(ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode failed: ${err.slice(-300)}`));
      const buf = Buffer.concat(chunks);
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
      resolve(f32);
    });
  });
}

/** in-place iterative radix-2 FFT (re/im of length n, power of two) */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** spectral-flux onset envelope, one value per hop */
function onsetEnvelope(pcm) {
  const win = hann(WIN);
  const nFrames = Math.max(1, Math.floor((pcm.length - WIN) / HOP) + 1);
  const bins = WIN / 2;
  const re = new Float32Array(WIN), im = new Float32Array(WIN);
  const prev = new Float32Array(bins);
  const mag = new Float32Array(bins);
  const flux = new Float32Array(nFrames);
  const low = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < WIN; i++) { re[i] = pcm[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let s = 0, lo = 0;
    for (let b = 1; b < bins; b++) {
      mag[b] = Math.hypot(re[b], im[b]);
      const d = mag[b] - prev[b];
      if (d > 0) s += d;
      if (b < 12) lo += mag[b];
      prev[b] = mag[b];
    }
    flux[f] = s;
    low[f] = lo;
  }
  // normalise + light smoothing
  const out = new Float32Array(nFrames);
  const max = Math.max(...flux, 1e-9);
  for (let i = 0; i < nFrames; i++) out[i] = flux[i] / max;
  return { env: out, low, hopSec: HOP / SR };
}

function median(arr, from, to) {
  const sub = Array.from(arr.slice(Math.max(0, from), Math.min(arr.length, to))).sort((a, b) => a - b);
  return sub.length ? sub[Math.floor(sub.length / 2)] : 0;
}

/** pick onsets with an adaptive local threshold */
function pickPeaks(env, hopSec, { minGap = 0.09, delta = 0.06, mult = 1.35 } = {}) {
  const peaks = [];
  const win = Math.round(0.35 / hopSec);
  for (let i = 2; i < env.length - 2; i++) {
    const v = env[i];
    if (v < env[i - 1] || v < env[i + 1]) continue;
    const thr = median(env, i - win, i + win) * mult + delta;
    if (v < thr) continue;
    const t = i * hopSec;
    if (peaks.length && t - peaks[peaks.length - 1].t < minGap) {
      if (v > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { t, v };
      continue;
    }
    peaks.push({ t, v });
  }
  return peaks;
}

/** autocorrelation tempo estimate from onset envelope */
function estimateTempo(env, hopSec) {
  const minLag = Math.round(0.30 / hopSec); // 200 bpm
  const maxLag = Math.round(1.20 / hopSec); // 50 bpm
  let best = { lag: 0, score: -1 };
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    s /= env.length - lag;
    // slight preference for 90-160 bpm
    const bpm = 60 / (lag * hopSec);
    const w = bpm < 70 ? 0.7 : bpm > 180 ? 0.6 : 1;
    if (s * w > best.score) best = { lag, score: s * w };
  }
  if (!best.lag) return { tempo: 0, periodSec: 0 };
  let lag = best.lag;
  // refine with parabolic interpolation on the autocorrelation
  const ac = (l) => {
    let s = 0;
    for (let i = 0; i + l < env.length; i++) s += env[i] * env[i + l];
    return s / Math.max(1, env.length - l);
  };
  const y0 = ac(lag - 1), y1 = ac(lag), y2 = ac(lag + 1);
  const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
  const refined = lag + Math.max(-0.5, Math.min(0.5, d));
  const periodSec = refined * hopSec;
  return { tempo: 60 / periodSec, periodSec };
}

/**
 * Full analysis. Returns beats on a tempo grid snapped to onsets,
 * plus raw onsets and a low-band energy envelope (for punches).
 */
export async function analyzeBeats(file, { duration = null, fps = 30 } = {}) {
  const pcm = await decodePcm(file);
  const { env, low, hopSec } = onsetEnvelope(pcm);
  const total = duration || pcm.length / SR;
  const peaks = pickPeaks(env, hopSec);
  const { tempo, periodSec } = estimateTempo(env, hopSec);

  const beats = [];
  if (periodSec > 0) {
    // anchor the grid on the strongest onset near the start
    const strong = [...peaks].sort((a, b) => b.v - a.v)[0];
    let t = strong ? strong.t : 0;
    while (t - periodSec > 0) t -= periodSec;
    const maxT = total + 1e-6;
    for (; t < maxT; t += periodSec) {
      // snap to a nearby onset if there is one
      let best = t, bestD = 0.09;
      for (const p of peaks) {
        if (Math.abs(p.t - t) < bestD) { best = p.t; bestD = Math.abs(p.t - t); }
      }
      beats.push(Math.round(best * 1000) / 1000);
    }
  }
  // coarse low-band envelope, handy for punches / reactive effects
  const envStep = 1 / 30;
  const lowEnv = [];
  const lowMax = Math.max(...low, 1e-9);
  for (let t = 0; t < total; t += envStep) {
    const i = Math.min(low.length - 1, Math.floor(t / hopSec));
    lowEnv.push(Math.round((low[i] / lowMax) * 1000) / 1000);
  }
  return {
    lowEnv,
    envStep,
    duration: total,
    fps,
    tempo: Math.round(tempo * 100) / 100,
    periodSec: Math.round(periodSec * 1000) / 1000,
    beats,
    onsets: peaks.map((p) => ({ t: Math.round(p.t * 1000) / 1000, strength: Math.round(p.v * 100) / 100 })),
  };
}

export { onsetEnvelope, pickPeaks, estimateTempo, fft, SR };
