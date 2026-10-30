// Source snapshots: reading, validation and the "source overlay / takeover"
// merge of docs/DESIGN-BACKEND-V2.md §7.8 (WP4.2).
//
// A compiled source (`.vdm/sources/<id>/base.json`, §7.8.1) is an array of
// nodes with *absolute* values plus a `t = 0` baseline per path. The editor
// layer (the element in `project.vdm.json`) mirrors that baseline and may add
// its own keyframes / edits on top. This module answers one question for one
// frame: how do the two layers combine into the number the IR draws (§7.8.2)?
//
//   add (default, everything that is not a ratio)
//     number     local + (src(t) - base)
//     otherwise  local !== base ? local : src(t)      ("whoever changed it")
//   mul (default for transform.scale / transform.opacity)
//     number     local * src(t) / base    (|base| < 1e-9 degrades to override)
//     otherwise  same as add (there is no multiplication to do)
//   override
//     anything   local                                (the source is ignored)
//
// "override" means *the editor owns this path*: §7.3 / §7.8.2 ("只听编辑器的，
// 源动画被忽略") and §7.8.3 (a write-back is not attempted, `path-overridden`).
// It is the escape hatch that keeps a user edit from being animated away, and
// the degradation of a zero-base `mul` (same rule as links.js refusing a zero
// `bindParentValue`).
//
// Pure ESM, no DOM and no `node:*`: `core/` never reads `.vdm/`. The caller
// passes the snapshots in (`buildFrameIR`'s `opts.sourceSnapshots`, §7.8.2 /
// §7.8.6 #1) as `{ [sourceId]: snapshot }` or `(sourceId) => snapshot | null`.
//
// Degradation is all-or-nothing per element (§7.8.2, "降级" table): a missing
// snapshot, a snapshot whose `version` / shape is invalid, or a node id that
// the snapshot does not carry means the element is evaluated exactly as if it
// had no `el.source` at all — `fallback: 'editor-layer'` — and nothing here
// throws. A *path* that the node carries neither as a baseline nor as a track
// is left to the editor layer: we never guess a default (that would turn a
// missing 0 into a real 0).
import { SOURCE_SNAPSHOT_VERSION } from './version.js';
import { EASE_NAMES, hasTrack, sampleTrack } from './time.js';
import { compileTrack } from './tracks.js';
import { isRecord } from './json.js';

/**
 * Every property a source layer can drive (§7.8.1, closed set). The order is
 * the table's order, so a caller iterating it produces a stable picture.
 *
 * 4.1's `core/source-map.js` re-exports this name (§7.8.1); it is defined here
 * because the merge and the snapshot validator both need it and core must not
 * grow a second copy.
 */
export const SOURCE_PATHS = Object.freeze([
  'style.text',
  'style.font',
  'style.size',
  'style.weight',
  'style.color',
  'style.align',
  'style.lineHeight',
  'style.letterSpacing',
  'src',
  'transform.x',
  'transform.y',
  'transform.scale',
  'transform.rotation',
  'transform.opacity',
]);

/**
 * Paths whose value is a number and interpolates (§7.8.1 table: "插值 =
 * 数值"). Everything else steps at the key.
 */
export const SOURCE_NUMERIC_PATHS = Object.freeze([
  'style.size',
  'style.weight',
  'style.lineHeight',
  'style.letterSpacing',
  'transform.x',
  'transform.y',
  'transform.scale',
  'transform.rotation',
  'transform.opacity',
]);

/**
 * Default mode per path where it is not `add` (§7.8.2: ratio units use `mul`,
 * exactly like `links.js`'s `LINK_COMBINES` default for `unit: 'ratio'`).
 */
export const SOURCE_DEFAULT_MODES = Object.freeze({
  'transform.scale': 'mul',
  'transform.opacity': 'mul',
});

/**
 * Value of a path that neither `props` nor `tracks` carry — the element
 * defaults of §7.8.1 (identical to `core/schema.js::DEFAULT_STYLE` /
 * `DEFAULT_TRANSFORM`). Only used to fill an editor-layer *local* value the
 * element leaves out; a source node never gets a guessed value.
 */
