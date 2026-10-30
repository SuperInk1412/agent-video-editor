// Manim layer: the offline runtime of docs/DESIGN-BACKEND-V2.md §6.4 (WP5.2).
//
// A `manim` source is *not* drawn by the RenderWorkerPool (core/code-layer.js:
// `RASTER_RUNTIMES` is canvas2d / p5 / glsl). A Python subprocess renders the
// whole scene once:
//
//   manim render --format png --transparent --fps <fps> -r <w>,<h>
//                --media_dir <tmp> --disable_caching <scene.py> <Scene>
//
// The parameters travel as JSON in `VDM_MANIM_PARAMS` (plus `VDM_MANIM_SIZE`,
// `VDM_MANIM_FPS`, `VDM_MANIM_DURATION`), so the scene can read them without
// the command line having to serialise every type; the fixture
// `tests/fixtures/sources/manim-formula/` shows the contract.
//
// The PNG sequence is copied into
//
//   <project>/.vdm/cache/manim/<hash>/f_00000.png …
//   <project>/.vdm/cache/manim/<hash>/meta.json
//
// and a repeated request is a plain directory hit — the same promise the raster
// cache makes (§5.5): unchanged source, parameters, size and fps mean no second
// render. `<hash>` covers the source snapshot (every file under `sources/<id>/`),
// the raw manifest, the resolved parameters, the raster size and the fps; it is
// therefore a content address, and a changed scene or parameter set starts a
// new directory. The manim version is recorded in `meta.json` for diagnostics
// but not part of the key: the tree is regenerable (`rm -rf .vdm/cache/manim`),
// and a key that changes per machine would make a cached sequence unusable on
// a second machine.
//
// Preview and export consume these frames through the raster path of WP3.3 /
// WP3.4 — `GET /api/raster` (engine/routes/raster.js) and `bakeRasterLayers`
// (engine/raster-bake.js) — because a manim frame is still one picture per
// frame on a 2D node plane: same IR item, same texture, same image sequence.
// Nothing here knows about the editor, and nothing here writes outside
// `<project>/.vdm/cache/manim/`.
//
// Failure is a coded error, never a bare exception:
//
//   MANIM_UNAVAILABLE    no `manim` on PATH and no `VDM_MANIM` (§6.4: the
//                        capability is off; callers skip/test-skip, the export
//                        leaves the layer out instead of failing the job)
//   MANIM_RENDER_FAILED  manim ran but produced no frame / timed out
//   SOURCE_INVALID       the manifest is not a usable manim source
//   CANCELLED            the caller aborted while the render was running
//
// The first live request for a scene blocks until the whole sequence exists
// (one `manim` run covers every frame; the rest are directory hits). The
// background job + progress UI of §6.4 is the job-service integration, not part
// of this module: preview and export only need the frames.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { which } from './which.js';
import { isWithin } from './path-policy.js';
import { paths } from './storage.js';
import {
  canonicalJson, readManifest, resolveParams, sha256, shortHash, sourceSnapshot,
} from './render-workers/cache.js';

/** Error code for "manim is not installed" (§6.4, D5). */
export const MANIM_UNAVAILABLE = 'MANIM_UNAVAILABLE';
/** Error code for "manim ran, but the scene produced no usable frame". */
export const MANIM_RENDER_FAILED = 'MANIM_RENDER_FAILED';
/** Format version of the cached sequence; part of the cache key. */
export const MANIM_LAYER_VERSION = 1;
/** File name template inside one cached sequence (printf style, like the raster bakes). */
export const MANIM_FRAME_PATTERN = 'f_%05d.png';
/** Wall-clock budget for one scene render; a formula animation is seconds, not frames. */
export const MANIM_DEFAULT_TIMEOUT_MS = 180000;

const CACHE_DIR = 'manim';
const META_FILE = 'meta.json';
const FRAME_RE = /^f_(\d{5})\.png$/;
const STATUS = {
  [MANIM_UNAVAILABLE]: 503,
  [MANIM_RENDER_FAILED]: 500,
  SOURCE_INVALID: 422,
  SOURCE_NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  CANCELLED: 499,
  PATH_OUTSIDE_SCOPE: 403,
};

/** Coded error with the status table the HTTP route and the bake log understand. */
export function manimFault(code, message, details = {}) {
  const err = new Error(message);
  err.name = 'ManimError';
  err.code = STATUS[code] ? code : MANIM_RENDER_FAILED;
  err.status = STATUS[err.code] || 500;
  err.manim = true;
  Object.assign(err, details);
  return err;
}

