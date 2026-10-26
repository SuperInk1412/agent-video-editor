import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProject, normalizeProject } from '../core/schema.js';
import { worldSnapshot, writeShot } from '../engine/shot.js';
import { compute } from '../engine/compute.js';

test('world workers match synchronous geometry and shot caches use content identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-compute-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = normalizeProject({ ...createProject({ duration: 1, fps: 4 }), camera: {
    id: 'cam_1', path: [{ t: 0, pos: [0, 20, 0] }, { t: 1, pos: [10, 20, -50] }],
  } });
  assert.deepEqual(await compute('world', project), worldSnapshot(project));
  const first = await writeShot(root, project);
  project.rev++;
  const second = await writeShot(root, project);
  assert.equal(second.file, first.file, 'revision alone does not invalidate geometry');
  assert.deepEqual(second.shot, first.shot);
  project.cameras[0].path[1].pos[0] += 10;
  const changed = await writeShot(root, project);
  assert.notEqual(changed.file, first.file);
});

test('cancelling CPU work terminates its worker without blocking the parent', async () => {
  const controller = new AbortController();
  const project = createProject();
  const pending = compute('world', project, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});