export const SOURCE_DEFAULTS = Object.freeze({
  'style.text': '',
  'style.font': 'SimHei',
  'style.size': 96,
  'style.weight': 400,
  'style.color': '#ffffff',
  'style.align': 'center',
  'style.lineHeight': 1.18,
  'style.letterSpacing': 0,
  src: '',
  'transform.x': 0,
  'transform.y': 0,
  'transform.scale': 1,
  'transform.rotation': 0,
  'transform.opacity': 1,
});

export const SOURCE_MODES = Object.freeze(['add', 'mul', 'override']);

const NUMERIC = new Set(SOURCE_NUMERIC_PATHS);
const PATHS = new Set(SOURCE_PATHS);

/** true for a `SOURCE_PATHS` member (the closed set of §7.8.1). */
export const isSourcePath = (path) => PATHS.has(String(path));

/** true when the path interpolates numbers (§7.8.1 "数值"). */
export const isNumericSourcePath = (path) => NUMERIC.has(String(path));

/** Default `sourceMode` for a path: `mul` for ratios, `add` otherwise. */
export const defaultSourceMode = (path) => SOURCE_DEFAULT_MODES[String(path)] || 'add';

/** Element id rule of §7.8.1 nodes (`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`). */
export const isSourceNodeId = (id) => typeof id === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(id);

// The source-id rule lives with the other source helpers (§7.8.1 points at
// `core/code-layer.js::isSafeSourceId`); re-exported so a caller of this module
// does not need to import two files to validate an `el.source`.
export { isSafeSourceId } from './code-layer.js';

/** Snapshot node types (§7.8.1: no video / audio / camfeed / code). */
export const SOURCE_NODE_TYPES = Object.freeze(['text', 'solid', 'shape', 'image']);

const NODE_KEYS = new Set(['id', 'type', 'parent', 'props', 'tracks']);
const SNAPSHOT_KEYS = new Set(['version', 'source', 'compiler', 'builtAt', 'hash', 'nodes']);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6 + 0; // `-0` is not JSON

const isNum = (v) => Number.isFinite(Number(v));

/**
 * §7.8.1 normalisation for "are these two values the same": numbers compare
 * rounded to 6 decimals with `-0` folded into `0`, arrays keep their order,
 * object keys are sorted. Strings / booleans compare by value. This is the
 * same rule the snapshot hash uses, so "the editor changed it" cannot disagree
 * with "the source changed it" on a rounding difference.
 */
export function sameSourceValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') {
    return isNum(a) && isNum(b) && r6(a) === r6(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameSourceValue(v, b[i]));
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => sameSourceValue(a[k], b[k]));
  }
  return a === b;
}

/**
 * `props` / track value valid for a path: the §7.8.1 table types it — a finite
 * number for a numeric path, a string for everything else (`style.text`,
 * `style.font`, `style.color`, `style.align`, `src`). No boolean: no path of
 * the frozen table is one.
 */
function pathValueOk(path, value) {
  if (NUMERIC.has(path)) return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'string';
}

