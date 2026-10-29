import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, OP_KINDS } from '../core/ops.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { objectPose } from '../core/scene.js';
import { worldPose, HIERARCHY_OP_KINDS, MAX_DEPTH } from '../core/hierarchy.js';
import { objectWorldPose, objectLocalPoint, objectLocalVector } from '../core/spatial-parent.js';
import { migrateLegacyParents, PARENT_STRENGTH_OP_KINDS } from '../core/parent-strength.js';
import { bakeObjects } from '../engine/shot.js';

// The old 3D parent (obj.parent) is retired: its op names write spatial parents
// (obj.frameParent) with the same inherit switches and keyable strength.
// docs/DESIGN-CAMFEED-PARENTS.md §3.

const fresh = () => normalizeProject(createProject({ title: 'hier', duration: 10 }));
const add = (p, object) => applyOp(p, { op: 'objectAdd', object }).changed[0];
const obj = (p, id) => p.scene.objects.find((o) => o.id === id);
const pose = (p, id, t) => objectWorldPose(p, obj(p, id), t);

function near(a, b, eps = 1e-6, msg = '') {
  if (Array.isArray(a)) {
    assert.equal(a.length, b.length, msg);
    a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
    return;
  }
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
}
function samePose(a, b, eps = 1e-6) {
  near(a.worldPos, b.worldPos, eps, 'worldPos');
  near(a.basis.right, b.basis.right, eps, 'right');
  near(a.basis.up, b.basis.up, eps, 'up');
  near(a.basis.forward, b.basis.forward, eps, 'forward');
  near(a.scale, b.scale, eps, 'scale');
}

/** Empty at the origin that moves +10 x and turns 90° (−z → +x) between 0 and 2s. */
function rig() {
  const p = fresh();
  const parent = add(p, { id: 'ob_rig', type: 'empty', pivot: [0, 0, 0] });
  applyOp(p, { op: 'objectKey', id: parent, path: 'pivot', t: 0, v: [0, 0, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: parent, path: 'pivot', t: 2, v: [10, 0, 0] });
  applyOp(p, { op: 'objectKey', id: parent, path: 'dir', t: 0, v: [0, 0, -1], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: parent, path: 'dir', t: 2, v: [1, 0, 0] });
  const child = add(p, { id: 'ob_box', type: 'solid', pivot: [0, 0, -5] });
  return { p, parent, child };
}

test('hierarchy: old and strength op names are registered', () => {
  for (const k of [...HIERARCHY_OP_KINDS, ...PARENT_STRENGTH_OP_KINDS]) assert.ok(OP_KINDS.includes(k), k);
});

test('hierarchy: objectParent writes a spatial parent and never moves the child', () => {
  const { p, parent, child } = rig();
  for (const t of [0, 0.7, 2]) {
    const before = pose(p, child, t);
    const q = structuredClone(p);
    applyOp(q, { op: 'objectParent', id: child, parent, t });
    const c = obj(q, child);
    assert.equal(c.parent, undefined, 'no old parent record');
    assert.equal(c.frameParent.id, parent);
    assert.equal(c.frameParent.mode, 'world');
    // the bind is stored to 6 decimals; the turn is now rotation.y keys
    samePose(objectWorldPose(q, c, t), before, 1e-5);
    assert.deepEqual(c.pivot, [0, 0, -5], 'own values untouched');
  }
});

test('hierarchy: child follows position and rotation', () => {
  const { p, parent, child } = rig();
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0 });
  // At 2s the parent sits at x=10 facing +x, so the child (5 m ahead of it) is at (15, 0, 0) facing +x.
  const w = pose(p, child, 2);
  near(w.worldPos, [15, 0, 0], 1e-6, 'pos');
  near(w.basis.forward, [1, 0, 0], 1e-6, 'forward');
  assert.equal(w.frameParentId, parent);
});

test('hierarchy: world points and directions can be mapped back to the child', () => {
  const { p, parent, child } = rig();
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0 });
  const w = pose(p, child, 2);
  near(objectLocalPoint(p, obj(p, child), 2, w.pivot), [0, 0, -5], 1e-6, 'pivot');
  near(objectLocalPoint(p, obj(p, child), 2, [15, 2, 0]), [0, 2, -5], 1e-6, 'offset point');
  near(objectLocalVector(p, obj(p, child), 2, [1, 0, 0]), [0, 0, -1], 1e-6, 'forward');
});

