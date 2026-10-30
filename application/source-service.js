// Compiled sources: HTML / SVG → element payloads + `.vdm/sources/<id>/base.json`
// (docs/DESIGN-BACKEND-V2.md §7.1, §7.8.1, §10.2 WP4.1).
//
// The split of responsibility is the one §7.8.6 #1 froze:
//
//   core/source-map.js   pure ESM: HTML/CSS parsing, mini layout, style and
//                        animation mapping — no DOM, no files;
//   this file (Node)     reads the source registry (`project.sources[].files`),
//                        resolves the fonts the render pipeline can load, calls
//                        the compiler, hashes the payload (§7.8.1) and writes
//                        the snapshot. `base.json` is **not** a cache: merge
//                        (WP4.4) uses it as `base`.
//
// Two write paths, both exposed as ops so every change stays in the op log:
//
//   sourceCompile { id }            compile + write base.json, change nothing
//   sourceApply   { id, elements }  upsert the compiled elements, one op = one
//                                   transaction (`applyCompiled` builds it from
//                                   the snapshot; `{ id }` alone is resolved by
//                                   `expandSourceOps` in this file, because core
//                                   never reads `.vdm/`)
//
// The write-back of one edited value into the source (§7.8.3, WP4.3) lives at
// the bottom of this file: `writeBack` decides, `writeBackOps` turns the answer
// into the `sourceWrite` + mirror `set` the caller submits as one transaction.
//
// The routes (`engine/routes/sources.js`) call the async functions here; the
// CLI/MCP surfaces come with WP4.3.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SOURCE_SNAPSHOT_VERSION } from '../core/version.js';
import { isNumericSourcePath, isSourceNodeId, snapshotProblems } from '../core/source-eval.js';
import { compileHtml, compileSvg, COMPILE_RUNTIMES } from '../core/source-map.js';
import { isSafeSourceId, manifestIssues, isSafeSourceFile, scanSourceFiles, sourceRecord, SOURCE_MANIFEST } from '../core/code-layer.js';
import { isRecord } from '../core/json.js';
import { parseFont, metricsOf, layoutText } from '../core/glyphs.js';
import { resolveFontFile } from '../engine/shot.js';
import { atomicJson } from '../engine/storage.js';
import { fault } from './errors.js';
import { DEFAULT_STYLE, DEFAULT_TRANSFORM } from '../core/schema.js';
import { isWriteBackPath, nodeTypeForPath, writeNodeValue } from './source-writeback.js';

/** Snapshot `compiler.name` for everything this module writes (§7.8.1). */
export const COMPILER_NAME = 'source-service';
/** `compiler.version`: bump when the compiler's output changes shape. */
export const COMPILER_VERSION = 1;

/** Families the render pipeline can resolve (`engine/shot.js::SYSTEM_FONT_FILES`). */
export const PIPELINE_FONTS = Object.freeze([
  'SimHei', 'Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'NSimSun', 'DengXian',
  '宋体', '黑体', '微软雅黑', 'Arial', 'Helvetica', 'Times New Roman', 'Courier New',
  'Consolas', 'Segoe UI', 'Noto Sans SC', 'Noto Serif SC',
]);

const fontCache = new Map(); // project root -> { families, metrics, fonts, measure }

/** `.vdm/sources/<id>` for one project. */
export function sourceDir(root, sourceId) {
  return path.join(path.resolve(root), '.vdm', 'sources', String(sourceId));
}

/** `.vdm/sources/<id>/base.json` (§7.8.1). */
export function basePath(root, sourceId) {
  return path.join(sourceDir(root, sourceId), 'base.json');
}

/** The directory an external editor writes: `sources/<id>/` (not `.vdm/`). */
export function copyDir(root, sourceId) {
  return path.join(path.resolve(root || '.'), 'sources', String(sourceId));
}

/** Files of a source copy the UI may show and load back (text only). */
export const SOURCE_COPY_TEXT_RE = /\.(?:js|mjs|cjs|ts|frag|glsl|vert|json|md|txt|css|html|svg)$/i;

/**
 * Read `sources/<id>/` — the copy an external editor edits (DESIGN-WP3.6 §7.1).
 * The project registry is the truth; this is what the person just saved.
 *
 * Never throws: a missing directory is `{ ok: false, missing: true }`, which is
 * the normal state of a source that was never opened outside the app.
 */