/** `.vdm/cache/manim/` — regenerable, never a source of truth. */
export function manimCacheDir(root) {
  return path.join(paths(root).cache, CACHE_DIR);
}

/** One cached sequence: `.vdm/cache/manim/<key>/`. */
export function manimSequenceDir(root, key) {
  return path.join(manimCacheDir(root), key);
}

/** `f_00007.png` for a 0-based frame index. */
export function manimFrameName(index) {
  return `f_${String(Math.max(0, Math.round(Number(index) || 0))).padStart(5, '0')}.png`;
}

/**
 * The manim executable: `VDM_MANIM` first (an absolute path or a name), then
 * `manim` on PATH. Returns null when there is none — that is the answer that
 * turns into `MANIM_UNAVAILABLE`, not an exception.
 */
export function findManim({ env = process.env } = {}) {
  const explicit = String(env?.VDM_MANIM ?? '').trim();
  if (explicit) return which(explicit, { env });
  return which('manim', { env });
}

/** true when a manim usable by this engine exists (cheap, synchronous). */
export const hasManim = (options = {}) => findManim(options) !== null;

const versionMemo = new Map();

/**
 * `manim --version` -> "0.18.1" (memoised per binary). Best effort: a build
 * that answers nothing still renders, so this never throws.
 */
export function manimVersion(bin, { env = process.env, timeoutMs = 20000 } = {}) {
  const key = String(bin ?? '');
  if (!key) return Promise.resolve(null);
  if (versionMemo.has(key)) return versionMemo.get(key);
  const task = (async () => {
    try {
      const out = await runProcess(bin, ['--version'], { env, timeoutMs });
      const text = `${out.stdout}\n${out.stderr}`.trim();
      const match = /(\d+\.\d+(?:\.\d+)?)/.exec(text);
      return match ? match[1] : (text.split('\n')[0].slice(0, 80) || null);
    } catch {
      return null;
    }
  })();
  versionMemo.set(key, task);
  return task;
}

// ---------------------------------------------------------------------------
// Command line + process
// ---------------------------------------------------------------------------

/** The manim command line of one scene render (options before the positionals). */
export function manimArgs({ entry, scene, size, fps, mediaDir }) {
  return [
    'render',
    '--format', 'png',
    '--transparent',
    '--fps', String(fps),
    '-r', `${size[0]},${size[1]}`,
    '--media_dir', mediaDir,
    // manim's own partial-movie cache would make a second render depend on the
    // first; the deterministic scene does not need it and the layer has its own
    // content-addressed cache one level up.
    '--disable_caching',
    String(entry),
    String(scene),
  ];
}

/**
 * Spawn `bin` and collect stdout/stderr. On Windows a `.cmd` / `.bat` has to go
 * through `cmd.exe` (a pip-installed manim is an `.exe`; the shell path exists
 * for stubs and for source checkouts). Resolves with the exit code; the caller
 * decides whether a non-zero code is an error.
 */
