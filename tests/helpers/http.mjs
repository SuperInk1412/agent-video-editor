// Shared HTTP test harness: one throwaway project + one engine per test.
//
// `post` speaks JSON, `get` is a plain fetch against the service root.
//
// Ports: the engine never boots on an ephemeral port (`listen(0)`) here. The OS
// may hand out one of the ports `fetch` refuses to talk to (undici's `badPorts`,
// the fetch spec's blocked ports: 6000, 6665-6669, 10080, …), and then every
// request in the suite dies with the useless `TypeError: fetch failed` /
// `Error: bad port`. Instead `pickPort()` probes an explicit port inside a
// private slice (41000-41999, which contains no blocked port) and `setup()`
// re-checks whatever the engine actually bound before returning it.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createProject } from '../../core/schema.js';
import { applyOp } from '../../core/ops.js';
import { saveProject } from '../../engine/storage.js';
import { startServer } from '../../engine/server.js';

/**
 * Undici's `badPorts` (fetch spec § "blocked ports"). `fetch` rejects these
 * before a socket is opened, so the harness must never point a test at one.
 * Keep this in sync with undici if the spec list changes.
 */
export const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** The only ports the harness hands to the engine (none of them is blocked). */
export const PORT_RANGE = Object.freeze({ start: 41000, end: 41999 });

/** True when `fetch` refuses to connect to `port` at all (`bad port`). */
export function isBlockedPort(port) {
  return BLOCKED_PORTS.has(Number(port));
}

/** Resolve true when `127.0.0.1:port` can be bound right now. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * Pick a free, fetch-safe port from PORT_RANGE.
 *
 * A random start keeps parallel test processes (one per file) off each other's
 * port; the engine's own EADDRINUSE probe (`port + 1`) covers the remaining
 * race, and the range has 1000 slots for at most a handful of suites.
 */
export async function pickPort({ start = PORT_RANGE.start, end = PORT_RANGE.end } = {}) {
  const size = end - start + 1;
  const first = Math.floor(Math.random() * size);
  for (let i = 0; i < size; i += 1) {
    const port = start + ((first + i) % size);
    if (isBlockedPort(port)) continue;
    if (await portIsFree(port)) return port;
  }
  throw new Error(`no fetch-safe free port left in ${start}..${end}`);
}

/** Boot the engine on a fetch-safe port, retrying if it somehow lands elsewhere. */
async function startOnSafePort(root, options) {
  let port = options.port ?? await pickPort();
  for (let attempt = 0; ; attempt += 1) {
    const service = await startServer({ ...options, root, port });
    if (!isBlockedPort(service.info.port)) return service;
    await service.close();
    if (attempt >= 2) throw new Error(`engine bound fetch-blocked port ${service.info.port}`);
    port = await pickPort();
  }
}

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
  const service = await startOnSafePort(root, options);
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
