import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { objectPose } from '../core/scene.js';

const project = () => normalizeProject({
  schema: 'vdm.project/1', rev: 1,
  meta: { title: 'obj', fps: 24, width: 1920, height: 1080, duration: 10, background: '#000' },
  segments: [], elements: [],
});

const add = (p, object) => {
  applyOp(p, { op: 'objectAdd', object });
  return p.scene.objects[p.scene.objects.length - 1];
};

test('objectAdd: fills defaults, metres geometry, duration up to the project end', () => {
  const p = project();
  const o = add(p, { type: 'solid', name: '招牌', pivot: [1, 2, 3], start: 2, geom: { w: 8, h: 4, d: 0.4 } });
  assert.match(o.id, /^ob_/);
  assert.equal(o.name, '招牌');
  assert.deepEqual(o.pivot, [1, 2, 3]);
  assert.equal(o.start, 2);
  assert.equal(o.duration, 8);
  assert.deepEqual(o.geom, { w: 8, h: 4, d: 0.4 });
  assert.deepEqual(o.scale, [1, 1, 1]);
  assert.equal(o.opacity, 1);
  assert.equal(p.scene.version, 3);
});

test('objectAdd: explicit duration and explicit id are respected, duplicates fail', () => {
  const p = project();
  const a = add(p, { id: 'ob_sign', duration: 3 });
  assert.equal(a.id, 'ob_sign');
  assert.equal(a.duration, 3);
  assert.throws(() => add(p, { id: 'ob_sign' }), /already exists/);
  // default duration is clamped by the remaining time
  const late = add(p, { start: 9.5 });
  assert.equal(late.duration, 0.5);
});

test('objectPatch: updates base props but cannot replace id or tracks', () => {
  const p = project();
  const o = add(p, { type: 'solid', pivot: [0, 0, 0] });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot', t: 0, v: [1, 1, 1] });
  applyOp(p, { op: 'objectPatch', id: o.id, patch: { name: 'A', pivot: [5, 6, 7], id: 'nope', tracks: {} } });
  assert.equal(o.name, 'A');
  assert.deepEqual(o.pivot, [5, 6, 7]);
  assert.equal(o.id, 'ob_1');
  assert.equal(o.tracks.pivot.length, 1);
});

test('objectKey: vec3 / scalar / dir tracks, replace at the same time, sorted', () => {
  const p = project();
  const o = add(p, { type: 'solid' });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot', t: 2, v: [3, 4, 5] });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot', t: 0, v: [0, 0, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot', t: 2, v: [6, 7, 8] });
  assert.equal(o.tracks.pivot.length, 2);
  assert.deepEqual(o.tracks.pivot.map((k) => k.t), [0, 2]);
  assert.deepEqual(o.tracks.pivot[1].v, [6, 7, 8]);

  applyOp(p, { op: 'objectKey', id: o.id, path: 'opacity', t: 1, v: 0.25 });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'scale.z', t: 1, v: 2 });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'dir', t: 1, v: [0, 2, 0] });
  assert.equal(o.tracks.opacity[0].v, 0.25);
  assert.equal(o.tracks['scale.z'][0].v, 2);
  assert.deepEqual(o.tracks.dir[0].v, [0, 1, 0]);

  const pose = objectPose(o, 1);
  assert.ok(Math.abs(pose.opacity - 0.25) < 1e-9);
  assert.ok(Math.abs(pose.scale[2] - 2) < 1e-9);
  assert.ok(Math.abs(pose.dir[1] - 1) < 1e-9);
});

test('objectKey: accepts .x sub-tracks and rejects unknown paths', () => {
  const p = project();
  const o = add(p, { type: 'solid' });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot.x', t: 1, v: 4 });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot.y', t: 1, v: 5 });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot.z', t: 1, v: 6 });
  assert.deepEqual(objectPose(o, 1).pivot, [4, 5, 6]);
  assert.throws(() => applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot.w', t: 1, v: 1 }), /unknown track path/);
  assert.throws(() => applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot', t: 1, v: [1, 2] }), /needs \[x,y,z\]/);
});

test('objectUnkey: drops one key, then the whole track, missing ids fail', () => {
  const p = project();
  const o = add(p, { type: 'solid' });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot', t: 1, v: [1, 1, 1] });
  applyOp(p, { op: 'objectKey', id: o.id, path: 'pivot', t: 2, v: [2, 2, 2] });
  applyOp(p, { op: 'objectUnkey', id: o.id, path: 'pivot', t: 1 });
  assert.deepEqual(o.tracks.pivot.map((k) => k.t), [2]);
  applyOp(p, { op: 'objectUnkey', id: o.id, path: 'pivot', t: 2 });
  assert.equal(o.tracks.pivot, undefined);
  assert.throws(() => applyOp(p, { op: 'objectUnkey', id: 'nope', path: 'pivot', t: 1 }), /no object/);
});

test('objectRemove: deletes and clears the scene entry', () => {
  const p = project();
  const a = add(p, {});
  const b = add(p, {});
  applyOp(p, { op: 'objectRemove', id: a.id });
  assert.deepEqual(p.scene.objects.map((o) => o.id), [b.id]);
  assert.throws(() => applyOp(p, { op: 'objectRemove', id: a.id }), /no object/);
});
