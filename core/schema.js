// Project schema: defaults, normalisation, ids.
import { normalizeCamera } from './camera.js';
import { normalizeWorld } from './world.js';
import { OBJECT_TYPES } from './scene.js';
import { assertSafeData, isRecord, pathParts } from './json.js';
import { PROJECT_SCHEMA } from './version.js';
import { linkIssues, normalizeLinks, projectLinkIssues } from './links.js';
import { feedIssues } from './camfeed.js';
import { dirRollFromRotation, normalizeRotation } from './rotation.js';
import { normalizeCustomPresets } from './curves.js';
import { codeIssues, isSafeSourceFile, isSafeSourceId, manifestIssues, normalizeCode, normalizeSources, sourceManifest, SOURCE_MANIFEST } from './code-layer.js';
import {
  SOURCE_MODES, SOURCE_PATHS, isNumericSourcePath, isSourceNodeId, isSourcePath,
} from './source-eval.js';
// A "project" is the single source of truth on disk: <project>/project.vdm.json

export const SCHEMA = PROJECT_SCHEMA;

// `code` = a raster layer drawn by a sandboxed source (DESIGN-BACKEND-V2 §6.1,
// core/code-layer.js). Its data lives in `element.code`.
export const ELEMENT_TYPES = ['image', 'video', 'text', 'solid', 'shape', 'audio', 'camfeed', 'code'];
export const SEGMENT_STATUS = ['draft', 'previewed', 'approved'];

export const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export const DEFAULT_STYLE = {
  // image / video
  fit: 'cover',
  // text
  text: '',
  font: 'SimHei',
  size: 96,
  weight: 400,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.18,
  letterSpacing: 0,
  shadow: 0,
  // solid / shape
  shape: 'rect',
  fill: '#ffffff',
  radius: 0,
  stroke: '',
  strokeWidth: 0,
};

export const DEFAULT_FX = {
  bloom: 0.25,
  ca: 0.0,
  grain: 0.04,
  vignette: 0.35,
  scanline: 0.0,
  grade: 0, // -1 cool .. +1 warm
  contrast: 0,
  saturation: 1,
  shake: 0,
};

export const DEFAULT_MOTION = { type: 'none', amount: 0, dir: 'in' };

// Unified spatial node (PLAN-ui-round3 §2, core/spatial.js): the single
// transform source once a 2D element is upgraded. Old elements keep using
// `transform`; normalisation never creates `node` by itself.
export const DEFAULT_SPATIAL_NODE = Object.freeze({
  pivot: Object.freeze([0, 0, 0]),
  position: Object.freeze([0, 0, 0]),
  dir: Object.freeze([0, 0, -1]),
  roll: 0,
  scale: Object.freeze([1, 1, 1]),
});

const isNum = (n) => Number.isFinite(Number(n));
const nodeVec = (v, fallback) => (Array.isArray(v) && v.length >= 2 && v.slice(0, 3).every(isNum)
  ? [Number(v[0]), Number(v[1]), Number(v[2] ?? fallback[2])]
  : fallback.slice());

function unitDir(v, fallback) {
  const d = nodeVec(v, fallback);
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len > 1e-12) return [d[0] / len, d[1] / len, d[2] / len];
  const fb = nodeVec(fallback, DEFAULT_SPATIAL_NODE.dir);
  const fl = Math.hypot(fb[0], fb[1], fb[2]) || 1;
  return [fb[0] / fl, fb[1] / fl, fb[2] / fl];
}

/**
 * Smallest tolerant normaliser for a SpatialNode. Missing/invalid fields fall
 * back to `base` (another node) or the defaults; arrays are copied, never
 * shared. This is also what `core/spatial.js` uses for readers.
 */
