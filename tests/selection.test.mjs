import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySelection, normalizeSelection, selectOne, addSelection, toggleSelection, pickSelection,
  hasRef, splitRef, cameraRef, objectRef, elementRef, propertyRef, keyframeRef,
  keyframeExists, keyframeDeleteOps, legacyFields,
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

// ------------------------------------------------------------ pointer picks
// The timeline's Ctrl+click used to be swallowed by a guard, so the first
// keyframe pick from an empty / element pool never entered the pool.

test('additive keyframe picks go empty -> one -> two -> one -> empty', () => {
  const a = keyframeRef(elementRef('el_1'), 'transform.y', 0);
  const b = keyframeRef(elementRef('el_1'), 'transform.z', 0.2);
  let p = pickSelection(emptySelection(), 'keyframe', a, true);
  assert.deepEqual(p, { kind: 'keyframe', ids: [a], primary: a });
  p = pickSelection(p, 'keyframe', b, true);
  assert.deepEqual(p.ids, [a, b]);
  assert.equal(p.primary, b);
  // Ctrl+click the primary (last picked) removes it.
  p = pickSelection(p, 'keyframe', p.primary, true);
  assert.deepEqual(p.ids, [a]);
  assert.equal(p.primary, a);
  p = pickSelection(p, 'keyframe', a, true);
  assert.deepEqual(p, emptySelection());
});

test('an additive pick of another kind starts a fresh pool; plain picks replace', () => {
  const pool = selectOne('element', elementRef('el_1'));
  const ref = keyframeRef(elementRef('el_1'), 'transform.y', 0);
  const p = pickSelection(pool, 'keyframe', ref, true);
  assert.deepEqual(p, { kind: 'keyframe', ids: [ref], primary: ref });
  const q = pickSelection(pool, 'keyframe', ref, false);
  assert.deepEqual(q, { kind: 'keyframe', ids: [ref], primary: ref });
  assert.deepEqual(pickSelection(p, 'element', elementRef('el_2'), false), {
    kind: 'element', ids: [elementRef('el_2')], primary: elementRef('el_2'),
  });
});

// ------------------------------------------------- cam / ob / el mixed pools
// One element pool holds cameras, 3D objects and 2D elements at once; only the
// primary decides which legacy single-selection field is set.

test('one element pool mixes cameras, 3D objects and 2D elements', () => {
  let p = pickSelection(emptySelection(), 'element', cameraRef('cam_1'), false);
  p = pickSelection(p, 'element', objectRef('ob_1'), true);
  p = pickSelection(p, 'element', elementRef('el_1'), true);
  assert.deepEqual(p, {
    kind: 'element',
    ids: ['cam:cam_1', 'ob:ob_1', 'el:el_1'],
    primary: 'el:el_1',
  });
  // Ctrl+click the primary again: it leaves the pool and the previous ref wins.
  p = pickSelection(p, 'element', elementRef('el_1'), true);
  assert.deepEqual(p.ids, ['cam:cam_1', 'ob:ob_1']);
  assert.equal(p.primary, 'ob:ob_1');
  // ... down to one, then out.
  p = toggleSelection(p, 'element', objectRef('ob_1'));
  assert.deepEqual(p, { kind: 'element', ids: ['cam:cam_1'], primary: 'cam:cam_1' });
  p = toggleSelection(p, 'element', cameraRef('cam_1'));
  assert.deepEqual(p, emptySelection());
});

test('legacy selection fields follow the pool primary', () => {
  const pool = { kind: 'element', ids: ['cam:cam_1', 'ob:ob_1', 'el:el_1'], primary: 'el:el_1' };
  assert.deepEqual(legacyFields(pool), { elementId: 'el_1', objectId: null, camera: false });
  assert.deepEqual(legacyFields({ ...pool, primary: 'ob:ob_1' }), {
    elementId: null, objectId: 'ob_1', camera: false,
  });
  assert.deepEqual(legacyFields({ ...pool, primary: 'cam:cam_1' }), {
    elementId: null, objectId: null, camera: true,
  });
  // A property / keyframe ref anchors to the same host row.
  assert.deepEqual(legacyFields(selectOne('property', propertyRef(cameraRef('cam_1'), 'fov'))), {
    elementId: null, objectId: null, camera: true,
  });
  assert.deepEqual(legacyFields(selectOne('keyframe', keyframeRef(objectRef('ob_1'), 'pivot', 2))), {
    elementId: null, objectId: 'ob_1', camera: false,
  });
  assert.deepEqual(legacyFields(emptySelection()), { elementId: null, objectId: null, camera: false });
  assert.deepEqual(legacyFields({ kind: 'element', ids: ['bogus'], primary: 'bogus' }), {
    elementId: null, objectId: null, camera: false,
  });
});

test('explicit selection fields win and are never cleared by the pool primary', () => {
  const pool = { kind: 'element', ids: ['cam:cam_1', 'ob:ob_1'], primary: 'cam:cam_1' };
  // An explicit object id survives a camera primary instead of being wiped.
  assert.deepEqual(legacyFields(pool, { objectId: 'ob_9' }), {
    elementId: null, objectId: 'ob_9', camera: false,
  });
  // Two explicit host fields both stay; the pool does not pick a winner.
  assert.deepEqual(legacyFields(pool, { elementId: 'el_9', objectId: 'ob_9' }), {
    elementId: 'el_9', objectId: 'ob_9', camera: false,
  });
  // Explicit `camera: false` is not a host: the primary still fills the hole.
  assert.deepEqual(legacyFields(pool, { camera: false }), {
    elementId: null, objectId: null, camera: true,
  });
  // Explicit camera true is authoritative.
  assert.deepEqual(legacyFields(pool, { camera: true }), {
    elementId: null, objectId: null, camera: true,
  });
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
