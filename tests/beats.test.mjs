import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { analyzeBeats, fft, onsetEnvelope, estimateTempo, SR } from '../engine/beats.js';

const AUDIO = process.env.VDM_TEST_AUDIO || path.resolve('projects/demo/media/bgm.m4a');

test('fft finds a pure tone bin', () => {
  const n = 1024, sr = 44100, f0 = 44100 / 8;
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * f0 * i) / sr);
  fft(re, im);
  let best = 1, bestMag = 0;
  for (let i = 1; i < n / 2; i++) {
    const m = Math.hypot(re[i], im[i]);
    if (m > bestMag) { bestMag = m; best = i; }
  }
  assert.equal(best, 128);
});

test('beat analysis on the demo track', async (t) => {
  let exists = true;
  try { await import('node:fs/promises').then((fs) => fs.access(AUDIO)); } catch { exists = false; }
  if (!exists) return t.skip('demo audio not present');
  const r = await analyzeBeats(AUDIO, { duration: 24 });
  assert.ok(r.beats.length > 20, 'detects a grid');
  assert.ok(r.tempo > 70 && r.tempo < 190, `tempo sane (${r.tempo})`);
  assert.ok(r.duration > 20);
  assert.ok(r.onsets.length > 10);
  // beats must be increasing
  for (let i = 1; i < r.beats.length; i++) assert.ok(r.beats[i] > r.beats[i - 1]);
});

/** kick on 1/3, snare on 2/4, hats on eighths: the pattern that used to read at half tempo */
function drumLoop(bpm, secs = 16) {
  const pcm = new Float32Array(Math.floor(secs * SR));
  let r = 7;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const beat = 60 / bpm;
  for (let b = 0; b * beat < secs; b++) {
    for (const [off, kind] of [[0, b % 2 ? 'snare' : 'kick'], [0.5, 'hat']]) {
      const i0 = Math.floor((b + off) * beat * SR);
      for (let i = 0; i < SR * 0.25 && i0 + i < pcm.length; i++) {
        const t = i / SR;
        if (kind === 'kick') pcm[i0 + i] += 0.9 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 12);
        else if (kind === 'snare') pcm[i0 + i] += 0.5 * rnd() * Math.exp(-t * 20) + 0.3 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 15);
        else pcm[i0 + i] += 0.15 * rnd() * Math.exp(-t * 60);
      }
    }
  }
  return pcm;
}

test('tempo of kick/snare loops is not halved', () => {
  for (const bpm of [90, 100, 120, 128]) {
    const { env, hopSec } = onsetEnvelope(drumLoop(bpm));
    const { tempo } = estimateTempo(env, hopSec);
    assert.ok(Math.abs(tempo - bpm) < 1, `${bpm} bpm read as ${tempo.toFixed(2)}`);
  }
});
