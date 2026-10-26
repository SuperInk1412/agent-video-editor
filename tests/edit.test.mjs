import test from 'node:test';
import assert from 'node:assert/strict';
import { evalElement } from '../core/evaluate.js';

const meta = { width: 1920, height: 1080, beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5] };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('beat punch works without a motion preset', () => {
  const el = { id: 'e', type: 'text', start: 0, duration: 4, punch: 1, motion: { type: 'none', amount: 0 }, keyframes: [] };
  assert.ok(evalElement(el, 1.0, meta).scale > 1.04, 'on the beat');
  close(evalElement(el, 0.2, meta).scale, 1, 'before the first beat');
});

test('motion.span pins the preset to an absolute range', () => {
  const el = { id: 'e', type: 'image', start: 2, duration: 2, motion: { type: 'in', amount: 0.2, span: [0, 4] }, keyframes: [] };
  const whole = { ...el, start: 0, duration: 4, motion: { type: 'in', amount: 0.2 } };
  for (const t of [2, 2.5, 3.9]) close(evalElement(el, t, meta).scale, evalElement(whole, t, meta).scale, `scale @${t}`);
});
