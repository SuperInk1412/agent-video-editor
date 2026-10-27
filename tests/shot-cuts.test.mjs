import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProject } from '../core/schema.js';
import { buildShot, isCutSequence } from '../engine/shot.js';

const base = (cams) => normalizeProject({
  schema: 'vdm.project/1', rev: 1,
  meta: { title: 'cuts', fps: 10, width: 320, height: 180, duration: 3, background: '#000' },
  segments: [], elements: [],
  world: { source: 'none' },
  cameras: cams,
  cameraOrder: cams.map((c) => c.id),
  activeCameraId: cams[0].id,
});
const cam = (id, start, duration, extra = {}) => ({
  id, name: id, visible: true, start, duration, path: [{ t: start, pos: [0, 5, 20], look: [0, 5, 0] }], ...extra,
});

test('shot-cuts: clips that follow one another are a cut sequence', () => {
  const p = base([cam('cam_a', 0, 1), cam('cam_b', 1, 1.2), cam('cam_c', 2.2, 0.8)]);
  assert.equal(isCutSequence(p), true);
  const shot = buildShot(p);
  assert.equal(shot.cameraLayers.length, 0, 'rendered through the single live-camera track');
  assert.ok(shot.camera.length > 0);
});

test('shot-cuts: overlaps, picture transforms or open ranges keep the layer stack', () => {
  assert.equal(isCutSequence(base([cam('cam_a', 0, 1.5), cam('cam_b', 1, 2)])), false, 'overlap');
  assert.equal(isCutSequence(base([cam('cam_a', 0, 1), cam('cam_b', 1, 2, { opacity: 0.5 })])), false, 'opacity');
  assert.equal(isCutSequence(base([cam('cam_a', 0, 1), cam('cam_b', 1, 2, { pictureOffset: [0.1, 0] })])), false, 'offset');
  const open = cam('cam_b', 1, 2);
  delete open.start; delete open.duration;
  assert.equal(isCutSequence(base([cam('cam_a', 0, 1), open])), false, 'no explicit range');
  assert.equal(isCutSequence(base([cam('cam_a', 0, 3)])), false, 'a single camera is not a sequence');
  assert.ok(buildShot(base([cam('cam_a', 0, 1.5), cam('cam_b', 1, 2)])).cameraLayers.length >= 1);
});
