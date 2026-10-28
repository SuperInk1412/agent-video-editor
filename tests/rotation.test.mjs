import test from 'node:test';
import assert from 'node:assert/strict';
import { basisFromDir } from '../core/scene.js';
import {
  basisFromRotation, rotationFromBasis, dirRollFromRotation, rotationFromDirRoll, applyCameraRotation,
} from '../core/rotation.js';

const near = (a, b, eps = 1e-9, msg = '') => {
  if (Array.isArray(a)) return a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};
const sameBasis = (a, b, eps = 1e-9) => { near(a.right, b.right, eps, 'right'); near(a.up, b.up, eps, 'up'); near(a.forward, b.forward, eps, 'forward'); };

test('rotation 0 faces +Z exactly like dir [0,0,1], roll 0', () => {
  sameBasis(basisFromRotation([0, 0, 0]), basisFromDir([0, 0, 1], 0));
  assert.deepEqual(dirRollFromRotation([0, 0, 0]), { dir: [0, 0, 1], roll: 0 });
});

test('z alone is the old 2D rotation / node roll (same sign)', () => {
  for (const z of [-170, -30, 0, 12.5, 90, 135]) {
    sameBasis(basisFromRotation([0, 0, z]), basisFromDir([0, 0, 1], z));
    near(dirRollFromRotation([0, 0, z]).roll, z, 1e-9);
  }
});

test('axis directions: +x tilts the top away, +y turns around the vertical', () => {
  // a viewer in front (+Z) looking at the element
  const tilt = basisFromRotation([30, 0, 0]);
  assert.ok(tilt.up[2] < 0, 'top goes away from the viewer (toward -Z)');
  const turn = basisFromRotation([0, 90, 0]);
  near(turn.up, [0, 1, 0], 1e-12, 'y keeps the vertical');
  near(turn.forward, [-1, 0, 0], 1e-12, 'clockwise seen from above: +Z front turns to -X');
});

test('basis -> angles -> basis round-trips (gimbal lock keeps the orientation)', () => {
  for (const r of [[10, 20, 30], [-45, 170, -80], [89.9, 33, 12], [90, 40, 0], [-90, -120, 0], [0, 180, 0], [179, -179, 5]]) {
    const b = basisFromRotation(r);
    sameBasis(basisFromRotation(rotationFromBasis(b)), b, 1e-6);
  }
});

test('dir/roll <-> angles agree with basisFromDir everywhere', () => {
  for (const [dir, roll] of [[[0, 0, -1], 0], [[0.3, 0.5, -0.8], 25], [[1, 0, 0], -60], [[0, 1, 0], 10], [[0, -1, 0.0001], 0]]) {
    const r = rotationFromDirRoll(dir, roll);
    sameBasis(basisFromRotation(r), basisFromDir(dir, roll), 1e-6);
    const back = dirRollFromRotation(r);
    sameBasis(basisFromDir(back.dir, back.roll), basisFromDir(dir, roll), 1e-6);
  }
  near(rotationFromDirRoll([0, 0, -1], 0), [0, 180, 0], 1e-9, 'the old object default faces -Z: y = 180');
});

test('camera offsets: +y pans right, +x looks down, +z rolls clockwise', () => {
  const st = { pos: [0, 5, 20], look: [0, 5, 0], roll: 0, fov: 50 };
  const pan = applyCameraRotation(st, [0, 30, 0]);
  assert.ok(pan.look[0] > 0, 'pans right');
  near(pan.look[1], 5, 1e-9);
  const down = applyCameraRotation(st, [20, 0, 0]);
  assert.ok(down.look[1] < 5, 'looks down');
  const roll = applyCameraRotation(st, [0, 0, 15]);
  near(roll.look, st.look, 1e-9, 'roll keeps the aim');
  near(roll.roll, 15, 1e-9);
  assert.equal(applyCameraRotation(st, [0, 0, 0]), st, 'no offset: same object');
});

// ---------------------------------------------------------------- hosts

import { objectPose } from '../core/scene.js';
import { applyOp } from '../core/ops.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { elementLocalNode, evalCameraWorld } from '../core/spatial-parent.js';

test('3D objects: rotation replaces dir/roll and keys interpolate per axis', () => {
  const a = objectPose({ rotation: [0, 0, 33] }, 0);
  const b = objectPose({ rot: { dir: [0, 0, 1], roll: 33 } }, 0);
  sameBasis(a.basis, b.basis, 1e-9);
  near(a.rotation, [0, 0, 33]);
  const keyed = { rotation: [10, 0, 0], tracks: { 'rotation.y': [{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 90 }] } };
  near(objectPose(keyed, 1).rotation, [10, 45, 0], 1e-9, 'halfway on y, x from the base');
  sameBasis(objectPose(keyed, 1).basis, basisFromRotation([10, 45, 0]));
});

test('2D nodes: node.rotation and rotation.* keys drive dir/roll', () => {
  const p = normalizeProject(createProject({ title: 'r', duration: 4 }));
  ensureSpace(p);
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 4,
    node: { pivot: [0, 5, 0], position: [0, 0, 0], rotation: [0, 30, 15], scale: [1, 1, 1] } } });
  assert.deepEqual(validateProject(p), []);
  const el = p.elements.find((e) => e.id === element.id);
  near(el.node.rotation, [0, 30, 15]);
  const want = dirRollFromRotation([0, 30, 15]);
  const n0 = elementLocalNode(p, el, 0);
  near(n0.dir, want.dir, 1e-9); near(n0.roll, want.roll, 1e-9);
  el.keyframes.push({ t: 0, path: 'rotation.x', value: 0, ease: 'linear' }, { t: 2, path: 'rotation.x', value: 40 });
  const n1 = elementLocalNode(p, el, 1);
  near(n1.rotation, [20, 30, 15], 1e-9);
  const w = dirRollFromRotation([20, 30, 15]);
  near(n1.dir, w.dir, 1e-9); near(n1.roll, w.roll, 1e-9);
});

test('cameras: rotation is an offset on the evaluated view', () => {
  const p = normalizeProject(createProject({ title: 'r', duration: 4 }));
  ensureSpace(p);
  const before = evalCameraWorld(p, 1);
  applyOp(p, { op: 'cameraPatch', id: p.cameras[0].id, patch: { rotation: [0, 20, 0] } });
  const after = evalCameraWorld(p, 1);
  near(after.pos, before.pos);
  assert.ok(after.look[0] > before.look[0] + 1, 'pans right');
});