export function normalizeSpatialNode(node, base = null) {
  const src = isRecord(node) ? node : {};
  const fb = isRecord(base) ? base : DEFAULT_SPATIAL_NODE;
  const out = {
    pivot: nodeVec(src.pivot, nodeVec(fb.pivot, DEFAULT_SPATIAL_NODE.pivot)),
    position: nodeVec(src.position, nodeVec(fb.position, DEFAULT_SPATIAL_NODE.position)),
    dir: unitDir(src.dir, nodeVec(fb.dir, DEFAULT_SPATIAL_NODE.dir)),
    roll: isNum(src.roll) ? Number(src.roll) : (isNum(fb.roll) ? Number(fb.roll) : 0),
    scale: nodeVec(src.scale, nodeVec(fb.scale, DEFAULT_SPATIAL_NODE.scale)),
  };
  // Three-axis rotation (core/rotation.js) is the orientation when present;
  // dir / roll are kept as its derived view for the node math.
  if (Array.isArray(src.rotation)) {
    out.rotation = normalizeRotation(src.rotation);
    Object.assign(out, dirRollFromRotation(out.rotation));
  }
  return out;
}

/** Validation problems for an optional element `node` (no repair, no mutation). */
export function spatialNodeIssues(node, at = 'node') {
  const issues = [];
  if (node === undefined) return issues;
  if (!isRecord(node)) return [{ path: at, msg: 'must be an object' }];
  // `dir` is the older orientation field: a node with `rotation` may omit it.
  const required = Array.isArray(node.rotation) ? ['pivot', 'position', 'scale'] : ['pivot', 'position', 'dir', 'scale'];
  for (const name of required) {
    const v = node[name];
    if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
      issues.push({ path: `${at}.${name}`, msg: 'must be a finite 3-vector' });
    } else if (name === 'dir' && Math.hypot(v[0], v[1], v[2]) < 1e-12) {
      issues.push({ path: `${at}.dir`, msg: 'must be a nonzero direction' });
    }
  }
  if (node.rotation !== undefined && (!Array.isArray(node.rotation) || node.rotation.length !== 3 || !node.rotation.every(Number.isFinite))) {
    issues.push({ path: `${at}.rotation`, msg: 'must be [x, y, z] degrees' });
  }
  if (node.roll !== undefined && !Number.isFinite(node.roll)) {
    issues.push({ path: `${at}.roll`, msg: 'must be a finite number' });
  }
  return issues;
}

export const isValidSpatialNode = (node) => spatialNodeIssues(node).length === 0;

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Property links (core/links.js) are stored on the host and normalised on load:
 * valid entries are kept, unusable ones dropped, an empty array removed. They
 * are never created here — a project without links must load write-free.
 */
function normalizeHostLinks(host) {
  if (!isRecord(host) || host.links === undefined) return;
  const links = normalizeLinks(host.links);
  if (links.length) host.links = links;
  else delete host.links;
}

// ---- locks (docs/DESIGN-BACKEND-V2.md §8.1 / D4) -------------------------
// `locked: true` on an element, camera or 3D object means "a human pinned
// this; agents may not write it". Humans still can, told apart by the
// transaction's actorId. The flag is stored only when true, so a project
// without locks loads and saves write-free.
// ---- source binding (§7.8.2, WP4.2) --------------------------------------
// `el.source = { id, node }` says "this element comes from a compiled source
// node"; `el.sourceMode` is the sparse per-path overlay table. Normalisation
// only *keeps* legal values — it never invents a binding, and a broken one is
// dropped whole instead of blocking the load (the "never fabricate" rule
// `node` follows). `validateProject` reports what normalisation removes.
function normalizeSourceMode(raw) {
  const out = {};
  if (!isRecord(raw)) return out;
  for (const path of SOURCE_PATHS) {
    const mode = raw[path];
    if (!SOURCE_MODES.includes(mode)) continue;
    // §7.8.2: `mul` on a string / colour / enum path has no multiplication to
    // do, so that key falls back to the default.
    if (mode === 'mul' && !isNumericSourcePath(path)) continue;
    out[path] = mode;
  }
  return out;
}

