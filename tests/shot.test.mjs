import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject } from '../core/schema.js';
import { buildShot } from '../engine/shot.js';

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
