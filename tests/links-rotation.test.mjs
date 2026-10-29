// Property links on three-axis rotation (DESIGN-TRANSFORM-UNIFY §2):
// rotation.x/y/z are ordinary angle targets of objects, node 2D elements and
// cameras; the effective angle must reach the same evaluators the picture uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { ensureSpace, screenCenterY } from '../core/space.js';
import {
  cameraValueWithLinks, findLinkTarget, objectPoseWithLinks, resolveEffectiveValue,
  resolveLocalValue,
} from '../core/links.js';
import { elementNodeWithLinks, evalCameraWorldWithLinks } from '../core/link-eval.js';
import { rotationFromDirRoll } from '../core/rotation.js';

const cy = screenCenterY({ width: 1920, height: 1080 });
const near = (a, b, eps = 1e-6, msg = '') => {
  assert.ok(Number.isFinite(a), `${msg}: ${a} is not finite`);
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

function fresh() {
  const p = normalizeProject(createProject({ title: 'links-rotation', duration: 8 }));
  ensureSpace(p);
  return p;
}

const addObj = (p, over = {}) => applyOp(p, {
  op: 'objectAdd',
  object: {
    type: 'empty', start: 0, duration: 8, id: over.id,
    pivot: [0, 0, 0], rot: { dir: [0, 0, 1], roll: 0 }, scale: [1, 1, 1], ...over,
  },
}).changed[0] && p.scene.objects.find((o) => o.id === over.id);

const addEl = (p, over = {}) => applyOp(p, {
  op: 'addElement',
  element: {
    type: 'solid', start: 0, duration: 8,
    node: { pivot: [0, cy, 0], position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1] },
    ...over,
  },
}).element;

const addCam = (p, over = {}) => applyOp(p, {
  op: 'addCamera',
  camera: { name: over.name || 'cam', path: [{ t: 0, pos: [0, cy, 20], look: [0, cy, 0] }], ...over },
}).camera;

const link = (p, id, to, from) => applyOp(p, { op: 'propLink', id, to, from, t: 0 }).link;

test('rotation links: targets exist on objects/cameras/nodes, not legacy 2D', () => {
  const p = fresh();
  const obj = addObj(p, { id: 'ob_r' });
  const cam = addCam(p, { name: 'cam_r' });
  const node = addEl(p, { node: { pivot: [0, cy, 0], position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } });
  const legacy = addEl(p, { node: undefined });
  delete legacy.node; // addElement now creates nodes (core/rotation-ops.js)
  for (const path of ['rotation.x', 'rotation.y', 'rotation.z']) {
    assert.equal(findLinkTarget('ob', obj, path)?.unit, 'angle');
    assert.equal(findLinkTarget('cam', cam, path)?.unit, 'angle');
    assert.equal(findLinkTarget('el', node, path)?.unit, 'angle');
    assert.equal(findLinkTarget('el', legacy, path), null);
  }
});

test('rotation links: a linked object angle reaches objectPoseWithLinks', () => {
  const p = fresh();
  const child = addObj(p, { id: 'ob_child', rotation: [0, 0, 0] });
  const parent = addObj(p, { id: 'ob_parent', rotation: [0, 0, 0] });
  applyOp(p, { op: 'objectKey', id: parent.id, path: 'rotation.z', t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: parent.id, path: 'rotation.z', t: 4, v: 40 });
  link(p, child.id, 'rotation.z', { host: 'ob', id: parent.id, path: 'rotation.z' });
  near(resolveLocalValue(p, { host: 'ob', id: child.id }, 'rotation.z', 2), 0, 1e-9, 'local stays 0');
  near(resolveEffectiveValue(p, { host: 'ob', id: child.id }, 'rotation.z', 2), 20, 1e-9, 'bind offset');
  const pose = objectPoseWithLinks(p, child, 2);
  near(pose.rotation[2], 20, 1e-9, 'linked pose carries rotation.z');
  near(pose.roll, 20, 1e-9, 'dir/roll are derived from the linked pose');
});

test('rotation links: a node and a camera see their linked rotation', () => {
  const p = fresh();
  const parent = addObj(p, { id: 'ob_parent', rotation: [0, 0, 0] });
  const node = addEl(p, { node: { pivot: [0, cy, 0], position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } });
  link(p, node.id, 'rotation.z', { host: 'ob', id: parent.id, path: 'rotation.z' });
  applyOp(p, { op: 'objectPatch', id: parent.id, patch: { rotation: [0, 0, 10] } });
  const n = elementNodeWithLinks(p, node, 1);
  near(n.rotation[2], 10, 1e-9, 'node effective angle');
  near(n.roll, 10, 1e-9, 'node roll derived from rotation');

  const camA = addCam(p, { name: 'cam_a', rotation: [0, 0, 0] });
  const camB = addCam(p, { name: 'cam_b', rotation: [0, 0, 0] });
  link(p, camA.id, 'rotation.z', { host: 'cam', id: camB.id, path: 'rotation.z' });
  applyOp(p, { op: 'cameraParamKey', id: camB.id, path: 'rotation.z', t: 0, v: 30 });
  near(cameraValueWithLinks(p, camA, 'rotation.z', 1), 30, 1e-9, 'camera effective angle');
  const world = evalCameraWorldWithLinks(p, 1, camA);
  near(world.roll, 30, 1e-6, 'the linked camera angle reaches evalCameraWorld');
});
