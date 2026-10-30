// Shared HTTP test harness: one throwaway project + one engine per test.
//
// The engine boots on port 0 (an ephemeral port), so suites can run in parallel
// and several suites in one file never collide. `post` speaks JSON, `get` is a
// plain fetch against the service root.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProject } from '../../core/schema.js';
import { applyOp } from '../../core/ops.js';
import { saveProject } from '../../engine/storage.js';
import { startServer } from '../../engine/server.js';

/**
 * Boot an engine over a fresh temp project with one `solid` element (`el_1`).
 *
 * @param {import('node:test').TestContext} t
 * @param {object} [options] passed through to startServer (uploadLimit, …)
 * @returns {Promise<{root: string, service: any, post: Function, get: Function}>}
 */
export async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-http-'));
  const p = createProject();
  applyOp(p, { op: 'addElement', element: { id: 'el_1', type: 'solid', duration: 2 } });
  await saveProject(root, p);
  await fs.mkdir(path.join(root, 'media'));
  const service = await startServer({ root, port: 0, ...options });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const post = (route, body) => fetch(service.info.url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (route, init) => fetch(service.info.url + route, init);
  return { root, service, post, get };
}

/** `GET route` -> { status, body } (JSON). */
export function getter(service) {
  return async (route) => {
    const response = await fetch(service.info.url + route);
    return { status: response.status, body: await response.json() };
  };
}
