// VedioMaker engine server: static files + JSON API + SSE.
// Pure Node. Electron only wraps it in a window.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  paths, findProjectRoot, watchProject,
  ensureProjectDirs, projectExists, PROJECT_FILE, atomicJson,
} from './storage.js';
import { projectService } from './projects.js';
import { errorData, fault } from '../application/errors.js';
import { ChangeSetService } from '../application/changeset-service.js';
import { stackAt, coverage, cutEdges, diff, pxAt, pixelCoverage } from '../application/inspect-service.js';
import { probeMedia, mimeOf, fileExists, findBin } from './media.js';
import { blenderVersion, findBlender } from './blender.js';
import { analyzeBeats } from './beats.js';
import { summarizeProject, STYLE_PRESETS } from './storyboard.js';
import { AgentRunner, findDsh, CLI_PATH } from './agent.js';
import { createLogger } from './log.js';
import { worldSnapshot, fontDirs, resolveFontFile } from './shot.js';
import { readPath, writePath, isWithin, pathDenied } from './path-policy.js';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { claimRuntime, connectRuntime } from './runtime.js';
import { createJobService } from './jobs.js';
import { readSelection, contextAt } from '../application/queries.js';
import { OP_KINDS } from '../core/ops.js';
import { mediaService } from './media-service.js';
import { compute } from './compute.js';
import { hashOf } from './media.js';
import { PROJECT_SCHEMA, EDIT_SEMANTICS_VERSION, RENDER_PLAN_VERSION } from '../core/version.js';
import { pruneCache } from './cache.js';
import { createRenderPool } from './render-workers/pool.js';
import { cacheKey, readCachedFrame, readManifest, resolveParams, runtimeKey, sourceSnapshot } from './render-workers/cache.js';
import { isSafeSourceId } from '../core/code-layer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const RENDERER = path.join(APP_DIR, 'app', 'renderer');
const CORE = path.join(APP_DIR, 'core');
let ffmpegAvailable = null; // Promise<boolean>, cached for the engine lifetime (/api/state)

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.resume(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object');
        resolve(value);
      } catch (e) { reject(Object.assign(new Error(`bad json: ${e.message}`), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

async function publishMedia(temporary, directory, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let i = 0; ; i++) {
    const name = i ? `${stem}-${i}${ext}` : filename;
    try {
      // Same-directory hard link publishes a complete file atomically without
      // replacing another upload that chose the same human-readable name.
      await fsp.link(temporary, path.join(directory, name));
      return name;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

async function serveFile(req, res, file, { range = false } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return json(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'not a file' });
  const mime = mimeOf(file);
  const head = { 'content-type': mime, 'cache-control': 'no-cache', 'accept-ranges': 'bytes', 'content-disposition': 'inline' };
  if (range && req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const suffix = m && !m[1] && m[2] ? Number(m[2]) : null;
    const start = suffix != null ? Math.max(0, st.size - suffix) : m?.[1] ? Number(m[1]) : NaN;
    let end = suffix != null ? st.size - 1 : m?.[2] ? Number(m[2]) : st.size - 1;
    if (!m || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || suffix === 0 || start < 0 || start >= st.size || end < start) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      ...head,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'content-length': end - start + 1,
    });
    return streamPipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
  }
  res.writeHead(200, { ...head, 'content-length': st.size });
  return streamPipeline(fs.createReadStream(file), res).catch(() => {});
}

function openInBrowser(url, log) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: 'ignore' });
    child.on('error', (e) => log.warn('could not open a browser', { url, error: e.message }));
    child.unref();
  } catch (e) {
    log.warn('could not open a browser', { url, error: e.message });
  }
}

