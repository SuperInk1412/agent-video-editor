import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject } from '../core/schema.js';
import { buildShot, bakeObjects, worldSnapshot } from '../engine/shot.js';
import { applyOp } from '../core/ops.js';

const project = () => normalizeProject({
  schema: 'vdm.project/1', rev: 1,
  meta: { title: 'layers', fps: 24, width: 320, height: 180, duration: 1, background: '#000' },
  segments: [], elements: [],
  cameras: [
    {
      id: 'cam_top', name: '顶', visible: true,
      path: [{ t: 0, pos: [0, 10, 0] }, { t: 1, pos: [0, 10, -20] }],
      opacity: 0.8,
      tracks: {
        scale: [{ t: 0, v: [0.5, 0.5, 1] }],
        pictureOffset: [{ t: 0, v: [0.1, -0.2] }],
      },
    },
    {
      id: 'cam_bottom', name: '底', visible: true,
      path: [{ t: 0, pos: [5, 20, 0] }, { t: 1, pos: [5, 20, -20] }],
    },
    {
      id: 'cam_hidden', name: '藏', visible: false,
      path: [{ t: 0, pos: [9, 9, 9] }],
    },
  ],
  cameraOrder: ['cam_top', 'cam_bottom', 'cam_hidden'],
  activeCameraId: 'cam_top',
  world: {},
});

test('buildShot exposes one baked layer per visible camera, top first', () => {
  const shot = buildShot(project(), { fps: 24, from: 0, to: 1 });
  assert.deepEqual(shot.cameraLayers.map((l) => l.id), ['cam_top', 'cam_bottom']);
  assert.equal(shot.cameraLayers[0].frames.length, 25);
  assert.equal(shot.cameraLayers[0].frames[0].f, 1);
  assert.equal(shot.cameraLayers[0].frames[0].opacity, 0.8);
  assert.deepEqual(shot.cameraLayers[0].frames[0].scale, [0.5, 0.5]);
  assert.deepEqual(shot.cameraLayers[0].frames[0].pictureOffset, [0.1, -0.2]);
  assert.equal(shot.cameraLayers[0].camera.length, 25);
  assert.ok(shot.cameraLayers[0].camera[0].dof);
  // legacy camera remains the active camera's bake
  assert.equal(shot.camera.length, 25);
  assert.deepEqual(shot.camera[0].pos, shot.cameraLayers[0].camera[0].pos);
});

test('hidden 3D objects do not appear in the render package', () => {
  const p = project();
  applyOp(p, { op: 'objectAdd', object: { id: 'hidden', type: 'solid', visible: false, duration: 1 } });
  applyOp(p, { op: 'objectAdd', object: { id: 'shown', type: 'solid', duration: 1 } });
  const baked = bakeObjects(p);
  assert.deepEqual(baked.map((obj) => obj.id), ['shown']);
  assert.equal(baked[0].frames[0].opacity, 1);
  assert.equal(baked[0].frames.at(-1).opacity, 0, 'the time range has an exclusive end');
});

test('worldSnapshot: a parented camera carries its parent animation into the city', () => {
  // The corridor clearing follows where the cameras fly. A camera parented to a
  // 3D object flies with that object's tracks, so the parent's animation is part
  // of the city's input — this is what the /api/world cache key has to include.
  const p = project();
  const ob = applyOp(p, {
    op: 'objectAdd',
    object: { type: 'empty', start: 0, duration: 1, pivot: [0, 10, 0] },
  }).changed[0];
  applyOp(p, { op: 'objectKey', id: ob, path: 'rotation.y', t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: ob, path: 'rotation.y', t: 1, v: 90 });
  applyOp(p, { op: 'spatialParent', id: 'cam_top', parent: ob, t: 0 });
  const animated = worldSnapshot(p).hash;

  // Flatten the animation: same project, same rev, different flight corridor.
  applyOp(p, { op: 'objectKey', id: ob, path: 'rotation.y', t: 1, v: 0 });
  const still = worldSnapshot(p).hash;
  assert.notEqual(animated, still, 'the city bake follows the parented camera');
});

test('viewport, full render and partial render share one full-shot city', () => {
  const p = project();
  p.meta.fps = 12;
  p.cameras[1].path = [{ t: 0, pos: [140, 8, 0] }, { t: 1, pos: [140, 8, -150] }];
  const world = worldSnapshot(p);
  assert.deepEqual(buildShot(p).city, world);
  assert.deepEqual(buildShot(p, { from: 0.5, to: 0.75 }).city, world);
  p.activeCameraId = 'cam_bottom';
  p.camera = p.cameras[1];
  assert.deepEqual(worldSnapshot(p), world, 'selecting the edit camera does not change world geometry');
});