export async function readSourceCopy({ root, sourceId }) {
  const id = String(sourceId ?? '');
  const scannedAt = new Date().toISOString();
  const empty = (problems, extra = {}) => ({
    ok: false, source: id, dir: `sources/${id}`, files: [], manifest: null,
    manifestText: null, problems, scannedAt, ...extra,
  });
  if (!isSafeSourceId(id)) return empty([`源 id 不合法：${JSON.stringify(sourceId)}`]);
  if (!root) return empty(['没有项目目录']);
  const dir = copyDir(root, id);
  const files = [];
  const problems = [];
  const walk = async (current, prefix) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full, `${prefix}${entry.name}/`); continue; }
      if (!entry.isFile() || !SOURCE_COPY_TEXT_RE.test(entry.name)) continue;
      const rel = `${prefix}${entry.name}`;
      if (!isSafeSourceFile(rel)) { problems.push(`副本里有不安全的路径：${rel}`); continue; }
      const content = await fs.readFile(full, 'utf8');
      files.push({ path: rel, content, bytes: Buffer.byteLength(content, 'utf8') });
    }
    return true;
  };
  const there = await walk(dir, '');
  if (!there) return empty([], { missing: true });
  if (!files.length) return empty(['副本里没有文本文件'], { missing: false });
  const manifestFile = files.find((file) => file.path === SOURCE_MANIFEST) || null;
  let manifest = null;
  let manifestError = null;
  if (manifestFile) {
    try {
      manifest = JSON.parse(manifestFile.content);
    } catch (error) {
      manifestError = error.message;
    }
  }
  return {
    ok: true, source: id, dir: `sources/${id}`, files,
    manifest, manifestText: manifestFile ? manifestFile.content : null, manifestError,
    problems, scannedAt,
  };
}

const checkRow = (id, title, status, detail) => ({ id, title, status, detail });

/**
 * Contract check of a candidate source — the half of `vdm source check` that
 * needs no frame (§6.3-1 plus the manifest / entry shape).
 *
 * `载入外部修改` runs this on the copy **before** the transaction: text that
 * fails here never reaches `project.sources[]`. Rendering checks (same-frame
 * hash, alpha, timing, parameter probes) still belong to `vdm source check`.
 */
export function checkSourceFiles({ sourceId = '', manifest = null, manifestText = null, files = [], runtime = null } = {}) {
  const id = String(sourceId ?? '');
  const problems = [];
  const push = (kind, message, extra = {}) => problems.push({ kind, message, ...extra });
  const list = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!isRecord(file) || typeof file.path !== 'string' || typeof file.content !== 'string') continue;
    if (file.path === SOURCE_MANIFEST) continue; // the manifest is not a text file here
    if (!isSafeSourceFile(file.path)) { push('path', `不安全的文件路径：${file.path}`, { file: file.path }); continue; }
    list.push({ path: file.path, content: file.content });
  }
  if (!list.length) push('copy', '没有可载入的文本文件（副本是空的，或只有 manifest.json）');

  let parsed = isRecord(manifest) ? manifest : null;
  let manifestError = null;
  if (typeof manifestText === 'string') {
    try {
      parsed = JSON.parse(manifestText);
    } catch (error) {
      manifestError = error.message;
      parsed = null;
      push('manifest', `manifest.json 解析失败：${error.message}`, { file: SOURCE_MANIFEST });
    }
  }
  const present = parsed !== null || manifestError !== null;
  const shape = parsed === null ? [] : manifestIssues(parsed);
  for (const issue of shape) push('manifest', `${issue.path} ${issue.msg}`, { file: SOURCE_MANIFEST });
  const rt = String(parsed?.runtime ?? runtime ?? '');
  const entry = String(parsed?.entry ?? '');
  if (parsed && !entry) push('entry', 'manifest 没有 entry', { file: SOURCE_MANIFEST });
  const entryThere = entry ? list.some((file) => file.path === entry) : false;
  if (entry && !entryThere) push('entry', `找不到 ${entry}`, { file: entry });

  const scan = scanSourceFiles(list, { runtime: rt || null });
  for (const error of scan.errors) push('static', error.message, { file: error.file, line: error.line, name: error.name });

  const checks = [
    checkRow('manifest', 'manifest.json 形状', !present ? 'warn' : (shape.length || manifestError ? 'fail' : 'pass'),
      manifestError ? `解析失败：${manifestError}` : (shape.length ? shape.map((issue) => `${issue.path} ${issue.msg}`).join('；') : 'manifest 合法')),
    checkRow('entry', '入口文件存在', !entry ? 'warn' : (entryThere ? 'pass' : 'fail'),
      entry ? (entryThere ? entry : `副本里没有 ${entry}`) : 'manifest 没有声明 entry'),
    checkRow('static', '静态扫描：禁用的 API', scan.errors.length ? 'fail' : (scan.warnings.length ? 'warn' : 'pass'),
      scan.errors.length
        ? scan.errors.map((error) => error.message).join('；')
        : (scan.warnings.length
          ? scan.warnings.map((warning) => warning.message || `${warning.name} @ ${warning.file}:${warning.line}`).join('；')
          : `扫描 ${scan.files} 个文件，没有禁用 API`)),
  ];
  return {
    ok: problems.length === 0,
    source: id,
    runtime: rt || null,
    entry: entry || null,
    manifest: { present, ok: !manifestError && !shape.length, error: manifestError, runtime: rt || null, entry: entry || null },
    files: list.map((file) => file.path),
    scan: { errors: scan.errors, warnings: scan.warnings, files: scan.files },
    checks,
    problems,
    checkedAt: new Date().toISOString(),
    notes: ['同帧哈希 / 透明通道 / 单帧耗时 / 参数探测要真的渲染一帧，用 vdm source check'],
  };
}

