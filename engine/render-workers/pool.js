// RenderWorkerPool — the single rasteriser (§5).
//
//   pool.render({ runtime, sourceId, params, frame, fps, size, seed })
//       -> { rgba? | pngPath, hash, ms, cacheKey, cached, frame, size }
//   pool.renderRange({ ..., f0, f1, outDir }) -> { dir, files, frames, totalMs }
//   pool.compile({ sourceId })                -> source snapshot (§7)
//   pool.post({ framesDir, screenFx, outDir })-> frames with screen effects (§5.4)
//   pool.sandboxProbe({ sourceId })            -> sandbox diagnostics (WP3.1 item 2)
//   pool.close()
//
// This module is plain Node: importing it costs nothing and never fails. The
// Electron host is spawned lazily on the first request; when there is no usable
// Electron the call rejects with `code: 'DEPENDENCY_MISSING'` (§10.2 item 4).

import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which, firstExecutable } from '../which.js';
import {
  createMessageDecoder, encodeMessage,
  DEFAULT_EXPORT_TIMEOUT_MS, DEFAULT_LOAD_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS,
  RUNTIME_VERSION,
} from './protocol.js';
import {
  cacheKey, ensureRasterDir, frameFileName, rasterDir, readCachedFrame, readManifest,
  resolveParams, runtimeKey, sha256, sourceSnapshot, writeCachedFrame,
} from './cache.js';
import { dependencyMissing, errorFromPayload, workerFault } from './errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = path.join(HERE, 'host.js');
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Candidate Electron binaries, same order as `scripts/dev.mjs` (§5.1: 复用本机 dist). */
export function electronCandidates({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  return [
    env.VDM_ELECTRON,
    path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron'),
    path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    'E:/Software/KTUM6/resources/app/node_modules/electron/dist/electron.exe',
    'C:/Program Files/Electron/electron.exe',
    '/Applications/Electron.app/Contents/MacOS/Electron',
  ].filter(Boolean);
}

/**
 * Locate a usable Electron. Returns an absolute path, or null when there is none
 * (which is exactly what a plain `node --test` session looks like).
 */
export function findElectron({ env = process.env, repoRoot = REPO_ROOT, pathLookup = true } = {}) {
  const found = firstExecutable(electronCandidates({ env, repoRoot }));
  if (found) return found;
  if (pathLookup) {
    const onPath = which('electron', { env });
    if (onPath) return onPath;
  }
  return null;
}

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;
const positiveInt = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

function normalizeSize(size) {
  if (size === undefined || size === null) return [1920, 1080];
  const width = positiveInt(Array.isArray(size) ? size[0] : size?.width) ? Math.floor(Number(Array.isArray(size) ? size[0] : size.width)) : 0;
  const height = positiveInt(Array.isArray(size) ? size[1] : size?.height) ? Math.floor(Number(Array.isArray(size) ? size[1] : size.height)) : 0;
  if (!width || !height) throw workerFault('INVALID_ARGUMENT', 'size 必须是 [宽, 高] 正整数');
  if (width > 8192 || height > 8192) throw workerFault('INVALID_ARGUMENT', 'size 不能超过 8192');
  return [width, height];
}

const normalizeFrame = (value, name = 'frame') => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw workerFault('INVALID_ARGUMENT', `${name} 必须是非负整数`);
  return Math.floor(num);
};

const normalizeFps = (value) => {
  if (value === undefined || value === null) return 30;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) throw workerFault('INVALID_ARGUMENT', 'fps 必须是正数');
  return num;
};

const decodeBase64 = (text) => Buffer.from(String(text || ''), 'base64');

