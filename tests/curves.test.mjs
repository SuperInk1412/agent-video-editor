import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleBezier, sampleCurve, normalizeCurve, presetCurve, curveLabel, BEZIER_SOLVE_STEPS,
} from '../core/curves.js';
import { sampleTrack } from '../core/time.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';

const fresh = () => normalizeProject(createProject({ title: 'curve', duration: 10 }));

test('curves: cubic bezier hits both endpoints exactly', () => {
  const p1 = [0.42, 0];
  const p2 = [0.58, 1];
  assert.equal(sampleBezier(p1, p2, 0), 0);
  assert.equal(sampleBezier(p1, p2, 1), 1);
  assert.equal(sampleCurve(null, 0.3), 0.3, 'no curve = linear');
  assert.equal(BEZIER_SOLVE_STEPS, 40, 'solver steps are part of the cross-language contract');
});

test('curves: linear preset is the identity', () => {
  const c = presetCurve('linear');
  for (const u of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    assert.ok(Math.abs(sampleCurve(c, u) - u) < 2e-3, `u=${u} -> ${sampleCurve(c, u)}`);
  }
});

test('curves: easeIn is slower than linear at the midpoint, easeOut faster', () => {
  assert.ok(sampleCurve(presetCurve('easeIn'), 0.5) < 0.5);
  assert.ok(sampleCurve(presetCurve('easeOut'), 0.5) > 0.5);
});

test('curves: control points may overshoot the 0..1 band', () => {
  const c = normalizeCurve({ type: 'bezier', p1: [0.2, 0.0], p2: [0.4, 1.6] });
  let max = 0;
  for (let i = 0; i <= 100; i++) max = Math.max(max, sampleCurve(c, i / 100));
  assert.ok(max > 1.08, `max ${max}`);
  assert.equal(sampleCurve(c, 1), 1);
});

test('curves: normalize rejects junk and clamps x into the segment', () => {
  assert.equal(normalizeCurve(null), null);
  assert.equal(normalizeCurve({ p1: ['x', 0], p2: [1, 1] }), null);
  const c = normalizeCurve({ p1: [-2, 0.33333], p2: [3, 1] });
  assert.equal(c.p1[0], 0);
  assert.equal(c.p2[0], 1);
  assert.equal(c.p1[1], 0.3333);
  assert.equal(c.type, 'bezier');
});

test('curves: labels come from the preset, custom otherwise', () => {
  assert.equal(curveLabel(presetCurve('easeInOut')), '缓入缓出');
  assert.equal(curveLabel(normalizeCurve({ p1: [0.2, 0.2], p2: [0.8, 0.8] })), '自定义贝塞尔');
  assert.equal(curveLabel(null), '线性（默认）');
});

test('curves: sampleTrack interpolates with the curve when one is stored', () => {
  const keys = [
    { t: 0, path: 'transform.opacity', value: 0, curve: presetCurve('easeIn') },
    { t: 2, path: 'transform.opacity', value: 1 },
  ];
  const mid = sampleTrack(keys, 'transform.opacity', 1, 0);
  assert.ok(mid < 0.5, `easeIn midpoint should lag, got ${mid}`);
  // the curve only owns the segment it is attached to
  assert.equal(sampleTrack(keys, 'transform.opacity', 2.5, 0), 1);
});

test('ops: keyCurve attaches and clears a curve on the left key', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 4 } });
  const id = element.id;
  applyOp(p, { op: 'keySet', id, path: 'transform.opacity', t: 0, value: 0 });
  applyOp(p, { op: 'keySet', id, path: 'transform.opacity', t: 2, value: 1 });
  applyOp(p, {
    op: 'keyCurve', host: 'element', id, path: 'transform.opacity', from: 0, to: 2,
    curve: { type: 'bezier', preset: 'easeIn', p1: [0.42, 0], p2: [1, 1] },
  });
  const key = p.elements[0].keyframes.find((k) => k.t === 0);
  assert.ok(key.curve, 'curve stored on the left key');
  assert.equal(key.curve.preset, 'easeIn');
  // clearing it goes back to the legacy ease
  applyOp(p, { op: 'keyCurve', host: 'element', id, path: 'transform.opacity', from: 0, to: 2, curve: null });
  assert.equal(p.elements[0].keyframes.find((k) => k.t === 0).curve, undefined);
  assert.throws(() => applyOp(p, {
    op: 'keyCurve', host: 'element', id, path: 'transform.opacity', from: 0, to: 9,
  }), /no keyframe at 9/);
});