/**
 * Font bytes + metrics + the typesetting the IR itself uses, resolved once per
 * project root. `metrics` are positive em fractions, which is what the
 * compiler needs for `line-height: normal`.
 */
export async function fontContext(root) {
  const key = path.resolve(root || '.');
  const hit = fontCache.get(key);
  if (hit) return hit;
  const families = [];
  const metrics = {};
  const fonts = {};
  for (const family of PIPELINE_FONTS) {
    const file = resolveFontFile(family, key);
    if (!file) continue;
    try {
      const bytes = new Uint8Array(await fs.readFile(file));
      const font = parseFont(bytes);
      const m = metricsOf(font, 1000);
      families.push(family);
      metrics[family.toLowerCase()] = {
        ascent: Number(m.ascender) / 1000,
        descent: Math.abs(Number(m.descender)) / 1000,
        lineGap: Math.abs(Number(m.lineGap) || 0) / 1000,
      };
      fonts[family.toLowerCase()] = font;
    } catch {
      // A font the parser cannot read is simply unavailable to the pipeline
      // (the IR falls back to its old text path), so the compiler must not
      // pick it either.
    }
  }
  const context = {
    families,
    metrics,
    fonts,
    /** The IR's own typesetting: same advances, same letter spacing. */
    measure: (text, style) => {
      const font = fonts[String(style.font || '').toLowerCase()] || fonts[families[0]?.toLowerCase()] || null;
      if (!font) return 0;
      return layoutText([font], text, {
        fontSize: style.fontSize,
        lineHeight: 1,
        letterSpacing: style.letterSpacing,
        align: 'left',
      }).width;
    },
  };
  fontCache.set(key, context);
  return context;
}

/** Drop the cached font context (tests that install/remove a font file). */
export function clearFontCache() {
  fontCache.clear();
}

// ---------------------------------------------------------------------------
// Hashing (§7.8.1: canonical payload → sha256)
// ---------------------------------------------------------------------------

const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6 + 0; // `-0` is not JSON

/**
 * §7.8.1 canonicalisation: object keys sorted recursively, arrays keep their
 * order, numbers rounded to 6 decimals with `-0` folded into `0`, no spaces.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number') return JSON.stringify(r6(value));
  return JSON.stringify(value === undefined ? null : value);
}

/** The hashed payload: exactly `{ version, source, nodes }` (§7.8.1). */
export function hashPayload({ version, source, nodes }) {
  return { version, source, nodes };
}

