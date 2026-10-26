import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { withLock, paths, saveProject, mutateProject, loadProject } from '../engine/storage.js';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('an old mtime never evicts a live lock owner', async (t) => {
  const root = await directory(t);
  let ready, release;
  const started = new Promise((r) => { ready = r; });
  const held = new Promise((r) => { release = r; });
  const first = withLock(root, async () => { ready(); await held; });
  await started;
  try {
    const old = new Date(Date.now() - 60000);
    await fs.utimes(paths(root).lock, old, old);
    await assert.rejects(withLock(root, () => assert.fail('overlapping lock'), { timeout: 70, stale: 1 }), { code: 'LOCK_TIMEOUT' });
  } finally { release(); await first; }
  await withLock(root, () => {});
});

test('a stale owner cannot remove a successor owner marker', async (t) => {
  const root = await directory(t);
  let ready, release;
  const started = new Promise((r) => { ready = r; });
  const held = new Promise((r) => { release = r; });
  const first = withLock(root, async () => { ready(); await held; });
  await started;
  const lock = paths(root).lock;
  const [old] = await fs.readdir(lock);
  await fs.unlink(path.join(lock, old));
  await fs.writeFile(path.join(lock, 'successor-owner'), '');
  release();
  await first;
  assert.deepEqual(await fs.readdir(lock), ['successor-owner']);
});

test('project mutations recover locks left by a terminated process', { timeout: 10000 }, async (t) => {
  const root = await directory(t);
  await saveProject(root, createProject());
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url)), root], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  const [data] = await once(child.stdout, 'data');
  assert.match(String(data), /LOCKED/);
  child.kill('SIGKILL');
  await exited;
  await mutateProject(root, (p) => applyOp(p, { op: 'setMeta', path: 'title', value: 'recovered' }));
  const p = await loadProject(root);
  assert.equal(p.rev, 2);
  assert.equal(p.meta.title, 'recovered');
});

test('invalid writes preserve disk data, revision and camera object identities', async (t) => {
  const root = await directory(t);
  const p = createProject();
  applyOp(p, { op: 'addCamera', camera: { path: [{ t: 0, pos: [0, 2, 3] }] } });
  await saveProject(root, p);
  assert.equal(p.camera, p.cameras[0]);
  const before = await fs.readFile(paths(root).file, 'utf8');
  await assert.rejects(mutateProject(root, (current) => applyOp(current, { op: 'setMeta', path: 'duration', value: 0 })), { code: 'OP_INVALID' });
  assert.equal(await fs.readFile(paths(root).file, 'utf8'), before);
  assert.equal((await loadProject(root)).rev, 1);
});

test('core modules cannot import Node or engine modules', async () => {
  for (const name of await fs.readdir(new URL('../core/', import.meta.url))) {
    if (!name.endsWith('.js')) continue;
    const source = await fs.readFile(new URL(`../core/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(?\s*)['"](?:node:|[^'"]*\/engine\/)/, name);
  }
});
