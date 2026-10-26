import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock, paths } from './storage.js';
import { fault } from '../application/errors.js';

export async function claimRuntime(root) {
  let acquired, failed, release;
  const ready = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
  const gate = new Promise((resolve) => { release = resolve; });
  const held = withLock(root, async () => { acquired(); await gate; }, { lockName: 'runtime-lock', timeout: 150 });
  held.catch(failed);
  try { await ready; }
  catch (e) { throw fault('RUNTIME_EXISTS', 'another runtime owns this project', { cause: e }); }
  return async () => { release(); await held; };
}

export async function discoverRuntime(root) {
  let info;
  try { info = JSON.parse(await fs.readFile(paths(root).app, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
  if (info.root !== root || !info.instanceId || !info.token || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(info.url)) return null;
  try {
    const response = await fetch(info.url + 'api/runtime', { signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    if (health.instanceId !== info.instanceId || health.root !== root || health.version !== 1) return null;
    return info;
  } catch { return null; }
}

export function runtimeClient(info) {
  return { info,
    async call(method, params = {}) {
      let response;
      try { response = await fetch(info.url + 'api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` }, body: JSON.stringify({ method, params }) }); }
      catch (cause) { throw fault('RUNTIME_UNAVAILABLE', 'project runtime is unavailable', { cause }); }
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.message || value.error), value, { status: response.status });
      return value;
    },
  };
}

/** Reuse the project's owner; CLI / MCP never create their own task queues. */
export async function connectRuntime(directory, { start = true } = {}) {
  const root = await fs.realpath(directory);
  let info = await discoverRuntime(root);
  if (info) return runtimeClient(info);
  if (!start) throw fault('RUNTIME_UNAVAILABLE', 'no project runtime available');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./runtime-main.js', import.meta.url)), '--project', root], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let failure;
  child.on('error', (e) => { failure = e; });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    info = await discoverRuntime(root);
    if (info) return runtimeClient(info);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw fault('RUNTIME_UNAVAILABLE', 'could not start project runtime');
}