/** `sha256:<64 lowercase hex>` over the canonical payload. */
export function snapshotHash(payload) {
  const text = canonicalJson(hashPayload(payload));
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/** Manifest parameters → CSS custom properties (`--<param>`) for the compiler. */
export function paramVariables(manifest) {
  const out = {};
  if (!isRecord(manifest) || !Array.isArray(manifest.params)) return out;
  for (const param of manifest.params) {
    if (!isRecord(param)) continue;
    const id = String(param.id ?? '');
    if (!id || param.default === undefined) continue;
    const value = param.type === 'number' ? Number(param.default) : param.default;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[`--${id}`] = String(value);
  }
  return out;
}

/** One element payload as `addElement` / `sourceApply` expect it. */
function elementWithDefaults(payload) {
  return {
    id: payload.id,
    name: payload.name,
    type: payload.type,
    src: payload.src || '',
    segment: null,
    start: Number(payload.start) || 0,
    duration: Number(payload.duration) > 0 ? Number(payload.duration) : 10,
    z: Number(payload.z) || 0,
    transform: { ...DEFAULT_TRANSFORM, ...(payload.transform || {}) },
    style: { ...DEFAULT_STYLE, ...(payload.style || {}) },
    fx: { glow: 0, ...(payload.fx || {}) },
    motion: { type: 'none', amount: 0, dir: 'in' },
    keyframes: [],
    visible: true,
    loop: false,
    fadeIn: 0,
    fadeOut: 0,
    punch: 0,
    srcIn: 0,
    meta: {},
    // Page-background elements a compiler emits (a solid fill, gradient bands)
    // are not bound to a node: they are the picture behind the nodes.
    ...(payload.source ? { source: { id: payload.source.id, node: payload.source.node } } : {}),
    ...(payload.sourceMode && Object.keys(payload.sourceMode).length ? { sourceMode: { ...payload.sourceMode } } : {}),
  };
}

/**
 * Compile one registered source into `{ snapshot, elements, warnings }` and
 * write `.vdm/sources/<id>/base.json` (§7.8.1). Nothing in the project changes:
 * that is `sourceApply` / `applyCompiled`.
 */
export async function compileSource({ project, sourceId, root, snapshot: provided = null }) {
  if (!isRecord(project)) throw fault('INVALID_ARGUMENT', 'compileSource needs a project');
  const id = String(sourceId ?? '');
  if (!isSafeSourceId(id)) throw fault('INVALID_ARGUMENT', `sourceId 必须是合法源 id，收到 ${JSON.stringify(sourceId)}`);
  const record = sourceRecord(project, id);
  if (!record) throw fault('SOURCE_NOT_FOUND', `没有源 ${id}（先 vdm source new / sourceAdd）`, { status: 404 });
  const manifest = isRecord(record.manifest) ? record.manifest : {};
  const runtime = String(manifest.runtime ?? '');
  if (!COMPILE_RUNTIMES.includes(runtime)) {
    throw fault('INVALID_ARGUMENT', `源 ${id} 的 runtime 是 ${JSON.stringify(runtime)}：编译只接受 ${COMPILE_RUNTIMES.join(' / ')}（其余 runtime 是逐帧渲染的代码图层）`);
  }
  const files = isRecord(record.files) ? record.files : {};
  const entry = String(manifest.entry ?? '');
  if (!entry) throw fault('INVALID_ARGUMENT', `源 ${id} 的 manifest 没有 entry`);
  if (typeof files[entry] !== 'string') {
    throw fault('INVALID_ARGUMENT', `源 ${id} 的入口 ${entry} 不在 project.sources[].files 里`);
  }
  const fonts = await fontContext(root);
  const meta = project.meta || {};
  const opts = {
    width: Number(meta.width) || 1920,
    height: Number(meta.height) || 1080,
    duration: Number(meta.duration) || 10,
    z0: 1,
    params: paramVariables(manifest),
    fonts: { families: fonts.families, metrics: fonts.metrics },
    measureText: fonts.measure,
  };
  const source = { id, manifest, files, entry, runtime };
  const compiled = runtime === 'svg' ? compileSvg(source, opts) : compileHtml(source, opts);
  const nodes = compiled.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    parent: node.parent ?? null,
    props: node.props,
    tracks: node.tracks,
  }));
  const elements = compiled.elements.map(elementWithDefaults);
  const payload = { version: SOURCE_SNAPSHOT_VERSION, source: id, nodes };
  const problems = snapshotProblems({ ...payload, compiler: {}, builtAt: 'x', hash: 'sha256:' + '0'.repeat(64) });
  if (problems.length) {
    throw fault('COMPILE_FAILED', `编译产物不是合法快照：${problems[0]}`);
  }
  const hash = snapshotHash(payload);
  const snapshot = {
    version: SOURCE_SNAPSHOT_VERSION,
    source: id,
    compiler: { name: COMPILER_NAME, version: COMPILER_VERSION, runtime, entry },
    builtAt: new Date().toISOString(),
    hash,
    nodes,
  };
  if (provided !== null && provided !== undefined) {
    // A caller that already has the payload (tests, a future worker compile):
    // keep its header but never trust a mismatched hash.
    if (provided.hash && provided.hash !== hash) {
      throw fault('INVALID_ARGUMENT', `传入的快照 hash 与载荷不符（${provided.hash} ≠ ${hash}）`);
    }
  }
  let written = null;
  if (root) {
    const file = basePath(root, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicJson(file, snapshot);
    written = file;
  }
  return {
    source: id,
    runtime,
    entry,
    snapshot,
    hash,
    nodes,
    elements,
    warnings: compiled.warnings,
    compiler: snapshot.compiler,
    builtAt: snapshot.builtAt,
    base: root ? path.relative(path.resolve(root), basePath(root, id)).split(path.sep).join('/') : null,
    path: written,
  };
}

// ---------------------------------------------------------------------------
// Write back: a value the user edited in the source layer (§7.8.3, WP4.3)
// ---------------------------------------------------------------------------
//
// Three steps, one transaction (§7.8.6 #6) — the caller drives them:
//
//   (1) `writeBack` works out the new file text and returns the `sourceWrite`
//       op; it never writes to disk itself;
//   (2) `writeBackOps` adds the mirror `set` so the element keeps equalling the
//       snapshot baseline (§7.8.2 "编译产物在元素上镜像基线值");
//   (3) the caller recompiles (`compileSource`) to refresh `base.json` + `hash`.
//
// The caller submits (1)+(2) as one transaction (one rev, one undo step) and
// only then runs (3). §7.8.3 allows step 3 to be debounced, and doing it after
// the transaction is what keeps §7.8.6 #6 honest: a transaction that fails has
// not written a new snapshot either. A snapshot that lags the project is the
// frozen trade-off ("防抖窗口里快照是旧的，允许"); the next compile heals it.
//
// Failure is a *result*, not an exception: `{ ok: false, fallback: 'editor-layer',
// reason }`, `reason` from the closed enum below. Only data validation throws
// (§7.8.3 "路径/值格式不对直接抛 OP_INVALID，不返回 fallback").

