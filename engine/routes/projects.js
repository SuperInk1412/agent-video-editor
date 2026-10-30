// Project lifecycle + editing routes: the picker, the one write path and history.
//
//   GET  /api/projects             list the projects under app/projects + this one
//   POST /api/projects/create      create a project through the transaction service
//   POST /api/projects/delete      delete a project folder under app/projects
//   POST /api/ops                  apply ops (the one write path)
//   GET  /api/project              read the current project
//   POST /api/project              replace the project document
//   GET  /api/history              the journal
//   POST /api/undo, /api/redo      undo / redo one step
//
// Every write goes through `ctx.transact`, exactly as it did inside server.js.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_FILE, projectExists } from '../storage.js';
import { projectService } from '../projects.js';

export function register(router, ctx) {
  const { json, readBody, log, projects, transact, transactionOptions } = ctx;
  const appDir = ctx.appDir;

  // ---------------- project picker ----------------
  router.post('/api/projects/create', async (req, res) => {
    const body = await readBody(req);
    const raw = String(body.dir || '').trim();
    if (!raw) return json(res, 400, { error: '请选择项目目录' });
    const dir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(appDir, raw);
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
  });

  router.get('/api/projects', async (req, res) => {
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
          current: abs === ctx.root,
        });
      } catch { /* not a project folder */ }
    };
    const base = path.join(appDir, 'projects');
    try {
      for (const d of await fsp.readdir(base, { withFileTypes: true })) {
        if (d.isDirectory()) await add(path.join(base, d.name));
      }
    } catch { /* no projects dir */ }
    await add(ctx.root);
    list.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    return json(res, 200, { root: ctx.root, projects: list });
  });

  router.post('/api/projects/delete', async (req, res) => {
    const body = await readBody(req);
    const raw = String(body.dir || '').trim();
    if (!raw) return json(res, 400, { error: '缺少项目目录' });
    const dir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(appDir, raw);
    const projectsDir = path.resolve(appDir, 'projects');
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
    let currentReal = path.resolve(ctx.root);
    try { currentReal = await fsp.realpath(ctx.root); } catch { /* keep resolved */ }
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
  });

  // ---------------- project mutations ----------------
  router.post('/api/ops', async (req, res) => {
    const body = await readBody(req);
    const ops = Array.isArray(body.ops) ? body.ops : [body];
    const result = await transact({ ...transactionOptions(body), ops });
    return json(res, 200, { ok: true, ...result, changed: result.changedIds });
  });
  router.get('/api/project', async (req, res) => json(res, 200, { project: await projects.read() }));
  router.post('/api/project', async (req, res) => {
    const body = await readBody(req);
    return json(res, 200, { ok: true, ...await transact({ ...transactionOptions(body), command: { type: 'replace', project: body.project } }) });
  });
  router.get('/api/history', async (req, res) => json(res, 200, await projects.history()));
  const undoRedo = async (req, res, { pathname }) => {
    const body = await readBody(req);
    return json(res, 200, { ok: true, ...await transact({ ...transactionOptions(body), command: { type: pathname.endsWith('/undo') ? 'undo' : 'redo' } }) });
  };
  router.post('/api/undo', undoRedo);
  router.post('/api/redo', undoRedo);
}
