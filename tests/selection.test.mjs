import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptySelection, normalizeSelection, selectOne, addSelection, toggleSelection,
  hasRef, splitRef, cameraRef, objectRef, elementRef, propertyRef, keyframeRef,
} from '../core/selection.js';

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
