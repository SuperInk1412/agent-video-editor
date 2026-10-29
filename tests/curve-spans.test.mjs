import test from 'node:test';
import assert from 'node:assert/strict';
import {
  innerKeys, spanProgress, firstArrival, retimeSpanTimes, invertCurve, sameCurveShape,
  spanCurveOps, curveFromEase,
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

test('curve-spans: spanCurveOps writes one curve per sub-segment and moves the inner key', () => {
  const keys = [
    { t: 0, path: 'transform.opacity', value: 0 },
    { t: 1, path: 'transform.opacity', value: 0.25 },
    { t: 2, path: 'transform.opacity', value: 1 },
  ];
  const res = spanCurveOps({
    host: 'element', id: 'el_1', trackPath: null, path: 'transform.opacity', keys,
    from: 0, to: 2, curve: presetCurve('linear'),
  });
  assert.ok(res, 'linear span is editable');
  // linear: 0.25 is reached at 0.5s, so the key moves from 1s to 0.5s
  const move = res.ops.find((o) => o.op === 'keySet');
  assert.equal(move.t, 0.5);
  assert.equal(move.value, 0.25);
  assert.ok(res.ops.some((o) => o.op === 'keyRemove' && o.t === 1));
  const [a, b] = res.ops.filter((o) => o.op === 'keyCurve');
  assert.deepEqual([a.from, a.to], [0, 0.5]);
  assert.deepEqual([b.from, b.to], [0.5, 2]);
  assert.equal(res.moved, 1);
});

test('curve-spans: spanCurveOps can write curves without retiming (Alt)', () => {
  const keys = [
    { t: 0, path: 'transform.opacity', value: 0 },
    { t: 1, path: 'transform.opacity', value: 0.25 },
    { t: 2, path: 'transform.opacity', value: 1 },
  ];
  const res = spanCurveOps({
    host: 'element', id: 'el_1', path: 'transform.opacity', keys,
    from: 0, to: 2, curve: presetCurve('easeIn'), retime: false,
  });
  assert.equal(res.moved, 0);
  assert.equal(res.ops.filter((o) => o.op === 'keySet').length, 0);
  assert.deepEqual(res.ops.map((o) => [o.from, o.to]), [[0, 1], [1, 2]]);
});

test('curve-spans: an out-of-range inner value stays put and lands on the curve', () => {
  const keys = [
    { t: 0, path: 'transform.opacity', value: 0 },
    { t: 0.5, path: 'transform.opacity', value: 1.4 },
    { t: 2, path: 'transform.opacity', value: 1 },
  ];
  const res = spanCurveOps({
    host: 'element', id: 'el_1', path: 'transform.opacity', keys,
    from: 0, to: 2, curve: presetCurve('linear'),
  });
  assert.equal(res.pinned, 1);
  const set = res.ops.find((o) => o.op === 'keySet');
  assert.equal(set.t, 0.5, 'time is the anchor when the value is out of range');
  close(set.value, 0.25, 1e-6, 'value snaps onto the curve at its own time');
});

test('curve-spans: object spans carry their handles and refuse colour tracks', () => {
  const keys = [
    { t: 0, path: 'pivot.x', v: 0, ease: 'linear', out: [1, 0, 0], in: [-1, 0, 0] },
    { t: 1, path: 'pivot.x', v: 4, ease: 'linear', out: [0, 0, 1], in: [0, 0, -1] },
    { t: 2, path: 'pivot.x', v: 8, ease: 'linear' },
  ];
  const res = spanCurveOps({
    host: 'object', id: 'ob_1', path: 'pivot.x', keys,
    from: 0, to: 2, curve: presetCurve('easeIn'),
  });
  const set = res.ops.find((o) => o.op === 'objectKey');
  assert.equal(set.v, 4);
  assert.ok(set.t > 1, 'easeIn reaches the middle later than linear');
  assert.deepEqual(set.out, [0, 0, 1], 'bezier handles survive the move');
  assert.deepEqual(set.in, [0, 0, -1]);
  assert.ok(res.ops.some((o) => o.op === 'objectUnkey' && o.t === 1));
  // colours have no progress: nothing is editable
  const colour = spanCurveOps({
    host: 'element', id: 'el_1', path: 'style.color',
    keys: [{ t: 0, path: 'style.color', value: '#000000' }, { t: 2, path: 'style.color', value: '#ffffff' }],
    from: 0, to: 2, curve: presetCurve('linear'),
  });
  assert.equal(colour, null, 'colour spans are skipped, never written');
});

test('curve-spans: axes sharing a timestamp land on one time', () => {
  const axes = ['rotation.x', 'rotation.y'].map((path) => ({
    path,
    keys: [
      { t: 0, path, value: 0 },
      { t: 1, path, value: 0.2 },
      { t: 2, path, value: 1 },
    ],
  }));
  const res = spanCurveOps({
    host: 'element', id: 'el_1', tracks: axes, from: 0, to: 2, curve: presetCurve('linear'),
  });
  const times = [...new Set(res.times.map((r) => r.newT))];
  assert.deepEqual(times, [0.4], '0.2 and 0.2 merge to one arrival');
  const sets = res.ops.filter((o) => o.op === 'keySet');
  assert.deepEqual(sets.map((o) => o.t), [0.4, 0.4]);
});

test('curve-spans: curveFromEase fits the real ease instead of faking one', () => {
  const linear = curveFromEase('linear');
  for (const u of [0.2, 0.5, 0.8]) close(sampleCurve(linear, u), u, 2e-3, `linear u=${u}`);
  const easeIn = curveFromEase('easeIn');
  for (const u of [0.3, 0.6]) close(sampleCurve(easeIn, u), u * u, 2e-3, `easeIn u=${u}`);
  // piecewise / exponential eases are approximations, not identities
  const inout = curveFromEase('easeInOut');
  close(sampleCurve(inout, 0.5), 0.5, 1e-3, 'symmetric midpoint');
  assert.ok(Math.abs(sampleCurve(inout, 0.25) - 0.125) < 0.03, 'close but not exact');
  const expo = curveFromEase('outExpo');
  assert.ok(Math.abs(sampleCurve(expo, 0.5) - 0.96875) < 0.1, 'exponential ease is approximated');
  assert.equal(curveFromEase('nope').type, 'bezier', 'unknown ease falls back to easeInOut');
});

test('curve-spans: spanCurveOps on a camera param carries ease and curve', () => {
  const keys = [
    { t: 0, path: 'fov', v: 40, ease: 'linear' },
    { t: 1, path: 'fov', v: 50, ease: 'smooth', curve: presetCurve('bounce') },
    { t: 2, path: 'fov', v: 60, ease: 'linear' },
  ];
  const res = spanCurveOps({
    host: 'camera', id: 'cam_1', path: 'fov', keys,
    from: 0, to: 2, curve: presetCurve('easeOut'),
  });
  const set = res.ops.find((o) => o.op === 'cameraParamKey');
  assert.equal(set.ease, 'smooth', 'the inner key keeps its own ease');
  assert.equal(set.curve.preset, 'bounce', 'and the curve that starts on it');
  assert.ok(res.ops.some((o) => o.op === 'cameraParamUnkey' && o.t === 1));
  // a camera flight path is not editable here (arc-length retiming lives in core/camera.js)
  assert.equal(spanCurveOps({
    host: 'camera', id: 'cam_1', path: 'path', keys, from: 0, to: 2, curve: presetCurve('linear'),
  }), null);
});
