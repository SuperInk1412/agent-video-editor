import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { cameraLayers } from '../core/camera.js';

const base = (extra = {}) => normalizeProject({
  schema: 'vdm.project/1', rev: 1,
  meta: { title: 'stack', fps: 24, width: 1920, height: 1080, duration: 6, background: '#000' },
  segments: [], elements: [],
  world: {},
  ...extra,
});

test('camera stack: a legacy single camera migrates to cameras[]', () => {
  const p = base({
    camera: { fov: 70, path: [{ t: 0, pos: [0, 10, 0] }, { t: 2, pos: [0, 10, -20] }] },
  });
  assert.equal(p.cameras.length, 1);
  assert.equal(p.cameras[0].id, 'cam_1');
  assert.equal(p.cameras[0].name, '相机 1');
  assert.deepEqual(p.cameraOrder, ['cam_1']);
  assert.equal(p.activeCameraId, 'cam_1');
  assert.equal(p.camera, p.cameras[0]);
  assert.equal(p.camera.fov, 70);
  assert.deepEqual(p.camera.center, [0, 0, 0]);
  assert.deepEqual(p.camera.scale, [1, 1, 1]);
  assert.deepEqual(p.camera.picturePivot, [0.5, 0.5]);
  assert.deepEqual(p.camera.pictureOffset, [0, 0]);
  assert.equal(p.camera.opacity, 1);
  assert.equal(p.camera.visible, true);
});

test('camera stack: order is top→bottom and active aliases the camera', () => {
  const p = base({
    cameras: [
      { id: 'cam_a', name: 'A', fov: 50, path: [] },
      { id: 'cam_b', name: 'B', fov: 80, path: [] },
    ],
    cameraOrder: ['cam_b', 'cam_a'],
    activeCameraId: 'cam_b',
  });
  assert.deepEqual(p.cameras.map((c) => c.id), ['cam_b', 'cam_a']);
  assert.deepEqual(p.cameraOrder, ['cam_b', 'cam_a']);
  assert.equal(p.activeCameraId, 'cam_b');
  assert.equal(p.camera.id, 'cam_b');
  assert.equal(p.camera.fov, 80);
});

test('camera stack: missing order/active fall back and duplicates get stable ids', () => {
  const p = base({
    cameras: [
      { name: 'first', path: [] },
      { name: 'second', path: [] },
    ],
  });
  assert.deepEqual(p.cameras.map((c) => c.id), ['cam_1', 'cam_2']);
  assert.deepEqual(p.cameraOrder, ['cam_1', 'cam_2']);
  assert.equal(p.activeCameraId, 'cam_1');
  assert.equal(p.camera, p.cameras[0]);

  const q = base({
    cameras: [
      { id: 'dup', name: 'one', path: [] },
      { id: 'dup', name: 'two', path: [] },
    ],
    cameraOrder: ['dup', 'missing'],
    activeCameraId: 'missing',
  });
  assert.equal(q.cameras.length, 2);
  assert.notEqual(q.cameras[0].id, q.cameras[1].id);
  assert.deepEqual(q.cameraOrder, q.cameras.map((c) => c.id));
  assert.equal(q.activeCameraId, q.cameraOrder[0]);
  assert.equal(q.camera, q.cameras[0]);
});

test('camera stack: transform defaults survive a roundtrip', () => {
  const p = base({
    cameras: [{
      id: 'cam_x', name: 'X', path: [],
      center: [1, 2, 3], scale: [2, 1, 4], opacity: 0.5,
      picturePivot: [0.25, 0.75], pictureOffset: [0.1, -0.2], visible: false,
    }],
  });
  const c = p.camera;
  assert.deepEqual(c.center, [1, 2, 3]);
  assert.deepEqual(c.scale, [2, 1, 4]);
  assert.equal(c.opacity, 0.5);
  assert.deepEqual(c.picturePivot, [0.25, 0.75]);
  assert.deepEqual(c.pictureOffset, [0.1, -0.2]);
  assert.equal(c.visible, false);
  assert.deepEqual(p.camera, p.cameras[0]);
});

test('camera stack: createProject has the fields; validate accepts the normalized stack', () => {
  const p = createProject({ title: 'fresh' });
  assert.deepEqual(p.cameras, []);
  assert.deepEqual(p.cameraOrder, []);
  assert.equal(p.activeCameraId, null);
  assert.equal(p.camera, null);
  assert.deepEqual(validateProject(p), []);
  const q = base({ camera: { fov: 60, path: [] } });
  assert.deepEqual(validateProject(q), []);
});

test('camera stack: active camera ops update the stack entry', () => {
  const p = base({
    cameras: [
      { id: 'cam_a', fov: 50, path: [] },
      { id: 'cam_b', fov: 80, path: [] },
    ],
    cameraOrder: ['cam_a', 'cam_b'],
    activeCameraId: 'cam_b',
  });
  applyOp(p, { op: 'cameraSet', patch: { fov: 100 } });
  assert.equal(p.camera.fov, 100);
  assert.equal(p.cameras.find((c) => c.id === 'cam_b').fov, 100);
  assert.equal(p.cameras.find((c) => c.id === 'cam_a').fov, 50);
});

