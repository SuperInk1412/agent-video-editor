// Baked shot parity for unified spatial parents (PLAN-ui-round3 §3.1).
//
// 3D objects and cameras can be spatial children (obj.frameParent /
// cam.frameParent). The preview and the Blender shot must read the same world
// frame (core/spatial-parent.js::objectWorldPose / evalCameraWorld), while a
// project without frameParent keeps the shipped bake byte-for-byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { ensureSpace, screenCenterY } from '../core/space.js';
import { evalCamera } from '../core/camera.js';
import { worldPose } from '../core/hierarchy.js';
import { evalCameraWorld, objectLocalPoint, objectLocalVector, objectWorldPose } from '../core/spatial-parent.js';
import { objectPose } from '../core/scene.js';
import { bakeObjects, buildShot } from '../engine/shot.js';

const near = (a, b, eps = 1e-3, msg = '') => {
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${msg}: expected arrays (${a} / ${b})`);
    assert.equal(a.length, b.length, `${msg}: length`);
    a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
    return;
  }
  assert.ok(Number.isFinite(a), `${msg}: ${a} is not finite`);
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

const cy = screenCenterY({ width: 1920, height: 1080 });
const r3 = (v) => Math.round(Number(v) * 1000) / 1000;

function fresh() {
  const p = normalizeProject(createProject({ title: 'spatial-child-bake', duration: 4 }));
  ensureSpace(p);
  return p;
}

const addEl = (p, pivot) => applyOp(p, {
  op: 'addElement',
  element: { type: 'solid', start: 0, duration: 4, node: { pivot, dir: [0, 0, 1], roll: 0, scale: [1, 1, 1] } },
}).element;

const addEmpty = (p, pivot) => applyOp(p, {
  op: 'objectAdd',
  object: {
    type: 'solid', start: 0, duration: 4, pivot, geom: { w: 1, h: 1, d: 1 },
    rot: { dir: [0, 0, -1], roll: 0 }, scale: [1, 1, 1],
  },
}).changed[0];

const keyRoll = (p, id, from, to, t = 2) => {
  applyOp(p, { op: 'keySet', id, path: 'roll', t: 0, value: from, ease: 'linear' });
  applyOp(p, { op: 'keySet', id, path: 'roll', t, value: to });
};

test('spatial-child-bake: baked objects follow the same objectWorldPose as the preview', () => {
  const p = fresh();
  const parent = addEl(p, [0, cy, 0]);
  keyRoll(p, parent.id, 0, 90);
  const ob = addEmpty(p, [2, cy, 0]);
  const obj = p.scene.objects.find((o) => o.id === ob);
  applyOp(p, { op: 'spatialParent', id: ob, parent: parent.id, t: 0 });

  const baked = bakeObjects(p, { fps: 24, from: 0, to: 2 });
  const track = baked.find((o) => o.id === ob).frames;
  for (const f of [1, 25, 49]) {
    const t = (f - 1) / 24;
    near(track.find((x) => x.f === f).loc, objectWorldPose(p, obj, t).worldPos.map(r3), 1e-3, `baked loc f=${f}`);
  }
  near(track.find((x) => x.f === 49).loc, [0, cy - 2, 0], 1e-3, 'bake orbits with the 2D parent');

  // A project without frameParent keeps the shipped worldPose values exactly.
  const plain = fresh();
  const free = addEmpty(plain, [1, cy, 2]);
  const freeObj = plain.scene.objects.find((o) => o.id === free);
  const freeTrack = bakeObjects(plain, { fps: 24, from: 0, to: 1 }).find((o) => o.id === free).frames;
  near(freeTrack[0].loc, worldPose(plain.scene.objects, freeObj, 0).worldPos.map(r3), 1e-12, 'plain bake unchanged');
});

test('spatial-child-bake: the gizmo inverse maps a parented object world pose back to its local values', () => {
  const p = fresh();
  const parent = addEl(p, [0, cy, 0]);
  keyRoll(p, parent.id, 0, 90);
  const ob = addEmpty(p, [2, cy, 0]);
  const obj = p.scene.objects.find((o) => o.id === ob);
  applyOp(p, { op: 'spatialParent', id: ob, parent: parent.id, t: 0 });
  for (const t of [0, 1, 2]) {
    const world = objectWorldPose(p, obj, t);
    const local = objectPose(obj, t);
    near(objectLocalPoint(p, obj, t, world.pivot), local.pivot, 1e-6, `local pivot t=${t}`);
    near(objectLocalVector(p, obj, t, world.basis.forward), local.dir, 1e-6, `local dir t=${t}`);
  }
});

test('spatial-child-bake: a camera frameParent is baked into the shot and camera layers', () => {
  const p = fresh();
  const cam = p.cameras[0];
  const ob = addEmpty(p, [0, cy, 0]);
  applyOp(p, { op: 'spatialParent', id: cam.id, parent: ob, t: 0 });
  applyOp(p, { op: 'objectKey', id: ob, path: 'pivot', t: 0, v: [0, cy, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: ob, path: 'pivot', t: 2, v: [3, cy, 0] });

  const shot = buildShot(p, { fps: 24, from: 0, to: 2 });
  const world = evalCameraWorld(p, 2);
  const frame = shot.camera.find((e) => e.t === 2) || shot.camera[shot.camera.length - 1];
  near(frame.pos, world.pos.map(r3), 1e-3, 'single-camera bake follows the parent');
  assert.ok(Math.abs(frame.pos[0] - evalCamera(p, 2).pos[0]) > 1, 'the bake really moved off the local camera');
  const layer = shot.cameraLayers.find((l) => l.id === cam.id);
  if (layer) near(layer.camera.find((e) => e.t === 2).pos, world.pos.map(r3), 1e-3, 'layer bake matches');

  // A project without frameParent still bakes exactly evalCamera.
  const plain = fresh();
  const plainShot = buildShot(plain, { fps: 24, from: 0, to: 1 });
  near(plainShot.camera[0].pos, evalCamera(plain, 0).pos.map(r3), 1e-12, 'plain camera bake unchanged');
});
