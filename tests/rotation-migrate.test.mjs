import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp } from '../core/ops.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { frameOf } from '../core/spatial.js';
import { objectWorldPose, evalCameraWorld } from '../core/spatial-parent.js';
import { elementWorldNode } from '../app/renderer/js/node-at.js';
import { migrateRotations, ROTATION_MIGRATION } from '../core/rotation-migrate.js';

// docs/DESIGN-TRANSFORM-UNIFY.md §2 step 2c: every older orientation becomes
// rotation.x/y/z with the same picture.

const near = (a, b, eps, msg) => {
  if (Array.isArray(a)) return a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};
const sameFrame = (a, b, eps, msg) => {
  near(a.pos, b.pos, eps, `${msg} pos`);
  a.basis.forEach((v, i) => near(v, b.basis[i], eps, `${msg} basis${i}`));
  near(a.scale, b.scale, eps, `${msg} scale`);
};
const TIMES = [0, 0.4, 1.1, 1.9, 2.6, 3.5];

function rig() {
  const p = normalizeProject(createProject({ title: 'rm', duration: 4 }));
  ensureSpace(p);
  // legacy 2D text with a keyed rotation
  applyOp(p, { op: 'addElement', element: { id: 'el_leg', type: 'text', start: 0, duration: 4, transform: { x: 200, y: -100, rotation: 15 }, style: { text: 'A' } } });
  applyOp(p, { op: 'keySet', id: 'el_leg', path: 'transform.rotation', t: 0, value: 15 });
  applyOp(p, { op: 'keySet', id: 'el_leg', path: 'transform.rotation', t: 3, value: -40 });
  // node element facing an odd direction with roll keys
  applyOp(p, { op: 'addElement', element: { id: 'el_node', type: 'solid', start: 0, duration: 4,
    node: { pivot: [1, 6, -2], position: [0.5, 0, 0], dir: [0.3, 0.2, 0.93], roll: 10, scale: [1, 1, 1] } } });
  p.elements.find((e) => e.id === 'el_node').keyframes.push(
    { t: 0, path: 'roll', value: 10, ease: 'linear' }, { t: 3, path: 'roll', value: 70 });
  // 3D objects: static odd orientation + roll keys; and one with dir keys
  applyOp(p, { op: 'objectAdd', object: { id: 'ob_roll', type: 'solid', pivot: [-3, 2, 0], position: [0, 0.5, 0], rot: { dir: [0.4, 0.3, -0.86], roll: 20 } } });
  applyOp(p, { op: 'objectKey', id: 'ob_roll', path: 'roll', t: 0, v: 20, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_roll', path: 'roll', t: 3, v: -50 });
  applyOp(p, { op: 'objectAdd', object: { id: 'ob_dir', type: 'solid', pivot: [3, 2, 0] } });
  applyOp(p, { op: 'objectKey', id: 'ob_dir', path: 'dir', t: 0, v: [0, 0, -1], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_dir', path: 'dir', t: 3, v: [1, 0, 0] });
  // camera with a keyed manual roll
  applyOp(p, { op: 'cameraParamKey', id: p.cameras[0].id, path: 'roll', t: 0, v: 0 });
  applyOp(p, { op: 'cameraParamKey', id: p.cameras[0].id, path: 'roll', t: 3, v: 25 });
  // links to / from roll
  applyOp(p, { op: 'propLink', host: 'ob', id: 'ob_dir', to: 'roll', from: { host: 'el', id: 'el_node', path: 'roll' }, combine: 'add', t: 0 });
  return p;
}

const snapshot = (p) => ({
  leg: TIMES.map((t) => frameOf(elementWorldNode(p, p.elements.find((e) => e.id === 'el_leg'), t))),
  node: TIMES.map((t) => frameOf(elementWorldNode(p, p.elements.find((e) => e.id === 'el_node'), t))),
  roll: TIMES.map((t) => objectWorldPose(p, p.scene.objects.find((o) => o.id === 'ob_roll'), t)),
  dir: [0, 3].map((t) => objectWorldPose(p, p.scene.objects.find((o) => o.id === 'ob_dir'), t)),
  cam: TIMES.map((t) => evalCameraWorld(p, t)),
});
const poseFrame = (s) => ({ pos: s.worldPos, basis: [s.basis.right, s.basis.up, s.basis.forward], scale: s.scale });

test('the migration is off until new data is created in the rotation format', () => {
  assert.equal(ROTATION_MIGRATION, false);
});

test('every orientation becomes rotation with the same picture', () => {
  const p = rig();
  const before = snapshot(p);
  const { project: q, report } = migrateRotations(p);
  assert.deepEqual(validateProject(q), []);
  assert.equal(report.elementsToNode, 1);
  assert.deepEqual(report.approximated, ['ob_dir']);
  const after = snapshot(q);
  TIMES.forEach((t, i) => {
    sameFrame(after.leg[i], before.leg[i], 1e-6, `legacy 2D @${t}`);
    sameFrame(after.node[i], before.node[i], 1e-6, `node @${t}`);
    sameFrame(poseFrame(after.roll[i]), poseFrame(before.roll[i]), 1e-6, `object roll @${t}`);
    near(after.cam[i].look, before.cam[i].look, 1e-6, `camera look @${t}`);
    near(after.cam[i].roll, before.cam[i].roll, 1e-6, `camera roll @${t}`);
  });
  // keyed dir: exact at its keys (per-axis in between)
  [0, 1].forEach((i) => sameFrame(poseFrame(after.dir[i]), poseFrame(before.dir[i]), 1e-6, `object dir key ${i}`));
});

test('old fields are gone and links point at rotation.z', () => {
  const { project: q } = migrateRotations(rig());
  const leg = q.elements.find((e) => e.id === 'el_leg');
  assert.ok(Array.isArray(leg.node.rotation));
  assert.equal(leg.node.dir, undefined);
  assert.ok(leg.keyframes.some((k) => k.path === 'rotation.z'));
  assert.ok(!leg.keyframes.some((k) => k.path === 'roll' || k.path === 'transform.rotation'));
  const ob = q.scene.objects.find((o) => o.id === 'ob_roll');
  assert.equal(ob.rot, undefined);
  assert.ok(Array.isArray(ob.tracks['rotation.z']) && !ob.tracks.roll && !ob.tracks.dir);
  const cam = q.cameras[0];
  assert.equal(cam.roll, undefined);
  assert.ok(Array.isArray(cam.tracks['rotation.z']) && !cam.tracks.roll);
  const link = q.scene.objects.find((o) => o.id === 'ob_dir').links[0];
  assert.equal(link.to, 'rotation.z');
  assert.equal(link.from.path, 'rotation.z');
});

test('a camera edited after 2b keeps its picture when the old roll folds in', () => {
  const cams = (setup) => {
    const p = normalizeProject(createProject({ title: 'rc', duration: 4 }));
    ensureSpace(p);
    setup(p, p.cameras[0].id);
    const before = TIMES.map((t) => evalCameraWorld(p, t));
    const { project: q } = migrateRotations(p);
    TIMES.forEach((t, i) => {
      const after = evalCameraWorld(q, t);
      near(after.look, before[i].look, 1e-5, `look @${t}`);
      near(after.roll, before[i].roll, 1e-5, `roll @${t}`);
    });
    return q.cameras[0];
  };
  // tilted + static roll + keyed z: folds exactly
  const a = cams((p, id) => {
    applyOp(p, { op: 'cameraPatch', id, patch: { rotation: [5, 10, 3], roll: 12 } });
    applyOp(p, { op: 'cameraParamKey', id, path: 'rotation.z', t: 0, v: 3 });
    applyOp(p, { op: 'cameraParamKey', id, path: 'rotation.z', t: 3, v: 40 });
  });
  assert.equal(a.roll, undefined);
  // tilted + keyed roll: cannot fold per axis, keeps the roll
  const b = cams((p, id) => {
    applyOp(p, { op: 'cameraPatch', id, patch: { rotation: [5, 10, 3] } });
    applyOp(p, { op: 'cameraParamKey', id, path: 'roll', t: 0, v: 0 });
    applyOp(p, { op: 'cameraParamKey', id, path: 'roll', t: 3, v: 30 });
  });
  assert.ok(b.tracks.roll.length);
});

test('a second run changes nothing', () => {
  const { project: q } = migrateRotations(rig());
  const once = JSON.stringify(q);
  const { project: r, report } = migrateRotations(q);
  assert.equal(JSON.stringify(r), once);
  assert.deepEqual(report, { elementsToNode: 0, nodes: 0, objects: 0, cameras: 0, links: 0, approximated: [] });
});
