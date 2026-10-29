// Spatial parents for 2D elements (PLAN-ui-round3 §3.1, core/spatial-parent.js).
//
// A 2D element can be a child of another element, a 3D object or a camera; the
// parent's motion since the bind carries it, so a parent roll orbits the child
// around the parent's pivot instead of only spinning the child in place.
// Binding at t is a no-op, unparenting only deletes `el.parent`, and `@live` /
// the legacy camera lock stay the render-time screen carrier.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { applyOp, OP_KINDS } from '../core/ops.js';
import { ensureSpace, screenCenterY } from '../core/space.js';
import { elementCarrier } from '../core/hierarchy.js';
import { frameOf } from '../core/spatial.js';
import { elementWorldParent, evalCameraWorld, objectWorldPose, SPATIAL_PARENT_OP_KINDS } from '../core/spatial-parent.js';
import { evalCamera } from '../core/camera.js';
import { elementNodeAt, elementWorldNode } from '../app/renderer/js/node-at.js';
import { PUBLIC_OPS, EDIT_SCHEMA } from '../core/contracts.js';
import { validateContract } from '../application/validate-contract.js';
import { projectService } from '../engine/projects.js';

const near = (a, b, eps = 1e-6, msg = '') => {
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${msg}: expected arrays (${a} / ${b})`);
    assert.equal(a.length, b.length, `${msg}: length`);
    a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
    return;
  }
  assert.ok(Number.isFinite(a), `${msg}: ${a} is not finite`);
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const cy = screenCenterY({ width: 1920, height: 1080 });

/** A project with the default camera (world + camera) and no elements. */
function fresh() {
  const p = normalizeProject(createProject({ title: 'spatial-parent', duration: 4 }));
  ensureSpace(p);
  return p;
}

const elOf = (p, id) => p.elements.find((e) => e.id === id);
const worldAt = (p, el, t) => elementWorldNode(p, el, t);
const frameAt = (p, el, t) => frameOf(worldAt(p, el, t));

function addEl(p, over = {}) {
  return applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 4, ...over } }).element;
}

/** A migrated-style 2D element: authoritative `node`, no legacy transform. */
const nodeEl = (pivot = [0, 0, 0], over = {}) => ({
  node: { pivot, position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1], ...over },
});

const keyRoll = (p, id, from, to, t = 2) => {
  applyOp(p, { op: 'keySet', id, path: 'roll', t: 0, value: from, ease: 'linear' });
  applyOp(p, { op: 'keySet', id, path: 'roll', t, value: to });
};

// ---------------------------------------------------------------- contract

test('spatial-parent: the two ops are registered and part of the public contract', () => {
  assert.deepEqual(SPATIAL_PARENT_OP_KINDS, ['spatialParent', 'spatialUnparent']);
  for (const kind of SPATIAL_PARENT_OP_KINDS) {
    assert.ok(OP_KINDS.includes(kind), `${kind} is an op kind`);
    assert.ok(PUBLIC_OPS.includes(kind), `${kind} is public`);
  }
  validateContract({
    ops: [
      { op: 'spatialParent', id: 'el_1', parent: 'el_2', t: 0, inherit: { pos: true, rot: false, scale: true } },
      { op: 'spatialUnparent', id: 'el_1' },
    ],
  }, { ...EDIT_SCHEMA, required: ['ops'] });
  assert.throws(() => validateContract({
    ops: [{ op: 'spatialParent', id: 'el_1', parent: 'el_2', extra: 1 }],
  }, { ...EDIT_SCHEMA, required: ['ops'] }), /supported variant|unknown field/);
  assert.throws(() => validateContract({
    ops: [{ op: 'spatialParent', id: 'el_1', t: 0 }],
  }, { ...EDIT_SCHEMA, required: ['ops'] }), /supported variant|required/i);
});

// ---------------------------------------------------------------- 2D parent

test('spatial-parent: a 2D parent roll orbits the child around the parent pivot, binding does not jump', () => {
  const p = fresh();
  const parent = addEl(p, nodeEl([0, cy, 0]));
  keyRoll(p, parent.id, 0, 90);
  const child = addEl(p, nodeEl([2, cy, 0]));
  const localNode = JSON.parse(JSON.stringify(elOf(p, child.id).node));

  const before = frameAt(p, child, 0);
  const result = applyOp(p, { op: 'spatialParent', id: child.id, parent: parent.id, t: 0 });
  assert.deepEqual(result.changed, [child.id]);

  const el = elOf(p, child.id);
  assert.equal(el.parent.id, parent.id);
  assert.equal(el.parent.mode, 'world');
  assert.deepEqual(el.parent.inherit, { pos: true, rot: true, scale: true });
  assert.deepEqual(el.node, localNode, 'binding only writes the parent record');
  // The bind is the parent frame at the playhead (the core sampler and the
  // renderer's elementNodeAt agree).
  near(el.parent.bind.pivot, frameAt(p, parent, 0).pos, 1e-6, 'bind pivot');

  // No jump at t: the child is exactly where it was before binding.
  near(frameAt(p, el, 0).pos, before.pos, 1e-6, 'no jump position');
  near(frameAt(p, el, 0).basis, before.basis, 1e-6, 'no jump basis');

  // Parent rolls +90°: a +2 m x offset orbits to -2 m world y (radius kept),
  // and the child's plane turns with it (roll 90, not just its own spin at the
  // old centre).
  const at1 = frameAt(p, el, 1);
  near(dist(at1.pos, [0, cy, 0]), 2, 1e-6, 'orbit radius at t=1');
  near(worldAt(p, el, 1).roll, 45, 1e-5, 'half the parent roll at t=1');
  const at2 = frameAt(p, el, 2);
  near(at2.pos, [0, cy - 2, 0], 1e-6, 'orbited to the parent -y');
  near(worldAt(p, el, 2).roll, 90, 1e-6, 'plane turned with the parent');
  near(dist(at2.pos, [0, cy, 0]), 2, 1e-6, 'orbit radius at t=2');
  assert.ok(dist(at2.pos, [2, cy, 0]) > 1, 'the child really moved off its bind position');
});

test('spatial-parent: a 2D parent translation carries the child', () => {
  const p = fresh();
  const parent = addEl(p, nodeEl([0, cy, 0]));
  applyOp(p, { op: 'keySet', id: parent.id, path: 'pivot.x', t: 0, value: 0, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: parent.id, path: 'pivot.x', t: 2, value: 3 });
  const child = addEl(p, nodeEl([2, cy, 0]));
  applyOp(p, { op: 'spatialParent', id: child.id, parent: parent.id, t: 0 });
  const el = elOf(p, child.id);
  near(frameAt(p, el, 0).pos, [2, cy, 0], 1e-6);
  near(frameAt(p, el, 2).pos, [5, cy, 0], 1e-6);
});

test('spatial-parent: inherit switches isolate position, rotation and scale', () => {
  const p = fresh();
  const parent = addEl(p, nodeEl([0, cy, 0]));
  applyOp(p, { op: 'keySet', id: parent.id, path: 'pivot.x', t: 0, value: 0, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: parent.id, path: 'pivot.x', t: 2, value: 3 });
  keyRoll(p, parent.id, 0, 90);

  const noRot = addEl(p, nodeEl([2, cy, 0]));
  applyOp(p, { op: 'spatialParent', id: noRot.id, parent: parent.id, t: 0, inherit: { rot: false } });
  const nr = elOf(p, noRot.id);
  near(frameAt(p, nr, 2).pos, [5, cy, 0], 1e-6, 'rot off: travels, does not orbit');
  near(worldAt(p, nr, 2).roll, 0, 1e-6, 'rot off: own roll kept');

  const noPos = addEl(p, nodeEl([2, cy, 0]));
  applyOp(p, { op: 'spatialParent', id: noPos.id, parent: parent.id, t: 0, inherit: { pos: false } });
  const np = elOf(p, noPos.id);
  near(frameAt(p, np, 2).pos, [0, cy - 2, 0], 1e-6, 'pos off: rotates about the bind pivot only');
  near(worldAt(p, np, 2).roll, 90, 1e-6, 'pos off: rotation still applies');

  const scaled = addEl(p, nodeEl([0, cy, 0]));
  applyOp(p, { op: 'keySet', id: scaled.id, path: 'scale.x', t: 0, value: 1, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: scaled.id, path: 'scale.x', t: 2, value: 3 });
  applyOp(p, { op: 'keySet', id: scaled.id, path: 'scale.y', t: 0, value: 1, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: scaled.id, path: 'scale.y', t: 2, value: 3 });
  const scaleChild = addEl(p, nodeEl([2, cy, 0]));
  applyOp(p, { op: 'spatialParent', id: scaleChild.id, parent: scaled.id, t: 0 });
  const sc = elOf(p, scaleChild.id);
  near(frameAt(p, sc, 2).pos, [6, cy, 0], 1e-6, 'parent scale stretches the offset');
  near(frameAt(p, sc, 2).scale, [3, 3, 1], 1e-6, 'parent scale stretches the child');

  const scaleOff = addEl(p, nodeEl([2, cy, 0]));
  applyOp(p, { op: 'spatialParent', id: scaleOff.id, parent: scaled.id, t: 0, inherit: { scale: false } });
  const so = elOf(p, scaleOff.id);
  near(frameAt(p, so, 2).pos, [2, cy, 0], 1e-6);
  near(frameAt(p, so, 2).scale, [1, 1, 1], 1e-6);

  // A partial inherit patch keeps the previously stored switches.
  applyOp(p, { op: 'spatialParent', id: so.id, parent: scaled.id, t: 0, inherit: { rot: false } });
  const prev = elOf(p, so.id).parent.inherit;
  assert.deepEqual(prev, { pos: true, rot: false, scale: false }, 'inherit merges with the stored record');
});

// ---------------------------------------------------------------- 3D parent

test('spatial-parent: a 3D object parent rotates and translates the 2D child', () => {
  const p = fresh();
  const ob = applyOp(p, { op: 'objectAdd', object: { type: 'empty', start: 0, duration: 4, pivot: [0, cy, 0], rot: { dir: [0, 0, -1], roll: 0 }, scale: [1, 1, 1] } }).changed[0];
  applyOp(p, { op: 'objectKey', id: ob, path: 'pivot', t: 0, v: [0, cy, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: ob, path: 'pivot', t: 2, v: [3, cy, 0] });
  applyOp(p, { op: 'objectKey', id: ob, path: 'dir', t: 0, v: [0, 0, -1], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: ob, path: 'dir', t: 2, v: [1, 0, 0] });

  const child = addEl(p, nodeEl([0, cy, -2]));
  const before = frameAt(p, child, 0);
  applyOp(p, { op: 'spatialParent', id: child.id, parent: ob, t: 0 });
  const el = elOf(p, child.id);
  assert.equal(el.parent.id, ob);
  near(frameAt(p, el, 0).pos, before.pos, 1e-6, 'no jump');
  assert.ok(frameAt(p, el, 1).pos[0] > 1.5, 'half-way orbit moves with the parent');
  near(frameAt(p, el, 2).pos, [5, cy, 0], 1e-6, 'object rotation + travel carry the child');
});

// ---------------------------------------------------------------- object child

test('spatial-parent: a 3D object child is carried by an element parent (frameParent)', () => {
  const p = fresh();
  const parent = addEl(p, nodeEl([0, cy, 0]));
  keyRoll(p, parent.id, 0, 90);
  const ob = applyOp(p, {
    op: 'objectAdd',
    object: { type: 'empty', start: 0, duration: 4, pivot: [2, cy, 0], rot: { dir: [0, 0, -1], roll: 0 }, scale: [1, 1, 1] },
  }).changed[0];
  const obj = p.scene.objects.find((o) => o.id === ob);
  const before = objectWorldPose(p, obj, 0);

  applyOp(p, { op: 'spatialParent', id: ob, parent: parent.id, t: 0 });
  assert.equal(obj.frameParent.id, parent.id);
  assert.equal(obj.frameParent.mode, 'world');
  assert.equal('parent' in obj, false, 'the old 3D parent graph is untouched');
  near(objectWorldPose(p, obj, 0).worldPos, before.worldPos, 1e-6, 'binding does not jump');
  near(objectWorldPose(p, obj, 0).basis.forward, before.basis.forward, 1e-6);

  // Parent rolls +90°: the object pivots around the parent centre, its own
  // basis turns with it (no old 3D hierarchy involved).
  const at2 = objectWorldPose(p, obj, 2);
  near(at2.worldPos, [0, cy - 2, 0], 1e-6, 'object orbits the parent pivot');
  near(at2.basis.right, [0, -1, 0], 1e-6, 'object basis turns with the parent');

  applyOp(p, { op: 'spatialUnparent', id: ob });
  assert.equal('frameParent' in obj, false);
  near(objectWorldPose(p, obj, 2).worldPos, [2, cy, 0], 1e-6, 'back to the local 3D pose');
});

test('spatial-parent: an object child follows a camera parent and stays byte-equal without a parent', () => {
  const p = fresh();
  const cam = p.cameras[0];
  const ob = applyOp(p, {
    op: 'objectAdd',
    object: { type: 'empty', start: 0, duration: 4, pivot: [2, cy, 10], rot: { dir: [0, 0, -1], roll: 0 }, scale: [1, 1, 1] },
  }).changed[0];
  const obj = p.scene.objects.find((o) => o.id === ob);
  const free = objectWorldPose(p, obj, 0);
  applyOp(p, { op: 'spatialParent', id: ob, parent: cam.id, t: 0 });
  near(objectWorldPose(p, obj, 0).worldPos, free.worldPos, 1e-6, 'no jump');

  // Pan the camera +3 m: the object travels with it at the same depth.
  applyOp(p, {
    op: 'cameraPath', id: cam.id, path: [
      { t: 0, pos: [0, cy, 20], look: [0, cy, 0] },
      { t: 2, pos: [3, cy, 20], look: [3, cy, 0] },
    ],
  });
  near(objectWorldPose(p, obj, 2).worldPos, [5, cy, 10], 1e-6, 'camera pan carries the object');

  // A project without frameParent still returns the shipped worldPose verbatim.
  const plain = fresh();
  const free2 = objectWorldPose(plain, { type: 'empty', pivot: [1, cy, 2], rot: { dir: [0, 0, -1], roll: 0 } }, 1);
  near(free2.worldPos, [1, cy, 2], 1e-12);
});

// ---------------------------------------------------------------- camera child

test('spatial-parent: a camera child follows its parent through evalCameraWorld', () => {
  const p = fresh();
  const cam = p.cameras[0];
  const base = evalCameraWorld(p, 0, cam);
  const ob = applyOp(p, {
    op: 'objectAdd',
    object: { type: 'empty', start: 0, duration: 4, pivot: [0, cy, 0], rot: { dir: [0, 0, -1], roll: 0 }, scale: [1, 1, 1] },
  }).changed[0];
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: ob, t: 0 });
  assert.equal(cam.frameParent.id, ob);
  near(evalCameraWorld(p, 0, cam).pos, base.pos, 1e-6, 'binding does not jump');
  near(evalCameraWorld(p, 0, cam).look, base.look, 1e-6);

  applyOp(p, { op: 'objectKey', id: ob, path: 'pivot', t: 0, v: [0, cy, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: ob, path: 'pivot', t: 2, v: [3, cy, 0] });
  const moved = evalCameraWorld(p, 2, cam);
  near(moved.pos, [base.pos[0] + 3, base.pos[1], base.pos[2]], 1e-6, 'object motion carries the camera');
  near(moved.fov, base.fov, 1e-9, 'lens stays local');
  assert.equal(evalCameraWorld(p, 2).pos[0], moved.pos[0], 'the live-camera path picks the parented camera');

  // Without a frameParent evalCameraWorld is evalCamera (byte-equal).
  const plain = fresh();
  assert.deepEqual(evalCameraWorld(plain, 1, plain.cameras[0]), evalCamera(plain, 1));

  applyOp(p, { op: 'spatialUnparent', id: cam.id });
  assert.equal('frameParent' in cam, false);
  near(evalCameraWorld(p, 2, cam).pos, base.pos, 1e-6, 'unparent restores the local camera');
});

test('spatial-parent: re-binding to the same parent keeps the zero frame', () => {
  const p = fresh();
  const cam = p.cameras[0];
  const ob = applyOp(p, {
    op: 'objectAdd',
    object: { type: 'empty', start: 0, duration: 4, pivot: [0, cy, 0], scale: [1, 1, 1] },
  }).changed[0];
  // The parent turns half a revolution over the shot: the camera orbits it.
  applyOp(p, { op: 'objectKey', id: ob, path: 'rotation.y', t: 0, v: 180, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: ob, path: 'rotation.y', t: 4, v: 0 });
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: ob, t: 0 });
  // -0 and +0 compare unequal under deepStrictEqual; the bind is a plain record.
  const bind = () => JSON.stringify(cam.frameParent.bind);
  const bindAtBind = bind();
  const at = (t) => evalCameraWorld(p, t, cam).pos.map((v) => Math.round(v * 1e6) / 1e6);
  const path = () => ({ t0: at(0), t2: at(2), t4: at(4) });
  const before = path();

  // The follow switches (跟随位置 / 旋转 / 缩放) send this op at the playhead.
  // Re-binding there against the parent's *current* pose used to re-zero the
  // child, which rotated the whole camera path by 90° and never came back.
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: ob, t: 2, inherit: { pos: false } });
  assert.equal(bind(), bindAtBind, 'bind kept while a follow switch changes');
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: ob, t: 2, inherit: { pos: true } });
  assert.equal(bind(), bindAtBind, 'bind kept on the way back');
  assert.deepEqual(path(), before, 'the camera path is exactly where it was');

  // A different parent is a real re-bind: the new zero frame is that parent's.
  const other = applyOp(p, {
    op: 'objectAdd',
    object: { type: 'empty', start: 0, duration: 4, pivot: [4, cy, 0], scale: [1, 1, 1] },
  }).changed[0];
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: other, t: 2 });
  assert.equal(cam.frameParent.id, other);
  assert.notEqual(bind(), bindAtBind, 'a new parent re-binds');
});

test('spatial-parent: the mixed graph rejects loops across elements, objects and cameras', () => {
  const p = fresh();
  const el = addEl(p, nodeEl([0, cy, 0]));
  const ob = applyOp(p, { op: 'objectAdd', object: { type: 'empty', start: 0, duration: 4, pivot: [2, cy, 0] } }).changed[0];
  const cam = p.cameras[0];
  applyOp(p, { op: 'spatialParent', id: ob, parent: el.id, t: 0 });
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: ob, t: 0 });
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: el.id, parent: cam.id, t: 0 }), /loop/);
  // A camera cannot be its own parent either.
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: cam.id, parent: cam.id }), /own spatial parent/);
});


test('spatial-parent: a camera parent pans and rolls the 2D child (not the screen lock)', () => {
  const p = fresh();
  const cam = p.cameras[0];
  const child = addEl(p, nodeEl([2, cy, 10]));
  const before = frameAt(p, child, 0);
  applyOp(p, { op: 'spatialParent', id: child.id, parent: cam.id, t: 0 });
  const el = elOf(p, child.id);
  assert.equal(el.parent.id, cam.id);
  assert.equal(elementCarrier(p, el, 0), null, 'a world parent gets no legacy screen pull-in');
  near(frameAt(p, el, 0).pos, before.pos, 1e-6, 'no jump (no camera pull-in)');

  // Pan the camera +3 m x: the child travels with it, its depth stays 10 m.
  applyOp(p, { op: 'cameraPath', id: cam.id, path: [
    { t: 0, pos: [0, cy, 20], look: [0, cy, 0] },
    { t: 2, pos: [3, cy, 20], look: [3, cy, 0] },
  ] });
  near(frameAt(p, el, 2).pos, [5, cy, 10], 1e-6, 'camera pan carries the child');

  // Camera roll +90°: the +2 m x offset orbits about the camera position.
  applyOp(p, { op: 'cameraPatch', id: cam.id, patch: { roll: 90 } });
  const rolled = frameAt(p, el, 0);
  near(rolled.pos, [0, cy + 2, 10], 1e-6, 'camera roll orbits the child around the camera');
  near(dist(rolled.pos, [0, cy, 20]), Math.hypot(2, 10), 1e-6, 'radius from the camera kept');

  // The screen lock is retired (docs/DESIGN-CAMFEED-PARENTS.md §2): no new
  // locks, and a leftover lock record is neither a world parent nor carried.
  const hud = addEl(p, { transform: { x: 300, y: 380, z: 1 } });
  assert.throws(() => applyOp(p, { op: 'elementParent', id: hud.id, parent: '@live', t: 0 }), /贴屏已取消/);
  elOf(p, hud.id).parent = { id: '@live', kind: 'camera', bind: { pos: [0, cy, 20], basis: [[1, 0, 0], [0, 1, 0], [0, 0, -1]], depth: 20 } };
  assert.equal(elementWorldParent(elOf(p, hud.id)), null);
  assert.equal(elementCarrier(p, elOf(p, hud.id), 0), null);
});

// ---------------------------------------------------------------- legacy child

test('spatial-parent: a legacy element without a node is carried through its derived node', () => {
  const p = fresh();
  const parent = addEl(p, nodeEl([0, cy, 0]));
  keyRoll(p, parent.id, 0, 90);
  const legacy = addEl(p, { transform: { x: 100, y: 0, z: 0, scale: 2, rotation: 0 } });
  delete legacy.node; // addElement now creates nodes (core/rotation-ops.js)
  const before = frameAt(p, legacy, 0);
  near(before.pos, [1, cy, 0], 1e-9, 'derived from transform.x = 100 px');

  applyOp(p, { op: 'spatialParent', id: legacy.id, parent: parent.id, t: 0 });
  const el = elOf(p, legacy.id);
  assert.equal('node' in el, false, 'binding never migrates the legacy element');
  assert.deepEqual(el.transform, { x: 100, y: 0, z: 0, scale: 2, rotation: 0, opacity: 1 }, 'transform untouched');
  near(frameAt(p, el, 0).pos, before.pos, 1e-6, 'no jump');
  near(frameAt(p, el, 2).pos, [0, cy - 1, 0], 1e-6, 'inherited roll orbits the derived pivot');
  near(frameAt(p, el, 2).scale, [2, 2, 1], 1e-6, 'derived scale kept');

  // The renderer's sampled node and the op's bind sampler agree.
  near(el.parent.bind.pivot, frameAt(p, parent, 0).pos, 1e-6);
});

// ---------------------------------------------------------------- unparent

test('spatial-parent: unparent only deletes the record and keeps the local node', () => {
  const p = fresh();
  const parent = addEl(p, nodeEl([0, cy, 0]));
  keyRoll(p, parent.id, 0, 90);
  const child = addEl(p, nodeEl([2, cy, 0]));
  const localNode = JSON.parse(JSON.stringify(elOf(p, child.id).node));
  applyOp(p, { op: 'spatialParent', id: child.id, parent: parent.id, t: 0 });
  near(frameAt(p, elOf(p, child.id), 2).pos, [0, cy - 2, 0], 1e-6, 'carried before unparent');

  const result = applyOp(p, { op: 'spatialUnparent', id: child.id });
  assert.deepEqual(result.changed, [child.id]);
  const el = elOf(p, child.id);
  assert.equal('parent' in el, false);
  assert.deepEqual(el.node, localNode, 'local values and keys are untouched');
  near(frameAt(p, el, 2).pos, [2, cy, 0], 1e-6, 'back to the local placement (no bake)');
  assert.deepEqual(applyOp(p, { op: 'spatialUnparent', id: child.id }).changed, [], 'no-op when free');
  assert.deepEqual(validateProject(p), [], 'the project still validates');
});

test('spatial-parent: rejects self, missing hosts, cycles, depth and non-element children', () => {
  const p = fresh();
  const a = addEl(p, nodeEl([0, cy, 0]));
  const b = addEl(p, nodeEl([2, cy, 0]));
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: a.id, parent: a.id }), /own spatial parent/);
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: a.id, parent: 'el_404' }), /no element, object or camera/);
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: a.id, parent: '@live' }), /@live|elementParent/);
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: a.id }), /needs a parent/);

  // 3D objects and cameras are spatial children too now (frameParent).
  const ob = applyOp(p, { op: 'objectAdd', object: { type: 'empty', start: 0, duration: 4 } }).changed[0];
  applyOp(p, { op: 'spatialParent', id: ob, parent: a.id, t: 0 });
  assert.equal(p.scene.objects.find((o) => o.id === ob).frameParent.id, a.id);
  assert.equal('parent' in p.scene.objects.find((o) => o.id === ob), false, 'old 3D parent untouched');
  applyOp(p, { op: 'spatialUnparent', id: ob });
  assert.equal('frameParent' in p.scene.objects.find((o) => o.id === ob), false);

  const cam = p.cameras[0];
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: a.id, t: 0 });
  assert.equal(cam.frameParent.id, a.id);
  applyOp(p, { op: 'spatialUnparent', id: cam.id });
  assert.equal('frameParent' in cam, false);

  const audio = addEl(p, { type: 'audio', src: 'a.m4a' });
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: audio.id, parent: a.id }), /audio/);

  // Loop: a under b, then b under a.
  applyOp(p, { op: 'spatialParent', id: a.id, parent: b.id, t: 0 });
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: b.id, parent: a.id }), /loop/);

  // A screen-locked element is not a stable world frame.
  const live = addEl(p, nodeEl([0, cy, 0]));
  elOf(p, live.id).parent = { id: '@live', kind: 'camera', bind: { pos: [0, cy, 20], basis: [[1, 0, 0], [0, 1, 0], [0, 0, -1]], depth: 20 } };
  assert.throws(() => applyOp(p, { op: 'spatialParent', id: b.id, parent: live.id }), /screen-locked/);
});

test('spatial-parent: chains stop at 32 levels and hand-edited loops fall back to local', () => {
  const p = fresh();
  const chain = [];
  for (let i = 0; i < 34; i++) chain.push(addEl(p, nodeEl([i * 0.1, cy, 0])));
  for (let i = 1; i <= 31; i++) {
    applyOp(p, { op: 'spatialParent', id: chain[i].id, parent: chain[i - 1].id, t: 0 });
  }
  assert.throws(
    () => applyOp(p, { op: 'spatialParent', id: chain[32].id, parent: chain[31].id, t: 0 }),
    /deeper than 32/,
  );
  const frame = frameAt(p, elOf(p, chain[31].id), 0);
  near(frame.pos[1], cy, 1e-6, 'a 31-deep chain still evaluates');

  // A loop written by hand does not throw: the chain falls back to the local
  // node (the preview cannot rely on ops having produced the data).
  const loopA = addEl(p, nodeEl([1, cy, 0]));
  const loopB = addEl(p, nodeEl([2, cy, 0]));
  const fakeBind = { pivot: [0, cy, 0], basis: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]], scale: [1, 1, 1] };
  elOf(p, loopA.id).parent = { id: loopB.id, mode: 'world', inherit: {}, bind: fakeBind };
  elOf(p, loopB.id).parent = { id: loopA.id, mode: 'world', inherit: {}, bind: fakeBind };
  // The chain stops at the loop: A is carried by B's local frame (B stops at
  // A), so the result is finite and deterministic instead of recursing.
  near(frameAt(p, elOf(p, loopA.id), 1).pos, [3, cy, 0], 1e-9, 'loop stops at the child');

  // A missing parent host also degrades to the local node.
  elOf(p, loopA.id).parent = { id: 'el_gone', mode: 'world', inherit: {}, bind: fakeBind };
  near(frameAt(p, elOf(p, loopA.id), 1).pos, [1, cy, 0], 1e-9, 'missing host -> local node');
});

test('spatial-parent: the renderer node path keeps unparented frames identical', () => {
  const p = fresh();
  const el = addEl(p, nodeEl([3, cy + 1, 2], { roll: 30, scale: [2, 2, 1] }));
  const at = elementNodeAt(el, p.meta, 1);
  const world = frameOf(elementWorldNode(p, el, 1));
  near(world.pos, frameOf(at).pos, 1e-12, 'no parent = the sampled local node');
  near(world.basis, frameOf(at).basis, 1e-12);
  near(world.scale, frameOf(at).scale, 1e-12);
});

// ---------------------------------------------------------------- undo / storage

test('spatial-parent: one spatialParent transaction is one undo step', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-spatial-parent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = projectService(root);
  await service.transact({ command: { type: 'initialize', options: { title: 'spatial-parent' } } });
  const a = await service.transact({
    ops: [{ op: 'addElement', element: { type: 'solid', duration: 4, node: { pivot: [0, 5.4, 0], dir: [0, 0, 1] } } }],
  });
  const b = await service.transact({
    ops: [{ op: 'addElement', element: { type: 'solid', duration: 4, node: { pivot: [2, 5.4, 0], dir: [0, 0, 1] } } }],
  });
  const [parentId, childId] = [a.project.elements[0].id, b.project.elements[1].id];
  const bound = await service.transact({
    expectedRev: b.rev,
    ops: [{ op: 'spatialParent', id: childId, parent: parentId, t: 0 }],
  });
  assert.equal(bound.rev, b.rev + 1, 'one parent op is one revision');
  const child = bound.project.elements.find((e) => e.id === childId);
  assert.equal(child.parent.id, parentId);
  assert.equal(child.parent.mode, 'world');
  assert.equal(bound.project.elements.length, 2, 'the op only writes the parent record');

  const undone = await service.transact({ expectedRev: bound.rev, command: { type: 'undo' } });
  assert.equal(undone.rev, bound.rev + 1);
  assert.equal('parent' in undone.project.elements.find((e) => e.id === childId), false);
  assert.equal(undone.project.elements.length, 2, 'undo removes only the parent step');
  assert.equal((await service.history()).undo, 2);
});
