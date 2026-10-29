// Electron main process of the render host: `<electron> engine/render-workers/host.js`.
//
// It owns N hidden sandbox windows (the "pool") and talks newline delimited JSON
// with `pool.js`. Transport: the *pool* listens on 127.0.0.1 (ephemeral port) and
// the host connects out. Two reasons for this direction:
//   - a GUI-subsystem Electron process has no usable stdin on Windows (it sees
//     EOF immediately), so a stdin/stdout channel cannot carry requests;
//   - an outbound loopback connection never triggers a firewall prompt, whereas
//     a listening socket owned by electron.exe can.
// stdout/stderr stay free for diagnostics (Chromium noise, `VDM_RENDER_DEBUG`).
//
// Requests (see pool.js for the producer side):
//   { id, t:'render', source, key, frame, fps, size, params, setupParams, seed, beat, volume, wantRgba, timeoutMs }
//   { id, t:'load',   source, key, size, fps, seed, setupParams, loadTimeoutMs, timeoutMs }
//   { id, t:'post',   dataUrl, screenFx, time, timeoutMs }
//   { id, t:'probe',  sourceId, timeoutMs }
//   { id, t:'close' }
//   { id, t:'ping' }

import { app } from 'electron';
import net from 'node:net';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMessageDecoder, encodeMessage, safeRelative, sourceUrl, RUNTIMES,
} from './protocol.js';
import { errorFromPayload, errorPayload, workerFault } from './errors.js';
import { SandboxWindow, applyCommandLineSwitches, installProtocol, registerSchemePrivileges } from './window.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TRACE = !!process.env.VDM_RENDER_DEBUG;
const trace = (message) => {
  if (TRACE) process.stderr.write(`[vdm-render-host] ${message}\n`);
};

process.on('uncaughtException', (error) => {
  process.stderr.write(`[vdm-render-host] uncaught: ${error && error.stack}\n`);
});
process.on('unhandledRejection', (error) => {
  process.stderr.write(`[vdm-render-host] unhandled rejection: ${error && (error.stack || error)}\n`);
});

const argOf = (name, fallback = null) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const ROOT = path.resolve(argOf('root', process.cwd()));
const REPO = path.resolve(argOf('repo', path.join(HERE, '..', '..')));
const PORT = Number(argOf('port', '0'));
const TOKEN = String(argOf('token', ''));
const SLOTS = Math.max(1, Math.min(4, Number(argOf('slots', '1')) || 1));
const SOURCES = path.join(ROOT, 'sources');

registerSchemePrivileges();
const gl = applyCommandLineSwitches();
// Destroying a window must not end the process (§5.3: a timed-out frame kills
// its window, the host keeps serving the next frame).
app.on('window-all-closed', () => {
  trace('window-all-closed (host stays alive)');
});
app.on('before-quit', () => trace('before-quit'));
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

const slots = [];

// ---------------------------------------------------------------------------
// Transport: connect back to the pool.
// ---------------------------------------------------------------------------

let socket = null;
const outbox = [];

function send(message) {
  if (socket && socket.writable) {
    socket.write(encodeMessage(message));
    return;
  }
  outbox.push(message);
}

function flushOutbox() {
  if (!socket || !socket.writable) return;
  while (outbox.length) socket.write(encodeMessage(outbox.shift()));
}

function connectBack() {
  return new Promise((resolve, reject) => {
    if (!PORT) {
      reject(new Error('缺少 --port'));
      return;
    }
    const connection = net.connect({ host: '127.0.0.1', port: PORT });
    connection.setEncoding('utf8');
    connection.setNoDelay(true);
    connection.once('connect', () => {
      socket = connection;
      trace(`connected to pool on ${PORT}`);
      connection.write(encodeMessage({ t: 'hello', token: TOKEN }));
      flushOutbox();
      resolve(connection);
    });
    connection.once('error', (error) => {
      if (!socket) reject(error);
      else trace(`socket error: ${error.message}`);
    });
    connection.once('close', () => {
      trace('socket closed, quitting');
      for (const slot of slots) slot.sandbox?.kill();
      app.quit();
    });
  });
}

// ---------------------------------------------------------------------------
// Source resolution: only `<root>/sources/<id>/` exists for the page, and the
// manifest decides the entry point.
// ---------------------------------------------------------------------------

let sourcesReal = null;

