import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject } from '../core/schema.js';
import { applyOp, applyOps } from '../core/ops.js';
import { cameraLayers, cameraRange, evalCamera } from '../core/camera.js';

const base = (cams, duration = 10) => normalizeProject({
  schema: 'vdm.project/1', rev: 1,
  meta: { title: 'clips', fps: 24, width: 1920, height: 1080, duration, background: '#000' },
  segments: [], elements: [], world: {},
  cameras: cams,
  cameraOrder: cams.map((c) => c.id),
  activeCameraId: cams[0]?.id || null,
});

const cam = (id, extra = {}) => ({
  id,
  name: id,
  path: [
    { t: 0, pos: [0, 6, 20], look: [0, 6, 0] },
    { t: 2, pos: [2, 6, 18], look: [1, 6, 0] },
    { t: 4, pos: [6, 7, 16], look: [3, 6, 0] },
    { t: 6, pos: [10, 8, 14], look: [6, 6, 0] },
  ],
  ...extra,
});

const near = (a, b, msg = '') => assert.ok(Math.abs(Number(a) - Number(b)) < 1e-6, `${msg}: ${a} vs ${b}`);
const sameCamera = (a, b, msg = '') => {
  near(a.pos[0], b.pos[0], `${msg} x`);
  near(a.pos[1], b.pos[1], `${msg} y`);
  near(a.pos[2], b.pos[2], `${msg} z`);
  near(a.look[0], b.look[0], `${msg} look x`);
  near(a.look[1], b.look[1], `${msg} look y`);
  near(a.look[2], b.look[2], `${msg} look z`);
  near(a.fov, b.fov, `${msg} fov`);
  near(a.roll, b.roll, `${msg} roll`);
};

test('camera clips: split keeps implementation ids, names and times on both sides', () => {
  const a = cam('cam_a', {
    start: 1,
    duration: 5,
    name: '主机位',
    tracks: { fov: [{ t: 0, v: 50 }, { t: 2, v: 60 }, { t: 4, v: 70 }, { t: 6, v: 80 }] },
  });
  const p = base([a, cam('cam_b', { start: 0, duration: 1 })]);
  const original = structuredClone(p.cameras[0]);

  const res = applyOps(p, [{ op: 'splitElement', id: 'cam_a', at: 3.5 }]);
  assert.equal(res.changed.length, 2);
  const left = p.cameras.find((c) => c.id === 'cam_a');
  const right = p.cameras.find((c) => c.start === 3.5);
  assert.ok(right, 'right half exists');
  assert.equal(res.changed[0], left.id);
  assert.equal(res.changed[1], right.id);
  assert.equal(left.name, '主机位');
  assert.equal(right.name, '主机位 · 2');
  assert.equal(left.start, 1);
  assert.equal(left.duration, 2.5);
  assert.equal(right.start, 3.5);
  assert.equal(right.duration, 2.5);

  // right half inserted directly below its source in the stack and made active
  const i = p.cameras.findIndex((c) => c.id === 'cam_a');
  assert.equal(p.cameras[i + 1].id, right.id);
  assert.equal(p.cameraOrder[i + 1], right.id);
  assert.equal(p.activeCameraId, right.id);
  assert.equal(p.camera.id, right.id);

  // keys are clipped, not re-timed / inserted
  assert.deepEqual(left.path.map((k) => k.t), [0, 2, 4, 6]);
  assert.deepEqual(right.path.map((k) => k.t), [0, 2, 4, 6]);
  assert.deepEqual(left.tracks.fov.map((k) => k.t), [0, 2, 4, 6]);
  assert.deepEqual(right.tracks.fov.map((k) => k.t), [0, 2, 4, 6]);

  // evaluation inside either half is unchanged from the unsplit camera
  const before = { camera: original };
  for (const t of [1.1, 2, 3.2]) sameCamera(evalCamera({ camera: left }, t), evalCamera(before, t), `left @${t}`);
  for (const t of [3.6, 4, 5.4]) sameCamera(evalCamera({ camera: right }, t), evalCamera(before, t), `right @${t}`);
});

test('camera clips: a range-less camera splits over the whole project', () => {
  const p = base([cam('cam_a')], 8);
  assert.deepEqual(cameraRange(p, p.cameras[0]), { start: 0, end: 8, duration: 8, explicit: false });

  applyOps(p, [{ op: 'splitElement', id: 'cam_a', at: 3 }]);
  const left = p.cameras.find((c) => c.id === 'cam_a');
  const right = p.cameras.find((c) => c.id !== 'cam_a');
  assert.equal(left.start, 0);
  assert.equal(left.duration, 3);
  assert.equal(right.start, 3);
  assert.equal(right.duration, 5);
  assert.equal(p.meta.duration, 8, 'splitting does not change the furthest end');
  assert.throws(() => applyOps(p, [{ op: 'splitElement', id: 'cam_a', at: 6 }]), /split point outside camera/);
});