function numberOk(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Problems with one snapshot node (§7.8.1 "节点记录"). Returns [] when valid. */
function nodeProblems(node, index) {
  const at = `nodes[${index}]`;
  const out = [];
  if (!isRecord(node)) return [`${at} must be an object`];
  for (const key of Object.keys(node)) if (!NODE_KEYS.has(key)) out.push(`${at}.${key} is not part of a snapshot node`);
  if (!isSourceNodeId(node.id)) out.push(`${at}.id must match ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`);
  if (!SOURCE_NODE_TYPES.includes(node.type)) out.push(`${at}.type must be one of ${SOURCE_NODE_TYPES.join(', ')}`);
  if (node.parent !== undefined && node.parent !== null && !isSourceNodeId(node.parent)) {
    out.push(`${at}.parent must be a node id or null`);
  }
  if (!isRecord(node.props)) {
    out.push(`${at}.props must be an object`);
  } else {
    for (const [path, value] of Object.entries(node.props)) {
      if (!PATHS.has(path)) out.push(`${at}.props.${path} is not a source path`);
      else if (!pathValueOk(path, value)) out.push(`${at}.props.${path} has the wrong value type`);
    }
  }
  const tracks = node.tracks === undefined ? [] : node.tracks;
  if (!Array.isArray(tracks)) {
    out.push(`${at}.tracks must be an array`);
    return out;
  }
  const seen = new Set();
  let lastPath = null;
  let lastT = -Infinity;
  for (let i = 0; i < tracks.length; i++) {
    const key = tracks[i];
    const loc = `${at}.tracks[${i}]`;
    if (!isRecord(key)) { out.push(`${loc} must be an object`); continue; }
    if (!PATHS.has(key.path)) { out.push(`${loc}.path is not a source path`); continue; }
    if (!numberOk(key.t) || key.t < 0) out.push(`${loc}.t must be a finite number >= 0`);
    if (!pathValueOk(key.path, key.value)) out.push(`${loc}.value has the wrong value type`);
    // A track without a baseline would make `add` / `mul` undo the source's
    // own animation (§7.8.1: "有轨道没有基线 = 快照非法").
    if (!isRecord(node.props) || !Object.hasOwn(node.props, key.path)) {
      out.push(`${loc}.path has no baseline in props`);
    }
    if (key.ease !== undefined && (typeof key.ease !== 'string' || !EASE_NAMES.includes(key.ease))) {
      out.push(`${loc}.ease must be one of ${EASE_NAMES.join(', ')}`);
    }
    if (key.curve !== undefined) {
      const curve = key.curve;
      if (!Array.isArray(curve) || curve.length < 2 || !curve.every((p) => Array.isArray(p) && p.length >= 2
        && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))) {
        out.push(`${loc}.curve must be an array of [u, v] pairs`);
      }
    }
    // Array is sorted by `(path, t)` and one key per `(path, t)` (§7.8.1).
    const t = numberOk(key.t) ? key.t : 0;
    const id = `${key.path}@${t}`;
    if (seen.has(id)) out.push(`${loc} duplicates ${id}`);
    seen.add(id);
    const path = String(key.path);
    if (lastPath !== null && (path < lastPath || (path === lastPath && t < lastT))) {
      out.push(`${loc} is out of (path, t) order`);
    }
    lastPath = path;
    lastT = t;
  }
  return out;
}

/** Problems with a whole snapshot (§7.8.1 file header + `nodes`). [] when valid. */
export function snapshotProblems(input) {
  if (!isRecord(input)) return ['snapshot must be an object'];
  const out = [];
  for (const key of Object.keys(input)) if (!SNAPSHOT_KEYS.has(key)) out.push(`${key} is not part of a snapshot`);
  if (input.version !== SOURCE_SNAPSHOT_VERSION) {
    out.push(`version must be ${SOURCE_SNAPSHOT_VERSION} (got ${JSON.stringify(input.version)})`);
  }
  if (typeof input.source !== 'string' || !SOURCE_ID_RE.test(input.source)) {
    out.push('source must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}');
  }
  if (!isRecord(input.compiler)) {
    out.push('compiler must be an object');
  } else {
    for (const name of ['name', 'version', 'runtime', 'entry']) {
      if (input.compiler[name] !== undefined && typeof input.compiler[name] !== 'string' && typeof input.compiler[name] !== 'number') {
        out.push(`compiler.${name} must be a string or number`);
      }
    }
  }
  if (typeof input.builtAt !== 'string' || !input.builtAt) out.push('builtAt must be a nonempty ISO 8601 string');
  if (typeof input.hash !== 'string' || !HASH_RE.test(input.hash)) out.push('hash must be sha256:<64 lowercase hex>');
  if (!Array.isArray(input.nodes)) {
    out.push('nodes must be an array');
    return out;
  }
  const ids = new Set();
  for (let i = 0; i < input.nodes.length; i++) {
    out.push(...nodeProblems(input.nodes[i], i));
    const id = isRecord(input.nodes[i]) ? input.nodes[i].id : null;
    if (isSourceNodeId(id)) {
      if (ids.has(id)) out.push(`nodes[${i}].id ${id} is duplicated`);
      ids.add(id);
    }
  }
  return out;
}

