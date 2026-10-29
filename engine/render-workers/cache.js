// Raster cache for the RenderWorkerPool (§5.5).
//
// Directory: `<project>/.vdm/cache/raster/<cacheKey>/` — one directory per
// rendered frame, containing `f%05d.png` and `meta.json`. The whole tree is
// regenerable: deleting `.vdm/cache/raster` only costs time.
//
// Cache key (per §5.5, plus the frame itself because `vdm.frame`/`vdm.t` are
// part of the render input):
//   hash(source file contents, manifest, parameter values at that frame,
//        size, seed, frame, fps, runtime version, vendor library versions)
//
// Everything here is plain Node (no Electron) so the cache key, the parameter
// evaluation and the layout stay testable in a pure `node --test` run.

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../storage.js';
import { RUNTIME_VERSION } from './protocol.js';
import { workerFault } from './errors.js';

export const RASTER_CACHE = 'raster';
export const META_FILE = 'meta.json';
/** `f%05d.png`, 0-based frame number (§4.4: the IR frame number is 0 based). */
export const frameFileName = (frame) => `f${String(frame).padStart(5, '0')}.png`;
export const FRAME_FILE_RE = /^f(\d{5})\.png$/;

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const shortHash = (data) => sha256(data).slice(0, 32);

/** JSON with object keys sorted at every level, so equal inputs hash equally. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw workerFault('INVALID_ARGUMENT', `non-finite number in cache input: ${value}`);
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Parameters (§6.1: manifest declares the PROPERTY-shaped list; the evaluated
// value at this frame comes from the caller — core/ is the only evaluator).
// ---------------------------------------------------------------------------

const numeric = (value) => typeof value === 'number' && Number.isFinite(value);

function coerceParam(id, type, value) {
  switch (type) {
    case 'number':
    case 'int':
    case 'length':
    case 'percent':
    case 'angle': {
      const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (!numeric(num)) throw workerFault('INVALID_ARGUMENT', `参数 ${id} 需要数字，收到 ${JSON.stringify(value)}`);
      return type === 'int' ? Math.round(num) : num;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw workerFault('INVALID_ARGUMENT', `参数 ${id} 需要布尔值，收到 ${JSON.stringify(value)}`);
      return value;
    case 'string':
    case 'text':
    case 'color':
    case 'font':
    case 'enum':
      return String(value);
    default:
      return value;
  }
}

/**
 * Merge manifest defaults with the values evaluated for this frame.
 * Returns a frozen plain object with exactly the declared parameters.
 * Unknown keys are dropped (the manifest is the contract, §6.3).
 */
