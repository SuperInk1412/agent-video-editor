import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { analyzeBeats, fft } from '../engine/beats.js';

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
