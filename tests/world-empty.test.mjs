import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorld, WORLD_SOURCES } from '../core/world.js';
import { generateCity, cityHash } from '../engine/city.js';
import { normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { buildShot } from '../engine/shot.js';

test('world-empty: normalisation keeps source none and rejects unknown sources', () => {
  assert.deepEqual(WORLD_SOURCES, ['procedural', 'none']);
  const w = normalizeWorld({ source: 'none' });
  assert.equal(w.source, 'none');
  assert.equal(typeof w.sky, 'string');
  assert.ok(w.fog && w.corridor && w.grid, 'other fields still normalised');
  assert.equal(normalizeWorld({ source: 'mars' }).source, 'procedural');
  assert.equal(normalizeWorld().source, 'procedural');
});

test('world-empty: an empty city has the same shape and no geometry', () => {
  const full = generateCity({ source: 'procedural', seed: 7 });
  const empty = generateCity({ source: 'none', seed: 7, sky: '#f2f0eb' });
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(full).sort());
  assert.equal(empty.empty, true);
  assert.equal(full.empty, false);
  assert.equal(empty.source, 'none');
  assert.equal(empty.buildings.length, 0);
  assert.equal(empty.neons.length, 0);
  assert.ok(full.buildings.length > 0);
  assert.ok(empty.bounds.x1 > empty.bounds.x0);
  assert.equal(empty.sky.length, 3);
  assert.notEqual(cityHash({ source: 'none', seed: 7 }), cityHash({ source: 'procedural', seed: 7 }));
});

test('world-empty: worldSet switches source both ways and a shot bakes', () => {
  const p = normalizeProject({
    schema: 'vdm.project/1', rev: 1,
    meta: { title: 'empty', fps: 10, width: 320, height: 180, duration: 1, background: '#000' },
    segments: [], elements: [],
    cameras: [{ id: 'cam_1', name: 'c', visible: true, path: [{ t: 0, pos: [0, 5.4, 20], look: [0, 5.4, 0] }] }],
    cameraOrder: ['cam_1'], activeCameraId: 'cam_1',
  });
  applyOp(p, { op: 'worldSet', patch: { source: 'none' } });
  applyOp(p, { op: 'objectAdd', object: { id: 'ob_1', type: 'solid', pivot: [0, 5.4, 0] } });
  let shot = buildShot(p);
  assert.equal(shot.city.empty, true);
  assert.equal(shot.city.buildings.length, 0);
  assert.equal(shot.objects.length, 1, 'user objects still bake');
  assert.ok(shot.camera.length > 0);
  applyOp(p, { op: 'worldSet', patch: { source: 'procedural' } });
  shot = buildShot(p);
  assert.equal(shot.city.empty, false);
  assert.ok(shot.city.buildings.length > 0);
});