export class RenderWorkerPool {
  constructor(options = {}) {
    if (!options.root) throw workerFault('INVALID_ARGUMENT', 'RenderWorkerPool 需要项目根目录 root');
    this.root = path.resolve(options.root);
    this.repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
    this.env = options.env || process.env;
    this.slots = Math.max(1, Math.min(4, Number(options.slots) || 1));
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.exportTimeoutMs = Number(options.exportTimeoutMs) > 0 ? Number(options.exportTimeoutMs) : DEFAULT_EXPORT_TIMEOUT_MS;
    this.loadTimeoutMs = Number(options.loadTimeoutMs) > 0 ? Number(options.loadTimeoutMs) : DEFAULT_LOAD_TIMEOUT_MS;
    this.startupTimeoutMs = Number(options.startupTimeoutMs) > 0 ? Number(options.startupTimeoutMs) : DEFAULT_STARTUP_TIMEOUT_MS;
    this.electronPath = options.electronPath === undefined ? null : options.electronPath;
    this.child = null;
    this.socket = null;
    this.server = null;
    this.starting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.console = [];
    this.stderr = '';
    this.hostInfo = null;
    this.sourceCache = new Map();
  }

  // -- public API -----------------------------------------------------------

  /**
   * Render one frame. Rejects (never throws synchronously) with a coded error.
   * `rgba` is only available on a cache miss (a cache hit returns the PNG; there
   * is no PNG decoder in a zero-dependency codebase).
   */
  async render(options = {}) {
    const request = this._normalizeRender(options);
    const source = await this._source(request.sourceId, request.runtime);
    return this._renderOne(request, source);
  }

  /**
   * Render a frame range into `outDir` (`f%05d.png`, the same names the cache
   * uses). `params` may be an object or `(frame) => object`, so the caller passes
   * whatever core/ evaluated for each frame (P2: the pool never evaluates).
   */
  async renderRange(options = {}) {
    const f0 = normalizeFrame(options.f0 ?? 0, 'f0');
    const f1 = normalizeFrame(options.f1 ?? f0, 'f1');
    if (f1 < f0) throw workerFault('INVALID_ARGUMENT', 'f1 必须不小于 f0');
    if (f1 - f0 + 1 > 20000) throw workerFault('INVALID_ARGUMENT', '一次最多渲染 20000 帧');
    if (!options.outDir) throw workerFault('INVALID_ARGUMENT', 'renderRange 需要 outDir');
    const outDir = path.resolve(options.outDir);
    await fs.mkdir(outDir, { recursive: true });

    const started = nowMs();
    const source = await this._source(options.sourceId, options.runtime);
    const files = [];
    const frames = [];
    let rendered = 0;
    let cached = 0;
    for (let frame = f0; frame <= f1; frame++) {
      const params = typeof options.params === 'function' ? options.params(frame) : options.params;
      const request = this._normalizeRender({ ...options, params, frame }, { forExport: true });
      const result = await this._renderOne(request, source, { outDir });
      files.push(result.pngPath);
      frames.push({ frame, path: result.pngPath, hash: result.hash, ms: result.ms, cached: result.cached });
      if (result.cached) cached++;
      else rendered++;
    }
    return {
      dir: outDir,
      files,
      frames,
      count: frames.length,
      rendered,
      cached,
      totalMs: Math.round((nowMs() - started) * 100) / 100,
      runtime: source.runtime,
      sourceId: source.id,
    };
  }

  /**
   * Load a source in the sandbox and return its snapshot (§7).
   * Foundation for WP4.1: this version hashes the source files + manifest and
   * proves the source runs; the DOM/CSS extraction lands in WP4.1.
   */
  async compile({ sourceId, runtime = null, size = [640, 360], fps = 30, seed = 0 } = {}) {
    const source = await this._source(sourceId, runtime);
    const normalized = normalizeSize(size);
    await this._request({
      t: 'load',
      source: { id: source.id, runtime: source.runtime },
      key: source.key,
      size: normalized,
      fps: normalizeFps(fps),
      seed: Number(seed) || 0,
      setupParams: setupParamsOf(source.manifest),
      loadTimeoutMs: this.loadTimeoutMs,
      timeoutMs: this.loadTimeoutMs,
    }, { timeoutMs: this.loadTimeoutMs + 5000, label: 'compile' });
    return {
      id: source.id,
      runtime: source.runtime,
      entry: source.entry,
      manifest: source.manifest,
      libs: source.manifest.libs || null,
      deterministic: source.manifest.deterministic ?? null,
      hash: source.snapshot.hash,
      files: source.snapshot.files,
      runtimeVersion: RUNTIME_VERSION,
      vendor: source.versions.vendor,
      dir: source.dir,
    };
  }

