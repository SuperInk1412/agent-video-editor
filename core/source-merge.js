// Three-way merge of source snapshots — docs/DESIGN-BACKEND-V2.md §7.8.4
// (WP4.4). Pure, synchronous, no IO: the caller reads `base.json`, turns the
// editor layer into a snapshot shape and passes the freshly compiled snapshot;
// this module says what the merged snapshot is and which decisions a human has
// to make. It never decides a conflict, never writes a file and never touches
// `el.sourceMode`.
//
//   base    the last compile (`.vdm/sources/<id>/base.json`)
//   ours    the editor layer (bound elements exported as a snapshot shape)
//   theirs  the new compile
//
// Per `(nodeId, path)` (§7.8.4 table; a path covers `props` + `tracks`, and a
// path that carries tracks is compared as the whole key array, never per key):
//
//   a a b   -> b                    the source moved, the editor did not
//   a c a   -> c                    the editor moved, the source did not
//   a c b   -> b + `both-changed`   both moved differently
//
// Node-level rows (`path: null`, value = `{ type, props, tracks }`):
//
//   node in base, gone in theirs, editor changed it  -> drop + `node-deleted`
//   node in base, gone in theirs, editor did not     -> drop
//   no node in base, already an element in ours      -> keep ours + `node-collision`
//   `type` changed (base ≠ theirs)                   -> whole node from theirs
//                                                     (+ `type-changed` when the
//                                                     editor changed the node)
//
// The editor layer never mirrors source *tracks* (§7.8.1: `sourceApply` writes
// the baseline, the animation lives in `base.json`). A path whose base value is
// a track array therefore reads "unchanged" when `ours` only carries the same
// scalar as `base.props[path]` — otherwise every animated path would look like
// an editor edit on the next merge. A path `base` does not carry has no
// baseline to compare against, so it is a pure source-side fact: `theirs` wins
// without a conflict (§7.8.2 "不猜默认值").
//
// Invalid input — an unknown node key, a path outside `SOURCE_PATHS`, a wrong
// value type, a newer `version`, a track without a baseline — makes the whole
// merge invalid (`result: null`) instead of half-parsing (§7.8.1 版本与降级).
//
// The result is `{ version, source, nodes, hash }`: legal as a snapshot payload
// and directly writable as the new `base.json` (the caller stamps `compiler` /
// `builtAt`, §7.8.4). `hash` follows the §7.8.1 hash recipe. That recipe needs
// SHA-256 and core cannot `import node:crypto`, so the digest lives here (pure
// JS, `TextEncoder`, browser + Node); `application/source-service.js` re-uses
// this implementation instead of keeping a second one.
import { SOURCE_SNAPSHOT_VERSION } from './version.js';
import {
  SOURCE_PATHS,
  SOURCE_NODE_TYPES,
  editorValueOf,
  isNumericSourcePath,
  isSourceNodeId,
  isSourcePath,
  sameSourceValue,
  snapshotProblems,
} from './source-eval.js';
import { isRecord } from './json.js';
import { EASE_NAMES } from './time.js';

/** `kind` is a closed set (§7.8.4); a new value is a spec version bump. */
export const MERGE_CONFLICT_KINDS = Object.freeze([
  'both-changed',
  'node-deleted',
  'node-collision',
  'type-changed',
]);

/** A snapshot's `source` id (same rule as §7.8.1 / `isSafeSourceId`). */
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Fixed header of the pseudo snapshot used to validate `nodes` only. */
const SYNTHETIC_HEADER = Object.freeze({
  version: SOURCE_SNAPSHOT_VERSION,
  source: 'x',
  compiler: {},
  builtAt: '1970-01-01T00:00:00.000Z',
  hash: `sha256:${'0'.repeat(64)}`,
});
const NUMERIC = new Set(SOURCE_PATHS.filter(isNumericSourcePath));

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const cloneValue = (value) => (Array.isArray(value) ? value.map((v) => ({ ...v })) : value);
const cloneKey = (key) => {
  const out = { t: key.t, path: key.path, value: key.value };
  if (key.ease !== undefined) out.ease = key.ease;
  if (key.curve !== undefined) out.curve = key.curve.map((pair) => [Number(pair[0]), Number(pair[1])]);
  return out;
};
const cloneNode = (node) => {
  const out = { id: node.id, type: node.type, props: { ...node.props }, tracks: (node.tracks || []).map(cloneKey) };
  if (Object.hasOwn(node, 'parent')) out.parent = node.parent ?? null;
  return out;
};