/**
 * §7.8.3's closed reason enum. `type-mismatch` is the one addition (R2 in
 * §7.8.8): a *node* whose type cannot carry the path (a solid's `style.text`,
 * a non-`<img>` node's `src`). A *value* of the wrong type still throws
 * `OP_INVALID` — that is §7.8.3's synchronous validation, not a fallback.
 * `source-read-only` has no producer in this schema (no source is read-only
 * yet) and `worker-unavailable` has none either: the write-back happens on the
 * text with the compiler's tokenizer instead of a DOM sandbox, so there is no
 * worker to be unavailable. Both stay in the enum so a future DOM/worker
 * implementation does not widen it.
 */
export const WRITEBACK_REASONS = Object.freeze([
  'source-missing',
  'node-missing',
  'path-editor-only',
  'path-overridden',
  'node-unwritable',
  'type-mismatch',
  'source-read-only',
  'worker-unavailable',
]);

/** Element bound to one source node (`el.source = { id, node }`, §7.8.2). */
export function elementForNode({ project, sourceId, nodeId }) {
  const id = String(sourceId ?? '');
  const node = String(nodeId ?? '');
  for (const el of Array.isArray(project?.elements) ? project.elements : []) {
    if (el?.source?.id === id && el?.source?.node === node) return el;
  }
  return null;
}

/** A `writeBack` result that degrades to the editor layer (§7.8.3). */
function degraded(reason, { path, value, message }) {
  return { ok: false, fallback: 'editor-layer', reason, path, value, message };
}

/**
 * The §7.8.3 write-back: `{ ok, changed, file, path, value, op }` when the
 * source can carry the value (`op` is the `sourceWrite` the caller submits), or
 * `{ ok: false, fallback: 'editor-layer', reason, … }` when it cannot. Async
 * because the frozen contract is (a real implementation edits the DOM in the
 * sandbox); this one is a text splice, but the caller's contract must not
 * depend on which is behind it.
 *
 * `root` is required: the node's type comes from `base.json` (§7.8.1 lists this
 * function among that file's readers), and a node the snapshot does not carry
 * is `node-missing` — we never guess what an uncompiled element is.
 */
export async function writeBack({ project, sourceId, nodeId, path, value, actorId = null, root = null }) {
  if (!isRecord(project)) throw fault('INVALID_ARGUMENT', 'writeBack 需要 project');
  const id = String(sourceId ?? '');
  if (!isSafeSourceId(id)) throw fault('INVALID_ARGUMENT', `sourceId 必须是合法源 id，收到 ${JSON.stringify(sourceId)}`);
  if (!isSourceNodeId(nodeId)) throw fault('OP_INVALID', `nodeId 必须是合法节点 id，收到 ${JSON.stringify(nodeId)}`);
  if (typeof path !== 'string' || !path) throw fault('OP_INVALID', `writeBack 需要 path，收到 ${JSON.stringify(path)}`);
  const target = { path, value };
  // §7.4's table first: a path that is not a write-back row never looks at the
  // source at all, not even for the `sourceMode` of the element.
  if (!isWriteBackPath(path)) {
    return degraded('path-editor-only', { ...target, message: `${path} 属于编辑器层（§7.4 表外），不写回源` });
  }
  // Value format: §7.8.3's synchronous data validation, which throws.
  const numeric = isNumericSourcePath(path);
  if (numeric ? !(typeof value === 'number' && Number.isFinite(value)) : typeof value !== 'string') {
    throw fault('OP_INVALID', `${path} 需要${numeric ? '有限数字' : '字符串'}，收到 ${JSON.stringify(value)}`);
  }
  if (actorId !== null && typeof actorId !== 'string') throw fault('INVALID_ARGUMENT', 'actorId 必须是字符串');
  const element = elementForNode({ project, sourceId: id, nodeId });
  if (element?.sourceMode?.[path] === 'override') {
    return degraded('path-overridden', {
      ...target, message: `元素 ${element.id} 已接管 ${path}（sourceMode: override），不再写回源`,
    });
  }
  const record = sourceRecord(project, id);
  if (!record) return degraded('source-missing', { ...target, message: `没有源 ${id}（先 vdm source new / sourceAdd）` });
  // §7.8.3 "不适用于 code 元素": a code layer has no DOM, so the runtime decides
  // before the snapshot does — an uncompiled code source must not look like a
  // missing node.
  const manifest = isRecord(record.manifest) ? record.manifest : {};
  const runtime = String(manifest.runtime ?? '');
  if (!COMPILE_RUNTIMES.includes(runtime)) {
    return degraded('node-unwritable', {
      ...target, message: `源 ${id} 的 runtime 是 ${JSON.stringify(runtime)}：只有 html / svg 有 DOM 可写回（代码图层用 sourceWrite / codeParamSet）`,
    });
  }
  const entry = String(manifest.entry ?? '');
  const files = isRecord(record.files) ? record.files : {};
  if (!entry || typeof files[entry] !== 'string') {
    return degraded('node-unwritable', { ...target, message: `源 ${id} 的入口 ${JSON.stringify(entry)} 不在 project.sources[].files 里` });
  }
  if (!root) throw fault('INVALID_ARGUMENT', 'writeBack 需要 project root：节点类型来自 .vdm/sources/<id>/base.json（§7.8.1）');
  const base = await readBase({ root, sourceId: id });
  if (!base.ok) {
    return degraded('node-missing', {
      ...target, message: `源 ${id} 还没有可用的 base.json（${base.problems[0] || 'not compiled'}）：先编译，再写回`,
    });
  }
  const node = base.snapshot.nodes.find((entry) => entry.id === nodeId) || null;
  if (!node) {
    return degraded('node-missing', { ...target, message: `上次编译的快照里没有节点 ${nodeId}（源改过？先重新编译）` });
  }
  const needed = nodeTypeForPath(path);
  if (needed && node.type !== needed) {
    return degraded('type-mismatch', { ...target, message: `节点 ${nodeId} 是 ${node.type}，${path} 只适用于 ${needed} 节点` });
  }
  const written = writeNodeValue({ text: files[entry], nodeId, runtime, path, value });
  if (!written.ok) {
    // 'missing' here means "the snapshot has it, the text does not": the source
    // was edited without a recompile, so the node is gone as far as the text
    // is concerned. Everything else is a §7.4 "write-back fails" case.
    return degraded(written.code === 'missing' ? 'node-missing' : 'node-unwritable', { ...target, message: written.message });
  }
  if (!written.changed) return { ok: true, changed: false, file: entry, path, value, op: null };
  return {
    ok: true, changed: true, file: entry, path, value,
    op: { op: 'sourceWrite', id, path: entry, content: written.text },
  };
}

