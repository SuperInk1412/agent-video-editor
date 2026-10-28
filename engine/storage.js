// Project persistence: atomic writes, a cross-process lock, external-change watching.
// The file on disk is the single source of truth; both the UI and the agent mutate it
// through this module (or through the CLI, which uses the same module).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeProject, assertValidProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { migrateLegacyParents } from '../core/parent-strength.js';
import { migrateScreenLocks } from '../core/screen-lock-migrate.js';
import { snapClipFrames } from '../core/clip-frames.js';
import { ensureAudioElements } from '../core/audio.js';

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
  // One placement parent kind: old 3D parents become spatial parents with the
  // same bind / switches / strength (docs/DESIGN-CAMFEED-PARENTS.md §3).
  const legacy = migrateLegacyParents(project);
  // The screen lock (贴屏) is retired: locked elements move into a HUD rig that
  // films the shots through camera feeds (core/screen-lock-migrate.js).
  const screen = migrateScreenLocks(project);
  // Old projects kept their song only in meta.audio; show it as a real element.
  ensureAudioElements(project);
  // Every clip window lands on the frame grid (both heads and tails). This is
  // the data fix behind "existing clips did not snap": the drag helpers only
  // touched the edge being dragged, so untouched legacy spans stayed off-grid.
  const clipFrames = snapClipFrames(project);
  const notes = [];
  const legacyCount = (Number(legacy?.migrated) || 0) + (Number(legacy?.flattened) || 0);
  if (legacyCount) notes.push(`${legacyCount} 个旧 3D 父级已并成空间父级`);
  if (screen) notes.push(`${screen.elements} 个贴屏元素已迁到 HUD 机位（${screen.feeds} 个投屏）`);
  if (clipFrames) notes.push(`${clipFrames} 个片段的头/尾已对齐到帧`);
  if (notes.length) {
    project.meta.ui = {
      ...(project.meta.ui || {}),
      migration: {
        at: new Date().toISOString(),
        notes,
        // The file on disk is still the old format: saveProject copies it to
        // .vdm/backups before the first write and flips this flag.
        backupPending: true,
      },
    };
  }
  assertValidProject(project);
  return project;
}

export async function saveProject(dir, project, { by = 'ui' } = {}) {
  const p = await ensureProjectDirs(dir);
  assertValidProject(project);
  // First save after an in-memory upgrade: copy the old-format file to
  // .vdm/backups and verify it parses before writing anything. This is the
  // safety net for retired screen locks / merged 3D parents / clip snapping.
  const migration = project.meta?.ui?.migration;
  if (migration?.backupPending) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `project-${project.rev}-${stamp}.vdm.json`;
    const backup = path.join(p.vdm, 'backups', name);
    try {
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(p.file, backup);
      JSON.parse(await fs.readFile(backup, 'utf8'));
      migration.backup = path.join(VDM_DIR, 'backups', name);
      migration.backupPending = false;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // A project with no file on disk cannot lose old data.
      migration.backup = null;
      migration.backupPending = false;
    }
  }
  const next = JSON.parse(JSON.stringify(project));
  next.rev++;
  next.meta.savedAt = new Date().toISOString();
  await atomicJson(p.file, next);
  project.rev = next.rev;
  project.meta.savedAt = next.meta.savedAt;
  await fs.writeFile(p.app && path.join(p.vdm, 'last-save.json'),
    JSON.stringify({ rev: project.rev, by, at: project.meta.savedAt }, null, 2)).catch(() => {});
  return project;
}

/** Atomic publication; a failed write never leaves a partial JSON file. */
export async function atomicJson(file, value) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true });
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};

// Removing a unique owner's file is the ownership check. Only the process that
// successfully unlinks it may remove the now-empty directory. Never rm -r a lock.
async function releaseOwner(lock, name) {
  try { await fs.unlink(path.join(lock, name)); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try { await fs.rmdir(lock); }
  catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
}

/** Local cross-process lock. A live owner is never evicted because of its age. */
export async function withLock(dir, fn, { timeout = 8000, stale = 15000, lockName = 'lock' } = {}) {
  const p = await ensureProjectDirs(dir);
  if (!['lock', 'runtime-lock', 'jobs-lock'].includes(lockName)) throw new Error('invalid lock name');
  p.lock = path.join(p.vdm, lockName);
  const t0 = Date.now();
  const owner = `owner-${process.pid}-${randomUUID()}`;
  for (;;) {
    try {
      await fs.mkdir(p.lock);
      try { await fs.writeFile(path.join(p.lock, owner), '', { flag: 'wx' }); }
      catch (e) { await fs.rmdir(p.lock).catch(() => {}); throw e; }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const entries = await fs.readdir(p.lock);
        if (entries.length === 1) {
          const match = /^owner-(\d+)-[\da-f-]+$/.exec(entries[0]);
          if (match && !alive(Number(match[1]))) {
            await releaseOwner(p.lock, entries[0]);
            continue;
          }
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (Date.now() - t0 >= timeout) {
        const st = await fs.stat(p.lock).catch(() => null);
        const entries = await fs.readdir(p.lock).catch(() => []);
        const orphan = st && !entries.length && Date.now() - st.mtimeMs > stale;
        throw Object.assign(new Error(`${orphan ? 'project lock has no identifiable owner' : 'project is locked'}: ${p.lock}`), { code: orphan ? 'LOCK_ORPHANED' : 'LOCK_TIMEOUT', status: 409 });
      }
      await sleep(40);
    }
  }
  try {
    return await fn(p);
  } finally {
    await releaseOwner(p.lock, owner);
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