function normalizeSourceBinding(el) {
  if (!isRecord(el)) return;
  if (el.source === undefined) {
    delete el.sourceMode; // §7.8.2: no binding, no overlay table
    return;
  }
  const src = isRecord(el.source) ? el.source : {};
  const id = typeof src.id === 'string' ? src.id : '';
  const node = typeof src.node === 'string' ? src.node : '';
  if (!id || !node || !isSafeSourceId(id)) {
    delete el.source;
    delete el.sourceMode;
    return;
  }
  el.source = { id, node };
  const mode = normalizeSourceMode(el.sourceMode);
  if (Object.keys(mode).length) el.sourceMode = mode;
  else delete el.sourceMode;
}

function normalizeLocked(host) {
  if (!isRecord(host) || host.locked === true) return;
  if (Object.hasOwn(host, 'locked')) delete host.locked;
}

/** Actors a lock rejects: `agent:<name>` and a bare `agent`. */
export const isAgentActor = (actorId) => /^agent(:|$)/i.test(String(actorId ?? ''));

/** JSON with sorted keys, so two normalised bodies compare by value. */
const sortedJson = (value) => (Array.isArray(value)
  ? `[${value.map(sortedJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`
    : JSON.stringify(value === undefined ? null : value));

/** Ids of every locked host, by collection. */
export function lockedHosts(project) {
  const out = { element: [], camera: [], object: [] };
  const read = (list, kind) => {
    for (const host of Array.isArray(list) ? list : []) {
      if (host?.locked === true && host.id != null) out[kind].push(host.id);
    }
  };
  read(project?.elements, 'element');
  read(project?.cameras, 'camera');
  read(project?.scene?.objects, 'object');
  return out;
}

/**
 * Locked hosts an agent's write would touch: a locked host whose body differs
 * between `before` and `after`, or one the write deletes. Returns [] for every
 * other actor — a human may unlock or edit at any time.
 */
export function lockedWriteIssues(before, after, { actorId } = {}) {
  if (!isAgentActor(actorId)) return [];
  const issues = [];
  const collections = [
    ['element', before?.elements, after?.elements, 'elements'],
    ['camera', before?.cameras, after?.cameras, 'cameras'],
    ['object', before?.scene?.objects, after?.scene?.objects, 'scene.objects'],
  ];
  for (const [kind, from, to, at] of collections) {
    const list = Array.isArray(from) ? from : [];
    const target = Array.isArray(to) ? to : [];
    for (let i = 0; i < list.length; i++) {
      const was = list[i];
      if (was?.locked !== true) continue;
      const now = target.find((host) => host?.id === was.id);
      if (!now) {
        issues.push({ id: was.id, kind, path: `${at}[${i}]`, msg: 'is locked and cannot be deleted by an agent' });
      } else if (sortedJson(was) !== sortedJson(now)) {
        issues.push({ id: was.id, kind, path: `${at}[${i}]`, msg: 'is locked; agent writes are rejected (a human can unlock it)' });
      }
    }
  }
  return issues;
}

/** Throw `LOCKED` when an agent's write touches a locked host. */
export function assertUnlockedWrite(before, after, opts = {}) {
  const issues = lockedWriteIssues(before, after, opts);
  if (!issues.length) return;
  const ids = [...new Set(issues.map((issue) => issue.id))];
  const error = new Error(`locked: ${ids.join(', ')} — ${opts.actorId || 'agent'} may not write a locked element`);
  Object.assign(error, { code: 'LOCKED', status: 409, issues, locked: ids });
  throw error;
}

export function newId(prefix, taken) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  let i = 1;
  while (used.has(`${prefix}_${i}`)) i++;
  used.add(`${prefix}_${i}`);
  return `${prefix}_${i}`;
}

export function createProject(opts = {}) {
  const {
    title = 'Untitled',
    fps = 24,
    width = 1920,
    height = 1080,
    duration = 12,
    background = '#05070d',
    audio = null,
  } = opts;
  return {
    schema: SCHEMA,
    rev: 0,
    meta: {
      title,
      fps,
      width,
      height,
      duration,
      background,
      audio,
      beats: [],
      tempo: 0,
      fx: { ...DEFAULT_FX },
      style: 'default',
      // Curve presets saved from the F2 rail travel with the project.
      curvePresets: [],
    },
    segments: [],
    elements: [],
    camera: null,
    cameras: [],
    cameraOrder: [],
    activeCameraId: null,
    world: normalizeWorld(),
  };
}

