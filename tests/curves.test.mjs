import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  sampleBezier, sampleCurve, normalizeCurve, presetCurve, curveLabel, BEZIER_SOLVE_STEPS,
  samplePreset, curveParamsText, curveHandles, moveCurveHandle, curveRange,
} from '../core/curves.js';
import { sampleTrack } from '../core/time.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';

const AM = JSON.parse(fs.readFileSync(new URL('./fixtures/am-curve-samples.json', import.meta.url), 'utf8'));
const close = (a, b, eps = 1e-9, msg = '') => assert.ok(
  Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`,
);

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

test('ops: keyCurve on an element stays on its path when two paths share a time', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 4 } });
  const id = element.id;
  // transform.y is keyed first and owns the key at t=0; a path-agnostic lookup
  // (the old code) would hand transform.z's curve to transform.y.
  for (const path of ['transform.y', 'transform.z']) {
    applyOp(p, { op: 'keySet', id, path, t: 0, value: 0 });
    applyOp(p, { op: 'keySet', id, path, t: 2, value: 1 });
  }
  applyOp(p, {
    op: 'keyCurve', host: 'element', id, path: 'transform.z', from: 0, to: 2,
    curve: { type: 'bezier', preset: 'easeIn', p1: [0.42, 0], p2: [1, 1] },
  });
  // the old transform.y / z paths land on the node's pivot.y / z (core/rotation-ops.js)
  const node = { 'transform.y': 'pivot.y', 'transform.z': 'pivot.z' };
  const at = (path) => p.elements[0].keyframes.find((k) => k.path === node[path] && k.t === 0);
  assert.ok(at('transform.z').curve, 'transform.z gets the curve');
  assert.equal(at('transform.z').curve.preset, 'easeIn');
  assert.equal(at('transform.y').curve, undefined, 'transform.y keeps its own key');
  // a path that has no key at `from` must not borrow another path's key
  assert.throws(() => applyOp(p, {
    op: 'keyCurve', host: 'element', id, path: 'transform.x', from: 0, to: 2, curve: null,
  }), /no keyframe at 0/);
  // clearing goes back through the same path
  applyOp(p, { op: 'keyCurve', host: 'element', id, path: 'transform.z', from: 0, to: 2, curve: null });
  assert.equal(at('transform.z').curve, undefined);
  assert.equal(at('transform.y').curve, undefined);
});

test('curves: preset formulas match the reference 257-point samples', () => {
  for (const group of AM.groups) {
    const curve = presetCurve(group.preset);
    assert.ok(curve, `preset ${group.preset} exists`);
    assert.deepEqual(curve.params, group.params, `${group.id} uses the reference defaults`);
    for (const [u, expected] of group.samples.slice(0, -1)) {
      const got = sampleCurve(curve, u);
      assert.ok(
        Math.abs(got - expected) <= AM.tolerance,
        `${group.id} u=${u}: expected ${expected}, got ${got}`,
      );
    }
    // The reference elasticStep stops at 0.8 on its last sample; this app pins
    // every segment end to the target value so the final frame never jumps.
    assert.equal(sampleCurve(curve, 1), 1, `${group.id} endpoint`);
  }
});

test('curves: every preset starts at 0 and ends at 1', () => {
  for (const id of ['bounce', 'elastic', 'cyclic', 'step', 'elasticStep']) {
    const curve = presetCurve(id);
    assert.equal(sampleCurve(curve, -1), 0, `${id} below range`);
    assert.equal(sampleCurve(curve, 0), 0, `${id} start`);
    assert.equal(sampleCurve(curve, 1), 1, `${id} end`);
    assert.equal(sampleCurve(curve, 2), 1, `${id} above range`);
  }
});

test('curves: preset params are clamped, defaulted and rounded', () => {
  const c = normalizeCurve({
    type: 'bounce',
    params: { firstStepLength: -3, bounciness: 2, extra: 9 },
  });
  assert.equal(c.firstStepLength, undefined, 'flat fields are not copied');
  assert.deepEqual(c.params, { firstStepLength: 0.01, bounciness: 1 });
  const d = normalizeCurve({ type: 'cyclic', params: { stepLength: 0.123456789 } });
  assert.equal(d.params.stepLength, 0.123457, 'six param decimals');
  assert.equal(d.params.sharpness, 0, 'missing params fall back to the schema');
  assert.equal(normalizeCurve({ type: 'nope', params: {} }), null);
  assert.equal(samplePreset('nope', {}, 0.3), 0.3, 'unknown kind is linear');
});

test('curves: labels and parameter readouts', () => {
  assert.equal(curveLabel(presetCurve('bounce')), '弹跳');
  assert.equal(curveLabel(presetCurve('elasticStep')), '弹动步数');
  assert.equal(curveParamsText(presetCurve('bounce')), '步长 0.30 · 回弹 0.80');
  assert.equal(curveParamsText(presetCurve('elastic')), '步长 0.25 · 衰减 0.50 · 幅度 1.00');
  assert.equal(curveParamsText(presetCurve('easeInOut')), '');
  const edited = moveCurveHandle(presetCurve('bounce'), 'main', 0.4, 0.2);
  assert.equal(edited.preset, undefined);
  assert.equal(curveLabel(edited), '自定义弹跳');
});

test('curves: handles follow the reference positions, including elastic overshoot', () => {
  const bounce = curveHandles(presetCurve('bounce'));
  assert.equal(bounce.length, 1);
  assert.equal(bounce[0].id, 'main');
  close(bounce[0].u, 0.27);
  close(bounce[0].v, 0.2);

  const elastic = curveHandles(presetCurve('elastic'));
  const magnitude = elastic.find((h) => h.id === 'magnitude');
  assert.equal(magnitude.allowOvershoot, true);
  close(magnitude.v, 2, 1e-9, 'magnitude handle sits above 1');
  assert.ok(curveRange(presetCurve('elastic'))[1] >= 2.05);

  assert.equal(curveHandles(presetCurve('step')).length, 2);
  assert.equal(curveHandles(presetCurve('cyclic')).length, 4);
  assert.equal(curveHandles(presetCurve('elasticStep')).length, 2);
  assert.equal(curveHandles(null).length, 0);
});

test('curves: handle drags write the mapped parameter on the mapped axis', () => {
  const bounce = moveCurveHandle(presetCurve('bounce'), 'main', 0.27, 0.2);
  assert.deepEqual(bounce.params, { firstStepLength: 0.3, bounciness: 0.8 });

  const elastic = moveCurveHandle(presetCurve('elastic'), 'main', 0.5, 0.4);
  assert.equal(elastic.params.stepLength, 0.25, 'x / (attack + 1)');
  assert.equal(elastic.params.decay, 0.4);
  const mag = moveCurveHandle(presetCurve('elastic'), 'magnitude', 0, 1.6);
  assert.equal(mag.params.magnitude, 0.6);

  const cyclic = presetCurve('cyclic');
  assert.equal(moveCurveHandle(cyclic, 'step', 0.4, 0.9).params.stepLength, 0.4, 'y ignored');
  assert.equal(moveCurveHandle(cyclic, 'decay', 0.2, 0.8).params.decay, 0.8, 'x ignored');
  assert.equal(moveCurveHandle(cyclic, 'sharpness', 0.142857, 0.9).params.sharpness, 0.5);
  assert.equal(moveCurveHandle(cyclic, 'skew', 0.142857, 0).params.skew, 0.5);

  const step = presetCurve('step');
  assert.equal(moveCurveHandle(step, 'main', 0.5, 0).params.stepLength, 0.5);
  assert.equal(moveCurveHandle(step, 'smooth', 0.375, 0).params.smoothing, 0.5);

  const eStep = presetCurve('elasticStep');
  assert.equal(moveCurveHandle(eStep, 'main', 0.4, 0).params.stepLength, 0.4);
  assert.equal(moveCurveHandle(eStep, 'magnitude', 1, 0.9).params.magnitude, 0.9);

  const bez = moveCurveHandle(presetCurve('easeInOut'), 'p2', 0.7, 1.3);
  assert.deepEqual(bez.p2, [0.7, 1.3]);
  assert.equal(bez.preset, undefined);
});

test('curves: keyCurve stores preset params and sampleTrack uses them', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 4 } });
  const id = element.id;
  applyOp(p, { op: 'keySet', id, path: 'transform.opacity', t: 0, value: 0 });
  applyOp(p, { op: 'keySet', id, path: 'transform.opacity', t: 2, value: 1 });
  applyOp(p, {
    op: 'keyCurve', host: 'element', id, path: 'transform.opacity', from: 0, to: 2,
    curve: presetCurve('bounce'),
  });
  const key = p.elements[0].keyframes.find((k) => k.t === 0);
  assert.equal(key.curve.type, 'bounce');
  assert.equal(key.curve.preset, 'bounce', 'preset id survives ops/normalisation');
  assert.deepEqual(key.curve.params, { firstStepLength: 0.3, bounciness: 0.8 });
  const mid = sampleTrack(p.elements[0].keyframes, 'transform.opacity', 1, 0);
  close(mid, sampleCurve(presetCurve('bounce'), 0.5), 1e-9, 'sampleTrack follows the preset');
});

test('ops: a key move (remove + set) can carry the curve along', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 4 } });
  const id = element.id;
  const path = 'transform.opacity';
  applyOp(p, { op: 'keySet', id, path, t: 0, value: 0 });
  applyOp(p, { op: 'keySet', id, path, t: 2, value: 1 });
  applyOp(p, { op: 'keyCurve', host: 'element', id, path, from: 0, to: 2, curve: presetCurve('easeIn') });
  const at = (t) => p.elements[0].keyframes.find((k) => k.path === path && k.t === t);
  const curve = at(0).curve;
  // The move the panel emits: one batch, remove + set with the curve attached.
  applyOp(p, { op: 'batch', ops: [
    { op: 'keyRemove', id, path, t: 0 },
    { op: 'keySet', id, path, t: 1, value: 0, curve },
  ] });
  assert.equal(at(0), undefined);
  assert.equal(at(1).curve?.preset, 'easeIn', 'explicit curve survives the move');
  // A set without a curve at a fresh time invents none…
  applyOp(p, { op: 'keySet', id, path, t: 1.5, value: 0 });
  assert.equal(at(1.5).curve, undefined);
  // …and an explicit null clears the one that is there.
  applyOp(p, { op: 'keySet', id, path, t: 1, value: 0, curve: null });
  assert.equal(at(1).curve, undefined);
});

test('ops: objectKey keeps the curve of the key it re-sets', () => {
  const p = fresh();
  applyOp(p, { op: 'objectAdd', kind: 'cube' });
  const id = p.scene.objects[0].id;
  const path = 'pivot.x';
  applyOp(p, { op: 'objectKey', id, path, t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id, path, t: 2, v: 10 });
  applyOp(p, { op: 'keyCurve', host: 'object', id, path, from: 0, to: 2, curve: presetCurve('easeOut') });
  // objectKey replaces the track array, so always read it fresh.
  const track = () => p.scene.objects[0].tracks[path];
  assert.equal(track()[0].curve?.preset, 'easeOut');
  // Re-setting the value at the same time (a value edit) must not eat the curve.
  applyOp(p, { op: 'objectKey', id, path, t: 0, v: 4 });
  assert.equal(track()[0].v, 4);
  assert.equal(track()[0].curve?.preset, 'easeOut', 'curve survives a value edit');
  // A move (unkey + key) carries it when the op passes it explicitly.
  applyOp(p, { op: 'objectUnkey', id, path, t: 0 });
  applyOp(p, { op: 'objectKey', id, path, t: 1, v: 4, curve: presetCurve('easeOut') });
  assert.equal(track().find((k) => k.t === 1).curve?.preset, 'easeOut');
  assert.equal(track().find((k) => k.t === 0), undefined);
});

test('ops: cameraParamKey keeps and accepts curves too', () => {
  const p = fresh();
  const id = applyOp(p, { op: 'addCamera' }).camera.id;
  applyOp(p, { op: 'cameraParamKey', id, path: 'fov', t: 0, v: 40, ease: 'linear' });
  applyOp(p, { op: 'cameraParamKey', id, path: 'fov', t: 2, v: 80 });
  applyOp(p, { op: 'keyCurve', host: 'camera', id, path: 'fov', from: 0, to: 2, curve: presetCurve('easeInOut') });
  const track = () => p.cameras[0].tracks.fov;
  assert.equal(track()[0].curve?.preset, 'easeInOut');
  applyOp(p, { op: 'cameraParamKey', id, path: 'fov', t: 0, v: 50 });
  assert.equal(track()[0].v, 50);
  assert.equal(track()[0].curve?.preset, 'easeInOut', 'curve survives a value edit');
  applyOp(p, { op: 'cameraParamUnkey', id, path: 'fov', t: 0 });
  applyOp(p, { op: 'cameraParamKey', id, path: 'fov', t: 1, v: 50, curve: presetCurve('easeInOut') });
  assert.equal(track().find((k) => k.t === 1).curve?.preset, 'easeInOut');
  applyOp(p, { op: 'cameraParamKey', id, path: 'fov', t: 1, v: 50, curve: null });
  assert.equal(track().find((k) => k.t === 1).curve, undefined, 'explicit null clears');
});
