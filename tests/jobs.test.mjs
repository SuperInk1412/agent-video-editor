import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJobService } from '../engine/jobs.js';
import { projectService } from '../engine/projects.js';
import { runProcess } from '../engine/process.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-jobs-'));
  const projects = projectService(root);
  await projects.transact({ command: { type: 'initialize', options: { width: 64, height: 64, duration: 1 } } });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, projects };
}

test('one queue bounds concurrency and cancellation waits for its child process to exit', { timeout: 10000 }, async (t) => {
  const { root, projects } = await fixture(t);
  let active = 0, peak = 0, spawned;
  const ready = new Promise((resolve) => { spawned = resolve; });
  const jobs = await createJobService(root, projects, () => {}, { execute: async (job, { signal }) => {
    active++; peak = Math.max(peak, active); spawned();
    try { await runProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal }); }
    finally { active--; }
    return {};
  } });
  t.after(() => jobs.close());
  const a = await jobs.submit({ kind: 'still', requestId: 'a' });
  const b = await jobs.submit({ kind: 'still', requestId: 'b' });
  await ready;
  assert.equal((await jobs.cancel(b.id)).status, 'cancelled');
  const cancel = await jobs.cancel(a.id);
  assert.ok(['cancelling', 'cancelled'].includes(cancel.status));
  assert.equal((await jobs.wait(a.id)).status, 'cancelled');
  assert.equal(active, 0);
  assert.equal(peak, 1);
});

test('queued jobs snapshot media content and retry across runtime restarts', async (t) => {
  const { root, projects } = await fixture(t);
  await fs.mkdir(path.join(root, 'media'));
  await fs.writeFile(path.join(root, 'media', 'asset.png'), 'original');
  await projects.transact({ ops: [{ op: 'addElement', element: { type: 'image', src: 'media/asset.png', duration: 1 } }] });
  const jobs = await createJobService(root, projects, () => {}, { execute: async () => ({ id: 'result' }) });
  const input = { kind: 'still', requestId: 'snapshot', expectedRev: 2 };
  const a = await jobs.submit(input);
  await fs.writeFile(path.join(root, 'media', 'asset.png'), 'changed');
  const snapshot = JSON.parse(await fs.readFile(path.join(root, '.vdm', 'jobs', a.id, 'project.json'), 'utf8'));
  assert.equal(await fs.readFile(path.join(root, snapshot.elements[0].src), 'utf8'), 'original');
  await jobs.wait(a.id);
  await jobs.close();
  const restarted = await createJobService(root, projects, () => {}, { execute: () => assert.fail('retry cannot execute again') });
  t.after(() => restarted.close());
  assert.equal((await restarted.submit(input)).id, a.id);
  await assert.rejects(restarted.submit({ ...input, time: 0.5 }), { code: 'REQUEST_ID_CONFLICT' });
});

test('render snapshots freeze audio elements and 3D media and deduplicate shared sources', async (t) => {
  const { root, projects } = await fixture(t);
  await fs.mkdir(path.join(root, 'media'));
  const originals = { 'song.m4a': 'sound', 'picture.png': 'image', 'clip.mp4': 'video' };
  for (const [name, content] of Object.entries(originals)) await fs.writeFile(path.join(root, 'media', name), content);
  await projects.transact({ ops: [
    { op: 'addElement', element: { id: 'sound', type: 'audio', src: 'media/song.m4a', duration: 1 } },
    { op: 'objectAdd', object: { id: 'picture', type: 'image', src: 'media/picture.png', duration: 1 } },
    { op: 'objectAdd', object: { id: 'video', type: 'video', src: 'media/clip.mp4', duration: 1 } },
    { op: 'objectAdd', object: { id: 'shared', type: 'image', src: 'media/picture.png', duration: 1 } },
  ] });
  const jobs = await createJobService(root, projects, () => {}, { execute: async () => ({}) });
  t.after(() => jobs.close());
  const job = await jobs.submit({ kind: 'still', expectedRev: 2, requestId: 'all-media' });
  await jobs.wait(job.id);
  const snapshot = JSON.parse(await fs.readFile(path.join(root, '.vdm', 'jobs', job.id, 'project.json'), 'utf8'));
  assert.equal(job.sources.length, 3);
  const inputs = [...snapshot.elements.filter((el) => el.type === 'audio'), ...snapshot.scene.objects];
  for (const name of Object.keys(originals)) await fs.writeFile(path.join(root, 'media', name), 'replaced');
  for (const entry of inputs) {
    const source = job.sources.find((item) => item.path === entry.src);
    assert.ok(source, `missing snapshotted source for ${entry.id}`);
    assert.equal(await fs.readFile(path.join(root, entry.src), 'utf8'), originals[path.basename(source.src)]);
  }
  assert.equal(snapshot.scene.objects.find((obj) => obj.id === 'picture').src, snapshot.scene.objects.find((obj) => obj.id === 'shared').src);
  assert.equal((await projects.read()).elements.find((el) => el.id === 'sound').src, 'media/song.m4a', 'project references stay relative to original media');
  assert.equal((await jobs.submit({ kind: 'still', expectedRev: 2, requestId: 'all-media' })).id, job.id, 'retry reuses the original input snapshot');
});

test('startup marks abandoned tasks interrupted; invalid time and stale revision fail', async (t) => {
  const { root, projects } = await fixture(t);
  const jobs = await createJobService(root, projects, () => {}, { execute: async () => ({}) });
  const job = await jobs.submit({ kind: 'still' });
  await jobs.wait(job.id); await jobs.close();
  const file = path.join(root, '.vdm', 'jobs', job.id, 'job.json');
  const abandoned = JSON.parse(await fs.readFile(file, 'utf8')); abandoned.status = 'rendering';
  await fs.writeFile(file, JSON.stringify(abandoned));
  const recovered = await createJobService(root, projects, () => {}, { execute: async () => ({}) });
  t.after(() => recovered.close());
  assert.equal((await recovered.get(job.id)).status, 'interrupted');
  await assert.rejects(recovered.submit({ kind: 'video', from: 0.5, to: 0.25 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(recovered.submit({ kind: 'still', expectedRev: 0 }), { code: 'REV_CONFLICT' });
});