/**
 * Validate a snapshot and turn it into the normalised form this module (and
 * the IR) reads. Anything else — a newer version, a broken `nodes` array, a
 * path outside `SOURCE_PATHS`, a wrong value type — returns `null`, and the
 * caller degrades the element to `editor-layer` (§7.8.1 "版本与降级").
 *
 * The returned record is a copy: the caller's snapshot is never mutated, and
 * `tracks` are already compiled for `sampleTrack` (one sort per path, cached
 * by object identity, so a per-frame build does not re-sort).
 */
export function normalizeSnapshot(input) {
  if (snapshotProblems(input).length) return null;
  const nodes = new Array(input.nodes.length);
  const byId = new Map();
  for (let i = 0; i < input.nodes.length; i++) {
    const src = input.nodes[i];
    const props = {};
    for (const [path, value] of Object.entries(src.props)) props[path] = value;
    const tracks = (src.tracks || []).map((key) => {
      const out = { t: key.t, path: key.path, value: key.value };
      if (key.ease !== undefined) out.ease = key.ease;
      if (key.curve !== undefined) out.curve = key.curve.map((p) => [Number(p[0]), Number(p[1])]);
      return out;
    });
    compileTrack(tracks, 'element');
    const node = {
      id: src.id,
      type: src.type,
      parent: src.parent ?? null,
      props,
      tracks,
    };
    nodes[i] = node;
    byId.set(node.id, node);
  }
  const snapshot = {
    version: input.version,
    source: input.source,
    compiler: { ...input.compiler },
    builtAt: input.builtAt,
    hash: input.hash,
    nodes,
  };
  // The node index is an implementation detail: non-enumerable so the record
  // still looks (and JSON-round-trips) like the snapshot that came in.
  Object.defineProperty(snapshot, 'byId', { value: byId, enumerable: false });
  return snapshot;
}

// Snapshots are immutable by contract (the hash covers the payload) and a
// per-frame build asks for the same one over and over. Key the validation on
// the caller's object + a cheap fingerprint, so a caller that replaces the
// snapshot (a recompile) gets a new record and the old frames fall out of the
// IRCache through the hash in its key.
const normalized = new WeakMap();

const fingerprintOf = (input) => `${input.version}|${input.source}|${input.hash}|${Array.isArray(input.nodes) ? input.nodes.length : -1}`;

/**
 * The *raw* snapshot for a source id, or `null` (§7.8.2 `opts.sourceSnapshots`).
 *
 * Two shapes are accepted, exactly as the frozen record says:
 *
 *   * `{ [sourceId]: snapshot }` — a plain map;
 *   * `(sourceId) => snapshot | null` — a resolver, for a caller that loads
 *     `.vdm/sources/<id>/base.json` lazily (core still never reads a file).
 *
 * Unvalidated on purpose: `buildFrameIR` resolves every id it needs once per
 * frame (for the cache key) and hands the same raw object to `cachedSnapshot`
 * per element. A resolver that throws reads as "no snapshot" — a broken load
 * must degrade the element, not break the frame.
 */
export function rawSnapshotFor(snapshots, id) {
  if (!snapshots || typeof id !== 'string' || !id) return null;
  if (typeof snapshots === 'function') {
    try {
      return snapshots(id) ?? null;
    } catch {
      return null;
    }
  }
  if (isRecord(snapshots)) return Object.hasOwn(snapshots, id) ? snapshots[id] : null;
  return null;
}

/** The snapshot for a source id, validated (§7.8.1), or `null`. */
export function snapshotFor(snapshots, id) {
  return normalizeSnapshot(rawSnapshotFor(snapshots, id));
}

/**
 * The normalised snapshot without re-validating an unchanged one. Same inputs
 * as `normalizeSnapshot`; `null` stays `null`.
 */