async function startOwnedServer({ root, port = 47100, open = false, onReady, importRoots = [], uploadLimit = 1024 * 1024 * 1024, releaseOwnership } = {}) {
  const projectRoot = path.resolve(root);
  if (!(await projectExists(projectRoot))) {
    throw new Error(`no ${PROJECT_FILE} in ${projectRoot}`);
  }
  const p = await ensureProjectDirs(projectRoot);
  const log = createLogger({ dir: projectRoot });
  log.info('engine starting', { root: projectRoot, pid: process.pid, version: '0.1.0' });
  const projects = projectService(projectRoot);
  // Change sets (WP2.2) over the one write path: the review panel and the
  // legacy agent proposal both go through this, so every AI write is recorded,
  // revertible and visible to the UI (WP2.5a).
  const changesets = new ChangeSetService(projects);
  const media = mediaService(projectRoot, importRoots);
  let project = await projects.read();
  let lastRev = project.rev;

  const clients = new Set();
  let eventId = 0;
  const broadcast = (type, data) => {
    const payload = `id: ${++eventId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      try { c.write(payload); } catch { /* dropped */ }
    }
  };
  const toast = (message, level = 'info') => broadcast('toast', { message, level, at: Date.now() });
  log.onLine((rec) => { if (rec.level !== 'debug') broadcast('log', rec); });

  let writeChain = Promise.resolve();
  const serialized = (fn) => {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => {});
    return run;
  };
  const adoptDisk = (fresh, source = 'disk', transaction = {}) => {
    if (fresh.rev === lastRev) return false;
    project = fresh;
    lastRev = fresh.rev;
    broadcast('project', { project, source, rev: fresh.rev, transactionId: transaction.transactionId });
    updateStoryboardStep(fresh);
    for (const step of pipeline.steps) if (step.sourceRev != null && step.sourceRev !== fresh.rev) {
      step.status = 'todo'; step.detail = `项目已更新（原产物 rev ${step.sourceRev}）`;
    }
    return true;
  };
  const transact = (input, source = 'ui') => serialized(async () => {
    const result = await projects.transact(input, { actorId: source });
    if (!result.dryRun) adoptDisk(result.project, source, result);
    return result;
  });
  const transactionOptions = (body) => ({ expectedRev: body.expectedRev, requestId: body.requestId, dryRun: body.dryRun });
  const isRejection = (e) => !!(e?.issues || e?.code === 'OP_INVALID');

  // ---- pipeline state ----
  const pipelineFile = path.join(p.vdm, 'pipeline.json');
  let pipelineTimer = null;
  const persistPipeline = () => {
    clearTimeout(pipelineTimer);
    pipelineTimer = setTimeout(() => {
      fsp.writeFile(pipelineFile, JSON.stringify(pipeline, null, 2)).catch(() => {});
    }, 120);
  };
  const savedPipeline = await fsp.readFile(pipelineFile, 'utf8').then((t) => JSON.parse(t)).catch(() => null);
  const pipeline = {
    steps: [
      { id: 'storyboard', label: '分镜', status: 'todo', detail: '还没有分镜' },
      { id: 'stills', label: '预览帧', status: 'todo', detail: '未生成' },
      { id: 'render', label: '片段渲染', status: 'todo', detail: '未渲染' },
      { id: 'master', label: '成片', status: 'todo', detail: '未合成' },
    ],
    artifacts: [],
    updatedAt: Date.now(),
  };
  if (savedPipeline) {
    for (const st of savedPipeline.steps || []) {
      const target = pipeline.steps.find((x) => x.id === st.id);
      if (target) Object.assign(target, st);
    }
    pipeline.artifacts = (savedPipeline.artifacts || []).slice(0, 40);
  } else {
    // first run with an existing .vdm: rebuild the artifacts shelf from disk
    const listDir = async (d) => fsp.readdir(d).catch(() => []);
    const stills = (await listDir(p.frames)).filter((f) => f.endsWith('.png')).sort().slice(-8);
    const clips = (await listDir(p.renders)).filter((f) => f.endsWith('.mp4')).sort().slice(-6);
    pipeline.artifacts = [
      ...clips.reverse().map((f) => ({ kind: 'render', label: f, url: `/renders/${f}`, path: path.join(p.renders, f), at: Date.now() })),
      ...stills.reverse().map((f) => ({ kind: 'still', label: f, url: `/frames/${f}`, path: path.join(p.frames, f), at: Date.now() })),
    ];
    if (stills.length) setStep('stills', { status: 'done', detail: `${stills.length} 张预览帧` });
    if (clips.some((f) => f.startsWith('master'))) setStep('master', { status: 'done', detail: clips.find((f) => f.startsWith('master')) });
  }
  function setStep(id, patch) {
    const s = pipeline.steps.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    pipeline.updatedAt = Date.now();
    persistPipeline();
    broadcast('pipeline', pipeline);
  }
  const addArtifact = (a) => {
    pipeline.artifacts.unshift({ ...a, at: Date.now() });
    if (pipeline.artifacts.length > 40) pipeline.artifacts.pop();
    persistPipeline();
    broadcast('pipeline', pipeline);
  };

  // ---- render queue (one job at a time) ----
  const renderState = { running: false, kind: null, from: 0, to: 0, progress: 0, total: 0, startedAt: 0, out: null, error: null };
  const finishedJobs = new Set();
  const jobs = await createJobService(projectRoot, projects, (job) => {
    broadcast('job', job);
    if (jobs?.active && jobs.active.id !== job.id) return;
    const running = !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status);
    Object.assign(renderState, { running, jobId: job.id, sourceRev: job.sourceRev,
      kind: job.kind, from: job.options.from, to: job.options.to,
      progress: job.progress, total: job.total, out: job.artifact?.path || null,
      status: job.status, error: job.error?.message || null });
    broadcast('render', { ...renderState, done: job.status === 'succeeded', cancelled: job.status === 'cancelled', url: job.artifact?.url });
    if (!running && !finishedJobs.has(job.id)) {
      finishedJobs.add(job.id);
      if (job.artifact) {
        addArtifact({ ...job.artifact, label: `${job.kind === 'still' ? '预览帧' : '成片'} · rev ${job.sourceRev}` });
        const full = job.kind === 'video' && job.options.from === 0 && job.options.to >= job.duration;
        setStep(job.kind === 'still' ? 'stills' : full ? 'master' : 'render', { sourceRev: job.sourceRev,
          status: job.sourceRev === project.rev ? 'done' : 'todo', detail: `${job.sourceRev === project.rev ? '' : '项目已更新，产物来自 '}rev ${job.sourceRev}` });
      }
    }
  });

  const agent = new AgentRunner({
    root: projectRoot,
    onEvent: async (ev) => {
      if (ev.type === 'proposal') {
        try {
          const record = await changesets.apply({
            ops: ev.proposal.ops, actorId: 'agent:dsh', intent: ev.proposal.note,
            expectedRev: ev.baseRev, requestId: ev.runId,
          });
          const changed = record.changed?.length ?? 0;
          adoptDisk(await projects.read(), 'agent', { transactionId: record.transactions?.[0] });
          log.info('agent applied', { ops: ev.proposal.ops.length, changeset: record.id, rev: record.rev, note: ev.proposal.note });
          broadcast('agent', { ...ev, applied: { changed, note: ev.proposal.note, rev: record.rev, changesetId: record.id } });
          broadcast('changeset', { action: 'apply', record });
          addArtifact({ kind: 'ai', label: `AI 改了 ${changed} 项`, detail: ev.proposal.note });
          toast(`AI 已应用 ${changed} 处修改`, 'success');
        } catch (e) {
          log.error('agent proposal rejected', { error: e.message, ops: ev.proposal.ops });
          broadcast('agent', { ...ev, error: e.message });
          toast(`AI 提议应用失败: ${e.message}`, 'error');
        }
        return;
      }
      if (ev.type === 'exit') log.info('agent exit', { code: ev.code, sec: ev.seconds, stderr: ev.stderr || undefined });
      broadcast('agent', ev);
    },
  });

  // ---- external file changes ----
  // queued behind our own writes, so a save we just made is never mistaken for an external edit
  const unwatch = watchProject(projectRoot, () => serialized(async () => {
    try {
      adoptDisk(await projects.read());
    } catch (e) {
      toast(`项目文件读取失败: ${e.message}`, 'error');
    }
  }));

  function updateStoryboardStep(proj) {
    const n = proj.segments.length;
    if (n > 0) setStep('storyboard', { status: 'done', detail: `${n} 个分镜 · ${proj.elements.length} 个元素` });
    else setStep('storyboard', { status: 'todo', detail: '还没有分镜' });
  }
  updateStoryboardStep(project);

  const instanceId = randomUUID(), token = randomUUID();
  let worldKey, worldPromise;

  // ---- raster frames of code layers (docs/DESIGN-BACKEND-V2.md §5/§6, WP3.3) ----
  // The preview never runs user code: one frame of a `code` source comes out of
  // the single rasteriser — engine/render-workers/pool.js — through this route.
  // The pool is spawned lazily on the first request and closed with the server.
  let rasterPool = null;
  const rasterPoolFor = () => (rasterPool ||= createRenderPool({ root: projectRoot }));
  const closeRasterPool = async () => {
    const pool = rasterPool;
    rasterPool = null;
    if (pool) await pool.close().catch(() => {});
  };
  /** HTTP status for a raster failure: the pool's own code->status table, else 500. */
  const rasterStatus = (e) => e.status || (e.code === 'RASTER_NOT_CACHED' ? 404 : 500);

  /**
   * Cache-only lookup for `mode=bake`: the key the pool would use, without
   * ever rendering (`bake` means "show cached frames only", §6.1).
   */
  async function cachedRasterPath({ source, frame, fps, size, seed, params }) {
    const dir = path.join(projectRoot, 'sources', source);
    try {
      const [read, snapshot, versions] = await Promise.all([
        readManifest(dir, source), sourceSnapshot(dir), runtimeKey({ repoRoot: APP_DIR }),
      ]);
      const key = cacheKey({
        snapshot, manifestRaw: read.raw, params: resolveParams(read.manifest, params),
        size, seed, frame, fps, versions,
      });
      const hit = await readCachedFrame(projectRoot, key, frame);
      return hit ? hit.pngPath : null;
    } catch {
      return null;
    }
  }

  /**
   * GET /api/raster?source=<id>&frame=<n>&w=<px>&h=<px>&params=<json>&seed=<n>
   *                                   [&mode=live|bake]
   * One PNG of one code-layer frame, `image/png` + `Cache-Control: no-store`.
   * `live` renders on demand (the pool's own cache answers a repeat), `bake`
   * only reads `.vdm/cache/raster/` and 404s on a miss.
   */
  async function serveRaster(url, res) {
    const q = url.searchParams;
    const fail = (status, code, error) => json(res, status, { error, code });
    const source = String(q.get('source') || '');
    if (!isSafeSourceId(source)) return fail(400, 'INVALID_ARGUMENT', 'source 必须是源 id（[A-Za-z0-9][A-Za-z0-9_-]{0,63}）');
    const frame = Number(q.get('frame') ?? 0);
    if (!Number.isInteger(frame) || frame < 0) return fail(400, 'INVALID_ARGUMENT', 'frame 必须是非负整数');
    const meta = project?.meta || {};
    const dim = (name, fallback) => {
      const raw = q.get(name);
      const value = raw === null ? Number(fallback) : Number(raw);
      return Number.isInteger(value) && value > 0 && value <= 8192 ? value : null;
    };
    const width = dim('w', Number(meta.width) || 1920);
    const height = dim('h', Number(meta.height) || 1080);
    if (!width || !height) return fail(400, 'INVALID_ARGUMENT', 'w / h 必须是 1..8192 的整数');
    const fps = Number(q.get('fps') ?? (Number(meta.fps) || 24));
    if (!Number.isFinite(fps) || fps <= 0) return fail(400, 'INVALID_ARGUMENT', 'fps 必须是正数');
    const seed = Number(q.get('seed') ?? 0);
    if (!Number.isFinite(seed)) return fail(400, 'INVALID_ARGUMENT', 'seed 必须是数字');
    let params = {};
    const rawParams = q.get('params');
    if (rawParams) {
      try {
        params = JSON.parse(rawParams);
      } catch {
        return fail(400, 'INVALID_ARGUMENT', 'params 必须是 URL 编码的 JSON 对象');
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return fail(400, 'INVALID_ARGUMENT', 'params 必须是 JSON 对象');
      }
    }
    const mode = q.get('mode') === 'bake' ? 'bake' : 'live';
    const size = [width, height];
    try {
      let pngPath;
      if (mode === 'bake') {
        pngPath = await cachedRasterPath({ source, frame, fps, size, seed, params });
        if (!pngPath) return fail(404, 'RASTER_NOT_CACHED', `没有缓存的帧：${source} f${frame}`);
      } else {
        const out = await rasterPoolFor().render({
          sourceId: source, frame, fps, size, seed, params, useCache: true,
        });
        pngPath = out.pngPath;
      }
      const png = await fsp.readFile(pngPath);
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': png.length,
      });
      return res.end(png);
    } catch (e) {
      const status = rasterStatus(e);
      log[status >= 500 ? 'error' : 'warn']('raster frame failed', {
        source, frame, mode, size, error: e.message, code: e.code || null, hint: e.hint || undefined,
      });
      return fail(status, e.code || 'RASTER_FAILED', e.message);
    }
  }

  /**
   * GET /api/font?font=<family or project-relative path>
   * The bytes of one font file, for the preview's text meshes (§4.4 v4, WP1.3).
   * `core/glyphs.js` parses them in the renderer; this route is the only way a
   * browser can reach a font file.
   *
   * Read-only and narrow: a file has to live inside `fontDirs` (the OS font
   * directories plus this project's media / assets / fonts) and end in
   * `.ttf` / `.otf` / `.ttc`; everything else is 403. `.ttc` is in the list on
   * purpose — the CJK face Windows ships ("Microsoft YaHei") is a collection.
   */
  async function serveFont(url, res) {
    const requested = String(url.searchParams.get('font') || url.searchParams.get('path') || '').trim();
    if (!requested) return json(res, 400, { error: 'font 必填', code: 'INVALID_ARGUMENT' });
    const file = resolveFontFile(requested, projectRoot);
    if (!file) return json(res, 404, { error: `找不到字体：${requested}`, code: 'FONT_NOT_FOUND' });
    const absolute = path.resolve(file);
    const allowed = fontDirs(projectRoot).some((dir) => {
      const root = path.resolve(dir);
      return absolute === root || absolute.startsWith(root + path.sep);
    });
    if (!allowed) return json(res, 403, { error: '字体目录不在白名单', code: 'ACCESS_DENIED' });
    if (!/\.(ttf|otf|ttc)$/i.test(absolute)) return json(res, 403, { error: '只允许 .ttf / .otf / .ttc', code: 'ACCESS_DENIED' });
    let bytes;
    try {
      bytes = await fsp.readFile(absolute);
    } catch (e) {
      return json(res, 404, { error: `读不到字体：${path.basename(absolute)}`, code: 'FONT_NOT_FOUND' });
    }
    const type = /\.ttc$/i.test(absolute) ? 'font/collection' : /\.otf$/i.test(absolute) ? 'font/otf' : 'font/ttf';
    res.writeHead(200, {
      'content-type': type,
      // A font file is immutable content; the mesh id hashes it, so a changed
      // file is a different mesh anyway.
      'cache-control': 'public, max-age=86400',
      'content-length': bytes.length,
    });
    return res.end(bytes);
  }

  const server = http.createServer(async (req, res) => {
    let pathname = req.url;
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const host = new URL(`http://${req.headers.host || ''}`);
      if (!['127.0.0.1', 'localhost'].includes(host.hostname) || host.port !== String(server.address().port)) return json(res, 403, { error: 'invalid host', code: 'ACCESS_DENIED' });
      if (req.headers.origin && ![origin, `http://localhost:${server.address().port}`].includes(req.headers.origin)) return json(res, 403, { error: 'invalid origin', code: 'ACCESS_DENIED' });
      const url = new URL(req.url, origin);
      try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'invalid URL encoding', code: 'INVALID_ARGUMENT' }); }
      if (pathname === '/api/runtime' && req.method === 'GET') return json(res, 200, { root: projectRoot, instanceId, version: 1 });
      if (pathname === '/api/rpc' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${token}`) return json(res, 403, { error: 'runtime credential required', code: 'ACCESS_DENIED' });
        const { method, params = {} } = await readBody(req);
        let result;
        switch (method) {
          case 'project.read': result = await projects.read(); break;
          case 'project.query': result = readSelection(await projects.read(), params); break;
          case 'project.context': result = contextAt(await projects.read(), params); break;
          case 'project.transact': result = await transact(params, 'local'); break;
          case 'project.history': result = await projects.history(); break;
          case 'job.submit': result = await jobs.submit(params); break;
          case 'job.get': result = await jobs.get(params.id); break;
          case 'job.list': result = await jobs.list(); break;
          case 'job.cancel': result = await jobs.cancel(params.id); break;
          case 'job.wait': result = await jobs.wait(params.id); break;
          case 'artifact.read': result = await jobs.artifact(params.id, params); break;
          case 'media.list': result = await media.list(params); break;
          case 'media.probe': result = await media.probe(params); break;
          case 'media.import': result = await media.import(params); break;
          case 'cache.prune': result = await jobs.serial(async () => {
            if (jobs.active || [...jobs.jobs.values()].some((job) => job.status === 'queued')) throw Object.assign(new Error('cannot prune cache while render jobs are pending'), { code: 'JOB_BUSY', status: 409 });
            return pruneCache(projectRoot, params);
          }); break;
          case 'capabilities': result = { projectSchema: PROJECT_SCHEMA, semanticsVersion: EDIT_SEMANTICS_VERSION, renderPlanVersion: RENDER_PLAN_VERSION,
            ops: OP_KINDS.filter((op) => !['restoreProject', 'replaceTimeline'].includes(op)),
            models: ['elements', 'cameras', 'scene.objects'], sceneTree: 'experimental, read-only',
            rendering: { concurrency: 1, backend: 'Blender', textLayout: 'approximate preview parity' },
            blender: await blenderVersion().catch(() => null), revision: project.rev }; break;
          case 'runtime.stop': result = { ok: true }; setImmediate(() => { void closeRuntime(); }); break;
          default: return json(res, 400, { error: 'unknown runtime method', code: 'INVALID_ARGUMENT' });
        }
        return json(res, 200, result);
      }
      // ---------------- SSE ----------------
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');
        clients.add(res);
        res.write(`event: hello\ndata: ${JSON.stringify({ root: projectRoot, rev: project.rev })}\n\n`);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }

      // ---------------- 3D world (shared by viewport + blender) ----------------
      if (pathname === '/api/world' && req.method === 'GET') {
        const snapshot = project;
        const key = hashOf({ world: snapshot.world, cameras: snapshot.cameras, cameraOrder: snapshot.cameraOrder,
          // The corridor clearing depends on where the cameras fly, and a
          // camera parented to a 3D object flies with that object's tracks —
          // without `scene.objects` here, animating the parent left every open
          // window on the old city while a fresh one baked the right one.
          scene: snapshot.scene?.objects || null,
          fps: snapshot.meta.fps, duration: snapshot.meta.duration });
        if (!worldPromise || key !== worldKey) {
          worldKey = key;
          worldPromise = compute('world', snapshot);
          worldPromise.catch(() => { if (worldKey === key) worldPromise = null; });
        }
        const city = await worldPromise;
        return json(res, 200, { hash: city.hash, city, rev: snapshot.rev });
      }

      // ---------------- logs ----------------
      if (pathname === '/api/logs' && req.method === 'GET') {
        const n = Math.min(2000, Math.max(10, Number(url.searchParams.get('lines') || 300)));
        const lines = await log.tail(n);
        const records = [];
        for (const line of lines) {
          try { records.push(JSON.parse(line)); } catch { records.push({ ts: new Date().toISOString(), level: 'info', msg: line }); }
        }
        return json(res, 200, { file: log.fileFor(), records });
      }

      if (pathname === '/api/log' && req.method === 'POST') {
        const body = await readBody(req);
        const level = ['info', 'warn', 'error', 'debug'].includes(body.level) ? body.level : 'info';
        log[level](String(body.msg || 'renderer report').slice(0, 4000), { source: body.source || 'renderer', stack: body.stack ? String(body.stack).slice(0, 2000) : undefined, url: body.url });
        return json(res, 200, { ok: true });
      }

      // ---------------- state ----------------
      if (pathname === '/api/state') {
        let blender = null;
        try { blender = await blenderVersion(); } catch { /* not installed */ }
        const dsh = await findDsh();
        // ffmpeg availability for the status bar; probed once per engine process
        ffmpegAvailable ??= findBin('ffmpeg').then(() => true, () => false);
        return json(res, 200, {
          root: projectRoot,
          project,
          rev: project.rev,
          cli: CLI_PATH,
          blender,
          ffmpeg: await ffmpegAvailable,
          agent: { available: !!dsh, running: agent.running, runId: agent.runId },
          render: renderState,
          pipeline,
          styles: Object.keys(STYLE_PRESETS),
          version: '0.1.0',
        });
      }

      // ---------------- project picker ----------------
      if (pathname === '/api/projects/create' && req.method === 'POST') {
        const body = await readBody(req);
        const raw = String(body.dir || '').trim();
        if (!raw) return json(res, 400, { error: '请选择项目目录' });
        const dir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(APP_DIR, raw);
        if (await projectExists(dir)) return json(res, 409, { error: `这个目录已经有项目：${dir}` });
        const options = {
          title: String(body.title || '').trim() || path.basename(dir) || '未命名项目',
          fps: Math.max(1, Math.round(Number(body.fps) || 24)),
          width: Math.max(1, Math.round(Number(body.width) || 1920)),
          height: Math.max(1, Math.round(Number(body.height) || 1080)),
          duration: Math.max(0.1, Number(body.duration) || 12),
          background: /^#[0-9a-f]{6}$/i.test(String(body.background || '')) ? body.background : '#05070d',
        };
        try {
          // Create through the same transaction service as every other write:
          // it locks the new directory, writes the journal and publishes
          // project.vdm.json atomically.
          const tx = await projectService(dir).transact({ command: { type: 'initialize', options } }, { actorId: 'ui' });
          return json(res, 200, { ok: true, dir, project: tx.project });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      if (pathname === '/api/projects' && req.method === 'GET') {
        const list = [];
        const seen = new Set();
        const add = async (dir) => {
          const abs = path.resolve(dir);
          if (seen.has(abs)) return;
          seen.add(abs);
          try {
            const raw = await fsp.readFile(path.join(abs, PROJECT_FILE), 'utf8');
            const p = JSON.parse(raw);
            list.push({
              dir: abs,
              id: path.basename(abs),
              title: p.meta?.title || path.basename(abs),
              rev: p.rev | 0,
              width: p.meta?.width || 1920,
              height: p.meta?.height || 1080,
              fps: p.meta?.fps || 24,
              duration: p.meta?.duration || 0,
              camera: !!p.camera,
              savedAt: p.meta?.savedAt || null,
              current: abs === projectRoot,
            });
          } catch { /* not a project folder */ }
        };
        const base = path.join(APP_DIR, 'projects');
        try {
          for (const d of await fsp.readdir(base, { withFileTypes: true })) {
            if (d.isDirectory()) await add(path.join(base, d.name));
          }
        } catch { /* no projects dir */ }
        await add(projectRoot);
        list.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
        return json(res, 200, { root: projectRoot, projects: list });
      }

      if (pathname === '/api/projects/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const raw = String(body.dir || '').trim();
        if (!raw) return json(res, 400, { error: '缺少项目目录' });
        const dir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(APP_DIR, raw);
        const projectsDir = path.resolve(APP_DIR, 'projects');
        let realDir = '';
        let realBase = '';
        try {
          realDir = await fsp.realpath(dir);
          realBase = await fsp.realpath(projectsDir);
        } catch {
          return json(res, 404, { error: '项目目录不存在' });
        }
        const rel = path.relative(realBase, realDir);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          return json(res, 403, { error: '只能删除 projects/ 下的项目' });
        }
        let currentReal = path.resolve(projectRoot);
        try { currentReal = await fsp.realpath(projectRoot); } catch { /* keep resolved */ }
        const same = process.platform === 'win32'
          ? realDir.toLowerCase() === currentReal.toLowerCase()
          : realDir === currentReal;
        const currentInside = path.relative(realDir, currentReal);
        const containsCurrent = currentInside === '' || (!currentInside.startsWith('..') && !path.isAbsolute(currentInside));
        if (same || containsCurrent) {
          return json(res, 409, { error: '不能删除当前打开的项目，请先切换到其他项目' });
        }
        if (!(await projectExists(realDir))) return json(res, 404, { error: '这个目录不是项目' });
        try {
          await fsp.rm(realDir, { recursive: true, force: false });
        } catch (e) {
          return json(res, 500, { error: `删除失败：${e.message}` });
        }
        log.info('project deleted', { dir: realDir, by: body.by || 'ui' });
        return json(res, 200, { ok: true, dir: realDir });
      }

      // ---------------- project mutations ----------------
      if (pathname === '/api/ops' && req.method === 'POST') {
        const body = await readBody(req);
        const ops = Array.isArray(body.ops) ? body.ops : [body];
        const result = await transact({ ...transactionOptions(body), ops });
        return json(res, 200, { ok: true, ...result, changed: result.changedIds });
      }
      if (pathname === '/api/project' && req.method === 'GET') return json(res, 200, { project: await projects.read() });
      if (pathname === '/api/project' && req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, { ok: true, ...await transact({ ...transactionOptions(body), command: { type: 'replace', project: body.project } }) });
      }
      if (pathname === '/api/history' && req.method === 'GET') return json(res, 200, await projects.history());
      if ((pathname === '/api/undo' || pathname === '/api/redo') && req.method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, { ok: true, ...await transact({ ...transactionOptions(body), command: { type: pathname.endsWith('/undo') ? 'undo' : 'redo' } }) });
      }

      // ---------------- change sets (WP2.5a) ----------------
      // The review panel reads and writes change sets here; every write goes
      // through ChangeSetService over the one write path, as actorId 'ui'
      // (a human pressed the button, so a locked element does not block it).
      if (pathname === '/api/changesets' && req.method === 'GET') {
        const status = url.searchParams.get('status') || undefined;
        const actorId = url.searchParams.get('actorId') || undefined;
        const limit = url.searchParams.get('limit') || undefined;
        const offset = url.searchParams.get('offset') || undefined;
        return json(res, 200, { ok: true, ...await changesets.list({ status, actorId, limit, offset }) });
      }
      const changesetMatch = /^\/api\/changesets\/([A-Za-z0-9_.-]+)$/.exec(pathname);
      if (changesetMatch && req.method === 'GET') {
        return json(res, 200, { ok: true, changeset: await changesets.show(changesetMatch[1], { limit: url.searchParams.get('limit') || undefined }) });
      }
      if (pathname === '/api/changesets' && req.method === 'POST') {
        const body = await readBody(req);
        const action = String(body.action || '');
        const actorId = 'ui';
        if (action === 'preview') {
          const preview = await changesets.preview({
            id: body.id, ops: body.ops, actorId,
            expectedRev: body.expectedRev, includeProject: body.includeProject === true,
          });
          return json(res, 200, { ok: true, ...preview });
        }
        let record;
        if (action === 'propose') {
          record = await changesets.propose({ ops: body.ops, actorId, intent: body.intent });
          broadcast('changeset', { action, record });
          return json(res, 200, { ok: true, changeset: record });
        }
        if (action === 'apply') {
          record = await changesets.apply({ id: body.id, ops: body.ops, actorId, intent: body.intent, expectedRev: body.expectedRev, requestId: body.requestId });
        } else if (action === 'revert') {
          record = await changesets.revert({ id: body.id, actorId, expectedRev: body.expectedRev });
        } else if (action === 'revert-one') {
          record = await changesets.revertOne({ id: body.id, actorId, index: body.index, entityId: body.entityId, path: body.path, expectedRev: body.expectedRev });
        } else {
          throw fault('INVALID_ARGUMENT', 'changeset action must be propose | preview | apply | revert | revert-one');
        }
        const fresh = await projects.read();
        adoptDisk(fresh, 'changeset', { transactionId: record.transactions?.[0] });
        broadcast('changeset', { action, record });
        return json(res, 200, { ok: true, changeset: record, project: fresh });
      }

      // ---------------- measurements (WP2.1, used by the report tool) ----------------
      if (pathname === '/api/measure' && req.method === 'POST') {
        const body = await readBody(req);
        const kind = String(body.kind || '');
        const fresh = await projects.read();
        const pick = (...keys) => Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
        let result;
        if (kind === 'stackAt') result = stackAt(fresh, body.t, pick('frame', 'point', 'camera', 'measureText'));
        else if (kind === 'coverage') result = coverage(fresh, pick('f0', 'f1', 'from', 'to', 'point', 'focus', 'camera', 'grid', 'measureText'));
        else if (kind === 'cutEdges') result = cutEdges(fresh);
        else if (kind === 'pxAt') result = pxAt(fresh, pick('x', 'y', 'frame', 'time', 'camera', 'measureText'));
        else if (kind === 'diff') result = diff(body.before, body.after, pick('limit'));
        else if (kind === 'pixelCoverage') result = await pixelCoverage(projectRoot, pick('elementId', 'element', 'f0', 'f1', 'from', 'to', 'camera'));
        else throw fault('INVALID_ARGUMENT', 'measure kind must be stackAt | coverage | cutEdges | pxAt | diff | pixelCoverage');
        return json(res, 200, { ok: true, kind, result });
      }

      // ---------------- media ----------------
      if (pathname === '/api/media' && req.method === 'GET') {
        const result = await media.list({ limit: 500 });
        return json(res, 200, { ...result, media: result.items });
      }
      if (pathname === '/api/import' && req.method === 'POST') return json(res, 200, await media.import(await readBody(req)));

      if (pathname === '/api/upload' && req.method === 'POST') {
        const rawName = String(url.searchParams.get('name') || `upload-${Date.now()}.bin`);
        const ext = path.extname(rawName);
        const base = path.basename(rawName, ext).replace(/[^\w.\- ()一-龥]/g, '_').slice(0, 80);
        await fsp.mkdir(path.join(projectRoot, 'media'), { recursive: true });
        const mediaDir = await readPath(projectRoot, 'media');
        let name;
        const temporary = path.join(mediaDir, `.upload-${randomUUID()}`);
        let size = 0;
        const limit = new Transform({ transform(chunk, _encoding, done) {
          size += chunk.length;
          done(size > uploadLimit ? Object.assign(new Error('upload too large'), { status: 413 }) : null, chunk);
        } });
        const failed = (error) => limit.destroy(error);
        const aborted = () => failed(new Error('upload aborted'));
        req.once('error', failed);
        req.once('aborted', aborted);
        limit.once('error', () => { req.unpipe(limit); req.resume(); });
        try {
          req.pipe(limit);
          await streamPipeline(limit, fs.createWriteStream(temporary, { flags: 'wx' }));
          name = await publishMedia(temporary, mediaDir, `${base}${ext}`);
        } finally {
          req.off('error', failed);
          req.off('aborted', aborted);
          await fsp.rm(temporary, { force: true });
        }
        const dest = path.join(mediaDir, name);
        let info = null;
        try { info = await probeMedia(dest); } catch { /* not media */ }
        return json(res, 200, { imported: [{ path: `media/${name}`, name, info }] });
      }

      if (pathname === '/api/probe' && req.method === 'GET') {
        const src = url.searchParams.get('src');
        if (!src) return json(res, 400, { error: 'src required' });
        const file = await readPath(projectRoot, src);
        if (!(await fileExists(file))) return json(res, 404, { error: 'not found' });
        return json(res, 200, await probeMedia(file));
      }

      // ---------------- audio / storyboard ----------------
      if (pathname === '/api/beats' && req.method === 'POST') {
        const body = await readBody(req);
        const rel = body.src || project.meta.audio?.src;
        if (!rel) return json(res, 400, { error: 'no audio' });
        const file = await readPath(projectRoot, rel);
        toast('分析节拍中…');
        const result = await analyzeBeats(file, { duration: body.duration || null, fps: project.meta.fps });
        const ops = [
          { op: 'setMeta', path: 'beats', value: result.beats },
          { op: 'setMeta', path: 'tempo', value: result.tempo },
        ];
        if (!project.meta.audio) ops.push({ op: 'setMeta', path: 'audio', value: { src: rel, offset: 0, gain: 0 } });
        if (body.setDuration) ops.push({ op: 'setMeta', path: 'duration', value: Math.round(result.duration * 1000) / 1000 });
        await transact({ ...transactionOptions(body), ops }, 'beats');
        broadcast('beats', result);
        return json(res, 200, result);
      }

      if (pathname === '/api/plan' && req.method === 'POST') {
        const body = await readBody(req);
        const media = body.media || (await (async () => {
          const dir = path.join(projectRoot, 'media');
          try { return (await fsp.readdir(dir)).filter((f) => /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(f)).sort().map((f) => `media/${f}`); } catch { return []; }
        })());
        const opts = {
          media, style: body.style || 'neon', brief: body.brief || '',
          seed: body.seed ?? 7, maxSegments: body.maxSegments || 12, duration: body.duration || null,
        };
        const tx = await transact({ ...transactionOptions(body), command: { type: 'plan', options: opts } }, 'plan');
        const saved = tx.project, made = { segments: saved.segments.length, elements: saved.elements.length };
        setStep('storyboard', { status: 'done', detail: `${made.segments} 个分镜 · ${made.elements} 个元素` });
        addArtifact({ kind: 'storyboard', label: `自动分镜 · ${made.segments} 段`, detail: opts.style });
        return json(res, 200, { ok: true, project: saved, steps: made.segments });
      }

      // ---------------- capture (what the user sees) ----------------
      if (pathname === '/api/capture' && req.method === 'POST') {
        const body = await readBody(req);
        const m = /^data:image\/png;base64,(.+)$/s.exec(body.dataUrl || '');
        if (!m) return json(res, 400, { error: 'dataUrl must be a png data url' });
        const dir = path.join(p.vdm, 'frames');
        await fsp.mkdir(dir, { recursive: true });
        const name = `cap-${Date.now()}${body.label ? '-' + String(body.label).replace(/[^\w-]/g, '') : ''}.png`;
        const file = path.join(dir, name);
        await fsp.writeFile(file, Buffer.from(m[1], 'base64'));
        const art = { kind: 'still', label: body.label || '预览帧', time: body.time ?? null, path: file, url: `/frames/${name}` };
        addArtifact(art);
        return json(res, 200, art);
      }

      if (pathname === '/api/still' && req.method === 'POST') {
        const body = await readBody(req);
        const submitted = await jobs.submit({ kind: 'still', time: body.time ?? 0, scale: body.scale ?? 0.5,
          samples: body.samples ?? 8, expectedRev: body.expectedRev, requestId: body.requestId });
        const completed = await jobs.wait(submitted.id);
        if (completed.status !== 'succeeded') throw Object.assign(new Error(completed.error?.message || completed.status), completed.error || {});
        return json(res, 200, completed.artifact);
      }
      if (pathname === '/api/render' && req.method === 'POST') {
        const body = await readBody(req);
        const submitted = await jobs.submit({ kind: 'video', from: body.from ?? 0, to: body.to ?? project.meta.duration,
          scale: body.scale ?? 1, crf: body.crf ?? 18, expectedRev: body.expectedRev, requestId: body.requestId });
        return json(res, 200, { ok: true, jobId: submitted.id, state: renderState });
      }
      if (pathname === '/api/render/cancel' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.id || jobs.active?.id || renderState.jobId;
        return json(res, 200, { ok: true, ...(id ? { job: await jobs.cancel(id) } : {}) });
      }
      if (pathname === '/api/jobs' && req.method === 'GET') return json(res, 200, { jobs: await jobs.list() });

      // ---------------- agent ----------------
      if (pathname === '/api/agent' && req.method === 'POST') {
        if (agent.running) return json(res, 409, { error: 'agent already running' });
        const body = await readBody(req);
        const selection = body.selection || {};
        const frames = [];
        if (Array.isArray(body.frames)) {
          const dir = path.join(p.vdm, 'agent', 'frames', `run-${Date.now()}`);
          await fsp.mkdir(dir, { recursive: true });
          for (const f of body.frames) {
            const m = /^data:image\/png;base64,(.+)$/s.exec(f.dataUrl || '');
            if (!m) continue;
            const file = path.join(dir, `${String(f.label || frames.length).replace(/[^\w-]/g, '')}.png`);
            await fsp.writeFile(file, Buffer.from(m[1], 'base64'));
            frames.push(file);
          }
        }
        if (body.stillFrames) {
          for (const t of body.stillFrames) {
            const file = path.join(p.frames, `agent-${Date.now()}-${Math.round(t * 100)}.png`);
            const submitted = await jobs.submit({ kind: 'still', time: t, scale: 0.5, samples: 6 });
            const completed = await jobs.wait(submitted.id);
            if (completed.artifact) frames.push(completed.artifact.path);
          }
        }
        const summary = summarizeProject(project, { segmentId: selection.segmentId, time: body.time ?? 0 });
        const contextFile = await agent.writeContext({
          project, selection, frames,
          extra: { summary, playhead: body.time ?? 0, requestedAt: new Date().toISOString() },
        });
        try {
          const r = await agent.start({ task: body.task, contextFile, frames, selection, project });
          return json(res, 200, { ok: true, ...r, contextFile, frames });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }

      if (pathname === '/api/agent/cancel' && req.method === 'POST') {
        return json(res, 200, { ok: agent.cancel() });
      }
      // The plan gate of AgentLoop (WP2.4) is not reachable from this server
      // yet: the loop transport needs a dsh adapter that speaks its tool
      // protocol. Answer honestly instead of hanging the approve button.
      if (pathname === '/api/agent/approve' && req.method === 'POST') {
        return json(res, 404, { error: 'no plan is awaiting approval', code: 'NO_PENDING_PLAN' });
      }
      if (pathname === '/api/agent/state' && req.method === 'GET') {
        return json(res, 200, { ok: true, running: agent.running, runId: agent.runId });
      }

      // ---------------- timeline context for the agent ----------
      if (pathname === '/api/context' && req.method === 'GET') {
        const segmentId = url.searchParams.get('segment');
        const time = Number(url.searchParams.get('time') || 0);
        return json(res, 200, summarizeProject(project, { segmentId, time }));
      }

      // ---------------- raster frames for code layers (WP3.3) ----------------
      if (pathname === '/api/raster' && req.method === 'GET') return serveRaster(url, res);
      // Text meshes fetch their font bytes from here (§4.4 v4, WP1.3).
      if (pathname === '/api/font' && req.method === 'GET') return serveFont(url, res);

      // ---------------- static ----------------
      if (pathname === '/' || pathname === '/index.html') {
        return serveFile(req, res, path.join(RENDERER, 'index.html'));
      }
      if (pathname.startsWith('/app/')) return serveFile(req, res, await readPath(path.join(APP_DIR, 'app'), pathname.slice(5)));
      if (pathname.startsWith('/core/')) return serveFile(req, res, await readPath(CORE, pathname.slice(6)));
      if (pathname.startsWith('/media/')) {
        const file = await readPath(path.join(projectRoot, 'media'), pathname.slice(7));
        return file ? serveFile(req, res, file, { range: true }) : json(res, 400, { error: 'bad path' });
      }
      if (pathname.startsWith('/frames/')) {
        const file = await readPath(p.frames, pathname.slice(8));
        return file ? serveFile(req, res, file) : json(res, 400, { error: 'bad path' });
      }
      if (pathname.startsWith('/renders/')) {
        const file = await readPath(p.renders, pathname.slice(9));
        return file ? serveFile(req, res, file, { range: true }) : json(res, 400, { error: 'bad path' });
      }
      if (pathname.startsWith('/assets/')) {
        const file = await readPath(path.join(projectRoot, 'assets'), pathname.slice(8));
        return file ? serveFile(req, res, file) : json(res, 400, { error: 'bad path' });
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e.status || (e.code === 'ENOENT' ? 404 : isRejection(e) ? 400 : 500);
      log[status >= 500 ? 'error' : 'warn']('request failed', {
        method: req.method, path: pathname, error: e.message, stack: status >= 500 ? String(e.stack || '').slice(0, 1200) : undefined,
        log: e.log ? String(e.log).slice(-3000) : undefined,
      });
      if (!res.headersSent) json(res, status, { error: e.message, ...errorData(e) });
      else res.end();
    }
  });

  // listen, probing for a free port
  let listenPort = port;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(listenPort, '127.0.0.1');
      });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || attempt === 19) throw e;
      listenPort += 1;
    }
  }

  const actualPort = server.address().port;
  const info = { instanceId, token, version: 1, port: actualPort, pid: process.pid, url: `http://127.0.0.1:${actualPort}/`, root: projectRoot, startedAt: Date.now() };
  await atomicJson(p.app, info);

  if (open) openInBrowser(info.url, log);
  onReady?.(info);

  let closing;
  function closeRuntime() {
    return closing ||= (async () => {
      log.info('engine shutting down');
      await closeRasterPool();
      await agent.close();
      await jobs.close();
      await writeChain;
      clearTimeout(pipelineTimer);
      unwatch();
      for (const c of clients) { try { c.end(); } catch {} }
      clients.clear();
      await new Promise((r) => server.close(r));
      const record = await fsp.readFile(p.app, 'utf8').then(JSON.parse).catch(() => null);
      if (record?.instanceId === instanceId) await fsp.rm(p.app, { force: true });
      await releaseOwnership();
    })();
  }
  return { server, info, port: actualPort, jobs, projects,
    get project() { return project; }, close: closeRuntime };
}

export async function startServer(options = {}) {
  const root = await fsp.realpath(options.root);
  let releaseOwnership;
  try { releaseOwnership = await claimRuntime(root); }
  catch (e) {
    if (options.attach === false) throw e;
    const client = await connectRuntime(root, { start: false });
    return { info: client.info, port: client.info.port, remote: true, close: async () => {} };
  }
  try { return await startOwnedServer({ ...options, root, releaseOwnership }); }
  catch (e) { await releaseOwnership(); throw e; }
}

// direct run: node engine/server.js [--project <dir>] [--port N] [--open]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const rootArg = arg('--project') || process.cwd();
  const root = (await findProjectRoot(rootArg)) || rootArg;
  const port = Number(arg('--port', 47100));
  const open = argv.includes('--open');
  try {
    const s = await startServer({ root, port, open });
    console.log(`[vdm] serving ${s.info.url}  project=${root}`);
    const bye = async () => { await s.close(); process.exit(0); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  } catch (e) {
    console.error('[vdm]', e.message);
    process.exit(1);
  }
}