test('hierarchy: inherit switches', () => {
  const { p, parent, child } = rig();
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0, inherit: { rot: false } });
  let w = pose(p, child, 2);
  near(w.worldPos, [10, 0, -5], 1e-6, 'position only');
  near(w.basis.forward, [0, 0, -1], 1e-6, 'keeps its facing');

  applyOp(p, { op: 'objectParent', id: child, parent, t: 0, inherit: { rot: true, pos: false } });
  w = pose(p, child, 2);
  near(w.worldPos, [5, 0, 0], 1e-6, 'rotates around the bind point, no travel');
  near(w.basis.forward, [1, 0, 0], 1e-6);
});

test('hierarchy: rotation strength and its keys', () => {
  const { p, parent, child } = rig();
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0, strength: { rot: 0.5 } });
  const half = Math.SQRT1_2;
  near(pose(p, child, 2).basis.forward, [half, 0, -half], 1e-6, 'half the 90° turn');

  applyOp(p, { op: 'spatialParentKey', id: child, channel: 'rot', t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectParentKey', id: child, channel: 'rot', t: 2, v: 1 });
  near(pose(p, child, 2).basis.forward, [1, 0, 0], 1e-6, 'keyed to full');
  applyOp(p, { op: 'spatialParentUnkey', id: child, channel: 'rot', t: 2 });
  applyOp(p, { op: 'objectParentUnkey', id: child, channel: 'rot', t: 0 });
  assert.equal(obj(p, child).frameParent.strengthKeys, undefined);
  assert.throws(() => applyOp(p, { op: 'spatialParentKey', id: child, channel: 'pos', t: 0, v: 1 }), /rot\|scale/);
});

test('hierarchy: scale strength', () => {
  const p = fresh();
  const parent = add(p, { id: 'ob_p', type: 'empty' });
  applyOp(p, { op: 'objectKey', id: parent, path: 'scale', t: 0, v: [1, 1, 1], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: parent, path: 'scale', t: 1, v: [3, 3, 3] });
  const child = add(p, { id: 'ob_c', type: 'solid', pivot: [2, 0, 0] });
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0, strength: { scale: 0.5 } });
  const w = pose(p, child, 1);
  near(w.scale, [2, 2, 2], 1e-6, 'k = 1 + (3-1)·0.5');
  near(w.worldPos, [4, 0, 0], 1e-6, 'offset scaled too');
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0, inherit: { scale: false }, strength: { scale: 1 } });
  near(pose(p, child, 0).scale, [1, 1, 1], 1e-6, 're-binding keeps the pose at t=0');
  near(pose(p, child, 1).scale, [1, 1, 1], 1e-6, 'scale no longer inherited');
  near(pose(p, child, 1).worldPos, [2, 0, 0], 1e-6, 'offset no longer scaled');
});

test('hierarchy: chains compose; unparent drops the record and keeps local values', () => {
  const { p, parent, child } = rig();
  const grand = add(p, { id: 'ob_g', type: 'empty' });
  applyOp(p, { op: 'objectKey', id: grand, path: 'pivot', t: 0, v: [0, 0, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: grand, path: 'pivot', t: 2, v: [0, 4, 0] });
  applyOp(p, { op: 'objectParent', id: parent, parent: grand, t: 0 });
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0 });
  near(pose(p, child, 2).worldPos, [15, 4, 0], 1e-6, 'grandparent lift + parent turn');

  applyOp(p, { op: 'objectUnparent', id: child, t: 1.3 });
  assert.equal(obj(p, child).frameParent, undefined);
  assert.deepEqual(obj(p, child).pivot, [0, 0, -5], 'local values stay (spatial parent rule)');
  samePose(pose(p, child, 1.3), objectPose(obj(p, child), 1.3));
});