export function cachedSnapshot(input) {
  if (!isRecord(input)) return null;
  const stamp = fingerprintOf(input);
  const hit = normalized.get(input);
  if (hit && hit.stamp === stamp) return hit.snapshot;
  const snapshot = normalizeSnapshot(input);
  normalized.set(input, { stamp, snapshot });
  return snapshot;
}

/**
 * The `hash` of a raw snapshot for the `IRCache` key (§7.8.2: "快照的 hash 进入
 * IRCache 的键（按 source id 排序拼接）"). Reads the raw header — a key only has
 * to change when the snapshot changes, and a snapshot without a usable hash
 * keys like a missing one (`-`).
 */
export const snapshotHashOf = (raw) => (isRecord(raw) && typeof raw.hash === 'string' && raw.hash ? raw.hash : '-');

/**
 * Sorted source ids the project's elements reference (§7.8.2: the cache key
 * concatenates them "按 source id 排序"). Only `el.source.id` counts: an
 * element without one never enters the source logic at all.
 */
export function sourceSnapshotIds(elements) {
  const ids = new Set();
  for (const el of Array.isArray(elements) ? elements : []) {
    const id = el && el.source ? el.source.id : null;
    if (typeof id === 'string' && id) ids.add(id);
  }
  return [...ids].sort();
}

/** One node of a normalised snapshot, or `null`. */
export function sourceNodeAt(snapshot, nodeId) {
  if (!snapshot || typeof nodeId !== 'string' || !nodeId) return null;
  if (snapshot.byId) return snapshot.byId.get(nodeId) || null;
  return (snapshot.nodes || []).find((node) => node.id === nodeId) || null;
}

/**
 * The source value of one path at `t` (§7.8.1): the `t = 0` baseline from
 * `props[path]`, overwritten by the node's own animation. `tracks` has the
 * exact shape of `el.keyframes`, so this is `sampleTrack` and nothing else —
 * a path with no track is the baseline, a track clamps before its first key
 * and after its last.
 *
 * Returns `undefined` when the node does not exist or carries neither a
 * baseline nor a track for `path`. The merge treats that as "the source has
 * nothing to say" and leaves the editor layer alone (§7.8.2 fallback table:
 * 不猜默认值).
 */
export function sourceValueAt(snapshot, nodeId, path, t) {
  const node = sourceNodeAt(snapshot, nodeId);
  if (!node) return undefined;
  const key = String(path);
  const base = Object.hasOwn(node.props, key) ? node.props[key] : undefined;
  const tracks = Array.isArray(node.tracks) ? node.tracks : [];
  // Neither `props` nor `tracks`: the source has nothing to say about this
  // path, and we do not guess a default (§7.8.2 fallback table).
  if (base === undefined && !hasTrack(tracks, key)) return undefined;
  // `sampleTrack` defaults a missing 4th argument to `null`, so pass the
  // baseline explicitly: `undefined` must stay "no baseline", never "0".
  const value = sampleTrack(tracks, key, Number(t) || 0, base === undefined ? null : base);
  if (value === null || value === undefined) return undefined;
  return NUMERIC.has(key) ? Number(value) : value;
}

/** The `t = 0` baseline of a path, or `undefined` (§7.8.1 `props[path]`). */
export function sourceBaseAt(snapshot, nodeId, path) {
  const node = sourceNodeAt(snapshot, nodeId);
  if (!node) return undefined;
  return Object.hasOwn(node.props, path) ? node.props[path] : undefined;
}

/**
 * Editor-layer value of a path, from `core/evaluate.js::evalElement`'s result
 * (`st`) plus the element's own style / src. Kept here so the merge cannot
 * drift from the IR: every path §7.8.1 allows maps to exactly one field.
 */
