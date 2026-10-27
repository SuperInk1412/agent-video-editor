import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SCREEN_DISTANCE, screenCenterY, defaultFov, screenToWorld, defaultWorld, defaultCamera, ensureSpace, hasCamera,
} from '../core/space.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { saveProject, loadProject } from '../core/store.js';
import { evalCamera } from '../core/camera.js';
import { applyOp } from '../core/ops.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('space: the screen plane sits on the ground and fills the default fov', () => {
  const meta = { width: 1920, height: 1080, background: '#F2F0EB' };
  assert.equal(SCREEN_DISTANCE, 20);
  near(screenCenterY(meta), 5.4);
  near(defaultFov(meta), (2 * Math.atan(9.6 / 20) * 180) / Math.PI);
  near(defaultFov(meta), 51.2820, 1e-4);
  assert.deepEqual(screenToWorld(meta, 0, 540), [0, 0, 0], 'bottom edge on the ground');
  assert.deepEqual(screenToWorld(meta, -960, -540, 1.5), [-9.6, 10.8, 1.5]);
  // the frame edge at distance D is exactly half the fov away
  const half = (defaultFov(meta) / 2) * Math.PI / 180;
  near(Math.tan(half) * SCREEN_DISTANCE, 9.6, 1e-9);
  near(screenCenterY({ width: 1080, height: 1920 }), 9.6, 1e-12);
});

test('space: defaults for world and camera', () => {
  const meta = { width: 1920, height: 1080, background: '#F2F0EB' };
  assert.deepEqual(defaultWorld(meta), { source: 'none', sky: '#F2F0EB' });
  const cam = defaultCamera(meta);
  assert.equal(cam.id, undefined, 'the op assigns the id');
  assert.deepEqual(cam.path, [{ t: 0, pos: [0, 5.4, 20], look: [0, 5.4, 0] }]);
  near(cam.fov, 51.2820, 1e-4);
});

test('space: ensureSpace upgrades camera-less projects once and leaves 3D projects alone', () => {
  const p = normalizeProject(createProject({ title: 'flat', background: '#F2F0EB' }));
  assert.equal(p.world.source, 'procedural', 'createProject still carries an unused city world');
  assert.equal(hasCamera(p), false);
  assert.equal(ensureSpace(p), true);
  assert.equal(p.world.source, 'none');
  assert.equal(p.world.sky, '#F2F0EB');
  assert.equal(p.cameras.length, 1);
  assert.equal(p.activeCameraId, p.cameras[0].id);
  assert.equal(p.camera, p.cameras[0]);
  const c = evalCamera(p, 0);
  assert.deepEqual(c.pos.map((v) => +v.toFixed(6)), [0, 5.4, 20]);
  assert.deepEqual(c.look.map((v) => +v.toFixed(6)), [0, 5.4, 0]);
  assert.equal(ensureSpace(p), false, 'idempotent');
  assert.equal(p.cameras.length, 1);

  const q = normalizeProject(createProject({ title: 'city' }));
  applyOp(q, { op: 'addCamera', camera: { path: [{ t: 0, pos: [1, 2, 3] }] } });
  const world = JSON.stringify(q.world);
  assert.equal(ensureSpace(q), false);
  assert.equal(JSON.stringify(q.world), world, 'world untouched when a camera exists');
});

test('space: loading a 2D project from disk upgrades it in memory only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-space-'));
  try {
    const p = normalizeProject(createProject({ title: 'legacy', background: '#112233' }));
    applyOp(p, { op: 'addElement', element: { type: 'text', start: 0, duration: 1, style: { text: 'hi' } } });
    await saveProject(dir, p);
    const before = await fs.readFile(path.join(dir, 'project.vdm.json'), 'utf8');
    const loaded = await loadProject(dir);
    assert.equal(loaded.world.source, 'none');
    assert.equal(loaded.world.sky, '#112233');
    assert.equal(loaded.cameras.length, 1);
    assert.equal(loaded.elements.length, 1, 'elements untouched');
    assert.equal(await fs.readFile(path.join(dir, 'project.vdm.json'), 'utf8'), before, 'loading does not write');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
