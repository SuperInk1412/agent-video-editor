// Code layers: the `code` element (§6.1), the parameters that reach the render
// pool (§6.2), and the contract check behind `vdm source check` (§6.3).
//
// Pure ESM (browser + Node, no `node:*`, no filesystem): reading
// `sources/<id>/`, writing files and calling the RenderWorkerPool belong to the
// callers — `cli/vdm.js` today, the preview (WP3.3) and the bakes (WP3.4) later.
// Everything that decides *what* to render at time t lives here so that all of
// them agree, and so the parameter evaluation is unit-testable without Electron.
//
// Data (§6.1):
//
//   element.code = { source, params, seed, size, cache }
//     source  id of `sources/<source>/`
//     params  current values; keyframes live at `code.params.<name>`
//     seed    deterministic random seed for `vdm.random`
//     size    [w, h] of the raster; null = the project size
//     cache   "live" (preview may render on demand) | "bake" (cached frames only)
//
//   project.sources[] = { id, manifest, files }   // the source registry
//     manifest  the parsed `manifest.json` (PROPERTY-shaped `params`, §DESIGN-TEMPLATES)
//     files     `{ "sketch.js": "<text>" }`, `manifest.json` excluded (derived)
//
// The registry is what makes a source *editable through ops* (core is the only
// writer, §AGENTS) and what lets the browser show parameter rows without
// touching the disk. `sourceFiles()` turns it back into the files the render
// pool reads, so the disk copy is always derivable.
import { isRecord, pathParts } from './json.js';
import { hasTrack, sampleTrack } from './time.js';
import { resolveEffectiveValue } from './links.js';

/** Keyframe / link path prefix of one source parameter. */
export const CODE_PARAM_PREFIX = 'code.params.';
/** `live`: preview renders on demand. `bake`: only already-cached frames. */
export const CODE_CACHE_MODES = Object.freeze(['live', 'bake']);
/** Every runtime a source may declare (the registry whitelist, §7.8.6 #8). */
export const CODE_RUNTIMES = Object.freeze(['canvas2d', 'p5', 'glsl', 'html', 'svg', 'manim']);
/**
 * The runtimes the RenderWorkerPool draws, one frame at a time (§5). `html` /
 * `svg` are compile sources (WP4.1): they turn into native elements, so they
 * never go through the pool and have no `code` element (§7.8.6 #8). `manim` is
 * an external renderer (§6.4, WP5.2): a Python subprocess writes the frames
 * into `.vdm/cache/manim/`, again without the pool.
 */
export const RASTER_RUNTIMES = Object.freeze(['canvas2d', 'p5', 'glsl']);
/** Runtimes that compile into native elements instead of rendering per frame. */
export const COMPILE_RUNTIMES = Object.freeze(['html', 'svg']);
/**
 * Runtimes whose frames come from an external renderer (`engine/manim.js`),
 * not from the pool. They are still *raster items* — one picture per frame on
 * a 2D node plane — so preview and export consume them through the WP3.3 /
 * WP3.4 raster path (`.vdm/cache/manim/` is the sequence, `GET /api/raster`
 * the door), just with a different producer.
 */
export const EXTERNAL_RUNTIMES = Object.freeze(['manim']);
/** true for a runtime the pool rasterises per frame. */
export const isRasterRuntime = (runtime) => RASTER_RUNTIMES.includes(String(runtime ?? ''));
/** true for a runtime an external renderer produces frames for. */
export const isExternalRuntime = (runtime) => EXTERNAL_RUNTIMES.includes(String(runtime ?? ''));
/** true for a runtime that yields one picture per frame (`kind: "raster"` in the IR). */
export const isRasterItemRuntime = (runtime) => isRasterRuntime(runtime) || isExternalRuntime(runtime);
/** The one file every source directory must contain. */
export const SOURCE_MANIFEST = 'manifest.json';
/** Budget the contract check enforces per frame (§5.3: live preview 200 ms). */
export const DEFAULT_FRAME_BUDGET_MS = 200;

export const DEFAULT_CODE = Object.freeze({
  source: '',
  params: Object.freeze({}),
  seed: 0,
  size: null,
  cache: 'live',
});

const isNum = (v) => (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
const num = (v, d = 0) => (isNum(v) ? Number(v) : d);
const int = (v, d = 0) => Math.round(num(v, d));
const POSITIVE_INT = (v) => Number.isFinite(Number(v)) && Number(v) > 0;

/** Source ids are directory names, not paths (same rule as the sandbox). */
export const isSafeSourceId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
/** Parameter names become part of a dotted property path and of `code.params`. */
export const isSafeParamName = (name) => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name);

export const isCodeElement = (el) => isRecord(el) && el.type === 'code';

/** `code.params.<name>` for a parameter name; throws for unsafe names. */
export function codeParamPath(name) {
  if (!isSafeParamName(name)) throw Object.assign(new Error(`bad code parameter name ${JSON.stringify(name)}`), { code: 'OP_INVALID' });
  return `${CODE_PARAM_PREFIX}${name}`;
}

/** True for any `code.params.<name>` path (safe or not: readers are tolerant). */
export const isCodeParamPath = (path) => typeof path === 'string' && path.startsWith(CODE_PARAM_PREFIX) && path.length > CODE_PARAM_PREFIX.length;

/** `code.params.tint` -> `tint`; anything else -> null. */
export function codeParamName(path) {
  if (!isCodeParamPath(path)) return null;
  const name = path.slice(CODE_PARAM_PREFIX.length);
  return name.includes('.') ? null : name;
}