/**
 * The caller's half of §7.8.3's transaction: the `sourceWrite` op `writeBack`
 * computed plus the mirror `set` that puts the same value on the element bound
 * to the node (§7.8.3 step 2: "镜像与 base 保持一致"). One `transact` call =
 * one rev + one undo step. Step 3 (recompile) is the caller's next call.
 */
export function writeBackOps({ project, sourceId, nodeId, result }) {
  if (!result?.ok || !result.op) return [];
  const ops = [result.op];
  const element = elementForNode({ project, sourceId, nodeId });
  if (element) ops.push({ op: 'set', id: element.id, path: result.path, value: result.value });
  return ops;
}

// ---------------------------------------------------------------------------
// Reading a snapshot back
// ---------------------------------------------------------------------------

/**
 * Read + validate `.vdm/sources/<id>/base.json` (§7.8.1 版本与降级). Never
 * throws: a missing or broken snapshot is `{ ok: false, problems }`, which the
 * IR turns into "缺源" for the affected elements.
 */
export async function readBase({ root, sourceId }) {
  const id = String(sourceId ?? '');
  if (!isSafeSourceId(id)) return { ok: false, source: id, snapshot: null, problems: ['bad source id'], path: null };
  if (!root) return { ok: false, source: id, snapshot: null, problems: ['no project root'], path: null };
  const file = basePath(root, id);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { ok: false, source: id, snapshot: null, problems: ['not compiled'], path: file };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, source: id, snapshot: null, problems: [`invalid json: ${error.message}`], path: file };
  }
  const problems = snapshotProblems(parsed);
  if (problems.length) return { ok: false, source: id, snapshot: null, problems, path: file };
  if (parsed.source !== id) {
    return { ok: false, source: id, snapshot: null, problems: [`snapshot belongs to ${parsed.source}`], path: file };
  }
  return { ok: true, source: id, snapshot: parsed, problems: [], path: file };
}

/** Registry + compile status of every source the project knows. */
export async function listSources({ project, root }) {
  const list = Array.isArray(project?.sources) ? project.sources.filter(isRecord) : [];
  const out = [];
  for (const record of list) {
    const id = String(record.id ?? '');
    if (!isSafeSourceId(id)) continue;
    const manifest = isRecord(record.manifest) ? record.manifest : {};
    const files = isRecord(record.files) ? record.files : {};
    const base = root ? await readBase({ root, sourceId: id }) : { ok: false, snapshot: null, problems: ['no root'] };
    out.push({
      id,
      label: String(manifest.label ?? id),
      runtime: String(manifest.runtime ?? ''),
      entry: String(manifest.entry ?? ''),
      compilable: COMPILE_RUNTIMES.includes(String(manifest.runtime ?? '')),
      files: [SOURCE_MANIFEST, ...Object.keys(files).sort()],
      manifest,
      compiled: base.snapshot
        ? {
          version: base.snapshot.version,
          hash: base.snapshot.hash,
          builtAt: base.snapshot.builtAt,
          nodes: base.snapshot.nodes.length,
          valid: base.ok,
          problems: base.problems,
        }
        : null,
      problems: base.problems,
    });
  }
  return { sources: out };
}