async function sourcesRootReal() {
  if (sourcesReal) return sourcesReal;
  try {
    sourcesReal = await fs.realpath(SOURCES);
  } catch {
    throw workerFault('SOURCE_NOT_FOUND', `项目没有 sources/ 目录：${SOURCES}`);
  }
  return sourcesReal;
}

async function prepareSource(spec) {
  if (!spec || typeof spec !== 'object') throw workerFault('INVALID_ARGUMENT', '缺少 source');
  const id = String(spec.id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw workerFault('PATH_OUTSIDE_SCOPE', `非法的源 id：${id}`);
  const base = await sourcesRootReal();
  let real;
  try {
    real = await fs.realpath(path.join(base, id));
  } catch {
    throw workerFault('SOURCE_NOT_FOUND', `源不存在：sources/${id}`);
  }
  const relDir = path.relative(base, real);
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) throw workerFault('PATH_OUTSIDE_SCOPE', `源目录越界：sources/${id}`);

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(real, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw workerFault('SOURCE_NOT_FOUND', `源 ${id} 读不到 manifest.json：${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object') throw workerFault('SOURCE_INVALID', `源 ${id} 的 manifest 不是对象`);
  const runtime = String(spec.runtime || manifest.runtime || '');
  if (spec.runtime && manifest.runtime && spec.runtime !== manifest.runtime) {
    throw workerFault('UNSUPPORTED_RUNTIME', `源 ${id} 的 manifest 是 ${manifest.runtime}，请求里是 ${spec.runtime}`);
  }
  if (!RUNTIMES.includes(runtime)) throw workerFault('UNSUPPORTED_RUNTIME', `源 ${id} 的 runtime 不支持：${runtime}（支持 ${RUNTIMES.join(' / ')}）`);
  const entry = safeRelative(String(manifest.entry || ''));
  const file = path.join(real, entry);
  if (!fss.existsSync(file)) throw workerFault('SOURCE_NOT_FOUND', `源 ${id} 缺少入口文件 ${entry}`);

  let shaderText;
  if (runtime === 'glsl' && /\.(frag|glsl|vert)$/i.test(entry)) shaderText = await fs.readFile(file, 'utf8');
  return {
    id,
    dir: real,
    runtime,
    entry,
    entryUrl: sourceUrl(id, entry),
    shaderText: shaderText ?? spec.shaderText,
    manifest: { libs: manifest.libs || null, deterministic: manifest.deterministic ?? null },
  };
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

async function sandboxFor(slot) {
  if (slot.sandbox && slot.sandbox.alive) return slot.sandbox;
  if (slot.sandbox) slot.sandbox.kill();
  slot.loadedKey = null;
  const sandbox = new SandboxWindow({
    width: 640,
    height: 360,
    onConsole: (entry) => {
      if (entry.severity !== 'error') return;
      send({ event: 'console', slot: slot.index, ...entry });
    },
  });
  await sandbox.open();
  slot.sandbox = sandbox;
  return sandbox;
}

const unwrap = (result, phase) => {
  if (!result || typeof result !== 'object') throw workerFault('INTERNAL_ERROR', `${phase}：沙箱返回了非对象`);
  if (result.ok === true) return result.value;
  throw errorFromPayload(result.error, `${phase} 失败`);
};

async function loadInto(slot, source, request, timeoutMs) {
  if (slot.loadedKey === request.key) return;
  const sandbox = await sandboxFor(slot);
  const payload = {
    key: request.key,
    sourceId: source.id,
    runtime: source.runtime,
    entryUrl: source.entryUrl,
    shaderText: source.shaderText,
    size: request.size,
    fps: request.fps,
    seed: request.seed,
    params: request.setupParams || {},
    manifest: source.manifest,
  };
  const result = await sandbox.execute(`window.__vdmLoad(${JSON.stringify(payload)})`, {
    timeoutMs: Math.max(1000, timeoutMs || 4000),
    label: 'load',
  });
  unwrap(result, 'load');
  slot.loadedKey = request.key;
}

const clampTimeout = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 2000;
  return Math.max(50, Math.min(600000, Math.floor(num)));
};

function acquireSlot() {
  const free = slots.find((slot) => !slot.busy);
  if (!free) throw workerFault('INTERNAL_ERROR', '没有空闲的渲染窗口（调度 bug）');
  free.busy = true;
  return free;
}

function releaseSlot(slot) {
  slot.busy = false;
}

async function runRequest(request) {
  const timeoutMs = clampTimeout(request.timeoutMs);
  switch (request.t) {
    case 'ping':
      return { ok: true, pong: true, electron: process.versions.electron, chrome: process.versions.chrome, gl };

    case 'load': {
      const slot = acquireSlot();
      try {
        const source = await prepareSource(request.source);
        await loadInto(slot, source, request, request.loadTimeoutMs || timeoutMs);
        return { ok: true, value: { sourceId: source.id, runtime: source.runtime, entry: source.entry } };
      } finally {
        releaseSlot(slot);
      }
    }

    case 'render': {
      const slot = acquireSlot();
      try {
        const source = await prepareSource(request.source);
        await loadInto(slot, source, request, request.loadTimeoutMs || timeoutMs);
        const sandbox = await sandboxFor(slot);
        const framePayload = {
          frame: request.frame,
          fps: request.fps,
          size: request.size,
          params: request.params || {},
          seed: request.seed,
          beat: request.beat ?? null,
          volume: request.volume ?? null,
          wantRgba: !!request.wantRgba,
        };
        const result = await sandbox.execute(`window.__vdmRender(${JSON.stringify(framePayload)})`, {
          timeoutMs,
          label: 'render',
        });
        return { ok: true, value: unwrap(result, 'render') };
      } finally {
        releaseSlot(slot);
      }
    }

    case 'post': {
      const slot = acquireSlot();
      try {
        const sandbox = await sandboxFor(slot);
        const payload = { dataUrl: request.dataUrl, screenFx: request.screenFx || {}, time: request.time ?? 0 };
        const result = await sandbox.execute(`window.__vdmPost(${JSON.stringify(payload)})`, { timeoutMs, label: 'post' });
        return { ok: true, value: unwrap(result, 'post') };
      } finally {
        releaseSlot(slot);
      }
    }

    case 'probe': {
      const slot = acquireSlot();
      try {
        const sandbox = await sandboxFor(slot);
        const payload = { sourceId: request.sourceId || null };
        const result = await sandbox.execute(`window.__vdmProbe(${JSON.stringify(payload)})`, { timeoutMs, label: 'probe' });
        return { ok: true, value: unwrap(result, 'probe') };
      } finally {
        releaseSlot(slot);
      }
    }

    default:
      throw workerFault('INVALID_ARGUMENT', `未知请求类型：${request.t}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch: at most `SLOTS` requests in flight, one per window.
// ---------------------------------------------------------------------------

const queue = [];
let inFlight = 0;

function pump() {
  while (queue.length && inFlight < SLOTS) {
    const { request, reply } = queue.shift();
    inFlight++;
    runRequest(request)
      .then((value) => reply(value), (error) => reply({ ok: false, error: errorPayload(error) }))
      .finally(() => {
        inFlight--;
        pump();
      });
  }
}

function respond(id, body) {
  send({ id, ...body });
}

const decoder = createMessageDecoder(
  (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.t === 'close') {
      respond(message.id, { ok: true });
      setImmediate(() => app.quit());
      return;
    }
    queue.push({ request: message, reply: (body) => respond(message.id, body) });
    pump();
  },
  (line) => trace(`ignored socket line: ${line.slice(0, 200)}`),
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  trace('app ready');
  try {
    const vendorManifest = JSON.parse(await fs.readFile(path.join(REPO, 'vendor', 'manifest.json'), 'utf8'));
    await installProtocol({ appDir: HERE, repoRoot: REPO, sourcesRoot: SOURCES, vendorManifest });
    trace('protocol installed');
  } catch (error) {
    process.stderr.write(`[vdm-render-host] protocol setup failed: ${error.stack || error}\n`);
    app.exit(1);
    return;
  }
  for (let index = 0; index < SLOTS; index++) slots.push({ index, sandbox: null, loadedKey: null, busy: false });
  let connection;
  try {
    connection = await connectBack();
  } catch (error) {
    process.stderr.write(`[vdm-render-host] cannot reach the pool: ${error.message}\n`);
    app.exit(1);
    return;
  }
  connection.on('data', (chunk) => decoder.push(chunk));
  send({
    event: 'ready',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    gl,
    slots: SLOTS,
    root: ROOT,
    pid: process.pid,
  });
});

export { runRequest, prepareSource };