// ---------------------------------------------------------------------------
// Normalisation + validation of one element's `code` block (§6.1)
// ---------------------------------------------------------------------------

/** Current values only: numbers, booleans and strings survive, everything else is dropped. */
function normalizeCodeParams(raw) {
  if (!isRecord(raw)) return {};
  const out = {};
  for (const name of Object.keys(raw).sort()) {
    if (!isSafeParamName(name)) continue;
    const value = raw[name];
    if (value === undefined || value === null) continue;
    if (typeof value === 'number') { if (Number.isFinite(value)) out[name] = value; continue; }
    if (typeof value === 'boolean' || typeof value === 'string') { out[name] = value; continue; }
    if (Array.isArray(value) && value.length >= 2 && value.every((n) => Number.isFinite(Number(n)))) {
      out[name] = value.map(Number); // vec2 / vec3 parameter
    }
  }
  return out;
}

/** Every declared parameter gets the element's current value, so links/keyframes see it. */
function fillDeclaredParams(params, manifest) {
  if (!isRecord(manifest) || !Array.isArray(manifest.params)) return params;
  const out = { ...params };
  for (const param of manifest.params) {
    if (!isRecord(param)) continue;
    const id = String(param.id ?? '');
    if (!id || !isSafeParamName(id) || out[id] !== undefined || param.default === undefined) continue;
    const value = coerceParamValue(param.type, param.default);
    if (value === undefined || value === null) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[id] = value;
  }
  return out;
}

/**
 * Fill in defaults for `element.code` without clobbering user values.
 * When the source is registered, every parameter the manifest declares gets a
 * base value on the element: `code.params` is then the complete current state,
 * which is what property links (`code.params.<name>`) and the UI read.
 */
export function normalizeCode(raw, manifest = null) {
  const src = isRecord(raw) ? raw : {};
  const size = Array.isArray(src.size) && src.size.length >= 2 && POSITIVE_INT(src.size[0]) && POSITIVE_INT(src.size[1])
    ? [Math.floor(Number(src.size[0])), Math.floor(Number(src.size[1]))]
    : null;
  const filled = fillDeclaredParams(normalizeCodeParams(src.params), manifest);
  const params = {};
  for (const name of Object.keys(filled).sort()) params[name] = filled[name];
  return {
    source: typeof src.source === 'string' ? src.source : '',
    params,
    seed: Number.isFinite(Number(src.seed)) ? Math.trunc(Number(src.seed)) : DEFAULT_CODE.seed,
    size,
    cache: CODE_CACHE_MODES.includes(src.cache) ? src.cache : DEFAULT_CODE.cache,
  };
}