function runProcess(bin, args, { cwd = null, env = process.env, timeoutMs = MANIM_DEFAULT_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
    const needsShell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(bin));
    const command = needsShell
      ? [quote(bin), ...args.map(quote)].join(' ')
      : bin;
    let child;
    try {
      child = spawn(command, needsShell ? [] : args, {
        shell: needsShell,
        cwd: cwd || undefined,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(manimFault(MANIM_RENDER_FAILED, `manim 启动失败：${error?.message || error}`, { bin, cause: error }));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.('abort', onAbort);
      if (error) reject(error); else resolve(result);
    };
    const kill = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const onAbort = () => {
      kill();
      finish(manimFault('CANCELLED', 'manim 渲染被取消'));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(manimFault(MANIM_RENDER_FAILED, `manim 超过 ${timeoutMs} ms 没有结束`, { timeoutMs }));
    }, Math.max(1000, Number(timeoutMs) || MANIM_DEFAULT_TIMEOUT_MS));
    if (signal && signal.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') {
        finish(manimFault(MANIM_UNAVAILABLE, `manim 可执行文件不存在：${bin}`, { bin, cause: error }));
        return;
      }
      finish(manimFault(MANIM_RENDER_FAILED, `manim 启动失败：${error?.message || error}`, { bin, cause: error }));
    });
    child.on('close', (code) => {
      if (timedOut || settled) return;
      finish(null, { code: Number(code) || 0, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

// ---------------------------------------------------------------------------
// Cache key + directory
// ---------------------------------------------------------------------------

/**
 * Content address of one rendered scene: source snapshot, raw manifest,
 * resolved parameters, size and fps. Same inputs -> same directory -> no
 * second render. `seed` is not an input: manim scenes are pure functions of
 * their parameters and the frame time (§6.2), and the fixture does not read
 * `code.seed`.
 */
export function manimCacheKey({ snapshot, manifestRaw, params, size, fps }) {
  if (!snapshot || !Array.isArray(snapshot.files)) throw manimFault('INVALID_ARGUMENT', 'manimCacheKey 需要源快照');
  return shortHash(canonicalJson({
    v: MANIM_LAYER_VERSION,
    files: snapshot.files.map((file) => [file.path, file.sha256]),
    manifest: sha256(String(manifestRaw ?? '')),
    params,
    size,
    fps,
  }));
}

/** Shape checks every caller can rely on before a render starts. */
function sceneInfo(manifest, sourceId) {
  const duration = Number(manifest?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw manimFault('SOURCE_INVALID', `Manim 源 ${sourceId} 的 manifest 需要 duration（秒，正数）；收到 ${JSON.stringify(manifest?.duration)}`, { sourceId });
  }
  const scene = String(manifest?.scene ?? 'Scene').trim();
  if (!scene || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(scene)) {
    throw manimFault('SOURCE_INVALID', `Manim 源 ${sourceId} 的 manifest.scene 必须是场景类名（[A-Za-z_][A-Za-z0-9_]*）`, { sourceId });
  }
  return { duration, scene };
}

function frameCountOf(duration, fps) {
  return Math.max(1, Math.round(duration * fps));
}

function measureSequence(meta, fileCount) {
  return Boolean(meta) && Number(meta.count) > 0 && fileCount >= Number(meta.count);
}

/**
 * Read one cached sequence, or null. Never renders and never throws: a missing
 * or half-written directory is simply "not cached" (meta.json is written last).
 */
export async function readManimSequence(dir, key) {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8'));
    if (!meta || meta.key !== key) return null;
    const names = await fs.readdir(dir);
    const files = names.filter((name) => FRAME_RE.test(name)).length;
    if (!measureSequence(meta, files)) return null;
    return {
      key,
      dir,
      pattern: MANIM_FRAME_PATTERN,
      count: Number(meta.count),
      cached: true,
      meta,
    };
  } catch {
    return null;
  }
}

/** The PNG of one frame: the index is clamped to the last rendered frame. */
export function manimFramePath(sequence, frame) {
  const count = Number(sequence?.count) || 0;
  const index = Math.min(Math.max(0, Math.round(Number(frame) || 0)), Math.max(0, count - 1));
  return { pngPath: path.join(sequence.dir, manimFrameName(index)), frame: index, key: sequence.key, count };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Recursively list the PNGs manim wrote, ordered by their frame number. */
async function collectPngs(dir) {
  const out = [];
  const walk = async (current) => {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.png$/i.test(entry.name)) out.push(full);
    }
  };
  await walk(dir);
  const numberOf = (file) => {
    const match = /(\d+)(?!.*\d)/.exec(path.basename(file, path.extname(file)));
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  // manim names the files `<Scene>0000.png` …; sorting on the last number keeps
  // the order even if a version pads differently. Files without a number keep
  // their path order at the end (then fail the count check below if early).
  return out
    .map((file, index) => ({ file, index, number: numberOf(file) }))
    .sort((a, b) => (a.number - b.number) || (a.index - b.index))
    .map((entry) => entry.file);
}

/** In-flight renders by sequence directory: N preview requests must not start N renders. */
const inflight = new Map();
/**
 * Failed renders by sequence directory (30 s). A preview asks for one frame at
 * a time, and a broken scene would otherwise start a fresh render for every
 * frame; the key already covers the source, so a fixed scene starts over.
 */
const failures = new Map();
const FAILURE_TTL_MS = 30000;

/**
 * Render one scene into `<cache>/<key>/` (or return the cached directory).
 *
 * `root` is the project root: the source is `sources/<sourceId>/`, the cache
 * `<root>/.vdm/cache/manim/`. `params` are the values core/ evaluated for this
 * request — the same object the pool would receive for a code layer.
 */
export async function ensureManimSequence({
  root,
  sourceId,
  sourceDir = null,
  manifest = null,
  manifestRaw = null,
  params = {},
  size = [1920, 1080],
  fps = 24,
  env = process.env,
  timeoutMs = MANIM_DEFAULT_TIMEOUT_MS,
  signal = null,
  onLog = null,
  useCache = true,
} = {}) {
  const id = String(sourceId ?? '');
  const dirSource = path.resolve(sourceDir || path.join(root, 'sources', id));
  if (!isWithin(path.join(root, 'sources'), dirSource)) {
    throw manimFault('PATH_OUTSIDE_SCOPE', `Manim 源目录不在项目的 sources/ 里：${dirSource}`, { sourceId: id });
  }
  const dims = Array.isArray(size) && size.length >= 2
    ? [Math.floor(Number(size[0])), Math.floor(Number(size[1]))]
    : [];
  if (!(dims[0] > 0) || !(dims[1] > 0) || dims[0] > 8192 || dims[1] > 8192) {
    throw manimFault('INVALID_ARGUMENT', `manim 需要 1..8192 的尺寸，收到 ${JSON.stringify(size)}`, { sourceId: id });
  }
  const rate = Number(fps);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw manimFault('INVALID_ARGUMENT', `manim 需要正的 fps，收到 ${JSON.stringify(fps)}`, { sourceId: id });
  }

  const read = manifest
    ? { manifest, raw: manifestRaw ?? `${JSON.stringify(manifest, null, 2)}\n` }
    : await readManifest(dirSource, id);
  const runtime = String(read.manifest?.runtime ?? '');
  if (runtime !== 'manim') {
    throw manimFault('INVALID_ARGUMENT', `源 ${id} 的 runtime 是 ${JSON.stringify(runtime)}，不是 manim`, { sourceId: id });
  }
  const { duration, scene } = sceneInfo(read.manifest, id);
  const entry = String(read.manifest.entry ?? '');
  const entryFile = path.resolve(dirSource, entry);
  if (!entry || !isWithin(dirSource, entryFile)) {
    throw manimFault('SOURCE_INVALID', `Manim 源 ${id} 的 entry 不在源目录里：${JSON.stringify(entry)}`, { sourceId: id });
  }
  const resolved = resolveParams(read.manifest, params);
  const snapshot = await sourceSnapshot(dirSource);
  const key = manimCacheKey({ snapshot, manifestRaw: read.raw, params: resolved, size: dims, fps: rate });
  const seqDir = manimSequenceDir(root, key);

  if (useCache) {
    const hit = await readManimSequence(seqDir, key);
    if (hit) return hit;
    const failure = failures.get(seqDir);
    if (failure && Date.now() - failure.at < FAILURE_TTL_MS) throw failure.error;
  }
  const running = inflight.get(seqDir);
  if (running) return running;

  // The binary is only required once a render is actually needed: a machine
  // without manim can still show an already-cached sequence (§6.4 "预览显示
  // 缓存帧").
  const bin = findManim({ env });
  if (!bin) {
    throw manimFault(MANIM_UNAVAILABLE, `manim 没有安装：PATH 上没有 manim，也没有设置 VDM_MANIM —— Manim 图层 ${id} 无法渲染`, {
      sourceId: id,
      hint: 'pip install manim，或把 manim 可执行文件路径设到 VDM_MANIM',
    });
  }

  const task = (async () => renderSequence({
    bin, root, seqDir, key, sourceId: id, sourceDir: dirSource, entryFile, scene,
    duration, params: resolved, size: dims, fps: rate, version: await manimVersion(bin, { env, timeoutMs }),
    env, timeoutMs, signal, onLog,
  }))().then((result) => {
    failures.delete(seqDir);
    return result;
  }, (error) => {
    if (error?.code !== 'CANCELLED') failures.set(seqDir, { at: Date.now(), error });
    throw error;
  }).finally(() => {
    if (inflight.get(seqDir) === task) inflight.delete(seqDir);
  });
  inflight.set(seqDir, task);
  return task;
}

/** Run manim once, copy its PNGs into the cache, write `meta.json` last. */
async function renderSequence({
  bin, root, seqDir, key, sourceId, sourceDir, entryFile, scene,
  duration, params, size, fps, version, env, timeoutMs, signal, onLog,
}) {
  const log = (line) => onLog?.(line);
  const expected = frameCountOf(duration, fps);
  const tmp = path.join(manimCacheDir(root), `.tmp-${key}-${process.pid}-${Date.now().toString(36)}`);
  const mediaDir = path.join(tmp, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  log(`manim ${sourceId}: ${scene} ${size[0]}x${size[1]} @${fps}fps, ${duration}s (${expected} frames expected)`);
  try {
    const result = await runProcess(bin, manimArgs({ entry: entryFile, scene, size, fps, mediaDir }), {
      cwd: sourceDir,
      env: {
        ...env,
        // §6.4: the parameters travel as JSON, so every property type reaches
        // the scene unchanged (strings, colours, numbers) without a CLI dialect.
        VDM_MANIM_PARAMS: canonicalJson(params),
        VDM_MANIM_SIZE: `${size[0]}x${size[1]}`,
        VDM_MANIM_FPS: String(fps),
        VDM_MANIM_DURATION: String(duration),
        VDM_MANIM_SOURCE: String(sourceId),
        VDM_MANIM_SCENE: String(scene),
      },
      timeoutMs,
      signal,
    });
    const pngs = await collectPngs(mediaDir);
    if (!pngs.length) {
      const tail = `${result.stderr || ''}`.trim().split('\n').slice(-6).join('\n');
      throw manimFault(MANIM_RENDER_FAILED, `manim 渲染 ${sourceId} 没有产出 PNG（退出码 ${result.code}）${tail ? `：${tail}` : ''}`, {
        sourceId, exitCode: result.code, stderr: tail,
      });
    }
    await fs.mkdir(seqDir, { recursive: true });
    for (let index = 0; index < pngs.length; index++) {
      await fs.copyFile(pngs[index], path.join(seqDir, manimFrameName(index)));
    }
    const meta = {
      key,
      v: MANIM_LAYER_VERSION,
      source: sourceId,
      scene,
      size,
      fps,
      duration,
      count: pngs.length,
      expected,
      params,
      manim: { bin: String(bin), version: version ?? null },
      at: new Date().toISOString(),
    };
    await fs.writeFile(path.join(seqDir, META_FILE), JSON.stringify(meta, null, 2));
    log(`manim ${sourceId}: ${pngs.length} frames -> ${path.relative(root, seqDir).split(path.sep).join('/')}`);
    return { key, dir: seqDir, pattern: MANIM_FRAME_PATTERN, count: pngs.length, cached: false, meta };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public lookups used by the raster route and the bake
// ---------------------------------------------------------------------------

/** Read (never render) one frame of one manim source; null when it is not cached. */
export async function readManimFrame({
  root, sourceId, frame = 0, params = {}, size = [1920, 1080], fps = 24,
} = {}) {
  const id = String(sourceId ?? '');
  const sourceDir = path.join(root, 'sources', id);
  const read = await readManifest(sourceDir, id);
  if (String(read.manifest?.runtime ?? '') !== 'manim') {
    throw manimFault('INVALID_ARGUMENT', `源 ${id} 的 runtime 不是 manim`, { sourceId: id });
  }
  const { duration } = sceneInfo(read.manifest, id);
  const dims = [Math.floor(Number(size[0])), Math.floor(Number(size[1]))];
  const rate = Number(fps);
  const resolved = resolveParams(read.manifest, params);
  const snapshot = await sourceSnapshot(sourceDir);
  const key = manimCacheKey({ snapshot, manifestRaw: read.raw, params: resolved, size: dims, fps: rate });
  const sequence = await readManimSequence(manimSequenceDir(root, key), key);
  if (!sequence) return null;
  return manimFramePath(sequence, frame);
}

/**
 * One frame of one manim source, rendering the whole sequence on the first
 * miss (frames after that are hits). This is the call `GET /api/raster` makes,
 * so a manim layer reaches the preview exactly like a code layer.
 */
export async function manimFrame({
  root, sourceId, frame = 0, params = {}, size = [1920, 1080], fps = 24,
  env = process.env, timeoutMs = MANIM_DEFAULT_TIMEOUT_MS, signal = null, onLog = null,
  useCache = true,
} = {}) {
  const sequence = await ensureManimSequence({
    root, sourceId, params, size, fps, env, timeoutMs, signal, onLog, useCache,
  });
  return { ...manimFramePath(sequence, frame), cached: sequence.cached, dir: sequence.dir, pattern: sequence.pattern };
}

export default { findManim, manimFrame, readManimFrame, ensureManimSequence, manimCacheDir };
