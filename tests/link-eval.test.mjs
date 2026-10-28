// Link-aware evaluation: the viewport / bake / Blender overlay must use the
// SAME effective values the property rows show (core/link-eval.js).
//
// Covered here:
//   - 2D node links (elementNodeWithLinks / elementWorldNodeWithLinks)
//   - 3D object links, including a linked frameParent host
//   - camera links (fov) through evalCameraWorld, shot bake included
//   - the Blender overlay table (elementLinkOverlay / ...Table)
//   - byte-identical bake for a project without links
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { ensureSpace, screenCenterY } from '../core/space.js';
import { bakeCameraTrack, cameraParamValue } from '../core/camera.js';
import {
  elementLinkOverlay, elementLinkOverlayTable, elementNodeWithLinks,
  elementWorldNodeWithLinks, evalCameraWorldWithLinks, objectWorldPoseWithLinks,
} from '../core/link-eval.js';
import { elementLocalNode, objectWorldPose } from '../core/spatial-parent.js';
import { elementOverlay } from '../core/links.js';
import { evalElement } from '../core/evaluate.js';
import { bakeObjects, buildShot } from '../engine/shot.js';

const cy = screenCenterY({ width: 1920, height: 1080 });
const near = (a, b, eps = 1e-6, msg = '') => {
  assert.ok(Number.isFinite(a), `${msg}: ${a} is not finite`);
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

function fresh() {
  const p = normalizeProject(createProject({ title: 'link-eval', duration: 4 }));
  ensureSpace(p);
  return p;
}

const addEl = (p, over = {}) => applyOp(p, {
  op: 'addElement',
  element: { type: 'solid', start: 0, duration: 4, ...over },
}).element;

const addNodeEl = (p, pivot = [0, cy, 0], over = {}) => addEl(p, {
  node: { pivot, position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1] },
  ...over,
});

const addObj = (p, over = {}) => {
  const result = applyOp(p, {
    op: 'objectAdd',
    object: {
      type: 'solid', start: 0, duration: 4, pivot: [0, cy, 0],
      geom: { w: 1, h: 1, d: 1 }, rot: { dir: [0, 0, -1], roll: 0 }, scale: [1, 1, 1],
      ...over,
    },
  });
  return p.scene.objects.find((o) => o.id === result.changed[0]);
};

const link = (p, id, to, from) => applyOp(p, { op: 'propLink', id, to, from, t: 0 }).link;

const keyObj = (p, id, path, keys) => {
  for (const [t, v] of keys) applyOp(p, { op: 'objectKey', id, path, t, v, ease: 'linear' });
};

const keyEl = (p, id, path, keys) => {
  for (const [t, value] of keys) applyOp(p, { op: 'keySet', id, path, t, value, ease: 'linear' });
};

test('link-eval: a linked 2D node channel feeds the viewport node and its world frame', () => {
  const p = fresh();
  const src = addObj(p, { id: 'ob_src' });
  keyObj(p, src.id, 'pivot', [[0, [0, 0, 0]], [2, [1, 0, 0]]]);
  const el = addNodeEl(p, [0, cy, 0]);
  link(p, el.id, 'pivot.x', { host: 'ob', id: src.id, path: 'pivot.x' });

  near(elementNodeWithLinks(p, el, 0).pivot[0], 0, 1e-9, 'bind is a no-op');
  near(elementNodeWithLinks(p, el, 1).pivot[0], 0.5, 1e-9, 'local 0 + parent 0.5');
  near(elementLocalNode(p, el, 1).pivot[0], 0, 1e-9, 'the local node stays untouched');
  near(elementWorldNodeWithLinks(p, el, 1).pivot[0], 0.5, 1e-9, 'unparented world node = effective node');

  // A world parent carries the effective child node: the parent offset adds on
  // top of the child's own link instead of replacing it.
  const parentEl = addNodeEl(p, [0, cy, 0]);
  applyOp(p, { op: 'spatialParent', id: el.id, parent: parentEl.id, t: 0 });
  keyEl(p, parentEl.id, 'pivot.x', [[0, 0], [2, 3]]);
  near(elementWorldNodeWithLinks(p, el, 2).pivot[0], 3 + 1, 1e-6, 'parent offset + child link');
});

test('link-eval: 3D object links reach objectWorldPose, including a linked frameParent host', () => {
  const p = fresh();
  const src = addObj(p, { id: 'ob_src' });
  keyObj(p, src.id, 'pivot', [[0, [0, 0, 0]], [2, [1, 0, 0]]]);

  const child = addObj(p, { id: 'ob_child', pivot: [0.2, cy, 0] });
  link(p, child.id, 'pivot.x', { host: 'ob', id: src.id, path: 'pivot.x' });
  near(objectWorldPoseWithLinks(p, child, 1).worldPos[0], 0.2 + 0.5, 1e-9, 'own link moves the world pose');
  near(objectWorldPose(p, child, 1).worldPos[0], 0.2, 1e-9, 'plain objectWorldPose stays local');

  const host = addNodeEl(p, [0, cy, 0]);
  keyEl(p, host.id, 'pivot.x', [[0, 0], [2, 3]]);
  const rider = addObj(p, { id: 'ob_rider', pivot: [0.2, cy, 0] });
  applyOp(p, { op: 'spatialParent', id: rider.id, parent: host.id, t: 0 });
  link(p, host.id, 'pivot.x', { host: 'ob', id: src.id, path: 'pivot.x' });
  near(objectWorldPoseWithLinks(p, rider, 2).worldPos[0], 0.2 + 3 + 1, 1e-6, 'parent link carries the child');
});

