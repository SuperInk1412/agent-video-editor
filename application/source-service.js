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
// The routes (`engine/routes/sources.js`) call the async functions here; the
// CLI/MCP surfaces come with WP4.3.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SOURCE_SNAPSHOT_VERSION } from '../core/version.js';
import { snapshotProblems } from '../core/source-eval.js';
import { compileHtml, compileSvg, COMPILE_RUNTIMES } from '../core/source-map.js';
import { isSafeSourceId, sourceRecord, SOURCE_MANIFEST } from '../core/code-layer.js';
import { isRecord } from '../core/json.js';
import { parseFont, metricsOf, layoutText } from '../core/glyphs.js';
import { resolveFontFile } from '../engine/shot.js';
import { atomicJson } from '../engine/storage.js';
import { fault } from './errors.js';
import { DEFAULT_STYLE, DEFAULT_TRANSFORM } from '../core/schema.js';

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