test('hierarchy: loops and depth are rejected, dangling parents ignored', () => {
  const p = fresh();
  const a = add(p, { id: 'ob_a', type: 'empty' });
  const b = add(p, { id: 'ob_b', type: 'empty' });
  applyOp(p, { op: 'objectParent', id: b, parent: a });
  assert.throws(() => applyOp(p, { op: 'objectParent', id: a, parent: b }), /loop/);
  assert.throws(() => applyOp(p, { op: 'objectParent', id: a, parent: a }), /own|loop/);

  let prev = b;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const id = add(p, { id: `ob_d${i}`, type: 'empty' });
    try { applyOp(p, { op: 'objectParent', id, parent: prev }); } catch (e) {
      assert.match(e.message, /deeper/);
      prev = null;
      break;
    }
    prev = id;
  }
  assert.equal(prev, null, 'depth limit reached');

  // A parent removed by core objectRemove: the child falls back to its own values.
  const q = fresh();
  add(q, { id: 'ob_p', type: 'empty', pivot: [5, 0, 0] });
  add(q, { id: 'ob_c', type: 'solid', pivot: [1, 2, 3] });
  applyOp(q, { op: 'objectParent', id: 'ob_c', parent: 'ob_p' });
  applyOp(q, { op: 'objectRemove', id: 'ob_p' });
  near(pose(q, 'ob_c', 0).worldPos, objectPose(obj(q, 'ob_c'), 0).worldPos);
});

test('hierarchy: strength survives normalization and undo-style cloning', () => {
  const { p, parent, child } = rig();
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0, strength: { rot: 0.25 } });
  applyOp(p, { op: 'objectParentKey', id: child, channel: 'scale', t: 1, v: 0.5 });
  const q = normalizeProject(JSON.parse(JSON.stringify(p)));
  const c = obj(q, child);
  assert.equal(c.frameParent.id, parent);
  assert.equal(c.frameParent.strength.rot, 0.25);
  assert.equal(c.frameParent.strengthKeys.scale[0].v, 0.5);
  samePose(pose(q, child, 2), pose(p, child, 2));
  applyOp(q, { op: 'objectPatch', id: child, patch: { name: 'renamed' } });
  assert.equal(obj(q, child).frameParent.id, parent, 'objectPatch keeps the parent');
});

test('hierarchy: migrating old 3D parents keeps every pose', () => {
  // Old W1 data, written as the retired objectParent op stored it.
  const { p, parent, child } = rig();
  const grand = add(p, { id: 'ob_g', type: 'empty' });
  applyOp(p, { op: 'objectKey', id: grand, path: 'scale', t: 0, v: [1, 1, 1], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: grand, path: 'scale', t: 2, v: [2, 1.5, 1] });
  applyOp(p, { op: 'objectKey', id: grand, path: 'dir', t: 0, v: [0, 0, -1], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: grand, path: 'dir', t: 2, v: [0, 0.6, -0.8] });
  const frameAt = (id, t) => {
    const w = worldPose(p, obj(p, id), t);
    return { pos: w.worldPos, basis: [w.basis.right, w.basis.up, w.basis.forward], scale: w.scale };
  };
  obj(p, parent).parent = { id: grand, inherit: { pos: true, rot: true, scale: true }, strength: { rot: 1, scale: 0.6 }, bind: frameAt(grand, 0.4) };
  obj(p, child).parent = { id: parent, inherit: { pos: true, rot: true, scale: false }, strength: { rot: 0.7, scale: 1 }, bind: frameAt(parent, 0.3) };
  obj(p, child).tracks['parent.rot'] = [{ t: 0.5, v: 0.2, ease: 'linear' }, { t: 1.8, v: 0.9 }];
  const times = [0, 0.3, 0.9, 1.4, 2];
  const before = times.map((t) => worldPose(p, obj(p, child), t));
  const counts = migrateLegacyParents(p);
  assert.deepEqual(counts, { migrated: 2, flattened: 0 });
  assert.equal(obj(p, child).parent, undefined);
  assert.equal(obj(p, child).tracks['parent.rot'], undefined);
  assert.equal(obj(p, child).frameParent.strengthKeys.rot.length, 2);
  times.forEach((t, i) => samePose(pose(p, child, t), before[i], 1e-5));
});

test('hierarchy: the Blender bake uses world poses', () => {
  const { p, parent, child } = rig();
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0 });
  const baked = bakeObjects(p, { fps: 10, from: 0, to: 2 });
  assert.ok(!baked.some((b) => b.id === parent), 'empties are not rendered');
  const box = baked.find((b) => b.id === child);
  const last = box.frames.find((f) => f.f === 21);
  near(last.loc, [15, 0, 0], 1e-3);
  near(last.rot[2], [1, 0, 0], 1e-3);
});