/**
 * Camera stack: `cameras[]` is the source, `cameraOrder` is top→bottom, and
 * `activeCameraId` picks the edit camera. The legacy `project.camera` stays as
 * an alias of the active camera so the existing single-camera code paths keep
 * working while the stack is rolled out.
 */
export function normalizeCameraStack(p) {
  const raw = Array.isArray(p.cameras) ? p.cameras.filter(Boolean) : [];
  if (!raw.length && p.camera) raw.push(p.camera);
  const used = new Set();
  const cams = raw.map((c, i) => {
    const cam = normalizeCamera(c);
    let id = cam.id || `cam_${i + 1}`;
    while (used.has(id)) id = `cam_${i + 1}_${used.size + 1}`;
    used.add(id);
    cam.id = id;
    cam.name = cam.name || `相机 ${i + 1}`;
    return cam;
  });
  const byId = new Map(cams.map((c) => [c.id, c]));
  const order = [];
  const seen = new Set();
  for (const id of Array.isArray(p.cameraOrder) ? p.cameraOrder : []) {
    const sid = String(id);
    if (byId.has(sid) && !seen.has(sid)) { seen.add(sid); order.push(sid); }
  }
  for (const c of cams) if (!seen.has(c.id)) { seen.add(c.id); order.push(c.id); }
  const active = byId.has(String(p.activeCameraId))
    ? String(p.activeCameraId)
    : (order[0] || null);
  p.cameras = order.map((id) => byId.get(id));
  p.cameraOrder = order;
  p.activeCameraId = active;
  p.camera = active ? byId.get(active) : null;
  return p;
}

/** Fill in defaults for every known field without clobbering user values. */
export function normalizeProject(p) {
  assertSafeData(p);
  if (!isRecord(p)) throw Object.assign(new Error('project must be an object'), { code: 'OP_INVALID' });
  p.schema ??= SCHEMA;
  p.rev ??= 0;
  p.meta ??= {};
  if (!isRecord(p.meta)) throw Object.assign(new Error('meta must be an object'), { code: 'OP_INVALID' });
  const m = p.meta;
  m.title = m.title || 'Untitled';
  m.fps ??= 24;
  m.width ??= 1920;
  m.height ??= 1080;
  m.duration ??= 12;
  m.background = m.background || '#05070d';
  m.audio = m.audio || null;
  m.beats ??= [];
  m.tempo ??= 0;
  m.fx = { ...DEFAULT_FX, ...(m.fx || {}) };
  m.style = m.style || 'default';
  // Garbage in a hand-edited project must not break the rail.
  m.curvePresets = normalizeCustomPresets(m.curvePresets);

  p.segments ??= [];
  p.elements ??= [];
  if (!Array.isArray(p.segments) || !Array.isArray(p.elements)
    || !p.segments.every(isRecord) || !p.elements.every(isRecord)) {
    throw Object.assign(new Error('segments and elements must be arrays of objects'), { code: 'OP_INVALID' });
  }

  // Code sources (§6.1) travel with the project; the disk copy under
  // `sources/<id>/` is derived from this registry (core/code-layer.js).
  if (p.sources !== undefined) p.sources = normalizeSources(p.sources);

  const segIds = new Set(p.segments.map((s) => s.id));
  p.segments = p.segments.map((s) => ({
    start: 0,
    duration: 1,
    name: '',
    intent: '',
    status: 'draft',
    ...s,
  }));
  p.segments.forEach((s) => { segIds.add(s.id); });

  const elIds = new Set(p.elements.map((e) => e.id));
  p.elements = p.elements.map((e) => {
    e.type ??= 'solid';
    e.start ??= 0;
    e.duration ??= 1;
    e.z ??= 0;
    e.transform = { ...DEFAULT_TRANSFORM, ...(e.transform || {}) };
    // Unified space: an existing `node` is the authoritative 2D transform and
    // is preserved verbatim (readers normalise it, `validateProject` checks it).
    // Never fabricate one here: loading an old project must stay write-free.
    e.style = { ...DEFAULT_STYLE, ...(e.style || {}) };
    e.fx = { glow: 0, ...(e.fx || {}) };
    e.motion = { ...DEFAULT_MOTION, ...(e.motion || {}) };
    e.keyframes ??= [];
    e.visible = e.visible !== false;
    e.name = e.name || (e.type === 'text' ? (e.style.text || 'text') : e.type);
    // Code layers carry one extra block (§6.1); everything else is shared with
    // the 2D element model (a code layer is a normal node plane in 3D).
    if (e.type === 'code') e.code = normalizeCode(e.code, sourceManifest(p, isRecord(e.code) ? e.code.source : ''));
    normalizeHostLinks(e);
    normalizeLocked(e);
    normalizeSourceBinding(e);
    return e;
  });
  elIds.clear();
  p.elements.forEach((e) => elIds.add(e.id));

  normalizeCameraStack(p);
  for (const obj of Array.isArray(p.scene?.objects) ? p.scene.objects : []) {
    normalizeHostLinks(obj);
    normalizeLocked(obj);
  }
  for (const cam of Array.isArray(p.cameras) ? p.cameras : []) {
    normalizeHostLinks(cam);
    normalizeLocked(cam);
  }
  p.world = normalizeWorld(p.world);
  return p;
}