  /** Apply the screen-effect stack to every PNG in `framesDir`. */
  async post({ framesDir, screenFx = {}, outDir, fps = 30 } = {}) {
    if (!framesDir) throw workerFault('INVALID_ARGUMENT', 'post 需要 framesDir');
    if (!outDir) throw workerFault('INVALID_ARGUMENT', 'post 需要 outDir');
    const input = path.resolve(framesDir);
    const output = path.resolve(outDir);
    let names;
    try {
      names = (await fs.readdir(input)).filter((name) => /\.png$/i.test(name)).sort();
    } catch (error) {
      throw workerFault('SOURCE_NOT_FOUND', `读不到帧目录：${error.message}`);
    }
    if (!names.length) throw workerFault('INVALID_ARGUMENT', `帧目录里没有 PNG：${input}`);
    await fs.mkdir(output, { recursive: true });
    const started = nowMs();
    const files = [];
    for (const name of names) {
      const buffer = await fs.readFile(path.join(input, name));
      const match = /^f(\d{5})\.png$/i.exec(name);
      const time = match ? Number(match[1]) / normalizeFps(fps) : 0;
      const result = await this._request({
        t: 'post',
        dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
        screenFx,
        time,
        timeoutMs: this.exportTimeoutMs,
      }, { timeoutMs: this.exportTimeoutMs + 5000, label: 'post' });
      const outBuffer = decodeBase64(result.png);
      const target = path.join(output, name);
      await fs.writeFile(target, outBuffer);
      files.push({ name, path: target, hash: sha256(outBuffer), bytes: outBuffer.length, ms: result.ms });
    }
    return {
      dir: output,
      files,
      count: files.length,
      screenFx,
      totalMs: Math.round((nowMs() - started) * 100) / 100,
    };
  }

  /**
   * Ask the sandbox what it can reach (WP3.1 acceptance item 2). Diagnostic /
   * test surface only — no production path calls this.
   */
  async sandboxProbe({ sourceId = null } = {}) {
    const result = await this._request(
      { t: 'probe', sourceId, timeoutMs: this.loadTimeoutMs },
      { timeoutMs: this.loadTimeoutMs + 5000, label: 'probe' },
    );
    return { ...result, host: this.hostInfo, console: this.console.slice(-20) };
  }

  /** Shut the host down. Safe to call twice, safe to call before starting. */
  async close() {
    this.closed = true;
    const child = this.child;
    const socket = this.socket;
    const server = this.server;
    this.child = null;
    this.socket = null;
    this.server = null;
    this.hostInfo = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(workerFault('POOL_CLOSED', '渲染池已关闭'));
    }
    this.pending.clear();
    if (server) {
      try { server.close(); } catch { /* gone */ }
    }
    if (socket) {
      try {
        socket.write(encodeMessage({ id: 0, t: 'close' }));
        socket.end();
      } catch { /* already gone */ }
    }
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Diagnostics: last console errors + host stderr tail. */
  diagnostics() {
    return {
      host: this.hostInfo,
      console: this.console.slice(-40),
      stderr: this.stderr.slice(-4000),
      pid: this.child?.pid ?? null,
    };
  }

  // -- internals ------------------------------------------------------------

