import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_ELEMENT_DIR, MAX_DEPTH, SCREEN_PARENT,
  applyParentToFrame, applyParentToNode, bindFrameFor, bindFrameFrom,
  cameraNode, cameraWorldFrame, elementNode, findSpatialHost, frameOf, frameToNode,
  isScreenParent, isWorldParent, isValidSpatialNode, legacyElementNode,
  mapParentPoint, mapParentVector, nodeBasis, nodeMatrix, nodeWorldPos,
  normalizeInherit, normalizeParentData, normalizeSpatialNode, objectNode,
  parentDelta, spatialAncestors, spatialNodeIssues, spatialParentId, wouldSpatialCycle,
} from '../core/spatial.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { objectPose, poseMatrix, basisFromDir } from '../core/scene.js';
import { worldPose, frameOf as poseFrameOf } from '../core/hierarchy.js';
import { applyOp } from '../core/ops.js';
import { screenCenterY } from '../core/space.js';

const near = (a, b, eps = 1e-9, msg = '') => {
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${msg}: expected two arrays (${a} / ${b})`);
    assert.equal(a.length, b.length, `${msg}: length`);
    a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
    return;
  }
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

/** A plain local node. */
const node = (over = {}) => ({
  pivot: [0, 0, 0], position: [0, 0, 0], dir: [0, 0, -1], roll: 0, scale: [1, 1, 1], ...over,
});

const identityCamera = (over = {}) => ({
  id: 'cam_1',
  center: [0, 5.4, 0],
  path: [{ t: 0, pos: [0, 0, 20], look: [0, 5.4, 0] }],
  ...over,
});

test('spatial: object nodes reuse the scene fields and match poseMatrix', () => {
  const obj = { pivot: [1, 2, 3], position: [0, 0, -5], rot: { dir: [0, 0, -1], roll: 15 }, scale: [2, 3, 4] };
  const n = objectNode(obj);
  assert.deepEqual(n, { pivot: [1, 2, 3], position: [0, 0, -5], dir: [0, 0, -1], roll: 15, scale: [2, 3, 4] });

  const f = frameOf(n);
  near(f.pos, [1, 2, 8], 1e-12, 'worldPos = pivot + basis·position');
  const b = basisFromDir([0, 0, -1], 15);
  near(f.basis, [b.right, b.up, b.forward], 1e-12, 'basis');
  near(f.scale, [2, 3, 4], 1e-12, 'scale');
  near(nodeWorldPos(n), f.pos, 1e-12, 'nodeWorldPos');
  near(Array.from(nodeMatrix(n)), Array.from(poseMatrix(objectPose(obj, 0))), 1e-5, 'matrix');
  const hf = poseFrameOf(objectPose(obj, 0));
  near(f.pos, hf.pos, 1e-12, 'same frame as core/hierarchy');
  near(f.basis, hf.basis, 1e-12, 'same basis as core/hierarchy');
  near(f.scale, hf.scale, 1e-12, 'same scale as core/hierarchy');

  // `t` samples the object's keyed channels; no `t` reads the base fields.
  const keyed = {
    ...obj,
    tracks: { pivot: [{ t: 0, v: [0, 0, 0], ease: 'linear' }, { t: 2, v: [10, 0, 0] }] },
  };
  near(objectNode(keyed, 1).pivot, [5, 0, 0]);
  near(objectNode(keyed).pivot, [1, 2, 3], 1e-12, 'base values without t');
});

test('spatial: legacy 2D transforms derive a node without writing', () => {
  const meta = { width: 1920, height: 1080 };
  const before = structuredClone({ id: 'el_1', transform: { x: 200, y: -100, z: 1.5, scale: 2, rotation: 30 } });
  const n = elementNode(before, meta);
  near(n.pivot, [2, screenCenterY(meta) + 1, 1.5], 1e-12, 'screen px -> world m');
  assert.deepEqual(n.position, [0, 0, 0], 'the plane offset stays local zero');
  assert.deepEqual(n.dir, LEGACY_ELEMENT_DIR);
  assert.equal(n.roll, 30, 'roll = transform.rotation');
  assert.deepEqual(n.scale, [2, 2, 1], 'uniform px scale expands to xyz');
  assert.deepEqual(before, { id: 'el_1', transform: { x: 200, y: -100, z: 1.5, scale: 2, rotation: 30 } }, 'never writes el.node');

  const keyed = {
    transform: { x: 0, y: 0, z: 0, scale: 1, rotation: 0 },
    keyframes: [
      { t: 0, path: 'transform.x', value: 0, ease: 'linear' }, { t: 2, path: 'transform.x', value: 200 },
      { t: 0, path: 'transform.y', value: 0, ease: 'linear' }, { t: 2, path: 'transform.y', value: 100 },
      { t: 0, path: 'transform.z', value: 0, ease: 'linear' }, { t: 2, path: 'transform.z', value: 4 },
      { t: 0, path: 'transform.scale', value: 1, ease: 'linear' }, { t: 2, path: 'transform.scale', value: 2 },
      { t: 0, path: 'transform.rotation', value: 0, ease: 'linear' }, { t: 2, path: 'transform.rotation', value: 90 },
    ],
  };
  const at = elementNode(keyed, meta, 1);
  near(at.pivot, [1, screenCenterY(meta) - 0.5, 2], 1e-12, 'keyed x/y/z at t');
  near(at.scale, [1.5, 1.5, 1], 1e-12, 'keyed scale');
  assert.equal(at.roll, 45, 'keyed rotation');

  near(legacyElementNode({}, meta).pivot, [0, screenCenterY(meta), 0], 1e-12, 'empty element');
});

test('spatial: an element node wins over transform and partial nodes fall back', () => {
  const meta = { width: 1920, height: 1080 };
  const el = {
    transform: { x: 100, y: 0, scale: 3, rotation: 10 },
    node: { pivot: [9, 8, 7], position: [1, 2, 3], dir: [0, 1, 0], roll: 12, scale: [2, 2, 2] },
  };
  const n = elementNode(el, meta);
  near(n.pivot, [9, 8, 7]);
  near(n.position, [1, 2, 3]);
  near(n.dir, [0, 1, 0]);
  assert.equal(n.roll, 12);
  near(n.scale, [2, 2, 2]);

  const partial = { transform: { x: 100, y: 0, z: 0, scale: 3, rotation: 10 }, node: { roll: 5 } };
  const p = elementNode(partial, meta);
  near(p.pivot, [1, screenCenterY(meta), 0], 1e-12, 'pivot from transform');
  near(p.scale, [3, 3, 1], 1e-12, 'scale from transform');
  near(p.dir, [0, 0, 1], 1e-12, 'dir from the legacy plane');
  assert.equal(p.roll, 5, 'the authored field wins');
});

test('spatial: camera nodes use the sampled center, path and evaluated look', () => {
  const cam = {
    id: 'cam_1', center: [1, 2, 3], scale: [2, 3, 4], roll: 10, fov: 50,
    pictureScale: [0.5, 1], pictureFov: 30,
    path: [{ t: 0, pos: [0, 5, 20], look: [0, 5, 0] }],
  };
  const n = cameraNode(cam, 0);
  near(n.pivot, [1, 2, 3], 1e-12, 'pivot = center');
  near(n.position, [0, 5, 20], 1e-12, 'position = pathPos');
  near(n.scale, [2, 3, 4], 1e-12, 'scale = camera scale');
  assert.equal(n.roll, 10, 'roll from evalCamera');
  const d = Math.hypot(1, 2, 23);
  near(n.dir, [-1 / d, -2 / d, -23 / d], 1e-12, 'dir from look - pos');
  assert.deepEqual(Object.keys(n).sort(), ['dir', 'pivot', 'position', 'roll', 'scale'], 'picture* / fov are not node fields');

  const f = cameraWorldFrame(cam, 0);
  near(f.pos, [1, 7, 23], 1e-12, 'camera world pos = center + path');
  near(f.basis[2], n.dir, 1e-12, 'frame forward');
  near(f.scale, [2, 3, 4], 1e-12, 'frame scale');

  // keyed camera channels follow time
  const keyed = {
    ...cam,
    tracks: {
      center: [{ t: 0, v: [1, 2, 3], ease: 'linear' }, { t: 2, v: [3, 2, 3] }],
      scale: [{ t: 0, v: [2, 3, 4], ease: 'linear' }, { t: 2, v: [4, 3, 4] }],
    },
  };
  const at = cameraNode(keyed, 1);
  near(at.pivot, [2, 2, 3], 1e-12, 'sampled center');
  near(at.scale, [3, 3, 4], 1e-12, 'sampled scale');

  assert.deepEqual(cameraNode(null), node(), 'missing camera -> defaults');
  near(frameToNode(cameraWorldFrame(cam, 0)).pivot, [1, 7, 23], 1e-12, 'frameToNode keeps the camera world position');
});

test('spatial: binding does not jump and parent rotation orbits the parent pivot', () => {
  const parent0 = node({ dir: [0, 0, -1] });
  const parent1 = node({ dir: [1, 0, 0] });
  const bind = bindFrameFor(parent0);
  assert.deepEqual(bind.pivot, [0, 0, 0], 'bind pivot is the parent frame position');
  near(bind.basis, frameOf(parent0).basis, 1e-12, 'bind basis');
  near(bind.scale, [1, 1, 1], 1e-12, 'bind scale');

  const child = node({ pivot: [0, 0, -5] });
  const bound = applyParentToNode(child, frameOf(parent0), bind);
  near(frameOf(bound).pos, [0, 0, -5], 1e-12, 'bind is a no-op');
  near(bound.dir, [0, 0, -1], 1e-12, 'orientation untouched at the bind time');
  near(bound.scale, [1, 1, 1], 1e-12, 'scale untouched');

  // The parent turns from -Z to +X: the child 5 m along -Z orbits to +5 x.
  const turned = applyParentToNode(child, frameOf(parent1), bind);
  near(frameOf(turned).pos, [5, 0, 0], 1e-12, 'orbit around the parent frame pivot');
  near(turned.dir, [1, 0, 0], 1e-12, 'child turns with the parent');
  near(turned.roll, 0, 1e-9, 'no roll added by the orbit');
});

test('spatial: parent scale stretches the child and inherit switches isolate axes', () => {
  const bind = bindFrameFor(node());
  const child = node({ pivot: [2, 0, 0] });

  const scaled = applyParentToNode(child, frameOf(node({ scale: [3, 3, 3] })), bind);
  near(scaled.pivot, [6, 0, 0], 1e-12, 'offset scales with the parent');
  near(scaled.scale, [3, 3, 3], 1e-12, 'child scale scales too');

  const noScale = applyParentToNode(child, frameOf(node({ scale: [3, 3, 3] })), bind, { scale: false });
  near(noScale.pivot, [2, 0, 0], 1e-12, 'scale off: offset unchanged');
  near(noScale.scale, [1, 1, 1], 1e-12, 'scale off: size unchanged');

  const moved = node({ pivot: [10, 0, 0], dir: [1, 0, 0] });
  const noRot = applyParentToNode(child, frameOf(moved), bind, { rot: false });
  near(noRot.pivot, [12, 0, 0], 1e-12, 'rot off: travels but does not turn');
  near(noRot.dir, [0, 0, -1], 1e-12, 'rot off: own facing kept');

  const noPos = applyParentToNode(child, frameOf(moved), bind, { pos: false });
  near(noPos.pivot, [0, 0, 2], 1e-12, 'pos off: rotates around the bind pivot, no travel');
  near(noPos.dir, [1, 0, 0], 1e-12, 'pos off: rotation still applies');

  // Non-uniform parent scale stretches along the parent's bind axes.
  const wide = applyParentToNode(node({ pivot: [2, 0, 0] }), frameOf(node({ scale: [2, 1, 1] })), bind);
  near(wide.pivot, [4, 0, 0], 1e-12, 'non-uniform stretch');
  near(wide.scale, [2, 1, 1], 1e-12, 'per-axis scale');

  // The delta is relative to the bind scale, not absolute.
  const bind2 = bindFrameFor(node({ scale: [2, 2, 2] }));
  const grow = applyParentToNode(node({ pivot: [1, 0, 0] }), frameOf(node({ scale: [4, 4, 4] })), bind2);
  near(grow.pivot, [2, 0, 0], 1e-12, 'relative scale');
  near(grow.scale, [2, 2, 2], 1e-12, 'relative size');

  assert.deepEqual(normalizeInherit({}), { pos: true, rot: true, scale: true });
  assert.deepEqual(normalizeInherit({ pos: false, rot: 0 }), { pos: false, rot: true, scale: true }, 'only literal false turns an axis off');
});

test('spatial: cameras work as parents and as children through frames', () => {
  const cam = identityCamera();
  // Pan: both the path position and the look target move, so the camera keeps
  // facing -Z (an absolute look target would also turn it).
  const movedCam = identityCamera({
    center: [3, 5.4, 0],
    path: [{ t: 0, pos: [0, 0, 20], look: [3, 5.4, 0] }],
  });
  const bind = bindFrameFrom(cameraWorldFrame(cam, 0));
  assert.deepEqual(bind.pivot, [0, 5.4, 20], 'camera parents bind at the camera position');

  const carried = applyParentToNode(node(), cameraWorldFrame(movedCam, 0), bind);
  near(carried.pivot, [3, 0, 0], 1e-12, 'child follows the camera pan');

  // Camera as a child: the parent's rotation turns the camera around its bind frame.
  const parent0 = node();
  const parent1 = node({ pivot: [10, 0, 0], dir: [1, 0, 0] });
  const parentBind = bindFrameFor(parent0);
  const worldCam = applyParentToFrame(cameraWorldFrame(cam, 0), frameOf(parent1), parentBind);
  near(worldCam.pos, [-10, 5.4, 0], 1e-12, 'rotated camera position');
  near(worldCam.basis[0], [0, 0, 1], 1e-12, 'camera right turns with the parent');
  near(worldCam.basis[2], [1, 0, 0], 1e-12, 'camera forward turns with the parent');

  const reborn = frameToNode(worldCam);
  near(reborn.pivot, [-10, 5.4, 0], 1e-12, 'the caller rebuilds a camera node from the frame');
  assert.deepEqual(reborn.position, [0, 0, 0]);
  near(reborn.dir, [1, 0, 0], 1e-12);
  near(reborn.scale, [1, 1, 1], 1e-12);
});

test('spatial: 2D, 3D and camera nodes are interchangeable as parents', () => {
  const meta = { width: 1920, height: 1080 };
  const parent0 = elementNode({ transform: { x: 100, y: 0, z: 0, scale: 1, rotation: 0 } }, meta);
  const parent1 = elementNode({ transform: { x: 100, y: 0, z: 0, scale: 1, rotation: 90 } }, meta);
  const bind = bindFrameFor(parent0);
  const objectChild = objectNode({ pivot: [3, 5.4, 0], rot: { dir: [0, 0, -1] } });
  const turned = applyParentToNode(objectChild, frameOf(parent1), bind);
  near(frameOf(turned).pos, [1, 3.4, 0], 1e-12, '3D child orbits a 2D element parent');
  near(turned.dir, [0, 0, -1], 1e-12, '2D roll around +Z keeps the facing');

  const objectParent0 = objectNode({ pivot: [0, 0, 0], rot: { dir: [0, 0, -1] } });
  const objectParent1 = objectNode({ pivot: [0, 0, 0], rot: { dir: [1, 0, 0] } });
  const child2d = elementNode({ transform: { x: 100, y: 0, z: 0, scale: 1, rotation: 0 } }, meta);
  const moved = applyParentToNode(child2d, frameOf(objectParent1), bindFrameFor(objectParent0));
  near(frameOf(moved).pos, [0, 5.4, 1], 1e-12, '2D child follows a 3D object parent');
  near(moved.scale, [1, 1, 1], 1e-12);
});

test('spatial: @live and screen parents stay outside the world-matrix path', () => {
  assert.equal(SCREEN_PARENT, '@live');
  assert.equal(isScreenParent({ id: '@live' }), true);
  assert.equal(isScreenParent({ id: 'cam_1', mode: 'screen' }), true);
  assert.equal(isScreenParent({ id: 'cam_1' }), false);
  assert.equal(isWorldParent({ id: 'cam_1' }), true);
  assert.equal(isWorldParent({ id: 'cam_1', mode: 'screen' }), false);
  assert.equal(isWorldParent({ id: '@live' }), false);
  assert.equal(isWorldParent(null), false);

  const data = normalizeParentData({
    id: '@live',
    bind: { pos: [1, 2, 3], basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], scale: [2, 2, 2] },
  });
  assert.equal(data.mode, 'screen', '@live is the screen mode even without an explicit mode');
  near(data.bind.pivot, [1, 2, 3], 1e-12, 'legacy bind.pos is accepted as bind.pivot');
  near(data.bind.scale, [2, 2, 2], 1e-12);
  assert.deepEqual(normalizeParentData({ id: 'cam_1' }).inherit, { pos: true, rot: true, scale: true });
  assert.deepEqual(normalizeParentData({ id: 'cam_1', inherit: { rot: false } }).inherit, { pos: true, rot: false, scale: true });
  assert.equal(normalizeParentData(null), null);
});

test('spatial: parent chains stop at cycles, missing hosts and depth 32', () => {
  const elements = [];
  for (let i = 0; i <= MAX_DEPTH + 2; i++) {
    elements.push({ id: `el_${i}`, ...(i ? { parent: { id: `el_${i - 1}` } } : {}) });
  }
  const project = {
    elements,
    scene: { objects: [{ id: 'ob_1', parent: { id: 'cam_1' } }] },
    cameras: [{ id: 'cam_1' }],
  };
  assert.equal(spatialAncestors(project, `el_${MAX_DEPTH + 2}`).length, MAX_DEPTH, 'depth is capped');
  assert.deepEqual(spatialAncestors(project, 'ob_1').map((h) => h.id), ['cam_1'], 'objects can parent to cameras');
  assert.equal(findSpatialHost(project, 'ob_1').id, 'ob_1');
  assert.equal(findSpatialHost(project, 'nope'), null);
  assert.equal(spatialParentId(elements[3]), 'el_2');
  assert.equal(spatialParentId(elements[0]), null);
  assert.equal(wouldSpatialCycle(project, 'el_0', 'el_5'), true, 'ancestor would loop');
  assert.equal(wouldSpatialCycle(project, 'el_5', 'el_0'), false, 'descendant is fine');
  assert.equal(wouldSpatialCycle(project, 'el_5', 'el_5'), true, 'self is a loop');
  assert.equal(wouldSpatialCycle(project, 'el_5', 'cam_1'), false);
  assert.equal(wouldSpatialCycle(project, 'el_5', '@live'), false, 'screen parent is not a host');

  const loop = { elements: [{ id: 'a', parent: { id: 'b' } }, { id: 'b', parent: { id: 'a' } }] };
  assert.deepEqual(spatialAncestors(loop, 'a').map((h) => h.id), ['b'], 'a real loop terminates');
});

test('spatial: invalid and missing data normalises to safe defaults', () => {
  assert.deepEqual(normalizeSpatialNode(null), node(), 'node defaults');
  const loose = normalizeSpatialNode({ pivot: [1, 2], position: 'bad', dir: [0, 0, 0], roll: 'x', scale: [2] });
  near(loose.pivot, [1, 2, 0]);
  near(loose.position, [0, 0, 0]);
  near(loose.dir, [0, 0, -1]);
  assert.equal(loose.roll, 0);
  near(loose.scale, [1, 1, 1]);

  near(nodeWorldPos(undefined), [0, 0, 0]);
  near(nodeBasis({}).forward, [0, 0, -1]);
  near(frameOf(undefined).pos, [0, 0, 0]);
  near(frameToNode(null).pivot, [0, 0, 0]);
  assert.equal(parentDelta(null, bindFrameFor(node())), null);
  assert.equal(parentDelta(undefined, undefined), null);
  assert.deepEqual(applyParentToNode(undefined, null, null), node(), 'no parent frame -> defaults');
  near(mapParentPoint(null, [1, 2, 3]), [1, 2, 3]);
  near(mapParentVector(undefined, [1, 2, 3]), [1, 2, 3]);
  near(applyParentToNode(node({ pivot: [1, 0, 0] }), frameOf(node()), null).pivot, [1, 0, 0], 1e-12, 'missing bind does not throw');

  assert.equal(isValidSpatialNode(undefined), true, 'an absent node is valid');
  assert.equal(isValidSpatialNode(node()), true);
  assert.equal(isValidSpatialNode({ pivot: [0, 0, 0] }), false);
  const issues = spatialNodeIssues({ pivot: [0, 0, 0], position: [0, 0, 0], dir: [0, 0, 0], roll: 'x', scale: [1, 1, 1] });
  assert.deepEqual(issues.map((i) => i.path).sort(), ['node.dir', 'node.roll']);
  assert.deepEqual(spatialNodeIssues(undefined), [], 'optional node');
  assert.deepEqual(spatialNodeIssues(null).map((i) => i.path), ['node'], 'null is not an object');
});

test('spatial: normalisation preserves element nodes and never fabricates them', () => {
  const p = normalizeProject(createProject({ title: 'spatial' }));
  const nodeA = { pivot: [1, 2, 3], position: [0, 0, 0], dir: [0, 0, 1], roll: 45, scale: [2, 2, 1] };
  p.elements.push({
    id: 'el_node', type: 'text', start: 0, duration: 2,
    transform: { x: 10, y: 20, scale: 2, rotation: 45 }, node: { ...nodeA, pivot: [1, 2, 3] },
  });
  p.elements.push({
    id: 'el_legacy', type: 'text', start: 0, duration: 2,
    transform: { x: 10, y: 20, scale: 2, rotation: 45 },
  });
  const q = normalizeProject(p);
  assert.deepEqual(q.elements[0].node, nodeA, 'existing node data is preserved');
  assert.deepEqual(q.elements[0].transform, { x: 10, y: 20, scale: 2, rotation: 45, opacity: 1 }, 'legacy transform is kept next to node');
  assert.equal('node' in q.elements[1], false, 'legacy elements never gain a node');
  assert.equal(JSON.stringify(q.elements[1]).includes('"node"'), false, 'nothing is written by loading');
  assert.deepEqual(validateProject(q), [], 'a full node validates');

  const partial = { elements: [{ id: 'el_partial', type: 'text', start: 0, duration: 1, node: { roll: 5 } }] };
  const r = normalizeProject(partial);
  assert.deepEqual(r.elements[0].node, { roll: 5 }, 'partial nodes are not rewritten on load');

  const bad = structuredClone(q);
  bad.elements[0].node.pivot = [1, 2];
  bad.elements[0].node.dir = [0, 0, 0];
  const paths = validateProject(bad).map((i) => i.path);
  assert.ok(paths.includes('elements[0].node.pivot'), 'bad pivot is reported');
  assert.ok(paths.includes('elements[0].node.dir'), 'zero direction is reported');
  assert.ok(!paths.some((path) => path.startsWith('elements[1].node')), 'legacy element is unaffected');
});

test('spatial: parent math matches the shipped 3D object hierarchy', () => {
  const p = normalizeProject(createProject({ title: 'hier', duration: 10 }));
  const add = (object) => applyOp(p, { op: 'objectAdd', object }).changed[0];
  const parent = add({ id: 'ob_rig', type: 'empty', pivot: [0, 0, 0] });
  applyOp(p, { op: 'objectKey', id: parent, path: 'pivot', t: 0, v: [0, 0, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: parent, path: 'pivot', t: 2, v: [10, 0, 0] });
  applyOp(p, { op: 'objectKey', id: parent, path: 'dir', t: 0, v: [0, 0, -1], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: parent, path: 'dir', t: 2, v: [1, 0, 0] });
  const child = add({ id: 'ob_box', type: 'solid', pivot: [0, 0, -5] });
  applyOp(p, { op: 'objectParent', id: child, parent, t: 0 });
  const parentObj = p.scene.objects.find((o) => o.id === parent);
  const childObj = p.scene.objects.find((o) => o.id === child);
  // The stored 3D bind uses `pos`; the unified reader accepts it as `pivot`.
  const bind = childObj.parent.bind;
  assert.equal(bind.pivot, undefined);
  for (const t of [0, 0.7, 2]) {
    const expected = worldPose(p, childObj, t);
    const got = frameOf(applyParentToNode(
      objectNode(childObj, t),
      poseFrameOf(worldPose(p, parentObj, t)),
      bind,
    ));
    near(got.pos, expected.worldPos, 1e-6, `worldPos @${t}`);
    near(got.basis, [expected.basis.right, expected.basis.up, expected.basis.forward], 1e-6, `basis @${t}`);
    near(got.scale, expected.scale, 1e-6, `scale @${t}`);
  }
});
