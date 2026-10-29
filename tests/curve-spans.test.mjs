import test from 'node:test';
import assert from 'node:assert/strict';
import {
  innerKeys, spanProgress, firstArrival, retimeSpanTimes, invertCurve, sameCurveShape,
} from '../core/curve-spans.js';
import { presetCurve, sampleCurve } from '../core/curves.js';
import { normalizeCamera, pathArcTable, retimePathSpan } from '../core/camera.js';

const close = (a, b, eps, msg = '') => assert.ok(
  Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`,
);

test('curve-spans: firstArrival is the identity for a linear curve', () => {
  const linear = presetCurve('linear');
  for (const y of [0, 0.1, 0.37, 0.5, 0.92, 1]) {
    close(firstArrival(linear, y), y, 2e-3, `y=${y}`);
  }
  assert.equal(firstArrival(null, 0.4), null, 'no curve = nothing to retime against');
  assert.equal(firstArrival(linear, 0), 0);
  assert.equal(firstArrival(linear, 1), 1);
});

test('curve-spans: firstArrival is monotonic in the target', () => {
  const curve = presetCurve('easeInOut');
  let prev = -1;
  for (let i = 1; i < 20; i++) {
    const u = firstArrival(curve, i / 20);
    assert.ok(u > prev, `u=${u} must exceed ${prev}`);
    prev = u;
  }
});

test('curve-spans: innerKeys only takes the strictly between keys, sorted', () => {
  const keys = [{ t: 2 }, { t: 0 }, { t: 1.5 }, { t: 3 }, { t: 0.99999 }];
  assert.deepEqual(innerKeys(keys, 0, 3).map((k) => k.t), [0.99999, 1.5, 2]);
  assert.deepEqual(innerKeys(keys, 3, 0), [], 'reversed span is empty');
  assert.deepEqual(innerKeys(keys, 1, 1), [], 'zero-width span is empty');
});

test('curve-spans: spanProgress refuses zero-range and non-numeric values', () => {
  assert.equal(spanProgress(0, 2, 0.5), 0.25);
  assert.equal(spanProgress(2, 0, 0.5), 0.75, 'descending spans read backwards');
  assert.equal(spanProgress(1, 1, 1), null, 'no value range = no progress');
  assert.equal(spanProgress(0, 1, '#ff0000'), null, 'colours have no progress');
  assert.equal(spanProgress(0, 1, null), null);
});

test('curve-spans: a linear curve leaves a linear ramp where it is', () => {
  const res = retimeSpanTimes({
    from: 0, to: 4, curve: presetCurve('linear'),
    points: [{ t: 1, ys: [0.25] }, { t: 2, ys: [0.5] }, { t: 3, ys: [0.75] }],
  });
  assert.deepEqual(res.map((r) => r.newT), [1, 2, 3]);
  assert.deepEqual(res.map((r) => r.outOfRange), [false, false, false]);
});

test('curve-spans: easeInOut keeps the midpoint and pushes early values later', () => {
  const curve = presetCurve('easeInOut');
  const early = retimeSpanTimes({ from: 0, to: 2, curve, points: [{ t: 0.5, ys: [0.25] }] })[0];
  assert.ok(early.newT > 0.5, `slow start: 0.25 arrives after 0.5s, got ${early.newT}`);
  const mid = retimeSpanTimes({ from: 0, to: 2, curve, points: [{ t: 1, ys: [0.5] }] })[0];
  close(mid.newT, 1, 1e-3, 'symmetric curve keeps the middle');
});

test('curve-spans: an out-of-range value pins the time instead of moving it', () => {
  const res = retimeSpanTimes({
    from: 0, to: 2, curve: presetCurve('easeInOut'), points: [{ t: 0.7, ys: [1.6] }],
  })[0];
  assert.equal(res.outOfRange, true);
  assert.equal(res.newT, 0.7, 'time anchor: the key stays put');
  assert.equal(res.y, 1.6);
});

test('curve-spans: merged axis progress is the mean, and colliding keys stay apart', () => {
  const curve = presetCurve('linear');
  const merged = retimeSpanTimes({ from: 0, to: 2, curve, points: [{ t: 1, ys: [0.2, 0.4] }] })[0];
  const single = retimeSpanTimes({ from: 0, to: 2, curve, points: [{ t: 1, ys: [0.3] }] })[0];
  close(merged.y, 0.3, 1e-9, 'mean of 0.2 and 0.4');
  assert.equal(merged.newT, single.newT, 'all axes land on one time');
  // two inner keys with the same value would land on the same u
  const dup = retimeSpanTimes({
    from: 0, to: 2, curve, points: [{ t: 0.5, ys: [0.5] }, { t: 1.5, ys: [0.5] }],
  });
  assert.ok(dup[1].newT - dup[0].newT >= 0.001 - 1e-9, 'strictly increasing with a 1ms gap');
  assert.ok(dup[1].newT < 2, 'never lands on the anchor');
});

test('curve-spans: retimeSpanTimes mirrors retimePathSpan for the same fractions', () => {
  const cam = normalizeCamera({
    path: [
      { t: 0, pos: [0, 0, 0] },
      { t: 1, pos: [1, 0.4, 0] },
      { t: 2, pos: [1.6, 1.2, 0] },
      { t: 3, pos: [2, 2, 0] },
    ],
  });
  const table = pathArcTable(cam);
  const a0 = table.keyArc[0];
  const a1 = table.keyArc[2];
  const fractions = cam.path.slice(1, 2).map((k, j) => (table.keyArc[1 + j] - a0) / (a1 - a0));
  const curve = presetCurve('easeIn');
  const cameraTimes = retimePathSpan(cam, 0, 2, curve).times;
  const spanTimes = retimeSpanTimes({
    from: 0, to: 2, curve, points: cam.path.slice(1, 2).map((k, j) => ({ t: k.t, ys: [fractions[j]] })),
  }).map((r) => r.newT);
  assert.deepEqual(spanTimes, cameraTimes, 'camera flights and property tracks share the rule');
});

test('curve-spans: invertCurve mirrors a bezier and refuses dynamic presets', () => {
  const easeIn = presetCurve('easeIn');
  const mirrored = invertCurve(easeIn);
  assert.ok(sameCurveShape(mirrored, presetCurve('easeOut')), 'easeIn mirrors to easeOut');
  assert.ok(sameCurveShape(invertCurve(mirrored), easeIn), 'inverting twice is a no-op');
  assert.equal(invertCurve(presetCurve('linear')).preset, 'linear');
  assert.equal(invertCurve(presetCurve('bounce')), null, 'bounce has no mirror image');
  assert.equal(invertCurve(null), null);
  // the mirrored curve really is the time-reversed shape
  const u = 0.3;
  close(sampleCurve(mirrored, u), 1 - sampleCurve(easeIn, 1 - u), 2e-3, 'mirror identity');
});