test('link-eval: camera fov links feed evalCameraWorld and the shot bake', () => {
  const p = fresh();
  const cam = p.cameras[0];
  const el = addNodeEl(p, [0, cy, 0]);
  keyEl(p, el.id, 'roll', [[0, 0], [2, 30]]);
  const localFov = cameraParamValue(cam, 'fov', 1);
  link(p, cam.id, 'fov', { host: 'el', id: el.id, path: 'roll' });

  near(evalCameraWorldWithLinks(p, 1).fov, localFov + 15, 1e-6, 'fov = local + parent roll delta');
  near(evalCameraWorldWithLinks(p, 2).fov, localFov + 30, 1e-6, 'end of the key');
  const shot = buildShot(p, { fps: 24, from: 0, to: 2 });
  near(shot.camera.find((f) => f.t === 2).fov, localFov + 30, 1e-3, 'bake uses the effective fov');

  // A parented camera keeps its effective lens while the parent moves its frame.
  const host = addObj(p, { id: 'ob_host', pivot: [0, cy, 0] });
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: host.id, t: 0 });
  keyObj(p, host.id, 'pivot', [[0, [0, cy, 0]], [2, [2, cy, 0]]]);
  const world = evalCameraWorldWithLinks(p, 2);
  near(world.fov, localFov + 30, 1e-6, 'frameParent does not swallow the linked fov');
  assert.equal(world.frameParentId, host.id, 'the camera really is parented');
  near(world.pos[0] - evalCameraWorldWithLinks(p, 0).pos[0], 2, 1e-3, 'parent moved the camera 0 -> 2 m');
});

test('link-eval: blender overlay table matches the JS evaluator', () => {
  const p = fresh();
  const src = addObj(p, { id: 'ob_src' });
  keyObj(p, src.id, 'pivot', [[0, [0, 0, 0]], [2, [1, 0, 0]]]);

  // Legacy 2D element: overlay in project px / screen y, applied by evalElement.
  const legacy = addEl(p, { transform: { x: 10, y: 20, scale: 1, rotation: 0, opacity: 1 } });
  link(p, legacy.id, 'pivot.x', { host: 'ob', id: src.id, path: 'pivot.x' });
  near(elementLinkOverlay(p, legacy, 1).x, 60, 1e-9, 'legacy x = local 10 px + 0.5 m');
  assert.equal(elementOverlay(p, legacy, 1).x, 60, 'legacy overlay reuses elementOverlay');
  near(evalElement(legacy, 1, p.meta, elementLinkOverlay(p, legacy, 1)).x, 60, 1e-9, 'evalElement takes the overlay');

  // Migrated node element: flat ±Z, pivot + position collapse into x/y/z.
  const nodeEl = addNodeEl(p, [0.2, cy, 0]);
  link(p, nodeEl.id, 'position.x', { host: 'ob', id: src.id, path: 'pivot.x' });
  link(p, nodeEl.id, 'style.size', { host: 'ob', id: src.id, path: 'pivot.x' });
  const overlay = elementLinkOverlay(p, nodeEl, 1);
  near(overlay.x, (0.2 - 0.5) * 100, 1e-9, 'x = (pivot.x − position.x) · 100');
  near(overlay.y, 0, 1e-9, 'y unchanged');
  near(overlay.z, 0, 1e-9, 'z unchanged');
  near(overlay.size, 96.5, 1e-9, 'node style.size reaches Blender');
  near(elementOverlay(p, nodeEl, 1).size, 96.5, 1e-9, 'and the preview evalElement overlay');

  // Per-frame table indexed by round(t · fps), empty frames stay empty.
  const table = elementLinkOverlayTable(p, nodeEl, { fps: 24 });
  assert.equal(table.fps, 24);
  assert.equal(table.values.length, 4 * 24 + 1);
  assert.deepEqual(table.values[24], overlay);
  assert.equal(table.values[0].x, 20, 'frame 0: local pivot only');
  assert.equal(table.values[0].size, 96, 'frame 0: local size');
  assert.equal(elementLinkOverlay(p, addEl(p, { type: 'solid' }), 1), null, 'no links -> no overlay');
});

test('link-eval: a project without links bakes exactly as before', () => {
  const p = fresh();
  const plainObj = addObj(p, { id: 'ob_plain', pivot: [1, cy, 2] });
  addEl(p, { transform: { x: 12, y: -8, scale: 1, rotation: 3, opacity: 1 } });

  const plain = JSON.stringify(bakeCameraTrack(p, { fps: 24 }));
  const withParam = JSON.stringify(bakeCameraTrack(p, { fps: 24, param: (cam, path, t) => cameraParamValue(cam, path, t) }));
  assert.equal(withParam, plain, 'camera bake is byte-identical');

  for (const obj of p.scene.objects) {
    for (const t of [0, 1.5, 3]) {
      assert.equal(
        JSON.stringify(objectWorldPose(p, obj, t, new Map())),
        JSON.stringify(objectWorldPoseWithLinks(p, obj, t, new Map())),
        `object ${obj.id} at ${t} is byte-identical`,
      );
    }
  }

  const baked = bakeObjects(p, { fps: 24, from: 0, to: 2 });
  for (const frame of baked.find((o) => o.id === plainObj.id).frames) {
    const t = (frame.f - 1) / 24;
    const world = objectWorldPoseWithLinks(p, plainObj, t);
    near(frame.loc[0], Math.round(world.worldPos[0] * 1000) / 1000, 1e-3, `frame ${frame.f}`);
  }
});