// ---------------------------------------------------------------------------
// §7.8.1 hashing (canonical JSON + sha256)
// ---------------------------------------------------------------------------

const r6 = (value) => Math.round(Number(value) * 1e6) / 1e6 + 0; // `-0` is not JSON

/**
 * §7.8.1 canonicalisation: object keys sorted recursively, arrays keep their
 * order, numbers rounded to 6 decimals with `-0` folded into `0`, no spaces.
 * Exported so `application/source-service.js` keeps one implementation.
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
export const hashPayload = ({ version, source, nodes }) => ({ version, source, nodes });

/** `sha256:<64 lowercase hex>` over the canonical payload (§7.8.1). */
export function snapshotHash(payload) {
  return `sha256:${sha256Hex(canonicalJson(hashPayload(payload)))}`;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 of a UTF-8 string, hex. Pure JS so `core/` needs no `node:crypto`. */
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4; let f = h5; let g = h6; let h = h7;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/**
 * Validate a `{ nodes }` input and index it by id. Header fields beyond
 * `version` / `source` are ignored (§7.8.4), node records are held to §7.8.1 —
 * anything else is `null` and the caller reports an invalid merge.
 */
function sideOf(input) {
  if (!isRecord(input)) return null;
  if (input.version !== undefined && input.version !== SOURCE_SNAPSHOT_VERSION) return null;
  if (input.source !== undefined && (typeof input.source !== 'string' || !SOURCE_ID_RE.test(input.source))) return null;
  const nodes = input.nodes;
  if (!Array.isArray(nodes)) return null;
  if (snapshotProblems({ ...SYNTHETIC_HEADER, nodes }).length) return null;
  const byId = new Map();
  for (const node of nodes) {
    // Duplicate ids are caught by `snapshotProblems`; sort below keeps the
    // result deterministic regardless of the input order (§7.8.1: by id).
    byId.set(node.id, cloneNode(node));
  }
  const sorted = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = new Map(sorted.map((node) => [node.id, indexNode(node)]));
  return { source: input.source ?? null, nodes: sorted, byId: index };
}

/** A node pre-indexed by track path so one merge does not rescan the array. */
function indexNode(node) {
  const tracks = new Map();
  for (const key of node.tracks) {
    if (!tracks.has(key.path)) tracks.set(key.path, []);
    tracks.get(key.path).push(key);
  }
  return { node, props: node.props, tracks };
}

/** Paths a node carries, either as a baseline or as a track (§7.8.1). */
function nodePaths(node) {
  const out = new Set();
  for (const path of Object.keys(node.props || {})) if (isSourcePath(path)) out.add(path);
  for (const key of node.tracks || []) if (isSourcePath(key.path)) out.add(key.path);
  return out;
}

/**
 * The merge value of one path: the whole key array when the node carries a
 * track for it, otherwise the `props` scalar. `undefined` = the node has
 * nothing to say about this path.
 */
function pathValue(index, path) {
  if (!index) return undefined;
  const keys = index.tracks.get(path);
  if (keys && keys.length) return keys;
  return Object.hasOwn(index.props, path) ? index.props[path] : undefined;
}

/** Does the editor layer carry the same value the source had? (§7.8.4 rows.) */
function editorUnchanged(baseIndex, oursIndex, path) {
  const ours = pathValue(oursIndex, path);
  // An `ours` snapshot that does not carry the path = the editor never held it.
  if (ours === undefined) return true;
  const base = pathValue(baseIndex, path);
  if (base === undefined) return true;
  // The editor mirrors the baseline but not the source's tracks (§7.8.1):
  // a scalar equal to `base.props[path]` means "the editor did not animate or
  // move this path", not "the editor deleted the whole track".
  if (Array.isArray(base) && !Array.isArray(ours)) {
    return sameSourceValue(ours, baseIndex.props[path]);
  }
  return sameSourceValue(base, ours);
}

/** Did the editor change anything the base node said? (node-level conflicts) */
function nodeChanged(baseIndex, oursIndex) {
  for (const path of nodePaths(baseIndex.node)) {
    if (!editorUnchanged(baseIndex, oursIndex, path)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

const summaryOf = (index) => (index
  ? {
    type: index.node.type,
    props: { ...index.props },
    tracks: (index.node.tracks || []).map(cloneKey),
  }
  : null);

const valueOrNull = (value) => (value === undefined ? null : cloneValue(value));

function nodeConflict(baseIndex, oursIndex, theirsIndex, kind) {
  return {
    nodeId: (theirsIndex || oursIndex || baseIndex).node.id,
    path: null,
    base: summaryOf(baseIndex),
    ours: summaryOf(oursIndex),
    theirs: summaryOf(theirsIndex),
    kind,
  };
}

function pathConflict(baseIndex, oursIndex, theirsIndex, path, base, ours, theirs) {
  return {
    nodeId: baseIndex.node.id,
    path,
    base: valueOrNull(base),
    ours: valueOrNull(ours),
    theirs: valueOrNull(theirs),
    kind: 'both-changed',
  };
}

// ---------------------------------------------------------------------------
// Node merge
// ---------------------------------------------------------------------------

/** One node's merged record + conflicts (§7.8.4 node-level rows). */
function mergeNode(baseIndex, oursIndex, theirsIndex) {
  const base = baseIndex?.node || null;
  const ours = oursIndex?.node || null;
  const theirs = theirsIndex?.node || null;

  // The source dropped the node.
  if (base && !theirs) {
    if (oursIndex && nodeChanged(baseIndex, oursIndex)) {
      return { node: null, conflicts: [nodeConflict(baseIndex, oursIndex, null, 'node-deleted')] };
    }
    return { node: null, conflicts: [] };
  }

  // The source did not have the node before.
  if (!base) {
    // No new source fact either: an editor-only element is not part of a
    // snapshot (§7.8.2: paths the source does not carry stay in the editor).
    if (!theirs) return { node: null, conflicts: [] };
    // The source now claims an id the editor already has: the editor keeps it.
    if (oursIndex) {
      return { node: cloneNode(ours), conflicts: [nodeConflict(null, oursIndex, theirsIndex, 'node-collision')] };
    }
    return { node: cloneNode(theirs), conflicts: [] };
  }

  // The editor deleted its element: nothing there to lose, source facts stand
  // (§7.8.4: "ours 缺节点 = 用户删了元素").
  if (!ours) return { node: cloneNode(theirs), conflicts: [] };

  // A type change is a whole-node fact; `ours.type` never decides it (§7.8.4).
  if (base.type !== theirs.type) {
    const changed = nodeChanged(baseIndex, oursIndex);
    return {
      node: cloneNode(theirs),
      conflicts: changed ? [nodeConflict(baseIndex, oursIndex, theirsIndex, 'type-changed')] : [],
    };
  }

  return mergePaths(baseIndex, oursIndex, theirsIndex);
}

/** Per-path three-way merge for a node whose type did not change. */
function mergePaths(baseIndex, oursIndex, theirsIndex) {
  const base = baseIndex.node;
  const theirs = theirsIndex.node;
  const paths = [...new Set([...nodePaths(base), ...nodePaths(theirs)])].sort();
  const node = { id: base.id, type: theirs.type, props: {}, tracks: [] };
  // `parent` is theirs' fact when it carries one (§7.8.1: optional, UI/merge
  // hint only; it is not a merged path).
  if (Object.hasOwn(theirs, 'parent')) node.parent = theirs.parent ?? null;
  const conflicts = [];
  for (const path of paths) {
    const baseValue = pathValue(baseIndex, path);
    const theirsValue = pathValue(theirsIndex, path);
    const oursValue = pathValue(oursIndex, path);
    const oursSame = editorUnchanged(baseIndex, oursIndex, path);
    let picked = theirsIndex;
    if (baseValue === undefined) {
      // No baseline: the source's new fact stands, nothing to compare.
      picked = theirsIndex;
    } else if (oursSame) {
      picked = theirsIndex;
    } else if (sameSourceValue(baseValue, theirsValue)) {
      picked = oursIndex;
    } else if (oursValue !== undefined && theirsValue !== undefined && sameSourceValue(oursValue, theirsValue)) {
      // Both sides made the same edit: no decision to make.
      picked = theirsIndex;
    } else {
      // `a c b`: both changed differently. `theirs` is the provisional value
      // (§7.8.4: "冲突暂取 theirs，由人决定") and the record carries all three.
      conflicts.push(pathConflict(baseIndex, oursIndex, theirsIndex, path, baseValue, oursValue, theirsValue));
      picked = theirsIndex;
    }
    const value = picked === oursIndex ? oursValue : theirsValue;
    if (value === undefined) continue; // the winning side dropped the path
    if (Array.isArray(value)) {
      // A track is one value; its baseline comes from the same side (§7.8.1:
      // a track without a baseline is not a legal snapshot).
      node.props[path] = picked.props[path];
      for (const key of value) node.tracks.push(cloneKey(key));
    } else {
      node.props[path] = value;
    }
  }
  return { node, conflicts };
}

// ---------------------------------------------------------------------------
// Public: merge
// ---------------------------------------------------------------------------

/**
 * §7.8.4 three-way merge. Pure: does not mutate `base` / `ours` / `theirs`,
 * writes nothing, decides nothing.
 *
 * @returns `{ result, conflicts }`; `result` is `{ version, source, nodes, hash }`
 *   (a writable snapshot payload) or `null` when any input is not a legal §7.8.1
 *   snapshot or the three inputs do not belong to one source. Conflicts are
 *   exactly `{ nodeId, path, base, ours, theirs, kind }` — `path: null` for
 *   node-level kinds, values are node summaries `{ type, props, tracks }`.
 */
export function merge(base, ours, theirs) {
  const baseSide = sideOf(base);
  const oursSide = sideOf(ours);
  const theirsSide = sideOf(theirs);
  if (!baseSide || !oursSide || !theirsSide) return { result: null, conflicts: [] };
  const sources = new Set([baseSide.source, oursSide.source, theirsSide.source].filter(Boolean));
  if (sources.size > 1) return { result: null, conflicts: [] };
  const source = [...sources][0] ?? null;
  if (!source || !SOURCE_ID_RE.test(source)) return { result: null, conflicts: [] };

  const ids = [...new Set([...baseSide.byId.keys(), ...oursSide.byId.keys(), ...theirsSide.byId.keys()])].sort();
  const nodes = [];
  const conflicts = [];
  for (const id of ids) {
    const merged = mergeNode(baseSide.byId.get(id) || null, oursSide.byId.get(id) || null, theirsSide.byId.get(id) || null);
    if (merged.node) nodes.push(merged.node);
    conflicts.push(...merged.conflicts);
  }
  const payload = { version: SOURCE_SNAPSHOT_VERSION, source, nodes };
  // Defensive: a merge of three legal snapshots must stay legal. If it does
  // not, the record is unusable rather than partially written (§7.8.1).
  if (snapshotProblems({ ...SYNTHETIC_HEADER, source, nodes }).length) return { result: null, conflicts: [] };
  return { result: { ...payload, hash: snapshotHash(payload) }, conflicts };
}

// ---------------------------------------------------------------------------
// Public: editor layer → snapshot shape
// ---------------------------------------------------------------------------

/**
 * The editor-layer static value of one §7.8.1 path (§7.8.2 "本地值" without a
 * frame: defaults → `el.transform` / `el.style`; keyframes are the track value
 * of the path, not its baseline).
 *
 * `editorValueOf` wants `evalElement`'s result; here `st` is the element's
 * static mirror (`transform` / `style`), not a sampled frame — an editor-layer
 * *baseline* must not be sampled from its own keyframes. Keeping the explicit
 * `st` keeps the one path mapping (§7.8.2) in one place instead of a second
 * table of `transform.x` → `el.transform.x`.
 */
export const editorStaticValueOf = (el, path) => editorValueOf(el, {
  x: el?.transform?.x,
  y: el?.transform?.y,
  scale: el?.transform?.scale,
  rotation: el?.transform?.rotation,
  opacity: el?.transform?.opacity,
  text: el?.style?.text,
  size: el?.style?.size,
  color: el?.style?.color,
}, path);

/** One editor keyframe as a §7.8.1 track key, or `null` when it is unusable. */
function editorKeyOf(key, path) {
  if (!isRecord(key) || key.path !== path) return null;
  const t = Number(key.t);
  if (!Number.isFinite(t) || t < 0) return null;
  if (!NUMERIC.has(path)) {
    if (typeof key.value !== 'string') return null;
  } else if (!isNum(key.value)) return null;
  const out = { t, path, value: key.value };
  if (key.ease !== undefined) {
    if (typeof key.ease !== 'string' || !EASE_NAMES.includes(key.ease)) return null;
    out.ease = key.ease;
  }
  if (key.curve !== undefined) {
    const curve = key.curve;
    if (!Array.isArray(curve) || curve.length < 2
      || !curve.every((pair) => Array.isArray(pair) && pair.length >= 2
        && Number.isFinite(Number(pair[0])) && Number.isFinite(Number(pair[1])))) return null;
    out.curve = curve.map((pair) => [Number(pair[0]), Number(pair[1])]);
  }
  return out;
}

/**
 * `ours` for the merge: every element bound to `sourceId` turned into a
 * snapshot-shaped node (§7.8.4 "编辑器层（`el.source.id === sourceId` 的元素
 * 导成快照形状）").
 *
 * Only §7.8.1 paths are exported. `props` mirrors the editor-layer value
 * (`editorValueOf`) and `tracks` carries the element's own keyframes per path,
 * whole array per path. A path whose editor keyframes are unusable for the
 * frozen table (wrong type, unsorted, bad ease/curve) is left out instead of
 * making the whole merge invalid; elements whose `type` is not one of the four
 * snapshot types are skipped for the same reason (they cannot come from a
 * compile). Returns `{ version, source, nodes }`, nodes sorted by id.
 */
export function editorSnapshotOf(elements, sourceId) {
  const id = String(sourceId ?? '');
  const nodes = [];
  const seen = new Set();
  for (const el of Array.isArray(elements) ? elements : []) {
    if (!isRecord(el) || !isRecord(el.source) || el.source.id !== id) continue;
    const nodeId = el.source.node;
    if (!isSourceNodeId(nodeId) || seen.has(nodeId)) continue;
    if (!SOURCE_NODE_TYPES.includes(el.type)) continue;
    seen.add(nodeId);
    const props = {};
    for (const path of SOURCE_PATHS) {
      const value = editorStaticValueOf(el, path);
      if (value !== undefined) props[path] = value;
    }
    const tracks = [];
    for (const path of SOURCE_PATHS) {
      const keys = (Array.isArray(el.keyframes) ? el.keyframes : [])
        .map((key) => editorKeyOf(key, path))
        .filter(Boolean)
        .sort((a, b) => a.t - b.t);
      if (!keys.length) continue;
      // `props[path]` is the baseline; a track without one is not legal, and
      // `editorValueOf` always produces one for a §7.8.1 path.
      if (!Object.hasOwn(props, path)) continue;
      tracks.push(...keys);
    }
    nodes.push({ id: nodeId, type: el.type, parent: null, props, tracks });
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: SOURCE_SNAPSHOT_VERSION, source: id, nodes };
}