export function resolveParams(manifest, given = {}) {
  const declared = Array.isArray(manifest?.params) ? manifest.params : [];
  if (given !== undefined && given !== null && typeof given !== 'object') throw workerFault('INVALID_ARGUMENT', 'params 必须是对象');
  const source = given || {};
  const out = {};
  for (const param of declared) {
    if (!param || typeof param !== 'object' || !param.id) throw workerFault('SOURCE_INVALID', 'manifest.params 的每一项都需要 id');
    const has = Object.prototype.hasOwnProperty.call(source, param.id) && source[param.id] !== undefined;
    const value = has ? source[param.id] : param.default;
    if (value === undefined) throw workerFault('INVALID_ARGUMENT', `参数 ${param.id} 没有值也没有默认值`);
    out[param.id] = coerceParam(param.id, param.type, value);
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Source snapshot: every servable file under sources/<id>/ with its content
// hash. Sorted, so the hash does not depend on directory enumeration order.
// Dotfiles and node_modules are skipped: they are not part of the source and
// would make the cache key flap on editor scratch files.
// ---------------------------------------------------------------------------

const SKIP_NAMES = new Set(['node_modules', '.git', '.vdm', 'Thumbs.db', 'desktop.ini']);

export async function sourceSnapshot(sourceDir) {
  const files = [];
  const walk = async (dir, prefix) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') throw workerFault('SOURCE_NOT_FOUND', `源目录不存在：${sourceDir}`);
      throw e;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (SKIP_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      const buffer = await fs.readFile(path.join(dir, entry.name));
      files.push({ path: `${prefix}${entry.name}`, bytes: buffer.length, sha256: sha256(buffer) });
    }
  };
  await walk(sourceDir, '');
  return { files, hash: shortHash(canonicalJson(files)) };
}

/** Parse `sources/<id>/manifest.json` (the only file the pool insists on). */
export async function readManifest(sourceDir, sourceId) {
  const file = path.join(sourceDir, 'manifest.json');
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw workerFault('SOURCE_NOT_FOUND', `源 ${sourceId} 缺少 manifest.json`);
    throw e;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw workerFault('SOURCE_INVALID', `源 ${sourceId} 的 manifest.json 不是合法 JSON：${e.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw workerFault('SOURCE_INVALID', `源 ${sourceId} 的 manifest.json 必须是对象`);
  if (!manifest.runtime) throw workerFault('SOURCE_INVALID', `源 ${sourceId} 的 manifest.json 缺少 runtime`);
  return { manifest, raw };
}

/** Version block for the cache key: runtime version + vendor manifest hash. */
export async function runtimeKey({ repoRoot, vendorManifestHash = null } = {}) {
  const hash = vendorManifestHash ?? (await readVendorManifestHash(repoRoot));
  return { runtime: RUNTIME_VERSION, vendor: hash };
}

export async function readVendorManifest(repoRoot) {
  const file = path.join(repoRoot, 'vendor', 'manifest.json');
  try {
    return { manifest: JSON.parse(await fs.readFile(file, 'utf8')), raw: await fs.readFile(file, 'utf8') };
  } catch (e) {
    throw workerFault('DEPENDENCY_MISSING', `缺少 vendor/manifest.json：${e.message}`, { file });
  }
}

async function readVendorManifestHash(repoRoot) {
  try {
    return shortHash(await fs.readFile(path.join(repoRoot, 'vendor', 'manifest.json')));
  } catch {
    return 'no-vendor';
  }
}

/**
 * The cache key for one frame.
 * @param {object} input
 * @param {{files: Array<{path: string, sha256: string}>}} input.snapshot source snapshot
 * @param {string} input.manifestRaw raw manifest.json text
 * @param {object} input.params evaluated parameters for THIS frame
 * @param {[number, number]} input.size
 * @param {number} input.seed
 * @param {number} input.frame
 * @param {number} input.fps
 * @param {{runtime: string, vendor: string}} input.versions
 */
export function cacheKey(input) {
  const { snapshot, manifestRaw, params, size, seed, frame, fps, versions } = input;
  if (!snapshot || !Array.isArray(snapshot.files)) throw workerFault('INVALID_ARGUMENT', 'cacheKey 需要源快照');
  return shortHash(canonicalJson({
    v: 1,
    files: snapshot.files.map((file) => [file.path, file.sha256]),
    manifest: sha256(String(manifestRaw ?? '')),
    params,
    size,
    seed,
    frame,
    fps,
    runtime: versions?.runtime || RUNTIME_VERSION,
    vendor: versions?.vendor || 'unknown',
  }));
}

export function rasterDir(root) {
  return path.join(paths(root).cache, RASTER_CACHE);
}

export function entryDir(root, key) {
  return path.join(rasterDir(root), key);
}

/** Read a cached frame. Returns null when absent or unreadable (never throws). */
export async function readCachedFrame(root, key, frame) {
  const dir = entryDir(root, key);
  const file = path.join(dir, frameFileName(frame));
  try {
    const [buffer, metaRaw] = await Promise.all([fs.readFile(file), fs.readFile(path.join(dir, META_FILE), 'utf8')]);
    const meta = JSON.parse(metaRaw);
    if (!meta || meta.key !== key || meta.frame !== frame) return null;
    const hash = meta.hash || sha256(buffer);
    if (hash !== sha256(buffer)) return null; // cache entry was tampered with / half written
    return { pngPath: file, buffer, hash, meta, cached: true };
  } catch {
    return null;
  }
}

/** Write a frame into the cache. Atomic per file: temp name then rename. */
export async function writeCachedFrame(root, key, frame, { buffer, hash, meta = {} }) {
  const dir = entryDir(root, key);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, frameFileName(frame));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, file);
  const record = { key, frame, hash, bytes: buffer.length, at: new Date().toISOString(), ...meta };
  const metaTmp = path.join(dir, `${META_FILE}.${process.pid}.tmp`);
  await fs.writeFile(metaTmp, JSON.stringify(record, null, 2));
  await fs.rename(metaTmp, path.join(dir, META_FILE));
  return { pngPath: file, hash, meta: record };
}

/** Ensure `.vdm/cache/raster` exists and return it. */
export async function ensureRasterDir(root) {
  const dir = rasterDir(root);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Best-effort size of the raster cache (bytes), for logs/reports. */
export async function rasterBytes(root) {
  let total = 0;
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try { total += (await fs.stat(full)).size; } catch { /* raced */ }
      }
    }
  };
  await walk(rasterDir(root));
  return total;
}

/** True when `file` exists as a regular file (sync; used for cheap guards). */
export const isFile = (file) => {
  try { return fss.statSync(file).isFile(); } catch { return false; }
};