test('camera clips: moving a half carries path and parameter keys; trim keeps them', () => {
  const p = base([cam('cam_a', { shake: { amp: 0 } })], 8);
  applyOps(p, [{ op: 'splitElement', id: 'cam_a', at: 3 }]);
  const right = p.cameras.find((c) => c.id !== 'cam_a');
  const at = 4;
  const before = evalCamera({ camera: structuredClone(right) }, at);
  const pathTimes = right.path.map((k) => k.t);

  applyOps(p, [{ op: 'moveElement', id: right.id, start: 4.5, duration: 5 }]);
  assert.equal(right.start, 4.5);
  assert.equal(right.duration, 5);
  assert.deepEqual(right.path.map((k) => k.t), pathTimes.map((t) => t + 1.5));
  sameCamera(evalCamera({ camera: right }, at + 1.5), before, 'moved camera');

  const movedTimes = right.path.map((k) => k.t);
  applyOps(p, [{ op: 'moveElement', id: right.id, start: 5, duration: 4 }]);
  assert.equal(right.start, 5);
  assert.equal(right.duration, 4);
  assert.deepEqual(right.path.map((k) => k.t), movedTimes, 'trim does not shift keys');
});

test('camera clips: explicit durations participate in project duration, legacy clips do not', () => {
  const p = base([cam('cam_a', { start: 2, duration: 5 })]);
  applyOps(p, [{ op: 'addElement', element: { type: 'solid', start: 0, duration: 3 } }]);
  assert.equal(p.meta.duration, 7, 'camera end 7 wins over element end 3');

  applyOps(p, [{ op: 'moveElement', id: 'cam_a', start: 2, duration: 1 }]);
  assert.equal(p.meta.duration, 3, 'shrinks to the element end when the camera is shorter');

  applyOps(p, [{ op: 'cameraPatch', id: 'cam_a', patch: { start: 3, duration: 4 } }]);
  assert.equal(p.meta.duration, 7, 'cameraPatch start/duration retriggers duration sync');

  const q = base([cam('cam_b')], 12);
  applyOps(q, [{ op: 'addElement', element: { type: 'solid', start: 0, duration: 2 } }]);
  assert.equal(q.meta.duration, 2, 'a legacy camera without a range does not pin the project');
});

test('camera clips: cameraLayers filters by t; omitting t keeps the full stack', () => {
  const p = base([
    cam('cam_a', { start: 0, duration: 1 }),
    cam('cam_b', { start: 1, duration: 1 }),
    cam('cam_c', { start: 3, duration: 1 }),
  ], 4);

  assert.deepEqual(cameraLayers(p).map((c) => c.id), ['cam_a', 'cam_b', 'cam_c']);
  assert.deepEqual(cameraLayers(p, null, 0.5).map((c) => c.id), ['cam_a']);
  assert.deepEqual(cameraLayers(p, null, 1).map((c) => c.id), ['cam_b'], 'clip is half-open at its end');
  assert.deepEqual(cameraLayers(p, new Set(['cam_a', 'cam_c']), 3.5).map((c) => c.id), ['cam_c']);

  const legacy = base([cam('legacy'), cam('b', { start: 1, duration: 1 })], 3);
  assert.deepEqual(cameraLayers(legacy, null, 99).map((c) => c.id), ['legacy'], 'range-less camera covers all t');
});

test('camera clips: evalCamera follows the topmost clip covering t, with active and fallback', () => {
  const p = base([
    cam('cam_top', { start: 1, duration: 1, path: [{ t: 0, pos: [9, 9, 9], look: [9, 9, 0] }] }),
    cam('cam_active', { start: 0, duration: 1 }),
  ], 4);
  // active is cam_active (base uses cams[0]); put another clip above it
  assert.equal(p.activeCameraId, 'cam_top');
  p.activeCameraId = 'cam_active';
  p.camera = p.cameras.find((c) => c.id === 'cam_active');

  // the active camera wins while its clip covers t, even below another layer
  sameCamera(evalCamera(p, 0.5), evalCamera({ camera: p.cameras.find((c) => c.id === 'cam_active') }, 0.5), 'active');
  // outside its clip, the topmost covering camera becomes the current shot
  sameCamera(evalCamera(p, 1.5), evalCamera({ camera: p.cameras.find((c) => c.id === 'cam_top') }, 1.5), 'top covering');
  // nothing covers t: fall back to active
  sameCamera(evalCamera(p, 3), evalCamera({ camera: p.cameras.find((c) => c.id === 'cam_active') }, 3), 'fallback');
});