/** Shape problems of an element's `code` block (no repair, no mutation). */
export function codeIssues(code, at = 'code') {
  const issues = [];
  const push = (path, msg) => issues.push({ path, msg });
  if (code === undefined) return issues;
  if (!isRecord(code)) { push(at, 'must be an object'); return issues; }
  if (typeof code.source !== 'string' || !code.source) push(`${at}.source`, 'must be a nonempty source id');
  else if (!isSafeSourceId(code.source)) push(`${at}.source`, 'must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}');
  if (code.params !== undefined) {
    if (!isRecord(code.params)) push(`${at}.params`, 'must be an object');
    else {
      for (const name of Object.keys(code.params)) {
        if (!isSafeParamName(name)) { push(`${at}.params.${name}`, 'parameter names must match [A-Za-z_][A-Za-z0-9_]*'); continue; }
        const value = code.params[name];
        const okType = typeof value === 'number' ? Number.isFinite(value)
          : typeof value === 'string' || typeof value === 'boolean'
            || (Array.isArray(value) && value.every((n) => Number.isFinite(Number(n))));
        if (!okType) push(`${at}.params.${name}`, 'must be a number, string, boolean or number[]');
      }
    }
  }
  if (code.seed !== undefined && (!Number.isFinite(Number(code.seed)) || !Number.isInteger(Number(code.seed)))) {
    push(`${at}.seed`, 'must be an integer');
  }
  if (code.size !== undefined && code.size !== null) {
    if (!Array.isArray(code.size) || code.size.length !== 2 || !code.size.every(POSITIVE_INT)) {
      push(`${at}.size`, 'must be [width, height] positive integers');
    } else if (Number(code.size[0]) > 8192 || Number(code.size[1]) > 8192) {
      push(`${at}.size`, 'cannot exceed 8192');
    }
  }
  if (code.cache !== undefined && !CODE_CACHE_MODES.includes(code.cache)) {
    push(`${at}.cache`, `must be one of ${CODE_CACHE_MODES.join(' / ')}`);
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Source registry (project.sources) — the ops write this, the pool reads the
// disk copy produced by `sourceFiles()`.
// ---------------------------------------------------------------------------

/** Parameter types a manifest may declare (DESIGN-TEMPLATES PROPERTY + the pool's coercion). */
export const PROPERTY_TYPES = Object.freeze([
  'number', 'int', 'length', 'percent', 'angle', 'boolean',
  'enum', 'color', 'string', 'text', 'font', 'vec2', 'vec3',
]);
export const KEYABLE_MODES = Object.freeze([false, 'frame', 'shot']);

/**
 * Shape problems of a `manifest.json` (§6.1 + DESIGN-TEMPLATES PROPERTY rows).
 * `sourceAdd` rejects a manifest with issues; `vdm source check` prints them.
 */
export function manifestIssues(manifest, at = 'manifest') {
  const issues = [];
  const push = (path, msg) => issues.push({ path, msg });
  if (!isRecord(manifest)) return [{ path: at, msg: 'must be an object' }];
  const runtime = manifest.runtime;
  if (typeof runtime !== 'string' || !runtime) push(`${at}.runtime`, `must be one of ${CODE_RUNTIMES.join(' / ')}`);
  else if (!CODE_RUNTIMES.includes(runtime)) push(`${at}.runtime`, `unsupported runtime ${runtime}（这一版支持 ${CODE_RUNTIMES.join(' / ')}；html / svg 编译成原生元素，manim 由外部渲染器产帧）`);
  if (manifest.id !== undefined && (typeof manifest.id !== 'string' || !isSafeSourceId(manifest.id))) {
    push(`${at}.id`, 'must be a nonempty source id');
  }
  if (typeof manifest.entry !== 'string' || !manifest.entry) push(`${at}.entry`, 'must be a nonempty relative path');
  else if (!isSafeSourceFile(manifest.entry)) push(`${at}.entry`, `unsafe path ${JSON.stringify(manifest.entry)}`);
  if (manifest.deterministic !== undefined && typeof manifest.deterministic !== 'boolean') {
    push(`${at}.deterministic`, 'must be boolean');
  }
  // Only a source that says its picture does not depend on the clock may have
  // one frame baked and reused for a whole render range (engine/raster-bake.js).
  // Default false: a sketch may animate through `vdm.t` / `vdm.frame` alone.
  if (manifest.timeIndependent !== undefined && typeof manifest.timeIndependent !== 'boolean') {
    push(`${at}.timeIndependent`, 'must be boolean');
  }
  if (manifest.libs !== undefined && !isRecord(manifest.libs)) push(`${at}.libs`, 'must be an object of library versions');
  if (manifest.params !== undefined) {
    if (!Array.isArray(manifest.params)) push(`${at}.params`, 'must be an array of PROPERTY rows');
    else {
      const seen = new Set();
      manifest.params.forEach((param, i) => {
        const loc = `${at}.params[${i}]`;
        if (!isRecord(param)) { push(loc, 'must be an object'); return; }
        const id = param.id;
        if (typeof id !== 'string' || !isSafeParamName(id)) push(`${loc}.id`, 'must match [A-Za-z_][A-Za-z0-9_]*');
        else if (seen.has(id)) push(`${loc}.id`, `duplicate parameter ${id}`);
        else seen.add(id);
        if (param.type !== undefined && !PROPERTY_TYPES.includes(param.type)) {
          push(`${loc}.type`, `unknown type ${JSON.stringify(param.type)}（支持 ${PROPERTY_TYPES.join(' / ')}）`);
        }
        if (param.keyable !== undefined && !KEYABLE_MODES.includes(param.keyable)) {
          push(`${loc}.keyable`, "must be false, 'frame' or 'shot'");
        }
        if (param.range !== undefined) {
          const ok = Array.isArray(param.range) && param.range.length === 2 && param.range.every((n) => Number.isFinite(Number(n)));
          if (!ok) push(`${loc}.range`, 'must be [min, max]');
          else if (Number(param.range[1]) < Number(param.range[0])) push(`${loc}.range`, 'max must be >= min');
        }
        if (param.type === 'enum' && param.options !== undefined && !Array.isArray(param.options)) {
          push(`${loc}.options`, 'must be an array');
        }
      });
    }
  }
  return issues;
}

/**
 * `manifest.timeIndependent` (§6.1): the source states that its picture does
 * not depend on the clock, so one frame may be baked and held for a render
 * range (engine/raster-bake.js). Default false — unchanged parameters are not
 * proof that the picture stands still, because a sketch may animate through
 * `vdm.t` / `vdm.frame` alone (§6.2).
 */
export const isTimeIndependentSource = (manifest) => isRecord(manifest) && manifest.timeIndependent === true;

const sourceList = (project) => (Array.isArray(project?.sources) ? project.sources.filter(isRecord) : []);


/** Registry entry for a source id, or null. */
export function sourceRecord(project, sourceId) {
  const id = String(sourceId ?? '');
  if (!id) return null;
  return sourceList(project).find((entry) => String(entry.id ?? '') === id) || null;
}

/** Parsed manifest of a registered source, or null (also null for a bad registry entry). */
export function sourceManifest(project, sourceId) {
  const record = sourceRecord(project, sourceId);
  if (!record || !isRecord(record.manifest)) return null;
  return record.manifest;
}

/** Declared parameters of a source, in manifest order. */
export function sourceParams(project, sourceId) {
  const manifest = sourceManifest(project, sourceId);
  return Array.isArray(manifest?.params) ? manifest.params.filter(isRecord) : [];
}

/** Every source id in the registry (sorted), for `vdm source ls` and id allocation. */
export function sourceIds(project) {
  return sourceList(project).map((entry) => String(entry.id ?? '')).filter(Boolean).sort();
}

const SAFE_FILE_RE = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]*(?:\/[A-Za-z0-9_@][A-Za-z0-9_.@-]*)*$/;

/** True when `rel` is a boring relative path inside a source directory. */
export function isSafeSourceFile(rel) {  if (typeof rel !== 'string' || !rel || rel.length > 200) return false;
  if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  if (!SAFE_FILE_RE.test(rel)) return false;
  try { pathParts(rel); } catch { return false; }
  return true;
}

/**
 * Files a registered source materialises to, `manifest.json` first:
 * `[{ path: 'manifest.json', content }, { path: 'sketch.js', content }, …]`.
 * Returns [] for an unknown id, so callers can fall back to the disk copy.
 */
export function sourceFiles(project, sourceId) {
  const record = sourceRecord(project, sourceId);
  if (!record) return [];
  const manifest = isRecord(record.manifest) ? record.manifest : null;
  const out = [];
  if (manifest) {
    out.push({
      path: SOURCE_MANIFEST,
      content: `${JSON.stringify({ ...manifest, id: String(record.id ?? sourceId) }, null, 2)}\n`,
    });
  }
  const files = isRecord(record.files) ? record.files : {};
  for (const rel of Object.keys(files).sort()) {
    if (rel === SOURCE_MANIFEST || !isSafeSourceFile(rel)) continue;
    const content = files[rel];
    if (typeof content !== 'string') continue;
    out.push({ path: rel, content });
  }
  return out;
}

/**
 * Clean up `project.sources` on load: keep safe ids, one entry per id, sorted;
 * drop files that could escape the source directory. Nothing is fabricated —
 * a project without sources keeps `sources === undefined`.
 */
export function normalizeSources(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = String(entry.id ?? '');
    if (!isSafeSourceId(id) || seen.has(id)) continue;
    seen.add(id);
    const manifest = isRecord(entry.manifest) ? { ...entry.manifest, id } : null;
    const files = {};
    if (isRecord(entry.files)) {
      for (const rel of Object.keys(entry.files)) {
        if (rel === SOURCE_MANIFEST || !isSafeSourceFile(rel) || typeof entry.files[rel] !== 'string') continue;
        files[rel] = entry.files[rel];
      }
    }
    out.push({ id, manifest, files });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Element readers
// ---------------------------------------------------------------------------

export const codeSourceId = (el) => (isRecord(el?.code) ? String(el.code.source ?? '') : '');
export const codeManifest = (project, el) => sourceManifest(project, codeSourceId(el));

/** Raster size: `code.size`, else the project size (§6.1 example writes it out). */
export function codeSize(el, meta = null) {
  const size = el?.code?.size;
  if (Array.isArray(size) && size.length >= 2 && POSITIVE_INT(size[0]) && POSITIVE_INT(size[1])) {
    return [Math.floor(Number(size[0])), Math.floor(Number(size[1]))];
  }
  const width = POSITIVE_INT(meta?.width) ? Math.floor(Number(meta.width)) : 1920;
  const height = POSITIVE_INT(meta?.height) ? Math.floor(Number(meta.height)) : 1080;
  return [width, height];
}

export const codeSeed = (el) => int(el?.code?.seed, 0);
export const codeCacheMode = (el) => (el?.code?.cache === 'bake' ? 'bake' : 'live');

/**
 * How a frame of this layer may be obtained (§6.1 `cache`):
 *   live  — render on demand (the pool caches transparently);
 *   bake  — preview shows a cached frame only, never renders;
 *   `manifest.deterministic === false` disables reuse (no cache read or write).
 */
export function codeCachePolicy(el, manifest = null) {
  const mode = codeCacheMode(el);
  const deterministic = manifest?.deterministic !== false;
  return {
    mode,
    live: mode === 'live',
    bake: mode === 'bake',
    allowLiveRender: mode === 'live',
    cacheable: deterministic,
    deterministic,
  };
}

// ---------------------------------------------------------------------------
// Parameter evaluation
// ---------------------------------------------------------------------------

/** Types whose values interpolate / take part in numeric property links. */
const NUMERIC_PARAM_TYPES = new Set(['number', 'int', 'length', 'percent', 'angle', 'vec2', 'vec3']);

/** Manifest type + current value decide whether keyframes and links apply. */
function isNumericParam(decl, value) {
  if (decl && NUMERIC_PARAM_TYPES.has(decl.type)) return true;
  if (decl && decl.type) return false;
  return typeof value === 'number' || Array.isArray(value);
}

/**
 * Coerce one evaluated value to the manifest type. Mirrors
 * `engine/render-workers/cache.js::coerceParam` (the render pool re-applies the
 * same rules; they must agree, `tests/code-layer.test.mjs` cross-checks them).
 */
export function coerceParamValue(type, value) {
  switch (type) {
    case 'int': return isNum(value) ? Math.round(Number(value)) : value;
    case 'number':
    case 'length':
    case 'percent':
    case 'angle':
      return isNum(value) ? Number(value) : value;
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : Boolean(value);
    case 'string':
    case 'text':
    case 'color':
    case 'font':
    case 'enum':
      return value === undefined || value === null ? value : String(value);
    default:
      return value;
  }
}

/** Declared parameter names plus any name that already has a value. */
export function codeParamNames(project, el) {
  const names = new Set(sourceParams(project, codeSourceId(el)).map((p) => String(p.id ?? '')).filter(Boolean));
  const stored = isRecord(el?.code?.params) ? el.code.params : {};
  for (const name of Object.keys(stored)) names.add(name);
  return [...names].sort();
}

/**
 * Parameters of a code element at time `t`:
 *   manifest default  →  element base value  →  `code.params.<name>` keyframes
 *   →  property links (core/links.js add / mul, applied through the same
 *      resolver every other linked channel uses).
 * Numeric parameters are interpolated; strings / booleans / colours step.
 */
export function codeParamsAt(project, el, t) {
  if (!isCodeElement(el)) return Object.freeze({});
  const declared = sourceParams(project, codeSourceId(el));
  const declById = new Map(declared.map((p) => [String(p.id ?? ''), p]));
  const stored = isRecord(el.code?.params) ? el.code.params : {};
  const linked = new Set();
  for (const link of Array.isArray(el.links) ? el.links : []) {
    if (isRecord(link) && link.enabled !== false && typeof link.to === 'string') linked.add(link.to);
  }
  const at = Number.isFinite(Number(t)) ? Number(t) : 0;
  const out = {};
  for (const name of codeParamNames(project, el)) {
    if (!isSafeParamName(name)) continue;
    const decl = declById.get(name) || null;
    const hasStored = Object.prototype.hasOwnProperty.call(stored, name) && stored[name] !== undefined;
    const base = hasStored ? stored[name] : decl?.default;
    if (base === undefined) continue;
    const path = `${CODE_PARAM_PREFIX}${name}`;
    let value = base;
    // Keyframes win over the base value for every type: numbers interpolate,
    // strings / booleans / colours step at the key (sampleTrack decides).
    if (hasTrack(el.keyframes, path)) {
      const sampled = sampleTrack(el.keyframes, path, at, base);
      if (sampled !== undefined && sampled !== null) value = sampled;
    }
    // Property links are numeric; a link into a non-numeric parameter is ignored.
    if (isNumericParam(decl, value) && linked.has(path)) {
      const effective = resolveEffectiveValue(project, el, path, at);
      if (Number.isFinite(effective)) value = effective;
    }
    out[name] = coerceParamValue(decl?.type, value);
  }
  return Object.freeze(out);
}

/**
 * Write one parameter at time `t`: updates the key at `t` when the channel is
 * already keyed, otherwise stores the base value. Returns the path written and
 * whether it wrote a key (the `codeParamSet` op uses this).
 */
export function writeCodeParam(el, name, value, t = 0) {
  if (!isRecord(el)) throw Object.assign(new Error('codeParamSet 需要元素'), { code: 'OP_INVALID' });
  const path = codeParamPath(name);
  const at = Math.round(Math.max(0, Number(t) || 0) * 1000) / 1000;
  const keys = Array.isArray(el.keyframes) ? el.keyframes : (el.keyframes = []);
  const keyed = keys.some((k) => isRecord(k) && k.path === path);
  el.code = isRecord(el.code) ? el.code : { ...DEFAULT_CODE, params: {} };
  el.code.params = isRecord(el.code.params) ? el.code.params : {};
  const stored = Array.isArray(value) ? value.slice() : value;
  if (!keyed) {
    el.code.params[name] = stored;
    return { path, key: false, value: stored };
  }
  const index = keys.findIndex((k) => isRecord(k) && k.path === path && Math.abs(Number(k.t) - at) < 1e-4);
  const old = index >= 0 ? keys[index] : null;
  const key = { t: at, path, value: stored, ease: old?.ease || 'easeInOut' };
  if (old?.curve) key.curve = old.curve;
  if (index >= 0) keys[index] = key; else keys.push(key);
  keys.sort((a, b) => Number(a.t) - Number(b.t));
  return { path, key: true, value: stored };
}

// ---------------------------------------------------------------------------
// Per-frame render request (§5.1 + §6.1)
// ---------------------------------------------------------------------------

/**
 * What the pool needs for one frame of this layer:
 *
 *   pool.render({ sourceId, runtime, params, frame, fps, size, seed,
 *                 useCache: plan.cacheable })
 *
 * `t` is project time in seconds; the frame number is 0 based (`round(t * fps)`),
 * which is what `core/frame-ir.js` hands the renderers.
 */
export function codeLayerPlan(project, el, t, { fps = 24 } = {}) {
  const meta = project?.meta || {};
  // A compile source (html / svg) is not a per-frame raster: there is no plan,
  // and the IR must not carry a `raster` item for it (§7.8.6 #8). A source the
  // project does not know keeps the old behaviour (the pool reports it).
  const runtime = codeManifest(project, el)?.runtime;
  if (runtime !== undefined && runtime !== null && COMPILE_RUNTIMES.includes(String(runtime))) return null;
  const rate = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : (Number(meta.fps) || 24);
  const manifest = codeManifest(project, el);
  const policy = codeCachePolicy(el, manifest);
  const at = Number.isFinite(Number(t)) ? Number(t) : 0;
  return {
    elementId: isRecord(el) ? String(el.id ?? '') : '',
    sourceId: codeSourceId(el),
    runtime: typeof manifest?.runtime === 'string' ? manifest.runtime : null,
    entry: typeof manifest?.entry === 'string' ? manifest.entry : null,
    params: codeParamsAt(project, el, at),
    size: codeSize(el, meta),
    seed: codeSeed(el),
    fps: rate,
    frame: Math.max(0, Math.round(at * rate)),
    cache: policy.mode,
    allowLiveRender: policy.allowLiveRender,
    cacheable: policy.cacheable,
  };
}

// ---------------------------------------------------------------------------
// Contract check, part 1: the static scan (§5.2, §6.3 item 1)
// ---------------------------------------------------------------------------

/**
 * APIs that break the purity contract. `error` fails the check, `warn` only
 * reports. Patterns run against source with comments and string literals
 * blanked out, so a mention in a comment is not a false positive.
 */
const BANNED_APIS = Object.freeze([
  { id: 'date-now', re: /\bDate\s*\.\s*now\s*\(/g, level: 'error', name: 'Date.now()', why: '读取挂钟时间，同一帧的哈希会漂移', fix: '用 vdm.t / vdm.frame' },
  { id: 'new-date', re: /\bnew\s+Date\s*\(\s*\)/g, level: 'error', name: 'new Date()', why: '读取挂钟时间，同一帧的哈希会漂移', fix: '用 vdm.t / vdm.frame' },
  { id: 'performance-now', re: /\bperformance\s*\.\s*now\s*\(/g, level: 'error', name: 'performance.now()', why: '读取挂钟时间，同一帧的哈希会漂移', fix: '用 vdm.t / vdm.frame' },
  { id: 'raf', re: /\brequestAnimationFrame\s*\(/g, level: 'error', name: 'requestAnimationFrame()', why: '帧由运行时逐帧驱动，自己排帧会让画面依赖调用顺序', fix: '把动画写成 vdm.t 的函数' },
  { id: 'math-random', re: /\bMath\s*\.\s*random\s*\(/g, level: 'error', name: 'Math.random()', why: '不带种子的随机，每帧结果不可复现', fix: "用 vdm.random(i, k)（带种子的哈希）" },
  { id: 'fetch', re: /\bfetch\s*\(/g, level: 'error', name: 'fetch()', why: '沙箱禁止一切网络请求（CSP connect-src none）', fix: '把数据写进源文件或 manifest 参数' },
  { id: 'xhr', re: /\bXMLHttpRequest\b/g, level: 'error', name: 'XMLHttpRequest', why: '沙箱禁止一切网络请求', fix: '把数据写进源文件或 manifest 参数' },
  { id: 'websocket', re: /\bWebSocket\b/g, level: 'error', name: 'WebSocket', why: '沙箱禁止一切网络请求', fix: '把数据写进源文件或 manifest 参数' },
  { id: 'worker', re: /\bnew\s+Worker\s*\(/g, level: 'error', name: 'new Worker()', why: 'CSP 禁 worker，且它会让帧与调用顺序相关', fix: '在 draw 里同步画完' },
  { id: 'set-timeout', re: /\bsetTimeout\s*\(/g, level: 'warn', name: 'setTimeout()', why: '异步回调会落在别的帧上', fix: '把动画写成 vdm.t 的函数' },
  { id: 'set-interval', re: /\bsetInterval\s*\(/g, level: 'warn', name: 'setInterval()', why: '异步回调会落在别的帧上', fix: '把动画写成 vdm.t 的函数' },
]);

/** p5 only: the sandbox no-ops these (§6.2) and file loaders cannot work offline. */
const P5_BANNED_APIS = Object.freeze([
  { id: 'p5-loop', re: /\.\s*loop\s*\(/g, level: 'error', name: 'loop()', why: '沙箱里 loop() 是空操作，帧由运行时驱动（§6.2）', fix: '删掉 loop()，动画写成 vdm.t 的函数' },
  { id: 'p5-frame-rate', re: /\.\s*frameRate\s*\(/g, level: 'error', name: 'frameRate()', why: '帧率由项目和渲染预算决定（§6.2）', fix: '删掉 frameRate()' },
  { id: 'p5-load', re: /\.\s*(?:loadImage|loadFont|loadJSON|loadStrings|loadTable|loadXML)\s*\(/g, level: 'error', name: 'p5 网络 / 文件加载器', why: '沙箱只暴露 sources/<id>/，没有网络也没有本机文件', fix: '把素材放进源目录并用相对路径 import' },
]);

/** Blank out comments and string literals, keeping offsets and newlines. */
export function stripSourceNoise(text) {
  const src = String(text ?? '');
  const out = new Array(src.length);
  let mode = null; // 'line' | 'block' | 'sq' | 'dq' | 'tpl'
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === null) {
      if (c === '/' && d === '/') { mode = 'line'; out[i] = ' '; i += 1; out[i] = ' '; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out[i] = ' '; i += 1; out[i] = ' '; continue; }
      if (c === "'") { mode = 'sq'; out[i] = ' '; continue; }
      if (c === '"') { mode = 'dq'; out[i] = ' '; continue; }
      if (c === '`') { mode = 'tpl'; out[i] = ' '; continue; }
      out[i] = c;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = null; out[i] = '\n'; } else out[i] = ' ';
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = null; out[i] = ' '; i += 1; out[i] = ' '; continue; }
      out[i] = c === '\n' ? '\n' : ' ';
      continue;
    }
    // inside a string literal
    if (c === '\\') { out[i] = ' '; i += 1; if (i < src.length) out[i] = src[i] === '\n' ? '\n' : ' '; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = null;
      out[i] = ' ';
      continue;
    }
    out[i] = c === '\n' ? '\n' : ' ';
  }
  return out.join('');
}

const lineAt = (text, index) => {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
};

/**
 * Static scan of one source file. Returns `{ errors, warnings }`, each entry
 * `{ file, line, id, name, message }`. `runtime` adds the runtime-specific rules.
 */
export function scanSourceText(text, { path = 'source.js', runtime = null } = {}) {
  const errors = [];
  const warnings = [];
  const stripped = stripSourceNoise(text);
  const rules = runtime === 'p5' ? [...BANNED_APIS, ...P5_BANNED_APIS] : BANNED_APIS;
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let match;
    while ((match = rule.re.exec(stripped)) !== null) {
      const entry = {
        file: path,
        line: lineAt(stripped, match.index),
        id: rule.id,
        name: rule.name,
        message: `${path}:${lineAt(stripped, match.index)} 用了 ${rule.name} —— ${rule.why}；${rule.fix}`,
      };
      (rule.level === 'error' ? errors : warnings).push(entry);
      if (match.index === rule.re.lastIndex) rule.re.lastIndex += 1;
    }
  }
  return { errors, warnings };
}

/** Files the scan looks at: JS/GLSL entry code, not JSON or prose. */
export const isScannableSourceFile = (rel) => /\.(?:js|mjs|cjs|frag|glsl|vert|jsx|ts)$/i.test(String(rel ?? ''));

/** Scan every scannable file of a source (`[{ path, content }]`). */
export function scanSourceFiles(files, { runtime = null } = {}) {
  const errors = [];
  const warnings = [];
  let scanned = 0;
  for (const file of Array.isArray(files) ? files : []) {
    if (!isRecord(file) || typeof file.content !== 'string') continue;
    if (!isScannableSourceFile(file.path)) continue;
    scanned += 1;
    const result = scanSourceText(file.content, { path: String(file.path), runtime });
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return { errors, warnings, files: scanned };
}

// ---------------------------------------------------------------------------
// Contract check, part 2: parameter probes (§6.3 item 5 — "did the sketch
// really read the manifest parameter, or did it hard-code the number?")
// ---------------------------------------------------------------------------

const COLOR_PROBES = ['#ff00ff', '#00ff00', '#ff8000', '#0040ff'];

function perturbNumber(param, current) {
  const range = Array.isArray(param?.range) && param.range.length >= 2 ? param.range.map(Number) : null;
  const value = Number(current);
  if (range && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0]) {
    const span = range[1] - range[0];
    const candidates = [range[0] + span * 0.83, range[0] + span * 0.17, range[1], range[0]];
    for (const candidate of candidates) if (Math.abs(candidate - value) > span * 0.12) return candidate;
    return range[1];
  }
  if (!Number.isFinite(value)) return 0.5;
  if (value === 0) return 1;
  if (Math.abs(value) < 1) return value > 0.5 ? 0.1 : 0.9;
  return Number((value * 1.7 + 0.3).toFixed(4));
}

/** A value that should visibly change the picture, or undefined when unknowable. */
export function perturbParamValue(param, current) {
  const type = String(param?.type ?? 'number');
  if (type === 'boolean') return !current;
  if (type === 'enum') {
    const options = Array.isArray(param?.options) ? param.options.map((o) => (isRecord(o) ? o.value : o)) : [];
    if (options.length < 2) return undefined;
    const index = options.findIndex((option) => String(option) === String(current));
    return options[(index + 1 + options.length) % options.length];
  }
  if (type === 'color') {
    const text = String(current ?? '').toLowerCase();
    return COLOR_PROBES.find((probe) => probe !== text) || COLOR_PROBES[0];
  }
  if (type === 'string' || type === 'text' || type === 'font') return `${String(current ?? '')}-probe`;
  if (type === 'vec2' || type === 'vec3') {
    const length = type === 'vec2' ? 2 : 3;
    const base = Array.isArray(current) ? current.map(Number) : Array.from({ length }, () => Number(current) || 0);
    return base.map((n, i) => perturbNumber(param, Number.isFinite(n) ? n : i * 0.5));
  }
  if (!NUMERIC_PARAM_TYPES.has(type)) return undefined;
  return perturbNumber(param, current);
}

/**
 * One probe per declared parameter: the value to render with, and how far it
 * is from the base value (used in the failure message).
 */
export function paramProbes(manifest, { params = null } = {}) {
  const declared = Array.isArray(manifest?.params) ? manifest.params.filter(isRecord) : [];
  const base = isRecord(params) ? params : {};
  const probes = [];
  for (const param of declared) {
    const id = String(param.id ?? '');
    if (!id) continue;
    const current = Object.prototype.hasOwnProperty.call(base, id) ? base[id] : param.default;
    if (current === undefined) continue;
    const value = perturbParamValue(param, current);
    if (value === undefined) continue;
    probes.push({ id, type: String(param.type ?? 'number'), from: current, to: value });
  }
  return probes;
}

// ---------------------------------------------------------------------------
// Contract check, part 3: the verdict (§6.3, items 1–5)
// ---------------------------------------------------------------------------

export const CONTRACT_CHECKS = Object.freeze([
  { id: 'static', title: '静态扫描：禁用的 API' },
  { id: 'determinism', title: '同一帧渲染两次，哈希相同' },
  { id: 'alpha', title: '透明通道' },
  { id: 'timing', title: '单帧耗时' },
  { id: 'params', title: 'manifest 参数真的被读取' },
]);

const statusOf = (failed, warned = false) => (failed ? 'fail' : warned ? 'warn' : 'pass');

/**
 * Turn the raw measurements into the five checks. Pure: the CLI feeds it the
 * numbers the RenderWorkerPool returned, and the unit tests feed it fixtures.
 *
 * @param {object} input
 * @param {string} [input.sourceId]
 * @param {string} [input.runtime]
 * @param {object} [input.manifest]
 * @param {{errors?:Array,warnings?:Array}} [input.scan]
 * @param {{frame?:number,hash?:string,hashAgain?:string,same?:boolean}} [input.determinism]
 * @param {{min?:number,max?:number,transparentFraction?:number,opaqueFraction?:number,width?:number,height?:number}} [input.alpha]
 * @param {{ms?:number,budgetMs?:number,frames?:number}} [input.timing]
 * @param {Array<{id:string,changed:boolean,from?:any,to?:any,frame?:number,error?:string}>} [input.params]
 */
export function evaluateContractCheck(input = {}) {
  const scan = isRecord(input.scan) ? input.scan : {};
  const errors = Array.isArray(scan.errors) ? scan.errors : [];
  const warnings = Array.isArray(scan.warnings) ? scan.warnings : [];
  const determinism = isRecord(input.determinism) ? input.determinism : null;
  const alpha = isRecord(input.alpha) ? input.alpha : null;
  const timing = isRecord(input.timing) ? input.timing : null;
  const probes = Array.isArray(input.params) ? input.params : [];
  const manifest = isRecord(input.manifest) ? input.manifest : null;
  const budgetMs = Number.isFinite(Number(timing?.budgetMs)) ? Number(timing.budgetMs) : DEFAULT_FRAME_BUDGET_MS;
  const checks = [];
  const notes = [];

  // 1) static scan
  {
    const status = statusOf(errors.length > 0, warnings.length > 0);
    const detail = errors.length
      ? errors.map((e) => e.message || `${e.file}:${e.line} ${e.name}`).join('；')
      : warnings.length
        ? warnings.map((e) => e.message || `${e.file}:${e.line} ${e.name}`).join('；')
        : `扫描 ${Number(scan.files) || 0} 个文件，没有禁用 API`;
    checks.push({ id: 'static', title: CONTRACT_CHECKS[0].title, status, detail, data: { errors, warnings } });
  }

  // 2) determinism
  if (!determinism) {
    checks.push({ id: 'determinism', title: CONTRACT_CHECKS[1].title, status: 'fail', detail: '没有拿到两次渲染的结果', data: null });
  } else {
    const same = determinism.same === true;
    checks.push({
      id: 'determinism',
      title: CONTRACT_CHECKS[1].title,
      status: statusOf(!same),
      detail: same
        ? `第 ${determinism.frame ?? 0} 帧两次渲染哈希一致：${String(determinism.hash ?? '').slice(0, 16)}`
        : `第 ${determinism.frame ?? 0} 帧两次渲染哈希不同：${String(determinism.hash ?? '').slice(0, 16)} ≠ ${String(determinism.hashAgain ?? '').slice(0, 16)} —— 画面依赖了调用顺序或未固定的状态`,
      data: { frame: determinism.frame ?? 0, hash: determinism.hash ?? null, hashAgain: determinism.hashAgain ?? null },
    });
  }

  // 3) alpha channel
  if (!alpha) {
    checks.push({ id: 'alpha', title: CONTRACT_CHECKS[2].title, status: 'warn', detail: '没有取到像素（需要一次带 rgba 的未命中渲染）', data: null });
  } else {
    const transparent = Number(alpha.transparentFraction);
    const max = Number(alpha.max);
    const min = Number(alpha.min);
    const blank = Number.isFinite(transparent) ? transparent >= 0.999 : max === 0;
    const opaque = Number.isFinite(transparent) ? transparent <= 0.001 : min === 255 && max === 255;
    let status = 'pass';
    let detail = `alpha ${min}..${max}，透明像素 ${(transparent * 100).toFixed(1)}%`;
    if (blank) {
      status = 'fail';
      detail = `画面全透明（${alpha.width || '?'}x${alpha.height || '?'} 上没有可见像素）—— 图层会看不见`;
    } else if (opaque) {
      status = 'warn';
      detail = `没有任何透明像素（alpha 恒为 ${max}）—— 叠加时会整块盖住下面的图层，确认这是你要的`;
      notes.push('透明通道：全不透明，如果是整屏背景可以忽略');
    }
    checks.push({ id: 'alpha', title: CONTRACT_CHECKS[2].title, status, detail, data: alpha });
  }

  // 4) timing
  if (!timing) {
    checks.push({ id: 'timing', title: CONTRACT_CHECKS[3].title, status: 'fail', detail: '没有拿到单帧耗时', data: null });
  } else {
    const ms = Number(timing.ms);
    const frames = Number(timing.frames) > 0 ? Number(timing.frames) : 1;
    const tooSlow = !Number.isFinite(ms) || ms > budgetMs;
    checks.push({
      id: 'timing',
      title: CONTRACT_CHECKS[3].title,
      status: statusOf(tooSlow),
      detail: tooSlow
        ? `单帧 ${Number.isFinite(ms) ? ms.toFixed(1) : '?'} ms，超过预算 ${budgetMs} ms（${frames} 帧取样）`
        : `单帧 ${ms.toFixed(1)} ms（预算 ${budgetMs} ms，${frames} 帧取样）`,
      data: { ms, budgetMs, frames },
    });
  }

  // 5) params really read
  {
    const declared = Array.isArray(manifest?.params) ? manifest.params.filter(isRecord) : [];
    const fmt = (value) => (typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : JSON.stringify(value));
    const where = (probe) => (input.frame != null && probe.frame != null && Number(probe.frame) !== Number(input.frame) ? `（第 ${probe.frame} 帧）` : '');
    if (!declared.length) {
      checks.push({ id: 'params', title: CONTRACT_CHECKS[4].title, status: 'pass', detail: 'manifest 没有声明参数（没有可写死的值）', data: { probes: [] } });
    } else if (!probes.length) {
      checks.push({ id: 'params', title: CONTRACT_CHECKS[4].title, status: 'fail', detail: `声明了 ${declared.length} 个参数但没有探测值（类型不支持？）`, data: { probes: [] } });
    } else {
      const failed = probes.filter((p) => p.changed !== true);
      const details = probes.map((p) => `${p.id}${p.changed === true ? ` ✓${where(p)}` : ' ✗'}`);
      checks.push({
        id: 'params',
        title: CONTRACT_CHECKS[4].title,
        status: statusOf(failed.length > 0),
        detail: failed.length
          ? failed.map((p) => `${p.id} 改成 ${fmt(p.to)} 后画面没有变化${where(p)}（${p.error || '哈希相同'}）—— 参数可能被写死了`).join('；')
          : `改了参数画面就变（${details.join('，')}）`,
        data: { probes },
      });
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.status] += 1;
  return {
    sourceId: input.sourceId ?? null,
    runtime: input.runtime ?? null,
    ok: counts.fail === 0,
    counts,
    checks,
    notes,
  };
}
