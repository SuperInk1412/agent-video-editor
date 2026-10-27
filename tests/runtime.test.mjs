import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectService } from '../engine/projects.js';
import { connectRuntime } from '../engine/runtime.js';
import { startServer } from '../engine/server.js';

test('concurrent clients discover one owner; CLI and HTTP use the same history and queue', { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-runtime-'));
  await projectService(root).transact({ command: { type: 'initialize', options: { duration: 1, width: 64, height: 64 } } });
  let runtime;
  t.after(async () => { if (runtime) await runtime.call('runtime.stop').catch(() => {}); await new Promise((r) => setTimeout(r, 100)); await fs.rm(root, { recursive: true, force: true }); });
  const [a, b] = await Promise.all([connectRuntime(root), connectRuntime(root)]);
  runtime = a;
  assert.equal(a.info.instanceId, b.info.instanceId);
  const attached = await startServer({ root, port: 0 });
  assert.equal(attached.remote, true);
  await attached.close();
  assert.equal((await a.call('project.read')).rev, 1);
  await promisify(execFile)(process.execPath, ['cli/vdm.js', 'ops', JSON.stringify({ requestId: 'cli', expectedRev: 1, ops: [{ op: 'addElement', element: { type: 'solid', duration: 1 } }] }), '--project', root, '--json']);
  assert.equal((await b.call('project.history')).undo, 1);
  assert.equal((await b.call('project.read')).rev, 2);
  const unauthenticated = await fetch(a.info.url + 'api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'project.read' }) });
  assert.equal(unauthenticated.status, 403);
});
