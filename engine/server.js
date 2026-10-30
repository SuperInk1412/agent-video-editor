// VedioMaker engine server: static files + JSON API + SSE.
// Pure Node. Electron only wraps it in a window.
//
// The JSON API lives in `engine/routes/` — one file per feature, each exporting
// `register(router, ctx)` (docs/DESIGN-BACKEND-V2.md §10.4.3). This file keeps
// the parts that genuinely need the whole process: the engine state every route
// shares (`ctx`), the route registration order, static file serving, the
// host/origin guard and the one error boundary.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  paths, findProjectRoot, watchProject,
  ensureProjectDirs, projectExists, PROJECT_FILE, atomicJson,
} from './storage.js';
import { projectService } from './projects.js';
import { errorData } from '../application/errors.js';
import { ChangeSetService } from '../application/changeset-service.js';
import { mimeOf, findBin } from './media.js';
import { AgentLoop, ProcessAgent, ScriptedAgent, pngSize } from './agent.js';
import { DshAgent } from './dsh-agent.js';
import { createLogger } from './log.js';
import { readPath } from './path-policy.js';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { claimRuntime, connectRuntime } from './runtime.js';
import { createJobService } from './jobs.js';
import { mediaService } from './media-service.js';
import {
  createRouter, projectRoutes, mediaRoutes, jobRoutes, agentRoutes, changesetRoutes,
  reportRoutes, measureRoutes, rasterRoutes, closeRasterPool, fontRoutes, eventRoutes,
} from './routes/index.js';

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

  // ---- the edit agent (WP2.5e) ----
  // One AgentLoop, created on first use (`ctx.agent`). The transport is chosen
  // once, in priority order:
  //   VDM_AGENT_SCRIPT  a JSON script            → ScriptedAgent (tests / offline)
  //   VDM_AGENT_BIN     an external line adapter → ProcessAgent
  //   otherwise         dsh headless, one process per step → DshAgent
  // Scope / mode / approval are engine configuration: `VDM_AGENT_SCOPE` (JSON,
  // default the whole project), `VDM_AGENT_MODE=create`, `VDM_AGENT_APPROVAL=manual`.
  // With no dsh on the machine the first step raises AGENT_UNAVAILABLE and
  // POST /api/agent answers 503 instead of pretending an agent ran.
  const agentScope = () => {
    const raw = process.env.VDM_AGENT_SCOPE;
    if (!raw) return { elements: ['*'], paths: ['*'], create: true };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* fall through to the default */ }
    log.warn('could not parse VDM_AGENT_SCOPE; using the whole project', { value: String(raw).slice(0, 200) });
    return { elements: ['*'], paths: ['*'], create: true };
  };
  const createAgentTransport = () => {
    const script = process.env.VDM_AGENT_SCRIPT;
    if (script) {
      const parsed = JSON.parse(fs.readFileSync(script, 'utf8').replace(/^\uFEFF/, ''));
      const steps = Array.isArray(parsed) ? parsed : parsed?.script;
      if (!Array.isArray(steps)) throw new Error(`agent script ${script} must be a JSON array or {"script": [...]}`);
      return new ScriptedAgent({ name: 'scripted-file', script: steps });
    }
    if (process.env.VDM_AGENT_BIN) {
      return new ProcessAgent({
        node: process.env.VDM_AGENT_NODE || process.execPath,
        bin: process.env.VDM_AGENT_BIN,
        cwd: projectRoot,
        name: 'process-adapter',
      });
    }
    return new DshAgent({ root: projectRoot, cwd: projectRoot, name: 'dsh' });
  };
  // The loop's still backend is the engine's own render queue (the same still
  // job the UI submits), so the report quotes a real PNG with a real size.
  const renderStillForAgent = async ({ t }) => {
    const started = Date.now();
    const submitted = await jobs.submit({ kind: 'still', time: t, scale: 0.5, samples: 6 });
    const completed = await jobs.wait(submitted.id);
    if (completed.status !== 'succeeded' || !completed.artifact?.path) {
      throw Object.assign(new Error(completed.error?.message || `still job ${completed.status}`), {
        code: completed.error?.code || 'STILL_FAILED',
      });
    }
    const bytes = await fsp.readFile(completed.artifact.path);
    return { path: completed.artifact.path, ...pngSize(bytes), bytes: bytes.length, ms: Date.now() - started, backend: 'job:still' };
  };
  // Every loop event reaches the renderer as `agent`; change sets also go out on
  // their own SSE channel (the review panel listens there) and an applied one
  // updates the engine's in-memory project, exactly like the legacy proposal.
  const onAgentEvent = async (event) => {
    broadcast('agent', event);
    if (event.type !== 'changeset') return;
    broadcast('changeset', { action: event.action, record: event.record });
    if (event.action !== 'apply' && event.action !== 'revert') return;
    try {
      adoptDisk(await projects.read(), 'agent', { transactionId: event.record?.transactions?.[0] });
      if (event.action === 'apply') {
        const changed = event.record?.changed?.length ?? 0;
        addArtifact({ kind: 'ai', label: `AI 改了 ${changed} 项`, detail: event.record?.intent || '' });
        toast(`AI 已应用 ${changed} 处修改`, 'success');
      }
    } catch (e) {
      log.warn('agent change set could not be adopted', { error: e.message, changeset: event.record?.id });
    }
  };
  let agentLoop = null;
  const getAgent = () => {
    agentLoop ||= new AgentLoop({
      root: projectRoot,
      scope: agentScope(),
      agent: createAgentTransport(),
      service: projects,
      changesets,
      renderStill: renderStillForAgent,
      actorId: 'agent:dsh',
      mode: process.env.VDM_AGENT_MODE === 'create' ? 'create' : 'tune',
      approval: process.env.VDM_AGENT_APPROVAL === 'manual' ? 'manual' : 'auto',
      onEvent: onAgentEvent,
    });
    return agentLoop;
  };

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

  // ---- the route table (engine/routes) ----
  // `ctx` is the whole contract between the engine and a feature route file:
  // services, the one write path, SSE, and getters for state that changes while
  // the server runs. Registration order is the old if-chain's order.
  const ctx = {
    root: projectRoot,
    appDir: APP_DIR,
    paths: p,
    log, json, readBody, uploadLimit,
    projects, changesets, media, jobs,
    // Lazy: `/api/state` and the agent routes always see the same instance,
    // and a server that never runs the agent never resolves a transport.
    get agent() { return getAgent(); },
    transact, transactionOptions, adoptDisk,
    broadcast, toast, setStep, addArtifact,
    getProject: () => project,
    renderState, pipeline, clients,
    instanceId, token,
    // Per-engine mutable state the old closures kept. Do not hoist these to
    // module scope: two engines in one process each need their own.
    worldCache: { key: null, promise: null },
    rasterPool: { current: null },
    ffmpegAvailable: () => (ffmpegAvailable ??= findBin('ffmpeg').then(() => true, () => false)),
    closeRuntime: () => closeRuntime(),
  };
  const router = createRouter();
  projectRoutes(router, ctx);
  changesetRoutes(router, ctx);
  measureRoutes(router, ctx);
  reportRoutes(router, ctx);
  mediaRoutes(router, ctx);
  jobRoutes(router, ctx);
  agentRoutes(router, ctx);
  rasterRoutes(router, ctx);
  fontRoutes(router, ctx);
  eventRoutes(router, ctx);

  const server = http.createServer(async (req, res) => {
    let pathname = req.url;
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const host = new URL(`http://${req.headers.host || ''}`);
      if (!['127.0.0.1', 'localhost'].includes(host.hostname) || host.port !== String(server.address().port)) return json(res, 403, { error: 'invalid host', code: 'ACCESS_DENIED' });
      if (req.headers.origin && ![origin, `http://localhost:${server.address().port}`].includes(req.headers.origin)) return json(res, 403, { error: 'invalid origin', code: 'ACCESS_DENIED' });
      const url = new URL(req.url, origin);
      try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'invalid URL encoding', code: 'INVALID_ARGUMENT' }); }

      // ---------------- JSON API (engine/routes/*.js) ----------------
      const route = router.match(req.method, pathname);
      // Awaited inside this try so a throw becomes the same JSON error the
      // inline handler produced (400 for a rejected op, 500 + a log line else).
      if (route) return await route.handler(req, res, { url, pathname, params: route.params });

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
      await closeRasterPool(ctx.rasterPool);
      if (agentLoop) await agentLoop.close();
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
    get project() { return project; }, close: closeRuntime, router };
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
