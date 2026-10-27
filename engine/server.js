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
  paths, loadProject, saveProject, findProjectRoot, watchProject,
  ensureProjectDirs, projectExists, withLock, PROJECT_FILE,
} from '../core/store.js';
import { normalizeProject, createProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { applyOps } from '../core/ops.js';
import { probeMedia, mimeOf, fileExists } from './media.js';
import { renderStill, renderVideo, blenderVersion, findBlender } from './blender.js';
import { analyzeBeats } from './beats.js';
import { planProject, summarizeProject, STYLE_PRESETS } from './storyboard.js';
import { AgentRunner, findDsh, CLI_PATH } from './agent.js';
import { createLogger } from './log.js';
import { cachedCity, is3D } from './shot.js';
import { bakeCameraTrack } from '../core/camera.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const RENDERER = path.join(APP_DIR, 'app', 'renderer');
const CORE = path.join(APP_DIR, 'core');

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
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`bad json: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.posix.sep + rel);
  if (!p.startsWith(path.resolve(base))) return null;
  return p;
}

async function serveFile(req, res, file, { range = false } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return json(res, 404, { error: 'not found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'not a file' });
  const mime = mimeOf(file);
  const head = { 'content-type': mime, 'cache-control': 'no-cache', 'accept-ranges': 'bytes', 'content-disposition': 'inline' };
  if (range && req.headers.range) {
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end)) end = st.size - 1;
    if (start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, {
      ...head,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'content-length': end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': st.size });
  return fs.createReadStream(file).pipe(res);
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

export async function startServer({ root, port = 47100, open = false, onReady } = {}) {
  const projectRoot = path.resolve(root);
  if (!(await projectExists(projectRoot))) {
    throw new Error(`no ${PROJECT_FILE} in ${projectRoot}`);
  }
  const p = await ensureProjectDirs(projectRoot);
  const log = createLogger({ dir: projectRoot });
  log.info('engine starting', { root: projectRoot, pid: process.pid, version: '0.1.0' });
  let project = await loadProject(projectRoot);
  let lastRev = project.rev;

  const clients = new Set();
  const broadcast = (type, data) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      try { c.write(payload); } catch { /* dropped */ }
    }
  };
  const toast = (message, level = 'info') => broadcast('toast', { message, level, at: Date.now() });
  log.onLine((rec) => { if (rec.level !== 'debug') broadcast('log', rec); });

  // ---- undo/redo (in-memory, per session) ----
  // Every change to the file lands here, whoever made it (UI, AI, or a CLI
  // write noticed by the watcher), so all of them can be undone from the UI.
  const history = { undo: [], redo: [], max: 80 };
  const snapshot = (proj) => JSON.stringify(proj);
  const pushUndo = (proj) => {
    history.undo.push(snapshot(proj));
    if (history.undo.length > history.max) history.undo.shift();
    history.redo.length = 0;
  };

  // ---- the one write path ----
  // Writes run one at a time, under the cross-process lock, against the file
  // on disk (not the in-memory copy), so a CLI/agent edit that the watcher has
  // not picked up yet is never overwritten. `fn(current)` returns the next
  // project (it may mutate and return its argument, a private copy); throwing
  // writes nothing.
  let writeChain = Promise.resolve();
  const serialized = (fn) => {
    const run = writeChain.then(fn, fn);
    writeChain = run.catch(() => {});
    return run;
  };
  const adoptDisk = (fresh) => {
    if (fresh.rev === lastRev) return false;
    pushUndo(project);
    project = fresh;
    lastRev = fresh.rev;
    broadcast('project', { project, source: 'disk', rev: fresh.rev });
    updateStoryboardStep(fresh);
    return true;
  };
  const commit = (by, fn, { undo = 'push' } = {}) => serialized(() => withLock(projectRoot, async () => {
    const current = await loadProject(projectRoot);
    adoptDisk(current);
    const work = JSON.parse(JSON.stringify(current));
    const out = await fn(work);
    const next = normalizeProject(out?.project || work);
    next.rev = current.rev; // keep rev monotonic even when restoring a snapshot
    const saved = await saveAndBroadcast(next, by);
    if (undo === 'push') pushUndo(current);
    return { saved, result: out?.result };
  }));
  // Anything that goes wrong while applying ops (or validating the result) is
  // the caller's fault (400), not the engine's (500).
  const applyOrReject = (cur, ops) => {
    try {
      return applyOps(cur, ops).changed;
    } catch (e) {
      e.rejected = true;
      throw e;
    }
  };
  const isRejection = (e) => !!(e?.rejected || e?.issues);

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
  let renderAbort = null;

  const agent = new AgentRunner({
    root: projectRoot,
    onEvent: async (ev) => {
      if (ev.type === 'proposal') {
        try {
          const { saved, result: changed } = await commit('ai', (cur) => ({ project: cur, result: applyOrReject(cur, ev.proposal.ops) }));
          log.info('agent applied', { ops: ev.proposal.ops.length, changed, rev: saved.rev, note: ev.proposal.note });
          broadcast('agent', { ...ev, applied: { changed, note: ev.proposal.note, rev: saved.rev } });
          addArtifact({ kind: 'ai', label: `AI 改了 ${changed.length} 项`, detail: ev.proposal.note });
          toast(`AI 已应用 ${changed.length} 处修改`, 'success');
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
      adoptDisk(await loadProject(projectRoot));
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

  async function saveAndBroadcast(next, by = 'ui') {
    const saved = await saveProject(projectRoot, next, { by });
    project = saved;
    lastRev = saved.rev;
    updateStoryboardStep(saved);
    broadcast('project', { project: saved, source: by, rev: saved.rev });
    return saved;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    try {
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
        const flight = is3D(project) ? bakeCameraTrack(project).map((c) => c.pos) : null;
        const city = cachedCity(project.world, flight);
        return json(res, 200, { hash: city.hash, city });
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
        return json(res, 200, {
          root: projectRoot,
          project,
          rev: project.rev,
          cli: CLI_PATH,
          blender,
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
        const width = Math.max(1, Math.round(Number(body.width) || 1920));
        const height = Math.max(1, Math.round(Number(body.height) || 1080));
        const fps = Math.max(1, Math.round(Number(body.fps) || 24));
        const duration = Math.max(0.1, Number(body.duration) || 12);
        const project = createProject({
          title: String(body.title || '').trim() || path.basename(dir) || '未命名项目',
          fps, width, height, duration,
          background: /^#[0-9a-f]{6}$/i.test(String(body.background || '')) ? body.background : '#05070d',
        });
        ensureSpace(project);
        try {
          await saveProject(dir, project, { by: 'ui' });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
        return json(res, 200, { ok: true, dir, project });
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
        if (!ops.length) return json(res, 400, { error: 'no ops' });
        try {
          const { saved, result: changed } = await commit(body.by || 'ui', (cur) => ({ project: cur, result: applyOrReject(cur, ops) }));
          return json(res, 200, { ok: true, changed, rev: saved.rev, project: saved });
        } catch (e) {
          if (!isRejection(e)) throw e;
          log.warn('ops rejected', { error: e.message, ops: ops.map((o) => o?.op).join(',') });
          return json(res, 400, { error: e.message, code: e.code || 'OP_FAILED' });
        }
      }

      if (pathname === '/api/project' && req.method === 'POST') {
        const body = await readBody(req);
        const replacement = normalizeProject(body.project);
        const { saved } = await commit(body.by || 'ui', () => ({ project: replacement }));
        return json(res, 200, { ok: true, project: saved });
      }

      if ((pathname === '/api/undo' || pathname === '/api/redo') && req.method === 'POST') {
        const isUndo = pathname === '/api/undo';
        const empty = new Error(isUndo ? 'nothing to undo' : 'nothing to redo');
        try {
          const { saved } = await commit(isUndo ? 'undo' : 'redo', (cur) => {
            const from = isUndo ? history.undo : history.redo;
            const to = isUndo ? history.redo : history.undo;
            if (!from.length) throw empty;
            const target = JSON.parse(from.pop());
            to.push(snapshot(cur));
            return { project: target };
          }, { undo: 'none' });
          return json(res, 200, { ok: true, project: saved, undo: history.undo.length, redo: history.redo.length });
        } catch (e) {
          if (e === empty) return json(res, 409, { error: e.message });
          throw e;
        }
      }

      // ---------------- media ----------------
      if (pathname === '/api/media' && req.method === 'GET') {
        const mediaDir = path.join(projectRoot, 'media');
        const out = [];
        const walk = async (dir, prefix = '') => {
          let entries = [];
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
            else out.push({ name: e.name, path: `media/${rel}`, size: 0 });
          }
        };
        await walk(mediaDir);
        for (const m of out) {
          try { m.size = (await fsp.stat(path.join(projectRoot, m.path))).size; } catch { /* ignore */ }
        }
        return json(res, 200, { media: out });
      }

      if (pathname === '/api/import' && req.method === 'POST') {
        const body = await readBody(req);
        const files = Array.isArray(body.files) ? body.files : [];
        const mediaDir = path.join(projectRoot, 'media');
        await fsp.mkdir(mediaDir, { recursive: true });
        const imported = [];
        for (const f of files) {
          const src = path.resolve(f);
          if (!(await fileExists(src))) continue;
          let name = path.basename(src);
          let dest = path.join(mediaDir, name);
          let i = 1;
          while (await fileExists(dest)) {
            const ext = path.extname(name);
            name = `${path.basename(name, ext)}-${i++}${ext}`;
            dest = path.join(mediaDir, name);
          }
          await fsp.copyFile(src, dest);
          let info = null;
          try { info = await probeMedia(dest); } catch { /* not media */ }
          imported.push({ path: `media/${name}`, name, info });
        }
        return json(res, 200, { imported });
      }

      if (pathname === '/api/upload' && req.method === 'POST') {
        const rawName = String(url.searchParams.get('name') || `upload-${Date.now()}.bin`);
        const ext = path.extname(rawName);
        const base = path.basename(rawName, ext).replace(/[^\w.\- ()一-龥]/g, '_').slice(0, 80);
        const mediaDir = path.join(projectRoot, 'media');
        await fsp.mkdir(mediaDir, { recursive: true });
        let name = `${base}${ext}`;
        let dest = path.join(mediaDir, name);
        let i = 1;
        while (await fileExists(dest)) { name = `${base}-${i++}${ext}`; dest = path.join(mediaDir, name); }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        await fsp.writeFile(dest, Buffer.concat(chunks));
        let info = null;
        try { info = await probeMedia(dest); } catch { /* not media */ }
        return json(res, 200, { imported: [{ path: `media/${name}`, name, info }] });
      }

      if (pathname === '/api/probe' && req.method === 'GET') {
        const src = url.searchParams.get('src');
        if (!src) return json(res, 400, { error: 'src required' });
        const file = path.isAbsolute(src) ? src : path.join(projectRoot, src);
        if (!(await fileExists(file))) return json(res, 404, { error: 'not found' });
        return json(res, 200, await probeMedia(file));
      }

      // ---------------- audio / storyboard ----------------
      if (pathname === '/api/beats' && req.method === 'POST') {
        const body = await readBody(req);
        const rel = body.src || project.meta.audio?.src;
        if (!rel) return json(res, 400, { error: 'no audio' });
        const file = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
        toast('分析节拍中…');
        const result = await analyzeBeats(file, { duration: body.duration || null, fps: project.meta.fps });
        await commit('beats', (cur) => {
          const ops = [
            { op: 'setMeta', path: 'beats', value: result.beats },
            { op: 'setMeta', path: 'tempo', value: result.tempo },
          ];
          if (!cur.meta.audio) ops.push({ op: 'setMeta', path: 'audio', value: { src: rel, offset: 0, gain: 0 } });
          if (body.setDuration) ops.push({ op: 'setMeta', path: 'duration', value: Math.round(result.duration * 1000) / 1000 });
          applyOps(cur, ops);
          return { project: cur };
        });
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
        let saved, made;
        try {
          ({ saved, result: made } = await commit('plan', (cur) => {
            try {
              return { project: cur, result: planProject(cur, opts) };
            } catch (err) {
              err.rejected = true;
              throw err;
            }
          }));
        } catch (e) {
          if (!isRejection(e)) throw e;
          return json(res, 400, { error: e.message });
        }
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
        const time = Number(body.time ?? 0);
        toast(`Blender 渲染第 ${time.toFixed(2)}s 预览帧…`);
        const out = path.join(p.frames, `blender-${Date.now()}.png`);
        const file = await renderStill({
          dir: projectRoot, project, time, out,
          scale: body.scale ?? 0.5, samples: body.samples ?? 8,
          onLog: () => {},
        });
        const name = path.basename(file);
        const art = { kind: 'still', label: `Blender 帧 @${time.toFixed(2)}s`, time, path: file, url: `/frames/${name}` };
        addArtifact(art);
        setStep('stills', { status: 'done', detail: `最新 Blender 帧 @${time.toFixed(2)}s` });
        return json(res, 200, art);
      }

      // ---------------- render ----------------
      if (pathname === '/api/render' && req.method === 'POST') {
        if (renderState.running) return json(res, 409, { error: 'render already running' });
        const body = await readBody(req);
        const from = Number(body.from ?? 0);
        const to = Number(body.to ?? project.meta.duration);
        const scale = Number(body.scale ?? 1);
        const crf = Number(body.crf ?? 18);
        const full = from <= 0.001 && to >= project.meta.duration - 0.05;
        const out = body.out
          ? path.resolve(body.out)
          : path.join(p.renders, `${full ? 'master' : 'part'}-${Date.now()}.mp4`);
        Object.assign(renderState, {
          running: true, kind: full ? 'master' : 'part', from, to, progress: 0,
          total: Math.max(1, Math.round((to - from) * project.meta.fps)), startedAt: Date.now(), out, error: null,
        });
        renderAbort = new AbortController();
        log.info('render start', { kind: renderState.kind, from, to, scale, total: renderState.total, out });
        broadcast('render', renderState);
        setStep(full ? 'master' : 'render', { status: 'running', detail: `${from.toFixed(1)}s → ${to.toFixed(1)}s` });

        (async () => {
          try {
            const res2 = await renderVideo({
              dir: projectRoot, project, from, to, out, scale, crf, signal: renderAbort.signal,
              onLog: () => {},
              onProgress: (ev) => {
                if (ev.stage === 'frame') {
                  renderState.progress = ev.frame;
                  renderState.total = ev.total;
                  broadcast('render', renderState);
                } else if (ev.stage === 'built') {
                  broadcast('render', { ...renderState, built: ev.sec });
                }
              },
            });
            Object.assign(renderState, { running: false, out: res2.out });
            const name = path.basename(res2.out);
            setStep(full ? 'master' : 'render', { status: 'done', detail: `${(to - from).toFixed(1)}s · ${name}` });
            addArtifact({ kind: 'render', label: `${full ? '成片' : '片段'} ${from.toFixed(1)}–${to.toFixed(1)}s`, path: res2.out, url: `/renders/${name}` });
            log.info('render done', { out: res2.out, frames: res2.frames, sec: (Date.now() - renderState.startedAt) / 1000 });
            broadcast('render', { ...renderState, done: true, url: `/renders/${name}` });
            toast(`渲染完成: ${name}`, 'success');
          } catch (e) {
            Object.assign(renderState, { running: false, error: e.message });
            log.error('render failed', { error: e.message, log: e.log ? String(e.log).slice(-3000) : undefined });
            setStep(full ? 'master' : 'render', { status: 'error', detail: e.message.slice(0, 120) });
            broadcast('render', { ...renderState, error: e.message });
            toast(`渲染失败: ${e.message}`, 'error');
          } finally {
            renderAbort = null;
          }
        })();
        return json(res, 200, { ok: true, out, state: renderState });
      }

      if (pathname === '/api/render/cancel' && req.method === 'POST') {
        if (renderAbort) renderAbort.abort();
        renderState.running = false;
        broadcast('render', { ...renderState, cancelled: true });
        return json(res, 200, { ok: true });
      }

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
            await renderStill({ dir: projectRoot, project, time: t, out: file, scale: 0.5, samples: 6, onLog: () => {} });
            frames.push(file);
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

      // ---------------- timeline context for the agent ----------
      if (pathname === '/api/context' && req.method === 'GET') {
        const segmentId = url.searchParams.get('segment');
        const time = Number(url.searchParams.get('time') || 0);
        return json(res, 200, summarizeProject(project, { segmentId, time }));
      }

      // ---------------- static ----------------
      if (pathname === '/' || pathname === '/index.html') {
        return serveFile(req, res, path.join(RENDERER, 'index.html'));
      }
      if (pathname.startsWith('/app/')) return serveFile(req, res, safeJoin(APP_DIR, pathname) || '');
      if (pathname.startsWith('/core/')) return serveFile(req, res, safeJoin(APP_DIR, pathname) || '');
      if (pathname.startsWith('/media/')) {
        const file = safeJoin(path.join(projectRoot, 'media'), pathname.slice(7));
        return file ? serveFile(req, res, file, { range: true }) : json(res, 400, { error: 'bad path' });
      }
      if (pathname.startsWith('/frames/')) {
        const file = safeJoin(p.frames, pathname.slice(8));
        return file ? serveFile(req, res, file) : json(res, 400, { error: 'bad path' });
      }
      if (pathname.startsWith('/renders/')) {
        const file = safeJoin(p.renders, pathname.slice(9));
        return file ? serveFile(req, res, file, { range: true }) : json(res, 400, { error: 'bad path' });
      }
      if (pathname.startsWith('/assets/')) {
        const file = safeJoin(path.join(projectRoot, 'assets'), pathname.slice(8));
        return file ? serveFile(req, res, file) : json(res, 400, { error: 'bad path' });
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      log.error('request failed', {
        method: req.method, path: pathname, error: e.message, stack: String(e.stack || '').slice(0, 1200),
        log: e.log ? String(e.log).slice(-3000) : undefined,
      });
      if (!res.headersSent) json(res, 500, { error: e.message });
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
  const info = { port: actualPort, pid: process.pid, url: `http://127.0.0.1:${actualPort}/`, root: projectRoot, startedAt: Date.now() };
  await fsp.writeFile(path.join(p.vdm, 'app.json'), JSON.stringify(info, null, 2));

  if (open) openInBrowser(info.url, log);
  onReady?.(info);

  return {
    server, info, port: actualPort,
    get project() { return project; },
    async close() {
      log.info('engine shutting down');
      agent.cancel();
      unwatch();
      for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
      clients.clear();
      await new Promise((r) => server.close(r));
      await fsp.rm(path.join(p.vdm, 'app.json'), { force: true }).catch(() => {});
    },
  };
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