export function editorValueOf(el, st, path) {
  const style = el?.style || {};
  const d = SOURCE_DEFAULTS;
  switch (path) {
    case 'style.text': return st?.text ?? style.text ?? d['style.text'];
    case 'style.font': return style.font ?? d['style.font'];
    case 'style.size': return Number(st?.size ?? style.size ?? d['style.size']);
    case 'style.weight': return Number(style.weight ?? d['style.weight']);
    case 'style.color': return st?.color ?? style.color ?? d['style.color'];
    case 'style.align': return style.align ?? d['style.align'];
    case 'style.lineHeight': return Number(style.lineHeight ?? d['style.lineHeight']);
    case 'style.letterSpacing': return Number(style.letterSpacing ?? d['style.letterSpacing']);
    case 'src': return el?.src ?? d.src;
    case 'transform.x': return Number(st?.x ?? d['transform.x']);
    case 'transform.y': return Number(st?.y ?? d['transform.y']);
    case 'transform.scale': return Number(st?.scale ?? d['transform.scale']);
    case 'transform.rotation': return Number(st?.rotation ?? d['transform.rotation']);
    case 'transform.opacity': return Number(st?.opacity ?? d['transform.opacity']);
    default: return undefined;
  }
}

/**
 * The mode an element uses for `path` (§7.8.2): `el.sourceMode[path]` when it
 * is one of the three values, the unit default otherwise. Normalisation drops
 * illegal entries; a hand-built project that skipped it still cannot smuggle
 * a fourth value in here.
 */
export function sourceModeOf(el, path) {
  const raw = el?.sourceMode;
  const mode = isRecord(raw) && Object.hasOwn(raw, path) ? raw[path] : null;
  return SOURCE_MODES.includes(mode) ? mode : defaultSourceMode(path);
}

/**
 * Steps 2 and 3 of §7.8.2 for one element: sample the source node at `t` and
 * merge it into the editor-layer values. `st` is `evalElement`'s result, which
 * already carries step 1 (defaults + keyframes) and step 4 (links); `add` and
 * `mul` are commutative, so applying them here is the frozen order (§7.8.2
 * "实现上可以在 evalElement 之后施加").
 *
 * Returns `null` when the element must degrade to `editor-layer` — no
 * snapshot, an invalid one, or no node with `el.source.node` — and otherwise
 * `{ node, values }` with one entry per path the node actually carries:
 *
 *   * `values[path] = { local, value, mode, base, src }` — the editor-layer
 *     input, the merged value and the numbers they came from, so a caller can
 *     apply the merge per representation (§7.8.2 "表示无关": px → metres, y up,
 *     uniform scale) and a test can see the formula's inputs;
 *   * paths the node does not carry are absent, so the caller keeps the
 *     editor value (the fallback table's "按 override / 不猜默认值").
 *
 * This function never throws and never mutates `el` / `st`.
 */