// ---------------------------------------------------------------------------
// Apply: snapshot nodes → element payloads → one `sourceApply` op
// ---------------------------------------------------------------------------
//
// Why apply needs a compile and cannot live off `base.json` alone: the frozen
// snapshot only carries the §7.8.1 source paths. A solid's `w`/`h`/`fill`, a
// shape's kind and an image's `src` are *element-layer* facts (§7.8.2 "编译产物
// 在元素上镜像基线值，元素单独看也是对的"), so `applyCompiled` takes the
// compile output when it has it and otherwise compiles again — the same source
// always yields the same `hash`, so the refresh is idempotent.

const TEXT_STYLE_KEYS = Object.freeze([
  ['style.text', 'text'], ['style.font', 'font'], ['style.size', 'size'], ['style.weight', 'weight'],
  ['style.color', 'color'], ['style.align', 'align'], ['style.lineHeight', 'lineHeight'],
  ['style.letterSpacing', 'letterSpacing'],
]);

/** Text / style fields the snapshot owns (they are §7.8.1 paths). */
function textStyleOf(props) {
  const style = {};
  for (const [path, key] of TEXT_STYLE_KEYS) {
    if (props[path] !== undefined) style[key] = props[path];
  }
  return style;
}

/** Geometry style the element layer owns (not a source path). */
function geometryStyleOf(compiled) {
  if (!compiled || !isRecord(compiled.style)) return null;
  const style = {};
  for (const key of ['w', 'h', 'fill', 'radius', 'shape', 'fit']) {
    if (compiled.style[key] !== undefined) style[key] = compiled.style[key];
  }
  return Object.keys(style).length ? style : null;
}

/** The `sourceMode` a node's baseline needs (only deviations, §7.8.2). */
function sourceModeOf(node) {
  const props = node.props || {};
  const mode = {};
  for (const [path, keys] of tracksByPath(Array.isArray(node.tracks) ? node.tracks : [])) {
    if (!keys.length) continue;
    if ((path === 'transform.scale' || path === 'transform.opacity') && Math.abs(Number(props[path])) < 1e-9) {
      mode[path] = 'add';
    }
  }
  return mode;
}

function tracksByPath(tracks) {
  const out = new Map();
  for (const key of tracks) {
    if (!out.has(key.path)) out.set(key.path, []);
    out.get(key.path).push(key);
  }
  return out;
}

/**
 * One snapshot node → one element payload. `compiled` is the compiler's payload
 * for the same node (it carries the element-layer geometry); `current` is the
 * element already bound to this node, if any.
 */
export function elementPayloadFor({ snapshot, node, compiled = null, current = null, duration = 10 }) {
  const props = isRecord(node.props) ? node.props : {};
  const type = compiled?.type || node.type;
  // Element-layer geometry: from this compile, else from the element that is
  // already bound (a refresh from base.json keeps an applied project intact).
  const geometry = geometryStyleOf(compiled) || geometryStyleOf(current);
  if ((type === 'solid' || type === 'shape' || type === 'image') && !geometry && type !== 'image') {
    throw fault('SOURCE_NOT_COMPILED', `节点 ${node.id} 是 ${type}：尺寸与填充属于元素层，不在 §7.8.1 快照里，apply 需要一次编译产物`);
  }
  const style = { ...(compiled?.style || {}), ...(geometry || {}), ...textStyleOf(props) };
  if (type === 'text' && style.text === undefined) style.text = String(props['style.text'] ?? '');
  const payload = {
    id: current?.id || compiled?.id || elementIdOf(snapshot.source, node.id),
    name: current?.name || compiled?.name || node.id,
    type,
    src: compiled?.src || (node.type === 'image' ? String(props.src ?? '') : ''),
    start: current?.start ?? compiled?.start ?? 0,
    duration: Number(current?.duration) > 0 ? current.duration : (Number(compiled?.duration) > 0 ? compiled.duration : duration),
    z: current?.z ?? compiled?.z ?? 0,
    transform: {
      x: Number(props['transform.x'] ?? compiled?.transform?.x ?? 0),
      y: Number(props['transform.y'] ?? compiled?.transform?.y ?? 0),
      scale: Number(props['transform.scale'] ?? compiled?.transform?.scale ?? 1),
      rotation: Number(props['transform.rotation'] ?? compiled?.transform?.rotation ?? 0),
      opacity: Number(props['transform.opacity'] ?? compiled?.transform?.opacity ?? 1),
    },
    style,
    source: { id: snapshot.source, node: node.id },
  };
  const mode = sourceModeOf(node);
  if (Object.keys(mode).length) payload.sourceMode = mode;
  return payload;
}

