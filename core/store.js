// Project persistence: atomic writes, a cross-process lock, external-change watching.
// The file on disk is the single source of truth; both the UI and the agent mutate it
// through this module (or through the CLI, which uses the same module).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { normalizeProject, validateProject } from './schema.js';
import { ensureSpace } from './space.js';
import { ensureAudioElements } from './audio.js';

export const PROJECT_FILE = 'project.vdm.json';
export const VDM_DIR = '.vdm';

export const paths = (dir) => {
  const root = path.resolve(dir);
  const vdm = path.join(root, VDM_DIR);
  return {
    root,
    file: path.join(root, PROJECT_FILE),
    vdm,
    cache: path.join(vdm, 'cache'),
    frames: path.join(vdm, 'frames'),
    renders: path.join(vdm, 'renders'),
    agent: path.join(vdm, 'agent'),
    lock: path.join(vdm, 'lock'),
    app: path.join(vdm, 'app.json'),
    pipeline: path.join(vdm, 'pipeline.json'),
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ensureProjectDirs(dir) {
  const p = paths(dir);
  for (const d of [p.vdm, p.cache, p.frames, p.renders, p.agent]) {
    await fs.mkdir(d, { recursive: true });
  }
  return p;
}

/** Walk up from a directory until project.vdm.json is found. */
export async function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    try {
      await fs.access(path.join(dir, PROJECT_FILE));
      return dir;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadProject(dir) {
  const file = paths(dir).file;
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no ${PROJECT_FILE} in ${path.resolve(dir)}`);
    throw e;
  }
  const project = JSON.parse(raw);
  normalizeProject(project);
  // Every project is 3D: a former 2D project gets the empty world and the
  // default camera when it is opened (docs/DESIGN-UNIFIED-SPACE.md §7).
  ensureSpace(project);
  // Old projects kept their song only in meta.audio; show it as a real element.
  ensureAudioElements(project);
  return project;
}

export async function saveProject(dir, project, { by = 'ui' } = {}) {
  const p = await ensureProjectDirs(dir);
  const issues = validateProject(project);
  if (issues.length) {
    const err = new Error(`invalid project: ${issues.map((i) => `${i.path}: ${i.msg}`).join('; ')}`);
    err.issues = issues;
    throw err;
  }
  project.rev = (project.rev || 0) + 1;
  project.meta.savedAt = new Date().toISOString();
  const json = JSON.stringify(project, null, 2) + '\n';
  const tmp = `${p.file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, json, 'utf8');
  await fs.rename(tmp, p.file);
  await fs.writeFile(p.app && path.join(p.vdm, 'last-save.json'),
    JSON.stringify({ rev: project.rev, by, at: project.meta.savedAt }, null, 2)).catch(() => {});
  return project;
}

/** Acquire an inter-process lock (mkdir is atomic on every platform we care about). */
export async function withLock(dir, fn, { timeout = 8000, stale = 15000 } = {}) {
  const p = await ensureProjectDirs(dir);
  const t0 = Date.now();
  for (;;) {
    try {
      await fs.mkdir(p.lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(p.lock);
        if (Date.now() - st.mtimeMs > stale) {
          await fs.rm(p.lock, { recursive: true, force: true });
          continue;
        }
      } catch { /* raced */ }
      if (Date.now() - t0 > timeout) throw new Error(`project is locked: ${p.lock}`);
      await sleep(40);
    }
  }
  try {
    return await fn(p);
  } finally {
    await fs.rm(p.lock, { recursive: true, force: true }).catch(() => {});
  }
}

/** Read-modify-write under the lock. `mutator(project)` returns anything. */
export async function mutateProject(dir, mutator, opts = {}) {
  return withLock(dir, async () => {
    const project = await loadProject(dir);
    const before = JSON.stringify(project);
    const result = await mutator(project);
    if (JSON.stringify(project) === before) return { changed: false, result, project };
    const saved = await saveProject(dir, project, opts);
    return { changed: true, result, project: saved };
  }, opts.lock);
}

/** Watch the project file for changes written by other processes. */
export function watchProject(dir, cb) {
  const file = paths(dir).file;
  let last = '';
  const listener = (cur) => {
    // fs.Stats has no `exists`; a missing file reports a zeroed mtime
    if (!cur || !cur.mtimeMs) return;
    const stamp = `${cur.mtimeMs}:${cur.size}`;
    if (stamp === last) return;
    last = stamp;
    cb();
  };
  fss.watchFile(file, { interval: 250 }, listener);
  return () => fss.unwatchFile(file, listener);
}

export async function projectExists(dir) {
  try { await fs.access(paths(dir).file); return true; } catch { return false; }
}

export { fs, fss };