export function sourceMerge(el, snapshot, t, st) {
  const nodeId = el?.source?.node;
  const node = sourceNodeAt(snapshot, nodeId);
  if (!node) return null;
  const values = {};
  for (const path of SOURCE_PATHS) {
    const base = sourceBaseAt(snapshot, nodeId, path);
    const src = sourceValueAt(snapshot, nodeId, path, t);
    // Neither `props` nor `tracks`: leave it to the editor layer.
    if (base === undefined && src === undefined) continue;
    const local = editorValueOf(el, st, path);
    const mode = sourceModeOf(el, path);
    let value;
    if (mode === 'override') {
      value = local;
    } else if (!NUMERIC.has(path)) {
      // Non-numeric `add`/`mul`: whoever changed it wins, compared with the
      // §7.8.1 normalisation.
      value = sameSourceValue(local, base) ? src : local;
    } else {
      const l = Number(local);
      const b = Number(base);
      const s = Number(src);
      if (!Number.isFinite(l)) {
        value = local;
      } else if (!Number.isFinite(b) || !Number.isFinite(s)) {
        // A baseline the snapshot does not carry / a broken value: no delta to
        // apply, so the editor layer keeps the path (same as `override`).
        value = l;
      } else if (mode === 'mul') {
        // Zero baseline degrades to override (§7.8.2 / §7.8.6 #5, the same
        // rule links.js applies to a zero `bindParentValue`), and override
        // leaves the editor value alone.
        value = Math.abs(b) < 1e-9 ? l : (l * s) / b;
      } else {
        value = l + (s - b);
      }
      // §7.8.2: opacity is clamped to 0..1 again after the merge.
      if (path === 'transform.opacity') value = clamp01(value);
    }
    values[path] = { local, value, mode, base, src };
  }
  return { node, values };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The `st` field each merged path overwrites (`core/evaluate.js::evalElement`'s
 * result). Only paths `evalElement` actually evaluates appear here; the rest of
 * the merged values are read by the IR from the style / `src` helpers below.
 */
export const SOURCE_ST_FIELDS = Object.freeze({
  'transform.x': 'x',
  'transform.y': 'y',
  'transform.scale': 'scale',
  'transform.rotation': 'rotation',
  'transform.opacity': 'opacity',
  'style.size': 'size',
  'style.text': 'text',
  'style.color': 'color',
});

/**
 * Write a `sourceMerge` record into `evalElement`'s result — step 3 of §7.8.2
 * applied in place (§7.8.2: add / mul commute with everything `evalElement`
 * already did, so applying them here is the frozen order).
 *
 * Returns `st` for chaining. Paths the node does not carry are untouched, so
 * an element whose source is missing keeps the editor-layer picture exactly.
 */
export function applySourceToSt(st, values) {
  if (!st || !values) return st;
  for (const [path, field] of Object.entries(SOURCE_ST_FIELDS)) {
    const hit = values[path];
    if (hit) st[field] = hit.value;
  }
  return st;
}

/**
 * The style paths `core/frame-ir.js` reads straight off `el.style` instead of
 * `st` (font / weight / align / lineHeight / letterSpacing), as a patch in
 * `el.style`'s own key names. An empty record means "keep the editor style".
 */
export function sourceStyleValues(values) {
  const out = {};
  if (!values) return out;
  const pairs = [
    ['style.font', 'font'],
    ['style.weight', 'weight'],
    ['style.align', 'align'],
    ['style.lineHeight', 'lineHeight'],
    ['style.letterSpacing', 'letterSpacing'],
  ];
  for (const [path, key] of pairs) {
    const hit = values[path];
    if (hit) out[key] = hit.value;
  }
  return out;
}

/** Merged `src` for an image / video element, or `undefined`. */
export const sourceSrcValue = (values) => (values && values.src ? values.src.value : undefined);

/**
 * The delta a `sourceMerge` record means for a node-represented plane (§7.8.2
 * "表示无关"): translation and rotation differences in project pixels / degrees,
 * `scale` as a multiplier. `null` when the record carries nothing spatial.
 *
 * A legacy element draws the merged values through `st`; an element placed by
 * `el.node` (or a spatial parent) never reads `st.x` / `st.scale`, so the IR
 * passes this to `pixelMatrixOf` instead. Only the *delta* is representation
 * dependent — `add` contributes `src - base` and `mul` the ratio `src / base`
 * — which is why the same record serves both paths.
 */
export function sourceNodeDelta(values) {
  if (!values) return null;
  let moved = false;
  const diff = (path) => {
    const hit = values[path];
    if (!hit) return 0;
    const value = Number(hit.value);
    const local = Number(hit.local);
    if (!Number.isFinite(value) || !Number.isFinite(local)) return 0;
    moved = true;
    return value - local;
  };
  const x = diff('transform.x');
  const y = diff('transform.y');
  const rotation = diff('transform.rotation');
  let scale = 1;
  const scaleHit = values['transform.scale'];
  if (scaleHit) {
    const local = Number(scaleHit.local);
    const value = Number(scaleHit.value);
    // A local scale of 0 has no ratio to apply; the merged value is 0 anyway
    // and the legacy path draws it collapsed.
    if (Number.isFinite(local) && Number.isFinite(value) && Math.abs(local) > 1e-12) {
      scale = value / local;
      moved = true;
    }
  }
  if (!moved || (x === 0 && y === 0 && rotation === 0 && scale === 1)) return null;
  return { x, y, rotation, scale };
}