/**
 * Validation problems of an optional element `source` (§7.8.2): no repair, no
 * mutation. The node id is checked for shape only — whether the compiled
 * snapshot actually carries it is the snapshot's business (§7.8.2 "降级").
 */
export function sourceIssues(source, at = 'source') {
  const issues = [];
  const push = (p, msg) => issues.push({ path: p, msg });
  if (!isRecord(source)) return [{ path: at, msg: 'must be an object' }];
  if (typeof source.id !== 'string' || !source.id) push(`${at}.id`, 'must be a nonempty source id');
  else if (!isSafeSourceId(source.id)) push(`${at}.id`, 'must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}');
  if (typeof source.node !== 'string' || !source.node) push(`${at}.node`, 'must be a nonempty node id');
  else if (!isSourceNodeId(source.node)) push(`${at}.node`, 'must match ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$');
  for (const key of Object.keys(source)) {
    if (key !== 'id' && key !== 'node') push(`${at}.${key}`, 'is not part of a source binding');
  }
  return issues;
}

/** Validation problems of an optional `sourceMode` table (§7.8.2). */
export function sourceModeIssues(mode, at = 'sourceMode', source = null) {
  const issues = [];
  const push = (p, msg) => issues.push({ path: p, msg });
  if (!isRecord(mode)) return [{ path: at, msg: 'must be an object' }];
  if (source === null || source === undefined) push(at, 'needs el.source');
  for (const [path, value] of Object.entries(mode)) {
    if (!isSourcePath(path)) { push(`${at}.${path}`, 'is not a source path'); continue; }
    if (!SOURCE_MODES.includes(value)) { push(`${at}.${path}`, 'must be add, mul or override'); continue; }
    if (value === 'mul' && !isNumericSourcePath(path)) push(`${at}.${path}`, 'mul needs a numeric path');
  }
  return issues;
}

