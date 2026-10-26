import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySelection, normalizeSelection, selectOne, addSelection, toggleSelection,
  hasRef, splitRef, cameraRef, objectRef, elementRef, propertyRef, keyframeRef,
  keyframeExists, keyframeDeleteOps,
} from '../core/selection.js';
import { applyOp } from '../core/ops.js';

test('selection refs are stable and split into host / path / time', () => {
  const host = cameraRef('cam_1');
  assert.equal(host, 'cam:cam_1');
  assert.equal(objectRef('ob_1'), 'ob:ob_1');
  assert.equal(elementRef('el_1'), 'el:el_1');
  const prop = propertyRef(host, 'fov');
  assert.equal(prop, 'cam:cam_1:fov');
  assert.equal(keyframeRef(host, 'fov', 2.5004), 'cam:cam_1:fov:2.5');
  assert.deepEqual(splitRef(host), { type: 'cam', id: 'cam_1', host, path: null, t: null });
  assert.deepEqual(splitRef(prop), { type: 'cam', id: 'cam_1', host, path: 'fov', t: null });
  assert.deepEqual(splitRef(keyframeRef(host, 'fov', 2.5)), {
    type: 'cam', id: 'cam_1', host, path: 'fov', t: 2.5,
  });
});

test('the selection pool is homogeneous and additive only within a kind', () => {
  let p = selectOne('element', cameraRef('cam_1'));
  assert.equal(p.kind, 'element');
  assert.deepEqual(p.ids, ['cam:cam_1']);
  p = addSelection(p, 'element', objectRef('ob_1'));
  assert.deepEqual(p.ids, ['cam:cam_1', 'ob:ob_1']);
  assert.equal(p.primary, 'ob:ob_1');
  // a different kind starts a fresh pool
  p = addSelection(p, 'property', 'cam:cam_1:fov');
  assert.equal(p.kind, 'property');
  assert.deepEqual(p.ids, ['cam:cam_1:fov']);
  assert.equal(hasRef(p, 'cam:cam_1:fov'), true);
  assert.equal(hasRef(p, 'cam:cam_1:roll'), false);
  p = addSelection(p, 'property', 'cam:cam_1:roll');
  assert.deepEqual(p.ids, ['cam:cam_1:fov', 'cam:cam_1:roll']);
  p = toggleSelection(p, 'property', 'cam:cam_1:roll');
  assert.deepEqual(p.ids, ['cam:cam_1:fov']);
  assert.equal(p.primary, 'cam:cam_1:fov');
});

test('normalizeSelection drops invalid kinds and primary refs', () => {
  assert.deepEqual(emptySelection(), { kind: null, ids: [], primary: null });
  const p = normalizeSelection({ kind: 'keyframe', ids: ['a', 'a', 'b'], primary: 'b' });
  assert.deepEqual(p, { kind: 'keyframe', ids: ['a', 'b'], primary: 'b' });
  const q = normalizeSelection({ kind: 'nope', ids: ['a'], primary: 'a' });
  assert.deepEqual(q, { kind: null, ids: [], primary: null });
  const r = normalizeSelection({ kind: 'property', ids: ['a'], primary: 'z' });
  assert.equal(r.primary, 'a');
});

// ------------------------------------------------------------- keyframe delete

const kfProject = () => ({
  cameras: [{
    id: 'cam_1',
    path: [{ t: 0, pos: [0, 10, 0] }, { t: 2, pos: [0, 10, -20] }],
    tracks: { fov: [{ t: 0, v: 50 }, { t: 2, v: 70 }] },
  }],
  scene: {
    objects: [{
      id: 'ob_1',
      tracks: {
        pivot: [{ t: 1, v: [0, 0, 0] }],
        'pivot.x': [{ t: 1, v: 3 }],
        'pivot.y': [{ t: 1, v: 4 }],
        'pivot.z': [{ t: 3, v: 1 }],
      },
    }],
  },
  elements: [{
    id: 'el_1',
    keyframes: [
      { t: 0.5, path: 'transform.scale', value: 1 },
      { t: 1.5, path: 'transform.scale', value: 2 },
    ],
  }],
});

test('keyframe refs resolve against the project and stale ones are dropped', () => {
  const p = kfProject();
  assert.equal(keyframeExists(p, keyframeRef(cameraRef('cam_1'), 'path', 2)), true);
  assert.equal(keyframeExists(p, keyframeRef(cameraRef('cam_1'), 'path', 1.7)), false);
  assert.equal(keyframeExists(p, keyframeRef(cameraRef('cam_1'), 'fov', 0)), true);
  assert.equal(keyframeExists(p, keyframeRef(cameraRef('cam_1'), 'fov', 1)), false);
  // one dot on the object's pivot row can cover several axis tracks
  assert.equal(keyframeExists(p, keyframeRef(objectRef('ob_1'), 'pivot', 1)), true);
  assert.equal(keyframeExists(p, keyframeRef(objectRef('ob_1'), 'pivot', 3)), true);
  assert.equal(keyframeExists(p, keyframeRef(objectRef('ob_1'), 'pivot', 2)), false);
  assert.equal(keyframeExists(p, keyframeRef(elementRef('el_1'), 'transform.scale', 1.5)), true);
  assert.equal(keyframeExists(p, keyframeRef(elementRef('el_1'), 'transform.scale', 1)), false);
  assert.equal(keyframeExists(p, 'nonsense'), false);
  assert.equal(keyframeExists(p, keyframeRef(cameraRef('cam_missing'), 'path', 0)), false);
});

test('keyframe refs delete exactly those keys through one batch', () => {
  const p = kfProject();
  const ops = keyframeDeleteOps([
    keyframeRef(cameraRef('cam_1'), 'path', 2),
    keyframeRef(cameraRef('cam_1'), 'fov', 0),
    keyframeRef(objectRef('ob_1'), 'pivot', 1),
    keyframeRef(elementRef('el_1'), 'transform.scale', 1.5),
    keyframeRef(cameraRef('cam_1'), 'path', 99), // stale: ignored
    keyframeRef(cameraRef('cam_1'), 'path', 2), // duplicate: collapsed
  ], p);
  assert.deepEqual(ops, [
    { op: 'cameraRemove', id: 'cam_1', t: 2 },
    { op: 'cameraParamUnkey', id: 'cam_1', path: 'fov', t: 0 },
    { op: 'objectUnkey', id: 'ob_1', path: 'pivot', t: 1 },
    { op: 'objectUnkey', id: 'ob_1', path: 'pivot.x', t: 1 },
    { op: 'objectUnkey', id: 'ob_1', path: 'pivot.y', t: 1 },
    { op: 'keyRemove', id: 'el_1', path: 'transform.scale', t: 1.5 },
  ]);
  applyOp(p, { op: 'batch', ops });
  assert.deepEqual(p.cameras[0].path.map((k) => k.t), [0]);
  assert.deepEqual(p.cameras[0].tracks.fov.map((k) => k.t), [2]);
  assert.equal(p.scene.objects[0].tracks.pivot, undefined);
  assert.equal(p.scene.objects[0].tracks['pivot.x'], undefined);
  assert.equal(p.scene.objects[0].tracks['pivot.y'], undefined);
  assert.deepEqual(p.scene.objects[0].tracks['pivot.z'].map((k) => k.t), [3]);
  assert.deepEqual(p.elements[0].keyframes.map((k) => k.t), [0.5]);
});