/** Stable element id for a source node (unique inside the project). */
export function elementIdOf(sourceId, nodeId) {
  const clean = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `src_${clean(sourceId)}_${clean(nodeId)}`;
}

/**
 * The single op that upserts every node of a snapshot (§7.8.2). One op is one
 * transaction: the caller submits it through `core/ops.js`.
 */
export function applyOpFor({ project, snapshot, elements = [], duration = 10 }) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.nodes)) {
    throw fault('SOURCE_NOT_COMPILED', '快照不可用（先编译）');
  }
  const problems = snapshotProblems(snapshot);
  if (problems.length) throw fault('SOURCE_NOT_COMPILED', `快照不合法：${problems[0]}`);
  const id = snapshot.source;
  const existing = new Map();
  for (const el of Array.isArray(project?.elements) ? project.elements : []) {
    if (el?.source?.id === id && typeof el.source.node === 'string' && !existing.has(el.source.node)) existing.set(el.source.node, el);
  }
  const compiled = new Map();
  for (const payload of Array.isArray(elements) ? elements : []) {
    if (payload?.source?.node) compiled.set(payload.source.node, payload);
  }
  const out = [];
  for (const node of snapshot.nodes) {
    out.push(elementPayloadFor({
      snapshot, node,
      compiled: compiled.get(node.id) || null,
      current: existing.get(node.id) || null,
      duration,
    }));
  }
  // Background elements (no source binding) travel with the same op: they are
  // what the page paints behind the nodes, and re-applying must refresh them.
  const seen = new Set(out.map((payload) => payload.id));
  for (const payload of Array.isArray(elements) ? elements : []) {
    if (!payload || payload.source || !payload.id || seen.has(payload.id)) continue;
    seen.add(payload.id);
    out.push(elementWithDefaults(payload));
  }
  return { op: { op: 'sourceApply', id, elements: out }, elements: out };
}

/**
 * Read the snapshot (or take one) and build the `sourceApply` op. Nothing is
 * written except a refreshed `base.json` when the project root is known.
 */
export async function applyCompiled({ project, sourceId, root, snapshot = null, elements = null }) {
  const id = String(sourceId ?? '');
  if (!isSafeSourceId(id)) throw fault('INVALID_ARGUMENT', `sourceId 必须是合法源 id，收到 ${JSON.stringify(sourceId)}`);
  const record = sourceRecord(project, id);
  if (!record) throw fault('SOURCE_NOT_FOUND', `没有源 ${id}`, { status: 404 });
  const meta = project?.meta || {};
  const duration = Number(meta.duration) > 0 ? Number(meta.duration) : 10;
  let snap = snapshot;
  let compiledElements = elements;
  if (!snap || !compiledElements) {
    const compiled = await compileSource({ project, sourceId: id, root });
    snap = snap || compiled.snapshot;
    compiledElements = compiledElements || compiled.elements;
  } else {
    const problems = snapshotProblems(snap);
    if (problems.length) throw fault('SOURCE_NOT_COMPILED', `快照不合法：${problems[0]}`);
  }
  const { op, elements: payloads } = applyOpFor({ project, snapshot: snap, elements: compiledElements, duration });
  return {
    op,
    elements: payloads,
    hash: snap.hash,
    builtAt: snap.builtAt,
    base: root ? path.relative(path.resolve(root), basePath(root, id)).split(path.sep).join('/') : null,
  };
}

/**
 * Expand `sourceCompile` / `sourceApply` ops into what core can execute
 * (§7.8.6 #1: core never reads `.vdm/`, so the file side lives here). Called at
 * the write boundary by `ProjectService.transact`, which is why an agent may
 * send `{ op: 'sourceApply', id }` and still get one transaction.
 *
 * A dry run compiles in memory only (no `base.json` write, no project change).
 */
export async function expandSourceOps(ops, { project, root = null, dryRun = false } = {}) {
  if (!Array.isArray(ops)) return ops;
  const out = [];
  for (const op of ops) {
    if (!isRecord(op)) { out.push(op); continue; }
    if (op.op === 'sourceCompile') {
      const compiled = await compileSource({ project, sourceId: op.id, root: dryRun ? null : root });
      out.push({
        op: 'sourceCompile', id: compiled.source,
        compiled: { hash: compiled.hash, builtAt: compiled.builtAt, nodes: compiled.nodes.length },
      });
      continue;
    }
    if (op.op === 'sourceApply') {
      if (Array.isArray(op.elements)) { out.push(op); continue; }
      const applied = await applyCompiled({ project, sourceId: op.id, root: dryRun ? null : root });
      out.push(applied.op);
      continue;
    }
    if (op.op === 'batch' && Array.isArray(op.ops)) {
      out.push({ ...op, ops: await expandSourceOps(op.ops, { project, root, dryRun }) });
      continue;
    }
    out.push(op);
  }
  return out;
}