/** Collect validation problems without repairing or mutating the document. */
export function validateProject(p) {
  const issues = [];
  const push = (path, msg) => issues.push({ path, msg });
  if (!isRecord(p)) return [{ path: '', msg: 'project must be an object' }];
  try { assertSafeData(p); } catch (e) { push('', e.message); return issues; }
  const number = (v, at, { min = -Infinity, max = Infinity, exclusive = false } = {}) => {
    if (!Number.isFinite(v) || (exclusive ? v <= min : v < min) || v > max) push(at, `must be a finite number ${exclusive ? '>' : '>='} ${min} and <= ${max}`);
  };
  const array = (v, at, optional = false) => {
    if (optional && v === undefined) return [];
    if (!Array.isArray(v)) { push(at, 'must be an array'); return []; }
    return v;
  };
  const record = (v, at) => {
    if (!isRecord(v)) { push(at, 'must be an object'); return false; }
    return true;
  };
  const id = (v, at, taken) => {
    if (typeof v !== 'string' || !v || v.length > 128) push(at, 'must be a nonempty string of at most 128 characters');
    if (taken.has(v)) push(at, `duplicate id ${v}`);
    taken.add(v);
  };
  const vector = (v, at, dims) => {
    if (!Array.isArray(v) || v.length !== dims || !v.every(Number.isFinite)) push(at, `must be a finite ${dims}-vector`);
  };
  const source = (v, at) => {
    if (typeof v !== 'string' || /[\\\0]/.test(v) || v.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(v) || v.split('/').includes('..')) push(at, 'must be a project-relative media path');
  };
  const tracks = (v, at) => {
    if (v === undefined) return;
    if (!record(v, at)) return;
    for (const [name, track] of Object.entries(v)) {
      try { pathParts(name); } catch (e) { push(`${at}.${name}`, e.message); }
      array(track, `${at}.${name}`).forEach((key, i) => {
        const loc = `${at}.${name}[${i}]`;
        if (!record(key, loc)) return;
        number(key.t, `${loc}.t`, { min: 0 });
        if (key.v === undefined || key.v === null) push(`${loc}.v`, 'missing value');
        if (Array.isArray(key.v) && !key.v.every(Number.isFinite)) push(`${loc}.v`, 'vector values must be finite');
      });
    }
  };
  if (p.schema !== SCHEMA) push('schema', `unsupported schema ${p.schema}`);
  if (!Number.isSafeInteger(p.rev) || p.rev < 0) push('rev', 'must be a nonnegative safe integer');
  if (!record(p.meta, 'meta')) { /* remaining sections can still be checked */ }
  else {
    for (const name of ['fps', 'width', 'height', 'duration']) number(p.meta[name], `meta.${name}`, { min: 0, exclusive: true });
    if (typeof p.meta.title !== 'string') push('meta.title', 'must be a string');
    if (p.meta.audio != null && record(p.meta.audio, 'meta.audio')) {
      source(p.meta.audio.src, 'meta.audio.src');
      for (const name of ['offset', 'gain']) if (p.meta.audio[name] !== undefined) number(p.meta.audio[name], `meta.audio.${name}`);
    }
    let lastBeat = -Infinity;
    array(p.meta.beats, 'meta.beats', true).forEach((beat, i) => {
      number(beat, `meta.beats[${i}]`, { min: 0 });
      if (beat < lastBeat) push(`meta.beats[${i}]`, 'beats must be sorted');
      lastBeat = beat;
    });
  }
  if (p.world !== undefined && record(p.world, 'world')) {
    if (p.world.grid !== undefined && record(p.world.grid, 'world.grid')) {
      for (const name of ['nx', 'nz']) {
        const value = p.world.grid[name];
        if (!Number.isInteger(value) || value < 1 || value > 256) push(`world.grid.${name}`, 'must be an integer from 1 to 256');
      }
      for (const name of ['block', 'street']) number(p.world.grid[name], `world.grid.${name}`, { min: 0, exclusive: name === 'block' });
    }
    if (p.world.density !== undefined) number(p.world.density, 'world.density', { min: 0, max: 1 });
    if (p.world.palette !== undefined && (!Array.isArray(p.world.palette) || !p.world.palette.length || !p.world.palette.every((c) => typeof c === 'string'))) push('world.palette', 'must be a nonempty array of colors');
  }
  const segIds = new Set();
  array(p.segments, 'segments').forEach((s, i) => {
    const at = `segments[${i}]`;
    if (!record(s, at)) return;
    id(s.id, `${at}.id`, segIds);
    number(s.start, `${at}.start`, { min: 0 });
    number(s.duration, `${at}.duration`, { min: 0, exclusive: true });
    if (s.status !== undefined && !SEGMENT_STATUS.includes(s.status)) push(`${at}.status`, 'unknown segment status');
  });
  const ids = new Set();
  array(p.elements, 'elements').forEach((e, i) => {
    const at = `elements[${i}]`;
    if (!record(e, at)) return;
    id(e.id, `${at}.id`, ids);
    if (!ELEMENT_TYPES.includes(e.type)) push(`elements[${i}].type`, `unknown type ${e.type}`);
    number(e.duration, `${at}.duration`, { min: 0, exclusive: true });
    number(e.start, `${at}.start`, { min: 0 });
    if (e.src !== undefined) source(e.src, `${at}.src`);
    if (e.type === 'audio' && !e.src) push(`${at}.src`, 'audio element needs src');
    for (const name of ['fadeIn', 'fadeOut', 'srcIn', 'punch']) if (e[name] !== undefined) number(e[name], `${at}.${name}`, { min: 0 });
    if (e.loop !== undefined && typeof e.loop !== 'boolean') push(`${at}.loop`, 'must be boolean');
    if (e.locked !== undefined && typeof e.locked !== 'boolean') push(`${at}.locked`, 'must be boolean');
    if (e.volume !== undefined) number(e.volume, `${at}.volume`, { min: 0, max: 1 });
    if (e.transform !== undefined && record(e.transform, `${at}.transform`)) {
      for (const name of Object.keys(DEFAULT_TRANSFORM)) if (e.transform[name] !== undefined) number(e.transform[name], `${at}.transform.${name}`);
    }
    if (e.node !== undefined) issues.push(...spatialNodeIssues(e.node, `${at}.node`));
    issues.push(...feedIssues(e, at));
    if (e.type === 'code') {
      if (e.code === undefined) push(`${at}.code`, 'code element needs a code block');
      else issues.push(...codeIssues(e.code, `${at}.code`));
    }
    if (e.links !== undefined) issues.push(...linkIssues(e.links, `${at}.links`));
    if (e.source !== undefined) issues.push(...sourceIssues(e.source, `${at}.source`));
    if (e.sourceMode !== undefined) issues.push(...sourceModeIssues(e.sourceMode, `${at}.sourceMode`, e.source));
    if (e.style?.size !== undefined) number(e.style.size, `${at}.style.size`, { min: 0 });
    if (e.segment && !segIds.has(e.segment)) push(`elements[${i}].segment`, `unknown segment ${e.segment}`);
    array(e.keyframes, `${at}.keyframes`, true).forEach((k, j) => {
      const loc = `${at}.keyframes[${j}]`;
      if (!record(k, loc)) return;
      number(k.t, `${loc}.t`); // keys outside the element window are needed after splitting
      try { pathParts(k.path); } catch (err) { push(`${loc}.path`, err.message); }
      if (k.value === undefined) push(`${loc}.value`, 'missing value');
    });
  });
  const camIds = new Set();
  array(p.cameras, 'cameras', true).forEach((c, i) => {
    const at = `cameras[${i}]`;
    if (!record(c, at)) return;
    id(c.id, `${at}.id`, camIds);
    if (c.fov !== undefined) number(c.fov, `${at}.fov`, { min: 1, max: 360 });
    if (c.locked !== undefined && typeof c.locked !== 'boolean') push(`${at}.locked`, 'must be boolean');
    if (c.start !== undefined) number(c.start, `${at}.start`, { min: 0 });
    if (c.duration !== undefined) number(c.duration, `${at}.duration`, { min: 0, exclusive: true });
    for (const name of ['center', 'scale']) if (c[name] !== undefined) vector(c[name], `${at}.${name}`, 3);
    array(c.path, `${at}.path`).forEach((key, j) => {
      const loc = `${at}.path[${j}]`;
      if (!record(key, loc)) return;
      number(key.t, `${loc}.t`, { min: 0 });
      vector(key.pos, `${loc}.pos`, 3);
      if (key.look != null) vector(key.look, `${loc}.look`, 3);
    });
    if (c.links !== undefined) issues.push(...linkIssues(c.links, `${at}.links`));
    tracks(c.tracks, `${at}.tracks`);
  });
  const order = array(p.cameraOrder, 'cameraOrder', true);
  order.forEach((id, i) => {
    if (!camIds.has(id)) push(`cameraOrder[${i}]`, `unknown camera ${id}`);
  });
  if (p.activeCameraId != null && !camIds.has(p.activeCameraId)) {
    push('activeCameraId', `unknown camera ${p.activeCameraId}`);
  }
  if (p.scene !== undefined && record(p.scene, 'scene')) {
    if (p.scene.version !== 3 || p.scene.units !== 'm') push('scene', 'unsupported scene version or units');
    const objects = new Set();
    array(p.scene.objects, 'scene.objects').forEach((obj, i) => {
      const at = `scene.objects[${i}]`;
      if (!record(obj, at)) return;
      id(obj.id, `${at}.id`, objects);
      if (!OBJECT_TYPES.includes(obj.type)) push(`${at}.type`, 'unknown object type');
      number(obj.start, `${at}.start`, { min: 0 });
      number(obj.duration, `${at}.duration`, { min: 0, exclusive: true });
      for (const name of ['pivot', 'position', 'scale']) if (obj[name] !== undefined) vector(obj[name], `${at}.${name}`, 3);
      if (obj.rot !== undefined && record(obj.rot, `${at}.rot`)) {
        vector(obj.rot.dir, `${at}.rot.dir`, 3);
        number(obj.rot.roll, `${at}.rot.roll`);
      }
      if (obj.opacity !== undefined) number(obj.opacity, `${at}.opacity`, { min: 0, max: 1 });
      if (obj.locked !== undefined && typeof obj.locked !== 'boolean') push(`${at}.locked`, 'must be boolean');
      if (obj.links !== undefined) issues.push(...linkIssues(obj.links, `${at}.links`));
      if (obj.geom !== undefined && record(obj.geom, `${at}.geom`)) for (const name of ['w', 'h', 'd']) number(obj.geom[name], `${at}.geom.${name}`, { min: 0, exclusive: true });
      tracks(obj.tracks, `${at}.tracks`);
    });
  }
  // Code sources (§6.1): ids, manifest shape, safe file paths.
  if (p.sources !== undefined) {
    array(p.sources, 'sources', true).forEach((entry, i) => {
      const at = `sources[${i}]`;
      if (!record(entry, at)) return;
      if (typeof entry.id !== 'string' || !entry.id) push(`${at}.id`, 'must be a nonempty source id');
      else if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.id)) push(`${at}.id`, 'must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}');
      issues.push(...manifestIssues(entry.manifest, `${at}.manifest`));
      if (entry.files !== undefined && record(entry.files, `${at}.files`)) {
        for (const rel of Object.keys(entry.files)) {
          if (rel === SOURCE_MANIFEST) push(`${at}.files.${rel}`, 'manifest.json is generated from manifest');
          else if (!isSafeSourceFile(rel)) push(`${at}.files.${rel}`, 'unsafe relative path');
          else if (typeof entry.files[rel] !== 'string') push(`${at}.files.${rel}`, 'must be a string');
        }
      }
    });
  }
  // Cross-host link graph: known hosts/paths, matching units, no cycles/depth.
  issues.push(...projectLinkIssues(p));
  return issues;
}

export function assertValidProject(project) {
  const issues = validateProject(project);
  if (issues.length) throw Object.assign(new Error(`invalid project: ${issues.map((i) => `${i.path}: ${i.msg}`).join('; ')}`), { code: 'OP_INVALID', issues });
  return project;
}

export function elementsAt(p, t) {
  return p.elements.filter((e) => e.visible !== false && t >= e.start - 1e-6 && t < e.start + e.duration - 1e-6);
}

export function segmentAt(p, t) {
  return p.segments.find((s) => t >= s.start && t < s.start + s.duration) || null;
}

export function projectDuration(p) {
  const lastEl = p.elements.reduce((m, e) => Math.max(m, e.start + e.duration), 0);
  const lastSeg = p.segments.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
  return Math.max(p.meta.duration || 0, lastEl, lastSeg);
}

export function cloneProject(p) {
  return clone(p);
}

export { clone };