  _normalizeRender(options, { forExport = false } = {}) {
    if (!options.sourceId) throw workerFault('INVALID_ARGUMENT', 'render 需要 sourceId');
    const params = options.params === undefined ? {} : options.params;
    if (params !== null && typeof params !== 'object') throw workerFault('INVALID_ARGUMENT', 'params 必须是对象');
    return {
      sourceId: String(options.sourceId),
      runtime: options.runtime || null,
      size: normalizeSize(options.size),
      frame: normalizeFrame(options.frame ?? 0),
      fps: normalizeFps(options.fps),
      seed: Number.isFinite(Number(options.seed)) ? Number(options.seed) : 0,
      params: params || {},
      beat: options.beat ?? null,
      volume: options.volume ?? null,
      wantRgba: !!options.wantRgba,
      useCache: options.useCache !== false,
      timeoutMs: Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs)
        : forExport ? this.exportTimeoutMs : this.timeoutMs,
    };
  }

  /** Read + hash a source; memoised per source id (a changed source re-reads on `compile`). */
  async _source(sourceId, runtime) {
    const id = String(sourceId || '');
    if (!id) throw workerFault('INVALID_ARGUMENT', '缺少 sourceId');
    const cached = this.sourceCache.get(id);
    if (cached) return cached;

    const dir = path.join(this.root, 'sources', id);
    let real;
    try {
      real = await fs.realpath(dir);
    } catch {
      throw workerFault('SOURCE_NOT_FOUND', `源不存在：sources/${id}`);
    }
    let sourcesReal;
    try {
      sourcesReal = await fs.realpath(path.join(this.root, 'sources'));
    } catch {
      throw workerFault('SOURCE_NOT_FOUND', '项目没有 sources/ 目录');
    }
    const relDir = path.relative(sourcesReal, real);
    if (relDir.startsWith('..') || path.isAbsolute(relDir)) throw workerFault('PATH_OUTSIDE_SCOPE', `源目录越界：sources/${id}`);

    const { manifest, raw } = await readManifest(real, id);
    const runtimeName = runtime || manifest.runtime;
    if (!runtimeName) throw workerFault('SOURCE_INVALID', `源 ${id} 的 manifest 缺少 runtime`);
    if (runtime && manifest.runtime && runtime !== manifest.runtime) {
      throw workerFault('UNSUPPORTED_RUNTIME', `源 ${id} 的 manifest 是 ${manifest.runtime}，请求里是 ${runtime}`);
    }
    const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
    if (!entry) throw workerFault('SOURCE_INVALID', `源 ${id} 的 manifest 缺少 entry`);
    const snapshot = await sourceSnapshot(real);
    const versions = await runtimeKey({ repoRoot: this.repoRoot });
    const state = {
      id,
      dir: real,
      runtime: runtimeName,
      entry,
      manifest,
      manifestRaw: raw,
      snapshot,
      versions,
      // Window-level load marker: changes when the source content changes.
      key: `${snapshot.hash}:${sha256(raw).slice(0, 12)}`,
    };
    this.sourceCache.set(id, state);
    return state;
  }

  async _renderOne(request, source, { outDir = null } = {}) {
    const params = resolveParams(source.manifest, request.params);
    const key = cacheKey({
      snapshot: source.snapshot,
      manifestRaw: source.manifestRaw,
      params,
      size: request.size,
      seed: request.seed,
      frame: request.frame,
      fps: request.fps,
      versions: source.versions,
    });

    if (request.useCache) {
      const hit = await readCachedFrame(this.root, key, request.frame);
      if (hit) {
        let target = hit.pngPath;
        if (outDir) {
          target = path.join(outDir, frameFileName(request.frame));
          await fs.writeFile(target, hit.buffer);
        }
        return {
          pngPath: target,
          hash: hit.hash,
          ms: 0,
          cached: true,
          cacheKey: key,
          frame: request.frame,
          size: request.size,
          runtime: source.runtime,
        };
      }
    }

    const started = nowMs();
    const result = await this._request({
      t: 'render',
      source: { id: source.id, runtime: source.runtime },
      key,
      frame: request.frame,
      fps: request.fps,
      size: request.size,
      params,
      setupParams: setupParamsOf(source.manifest, params),
      seed: request.seed,
      beat: request.beat,
      volume: request.volume,
      wantRgba: request.wantRgba,
      loadTimeoutMs: this.loadTimeoutMs,
      timeoutMs: request.timeoutMs,
    }, { timeoutMs: request.timeoutMs + Math.max(5000, request.timeoutMs * 2), label: 'render' });

    const buffer = decodeBase64(result.png);
    const hash = sha256(buffer);
    let pngPath = null;
    if (request.useCache) {
      const written = await writeCachedFrame(this.root, key, request.frame, {
        buffer,
        hash,
        meta: {
          sourceId: source.id,
          runtime: source.runtime,
          params,
          size: request.size,
          seed: request.seed,
          fps: request.fps,
          ms: result.ms,
          runtimeVersion: RUNTIME_VERSION,
        },
      });
      pngPath = written.pngPath;
    }
    if (outDir) {
      const target = path.join(outDir, frameFileName(request.frame));
      await fs.writeFile(target, buffer);
      pngPath = target;
    }
    const rgba = request.wantRgba && result.rgba ? Buffer.from(result.rgba, 'base64') : undefined;
    return {
      pngPath,
      hash,
      ms: result.ms,
      cached: false,
      cacheKey: key,
      frame: request.frame,
      size: request.size,
      runtime: source.runtime,
      totalMs: Math.round((nowMs() - started) * 100) / 100,
      ...(rgba ? { rgba } : {}),
    };
  }

  /**
   * Send one request to the host. The host enforces the per-frame budget; this
   * side has a coarser watchdog so a wedged host can never hang the engine.
   */
  async _request(message, { timeoutMs = this.loadTimeoutMs + 5000, label = 'request' } = {}) {
    if (this.closed) throw workerFault('POOL_CLOSED', '渲染池已关闭');
    const socket = await this._ensureHost();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this._killHost(`请求超时（${label}，${timeoutMs} ms）`);
        reject(workerFault('WORKER_CRASHED', `渲染宿主没有在 ${timeoutMs} ms 内响应（${label}），已重启`, { label, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, label });
      try {
        socket.write(encodeMessage({ id, ...message }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(workerFault('WORKER_CRASHED', `写入渲染宿主失败：${error.message}`));
      }
    });
  }

  _settle(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value ?? message);
    else pending.reject(errorFromPayload(message.error, `${pending.label} 失败`));
  }

  _killHost(reason) {
    const child = this.child;
    const socket = this.socket;
    const server = this.server;
    this.child = null;
    this.socket = null;
    this.server = null;
    this.hostInfo = null;
    this.starting = null;
    if (socket) {
      try { socket.destroy(); } catch { /* gone */ }
    }
    if (server) {
      try { server.close(); } catch { /* gone */ }
    }
    if (child) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      this.stderr = `${this.stderr}
[pool] killed host: ${reason}`.slice(-8000);
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(workerFault('WORKER_CRASHED', `渲染宿主已终止：${reason}`));
    }
    this.pending.clear();
  }

  async _ensureHost() {
    if (this.socket) return this.socket;
    if (this.starting) await this.starting.catch(() => {});
    if (this.socket) return this.socket;
    if (this.closed) throw workerFault('POOL_CLOSED', '渲染池已关闭');

    const electron = this.electronPath || findElectron({ env: this.env, repoRoot: this.repoRoot });
    if (!electron) {
      throw dependencyMissing('没有找到 Electron 可执行文件', {
        hint: '设置 VDM_ELECTRON 指向 Electron，或把 electron 放进 PATH；纯 Node 环境下渲染不可用（这是预期行为）',
        tried: electronCandidates({ env: this.env, repoRoot: this.repoRoot }),
      });
    }
    if (!fss.existsSync(electron)) {
      throw dependencyMissing(`Electron 路径不存在：${electron}`, { hint: 'VDM_ELECTRON 指向了不存在的文件', electron });
    }

    this.starting = (async () => {
      // The pool listens; the host connects out (see host.js for why).
      const server = net.createServer();
      const port = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
      const token = randomBytes(16).toString('hex');
      this.server = server;

      const env = { ...this.env };
      delete env.ELECTRON_RUN_AS_NODE; // must stay an Electron *app*, not plain node
      delete env.ELECTRON_ENABLE_LOGGING;
      const child = spawn(electron, [
        HOST_SCRIPT,
        `--root=${this.root}`,
        `--repo=${this.repoRoot}`,
        `--slots=${this.slots}`,
        `--port=${port}`,
        `--token=${token}`,
      ], {
        cwd: this.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
      child.on('error', (error) => {
        this.stderr = `${this.stderr}
[pool] spawn error: ${error.message}`.slice(-8000);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderr = `${this.stderr}${chunk}`.slice(-8000);
        if (this.env.VDM_RENDER_DEBUG) process.stderr.write(chunk);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (this.env.VDM_RENDER_DEBUG) process.stderr.write(`[host stdout] ${chunk}`);
      });

      const handshake = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(dependencyMissing(`渲染宿主 ${this.startupTimeoutMs} ms 内没有连上来`, { stderr: this.stderr.slice(-2000) }));
        }, this.startupTimeoutMs);
        const fail = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        server.on('connection', (socket) => {
          socket.setEncoding('utf8');
          socket.setNoDelay(true);
          let greeted = false;
          // The first line must be the handshake: anything else on loopback is
          // not our host and gets dropped.
          const hello = createMessageDecoder((message) => {
            if (greeted) return;
            greeted = true;
            if (!message || message.t !== 'hello' || message.token !== token) {
              socket.destroy();
              return;
            }
            clearTimeout(timer);
            this._adoptSocket(socket, resolve, reject);
          });
          socket.on('data', (chunk) => hello.push(chunk));
          socket.on('error', () => socket.destroy());
        });
        server.once('error', fail);
        child.once('exit', (code, signal) => {
          if (this.child !== child) return;
          const wasReady = !!this.hostInfo;
          this.child = null;
          this.socket = null;
          this.hostInfo = null;
          const tail = this.stderr.slice(-1500);
          for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(workerFault('WORKER_CRASHED', `渲染宿主退出（code=${code} signal=${signal}）`, { tail }));
          }
          this.pending.clear();
          if (!wasReady) fail(dependencyMissing(`渲染宿主启动即退出（code=${code} signal=${signal}）`, { stderr: tail }));
        });
      });

      this.child = child;
      try {
        await handshake;
      } catch (error) {
        this._killHost(error.message);
        throw error;
      }
      return this.socket;
    })();

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
    return this.socket;
  }

  /** Take over the host socket and resolve the startup promise on `ready`. */
  _adoptSocket(socket, resolveStartup, rejectStartup) {
    this.socket = socket;
    const timer = setTimeout(() => {
      rejectStartup(dependencyMissing('渲染宿主连上了但没有就绪', { stderr: this.stderr.slice(-2000) }));
      this._killHost('没有就绪');
    }, this.startupTimeoutMs);
    const decoder = createMessageDecoder(
      (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.event === 'ready') {
          clearTimeout(timer);
          this.hostInfo = message;
          resolveStartup(message);
          return;
        }
        if (message.event === 'console') {
          this.console.push(message);
          if (this.console.length > 200) this.console.shift();
          return;
        }
        if (message.id !== undefined) this._settle(message);
      },
      (line) => {
        if (this.env.VDM_RENDER_DEBUG) this.stderr = `${this.stderr}
[host line] ${line}`.slice(-8000);
      },
    );
    socket.on('data', (chunk) => decoder.push(chunk));
    socket.on('error', (error) => {
      this.stderr = `${this.stderr}
[pool] socket error: ${error.message}`.slice(-8000);
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.hostInfo = null;
      }
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(workerFault('WORKER_CRASHED', '渲染宿主连接断开了'));
      }
      this.pending.clear();
    });
  }
}

/** Defaults for `setup()`: frame 0 values (falls back to this frame's values). */
function setupParamsOf(manifest, fallback = null) {
  try {
    return resolveParams(manifest, {});
  } catch {
    return fallback || {};
  }
}

/** Create a pool (does not spawn anything until the first request). */
export function createRenderPool(options = {}) {
  return new RenderWorkerPool(options);
}

export default createRenderPool;
export { rasterDir, ensureRasterDir, frameFileName, resolveParams, cacheKey };