test('camera stack ops: addCamera is top, active, and gets stack defaults', () => {
  const p = base({
    cameras: [{ id: 'cam_a', name: 'A', fov: 50, path: [] }],
    cameraOrder: ['cam_a'],
    activeCameraId: 'cam_a',
  });
  const r = applyOp(p, {
    op: 'addCamera',
    camera: { name: '新机位', fov: 70, path: [{ t: 0, pos: [0, 10, 0], look: [0, 10, -10] }] },
  });
  assert.equal(p.cameras.length, 2);
  assert.equal(p.cameras[0].id, r.camera.id);
  assert.equal(p.cameraOrder[0], r.camera.id);
  assert.equal(p.activeCameraId, r.camera.id);
  assert.equal(p.camera, r.camera);
  assert.equal(p.camera.name, '新机位');
  assert.deepEqual(p.camera.center, [0, 0, 0]);
  assert.deepEqual(p.camera.picturePivot, [0.5, 0.5]);
  assert.equal(p.camera.opacity, 1);
  assert.equal(p.camera.visible, true);
  assert.equal(p.camera.path.length, 1);
});

test('camera stack ops: removeCamera falls back to the next camera, then null', () => {
  const p = base({
    cameras: [
      { id: 'cam_a', name: 'A', path: [] },
      { id: 'cam_b', name: 'B', path: [] },
    ],
    cameraOrder: ['cam_a', 'cam_b'],
    activeCameraId: 'cam_a',
  });
  applyOp(p, { op: 'removeCamera', id: 'cam_a' });
  assert.deepEqual(p.cameras.map((c) => c.id), ['cam_b']);
  assert.equal(p.activeCameraId, 'cam_b');
  assert.equal(p.camera.id, 'cam_b');
  applyOp(p, { op: 'removeCamera', id: 'cam_b' });
  assert.deepEqual(p.cameras, []);
  assert.deepEqual(p.cameraOrder, []);
  assert.equal(p.activeCameraId, null);
  assert.equal(p.camera, null);
});

test('camera stack ops: reorderCamera and activateCamera', () => {
  const p = base({
    cameras: [
      { id: 'cam_a', path: [] },
      { id: 'cam_b', path: [] },
      { id: 'cam_c', path: [] },
    ],
    cameraOrder: ['cam_a', 'cam_b', 'cam_c'],
    activeCameraId: 'cam_a',
  });
  applyOp(p, { op: 'reorderCamera', id: 'cam_c', index: 0 });
  assert.deepEqual(p.cameraOrder, ['cam_c', 'cam_a', 'cam_b']);
  assert.deepEqual(p.cameras.map((c) => c.id), ['cam_c', 'cam_a', 'cam_b']);
  applyOp(p, { op: 'activateCamera', id: 'cam_b' });
  assert.equal(p.activeCameraId, 'cam_b');
  assert.equal(p.camera.id, 'cam_b');
  assert.throws(() => applyOp(p, { op: 'activateCamera', id: 'nope' }), /no camera/);
});

test('camera stack: layer order is top->bottom and solo is viewport-only', () => {
  const p = base({
    cameras: [
      { id: 'cam_a', visible: true, path: [{ t: 0, pos: [0, 1, 0] }] },
      { id: 'cam_b', visible: true, path: [{ t: 0, pos: [0, 2, 0] }] },
      { id: 'cam_c', visible: false, path: [{ t: 0, pos: [0, 3, 0] }] },
      { id: 'cam_d', visible: true, path: [] },
    ],
    cameraOrder: ['cam_a', 'cam_b', 'cam_c', 'cam_d'],
    activeCameraId: 'cam_a',
  });
  assert.deepEqual(cameraLayers(p).map((c) => c.id), ['cam_a', 'cam_b']);
  assert.deepEqual(cameraLayers(p, new Set(['cam_b'])).map((c) => c.id), ['cam_b']);
  // The data is unchanged: a final render still uses every visible camera.
  assert.equal(p.cameras.length, 4);
  assert.equal(p.cameras.find((c) => c.id === 'cam_c').visible, false);
});

test('camera stack ops: cameraPatch targets one camera by id', () => {
  const p = base({
    cameras: [
      { id: 'cam_a', visible: true, path: [] },
      { id: 'cam_b', visible: true, path: [] },
    ],
    cameraOrder: ['cam_a', 'cam_b'],
    activeCameraId: 'cam_a',
  });
  applyOp(p, { op: 'cameraPatch', id: 'cam_b', patch: { visible: false, name: 'B' } });
  assert.equal(p.cameras.find((c) => c.id === 'cam_b').visible, false);
  assert.equal(p.cameras.find((c) => c.id === 'cam_b').name, 'B');
  assert.equal(p.cameras.find((c) => c.id === 'cam_a').visible, true);
  assert.equal(p.camera.id, 'cam_a');
});

test('camera stack ops: cameraKey targets the active camera only', () => {
  const p = base({
    cameras: [
      { id: 'cam_a', path: [] },
      { id: 'cam_b', path: [] },
    ],
    cameraOrder: ['cam_a', 'cam_b'],
    activeCameraId: 'cam_b',
  });
  applyOp(p, { op: 'cameraKey', t: 1, pos: [1, 2, 3] });
  assert.equal(p.cameras.find((c) => c.id === 'cam_a').path.length, 0);
  assert.equal(p.cameras.find((c) => c.id === 'cam_b').path.length, 1);
  assert.deepEqual(p.camera.path[0].pos, [1, 2, 3]);
});

