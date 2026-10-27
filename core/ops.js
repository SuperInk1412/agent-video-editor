// Edit operations: the ONE way anything (UI, CLI, AI) mutates a project.
// Ops are plain JSON so they can be logged, replayed, diffed and undone.
import { DEFAULT_TRANSFORM, DEFAULT_STYLE, DEFAULT_FX, ELEMENT_TYPES, newId } from './schema.js';
import { SCENE_VERSION, normalizeObject } from './scene.js';
import { normalizeCamera, retimeCamSpans, retimePathSpan, cameraRange } from './camera.js';
import { normalizeCurve } from './curves.js';
import { EXT_OP_KINDS, applyExtOp } from './ops-ext.js';

export const OP_KINDS = [
  'addElement', 'updateElement', 'set', 'removeElement', 'moveElement',
  'splitElement', 'splitAt', 'duplicateElement', 'reorder', 'addSegment', 'updateSegment',
  'removeSegment', 'setMeta', 'setFx', 'keySet', 'keyRemove', 'keyCurve', 'batch',
  'cameraKey', 'cameraRemove', 'cameraSet', 'cameraPath', 'cameraPatch',
  'cameraParamKey', 'cameraParamUnkey', 'worldSet',
  'addCamera', 'removeCamera', 'reorderCamera', 'activateCamera',
  'objectAdd', 'objectRemove', 'objectPatch', 'objectKey', 'objectUnkey',
  // ops added by feature modules through core/ops-ext.js
  ...EXT_OP_KINDS,
];

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

const TIMING_OPS = new Set([
  'addElement', 'removeElement', 'moveElement', 'splitElement', 'splitAt',
  'duplicateElement', 'objectAdd', 'objectRemove', 'addCamera', 'removeCamera',
]);

function touchesTiming(op) {
  if (!op) return false;
  if (op.op === 'batch') return (op.ops || []).some(touchesTiming);
  if (op.op === 'updateElement') {
    return isObj(op.patch) && ('start' in op.patch || 'duration' in op.patch);
  }
  if (op.op === 'objectPatch') {
    return isObj(op.patch) && ('start' in op.patch || 'duration' in op.patch);
  }
  if (op.op === 'cameraPatch' || op.op === 'cameraSet') {
    return isObj(op.patch) && ('start' in op.patch || 'duration' in op.patch);
  }
  return TIMING_OPS.has(op.op);
}

/**
 * Projects are as long as their furthest element. Called after edits that can
 * change an element's start/duration, so trimming, moving, adding and splitting
 * grow or shrink the timeline automatically. Camera clips only count when they
 * carry an explicit duration; a legacy camera without a range still covers the
 * whole project and does not pin its length.
 */
function syncDuration(p) {
  if (!p.meta) return;
  const ends = [];
  for (const el of p.elements || []) {
    const n = Number(el.start) + Number(el.duration);
    if (Number.isFinite(n)) ends.push(n);
  }
  for (const obj of p.scene?.objects || []) {
    const n = Number(obj.start) + Number(obj.duration);
    if (Number.isFinite(n)) ends.push(n);
  }
  for (const cam of p.cameras || []) {
    if (!Number.isFinite(Number(cam.duration))) continue;
    const start = Number.isFinite(Number(cam.start)) ? Math.max(0, Number(cam.start)) : 0;
    ends.push(start + Math.max(0, Number(cam.duration)));
  }
  if (!ends.length) return;
  const end = Math.max(...ends);
  p.meta.duration = Math.max(0.1, Math.round(end * 1000) / 1000);
}

export function deepMerge(target, patch) {
  if (!isObj(patch)) return patch;
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** get/set a dotted path, with numeric segments addressing array indices */
export function getPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    if (cur[k] == null) cur[k] = nextIsIndex ? [] : {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

const fail = (msg) => { const e = new Error(msg); e.code = 'OP_INVALID'; throw e; };

function allIds(p) {
  return new Set([...p.elements.map((e) => e.id), ...p.segments.map((s) => s.id)]);
}

// ---------------------------------------------------------------- camera stack
function ensureCameraStack(p) {
  if (!Array.isArray(p.cameras)) p.cameras = [];
  if (!Array.isArray(p.cameraOrder)) p.cameraOrder = [];
  if (!p.cameras.length && p.camera) p.cameras.push(p.camera);
  const ids = new Set(p.cameras.map((c) => c.id).filter(Boolean));
  for (const cam of p.cameras) {
    if (!cam.id) { cam.id = newId('cam', ids); ids.add(cam.id); }
    if (!cam.name) cam.name = `相机 ${p.cameras.indexOf(cam) + 1}`;
  }
  p.cameraOrder = p.cameraOrder.filter((id, i, a) => p.cameras.some((c) => c.id === id) && a.indexOf(id) === i);
  for (const cam of p.cameras) if (!p.cameraOrder.includes(cam.id)) p.cameraOrder.push(cam.id);
  let active = p.cameras.find((c) => c.id === p.activeCameraId);
  if (!active) active = p.cameras.find((c) => c.id === p.camera?.id) || p.cameras[0] || null;
  p.camera = active || null;
  p.activeCameraId = active ? active.id : null;
  return p;
}

function activeCamera(p, create = false) {
  ensureCameraStack(p);
  if (p.camera) return p.camera;
  if (!create) return null;
  const ids = new Set(p.cameras.map((c) => c.id));
  const cam = normalizeCamera({ id: newId('cam', ids), name: `相机 ${p.cameras.length + 1}`, path: [] });
  p.cameras.unshift(cam);
  p.cameraOrder.unshift(cam.id);
  p.activeCameraId = cam.id;
  p.camera = cam;
  return cam;
}

/** Camera transform channels addressed by the timeline keyframes. */
const CAMERA_TRACK_DIMS = {
  center: 3, scale: 3, picturePivot: 2, pictureOffset: 2, opacity: 1,
  fov: 1, lookAhead: 1, bankGain: 1, maxRoll: 1, roll: 1,
  'shake.amp': 1, 'shake.freq': 1, 'shake.speedGain': 1,
  'dof.enabled': 1, 'dof.fstop': 1,
};

const CAMERA_TRACK_RANGES = {
  fov: [1, 360], lookAhead: [1, 500], bankGain: [0, 4], maxRoll: [0, 60], roll: [-60, 60],
  'shake.amp': [0, 5], 'shake.freq': [0.1, 8], 'shake.speedGain': [0, 2],
  'dof.fstop': [0.5, 32],
};

function cameraTrackValue(path, v) {
  const dims = CAMERA_TRACK_DIMS[path];
  if (!dims) fail(`camera ${path} is not a keyed property`);
  if (path === 'dof.enabled') return v === true || v === 'true';
  if (dims === 1) {
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`${path} needs a number`);
    const range = path === 'opacity' ? [0, 1] : CAMERA_TRACK_RANGES[path];
    return range ? Math.max(range[0], Math.min(range[1], n)) : n;
  }
  if (!Array.isArray(v) || v.length < dims || !v.slice(0, dims).every((n) => Number.isFinite(Number(n)))) {
    fail(`${path} needs [${'x,y,z'.split(',').slice(0, dims).join(',')}]`);
  }
  const out = v.slice(0, dims).map(Number);
  if (path === 'picturePivot') {
    out[0] = Math.max(0, Math.min(1, out[0]));
    out[1] = Math.max(0, Math.min(1, out[1]));
  }
  if (path === 'pictureOffset') {
    // normalized screen offsets; values far outside would push the whole shot
    // off-screen and the preview would look black for no visible reason
    out[0] = Math.max(-1, Math.min(1, out[0]));
    out[1] = Math.max(-1, Math.min(1, out[1]));
  }
  return out;
}

function cameraById(p, id) {
  ensureCameraStack(p);
  if (!id) return p.camera || null;
  const cam = p.cameras.find((c) => c.id === String(id));
  if (!cam) fail(`no camera ${id}`);
  return cam;
}

/** Drop span curves whose right endpoint disappeared. */
function cleanupPathSpans(cam) {
  const keys = cam.path || [];
  for (const k of keys) {
    if (!k.curve) continue;
    const ok = keys.some((x) => x !== k && Math.abs(Number(x.t) - Number(k.spanTo)) <= 1e-4);
    if (!ok) {
      delete k.curve;
      delete k.spanTo;
    }
  }
}

/** Normalized picture-space fields: keep base values inside their meaning. */
function clampCameraPicture(cam) {
  if (!cam) return cam;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
  if (Array.isArray(cam.picturePivot) && cam.picturePivot.length >= 2) {
    cam.picturePivot = [clamp(cam.picturePivot[0], 0, 1), clamp(cam.picturePivot[1], 0, 1)];
  }
  if (Array.isArray(cam.pictureOffset) && cam.pictureOffset.length >= 2) {
    cam.pictureOffset = [clamp(cam.pictureOffset[0], -1, 1), clamp(cam.pictureOffset[1], -1, 1)];
  }
  return cam;
}

function findEl(p, id) {  const el = p.elements.find((e) => e.id === id);
  if (!el) fail(`no element ${id}`);
  return el;
}

function findSeg(p, id) {
  const s = p.segments.find((x) => x.id === id);
  if (!s) fail(`no segment ${id}`);
  return s;
}

const t3 = (t) => Math.round(t * 1000) / 1000;

/** Keyframe times are absolute: moving an element carries its animation along. */
function shiftTiming(el, dt) {
  if (!dt) return;
  el.keyframes = (el.keyframes || []).map((k) => ({ ...k, t: t3(k.t + dt) }));
  const span = el.motion?.span;
  if (Array.isArray(span) && span.length === 2) el.motion.span = span.map((v) => t3(Number(v) + dt));
}

/**
 * Keys a half of a split element needs for [start, end]: everything inside plus
 * `context` nearest keys on each side per path, so sampling inside the range is
 * unchanged. Element keyframes are linear (1 is enough); camera paths use cubic
 * Catmull-Rom tangents and pass 2 so the curve shape near the cut is identical.
 */
function keysForRange(keys, start, end, context = 1) {
  const byPath = new Map();
  for (const k of keys || []) {
    if (!byPath.has(k.path)) byPath.set(k.path, []);
    byPath.get(k.path).push(k);
  }
  const out = [];
  const n = Math.max(1, Math.floor(context));
  for (const list of byPath.values()) {
    list.sort((a, b) => a.t - b.t);
    const before = list.filter((k) => k.t < start - 1e-6).slice(-n);
    const after = list.filter((k) => k.t > end + 1e-6).slice(0, n);
    for (const k of list) {
      if (before.includes(k) || after.includes(k) || (k.t >= start - 1e-6 && k.t <= end + 1e-6)) out.push({ ...k });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Split one element in place and return the new right-hand element. */
function splitOne(p, el, at, ids = allIds(p)) {
  // Both halves must look exactly like the original did: keyframe times are
  // absolute, the motion preset keeps its original span, there is no fade at
  // the cut, and the right half of a video resumes where the left one stopped.
  const end = el.start + el.duration;
  const right = JSON.parse(JSON.stringify(el));
  right.id = newId('el', ids);
  ids.add(right.id);
  right.name = el.name;
  right.start = at;
  right.duration = t3(end - at);
  right.keyframes = keysForRange(el.keyframes, at, end);
  right.fadeIn = 0;
  if (el.type === 'video' || el.type === 'audio') {
    right.srcIn = t3((Number(el.srcIn) || 0) + (at - el.start));
  }
  const motion = el.motion || {};
  if (motion.type && motion.type !== 'none' && Number(motion.amount)) {
    const span = Array.isArray(motion.span) && motion.span.length === 2 ? motion.span : [el.start, end];
    el.motion = { ...motion, span: [...span] };
    right.motion = { ...motion, span: [...span] };
  }
  el.duration = t3(at - el.start);
  el.keyframes = keysForRange(el.keyframes, el.start, at);
  el.fadeOut = 0;
  return right;
}

// ---------------------------------------------------------------- camera clips

/** Camera in this project by id, or null (does not throw for element ids). */
function cameraClipById(p, id) {
  ensureCameraStack(p);
  return p.cameras.find((c) => c.id === String(id)) || null;
}

/** Camera path / track keys are absolute-time, like element keyframes. */
function shiftCameraTiming(cam, dt) {
  if (!dt) return;
  for (const k of cam.path || []) {
    k.t = t3(Number(k.t) + dt);
    if (Number.isFinite(Number(k.spanTo))) k.spanTo = t3(Number(k.spanTo) + dt);
  }
  for (const keys of Object.values(cam.tracks || {})) {
    for (const k of keys || []) k.t = t3(Number(k.t) + dt);
  }
  cam.path?.sort((a, b) => a.t - b.t);
}

/**
 * Split one camera clip like splitOne(): the left half keeps the id, the right
 * half gets a fresh id and the original name + " · 2". Path keys and parameter
 * tracks keep the keys inside the half plus two nearest keys on each side (the
 * cubic path needs one extra for its tangent), never inserting a key, so
 * evaluation inside either range is unchanged.
 */
function splitCameraOne(p, cam, at) {
  const range = cameraRange(p, cam);
  const start = range.start;
  const end = range.end;
  if (!Array.isArray(cam.path) || !cam.path.length) fail('camera has no path to split');
  if (!(at > start + 0.02 && at < end - 0.02)) fail('split point outside camera');

  const ids = new Set(p.cameras.map((c) => c.id));
  const right = JSON.parse(JSON.stringify(cam));
  right.id = newId('cam', ids);
  right.name = `${cam.name || '相机'} · 2`;
  right.start = t3(at);
  right.duration = t3(end - at);

  const leftTracks = {};
  const rightTracks = {};
  for (const [path, keys] of Object.entries(cam.tracks || {})) {
    const left = keysForRange(keys, start, at, 2);
    if (left.length) leftTracks[path] = left;
    const rightKeys = keysForRange(keys, at, end, 2);
    if (rightKeys.length) rightTracks[path] = rightKeys;
  }

  right.path = keysForRange(cam.path, at, end, 2);
  right.tracks = rightTracks;
  cam.start = t3(start);
  cam.duration = t3(at - start);
  cam.path = keysForRange(cam.path, start, at, 2);
  cam.tracks = leftTracks;

  const index = p.cameras.indexOf(cam);
  p.cameras.splice(index + 1, 0, right);
  const orderIndex = p.cameraOrder.indexOf(cam.id);
  if (orderIndex >= 0) p.cameraOrder.splice(orderIndex + 1, 0, right.id);
  else p.cameraOrder.push(right.id);
  p.activeCameraId = right.id;
  p.camera = right;
  return right;
}

/** Move / trim a camera clip. Moving carries its path and parameter keys. */
function moveCameraClip(p, cam, op) {
  const hadDuration = Number.isFinite(Number(cam.duration));
  const oldRange = cameraRange(p, cam);
  const oldStart = oldRange.start;
  let start = oldStart;
  let duration = oldRange.duration;

  if (op.start != null) {
    const s0 = Number(op.start);
    if (!Number.isFinite(s0)) fail('moveElement start must be a number');
    start = Math.max(0, s0);
  }
  if (op.duration != null) {
    const d0 = Number(op.duration);
    if (!Number.isFinite(d0)) fail('moveElement duration must be a number');
    duration = Math.max(1 / 120, d0);
  } else if (op.start != null && !hadDuration) {
    // A start-only move of a legacy full-length camera keeps its length instead
    // of letting the implicit end follow the project duration.
    duration = oldRange.duration;
  }

  const dt = start - oldStart;
  const trim = Math.abs(duration - oldRange.duration) > 1e-6;
  const carry = op.keys === 'shift' || (op.keys !== 'keep' && !trim);
  if (carry) shiftCameraTiming(cam, dt);

  cam.start = t3(start);
  cam.duration = t3(duration);
  return cam;
}

// ---------------------------------------------------------------- v3 objects

function rootScene(p, create = false) {
  if (!p.scene || typeof p.scene !== 'object') {
    if (!create) return null;
    p.scene = { version: SCENE_VERSION, units: 'm', objects: [], annotations: [] };
  }
  if (!Array.isArray(p.scene.objects)) p.scene.objects = [];
  return p.scene;
}

function findObj(p, id) {
  const obj = rootScene(p)?.objects?.find((o) => o.id === id);
  if (!obj) fail(`no object ${id}`);
  return obj;
}

const VEC_TRACKS = new Set(['pivot', 'position', 'scale']);
const DIR_TRACKS = new Set(['dir']);
const SCALAR_TRACKS = new Set([
  'roll', 'opacity',
  'scale.x', 'scale.y', 'scale.z',
  'pivot.x', 'pivot.y', 'pivot.z',
  'position.x', 'position.y', 'position.z',
]);

function trackValue(path, v) {
  if (VEC_TRACKS.has(path) || DIR_TRACKS.has(path)) {
    if (!Array.isArray(v) || v.length < 3 || !v.slice(0, 3).every((n) => Number.isFinite(Number(n)))) {
      fail(`${path} needs [x,y,z]`);
    }
    let a = v.slice(0, 3).map(Number);
    if (DIR_TRACKS.has(path)) {
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      a = a.map((n) => n / l);
    }
    return a;
  }
  if (SCALAR_TRACKS.has(path)) {
    if (!Number.isFinite(Number(v))) fail(`${path} needs a number`);
    return Number(v);
  }
  fail(`unknown track path ${path}`);
}

/** Normalize a speed polyline: u clamped to 0..1, v >= 0, at least 2 points. */
function normSpeed(pts) {
  if (!Array.isArray(pts)) return null;
  const list = pts
    .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .map((p) => [Math.max(0, Math.min(1, Number(p[0]))), Math.max(0, Number(p[1]))]);
  return list.length >= 2 ? list : null;
}

export function coerceValue(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { return JSON.parse(s); } catch { return value; }
  }
  return value;
}

/**
 * Apply one op in place. Returns { changed: string[], undo?: object }.
 * Ops never touch disk.
 */
export function applyOp(p, op) {
  if (!op || typeof op !== 'object') fail('op must be an object');
  const kind = op.op;
  if (!kind) fail('op.op missing');
  const changed = [];

  switch (kind) {
    case 'addElement': {
      const el = op.element;
      if (!isObj(el)) fail('addElement needs element object');
      if (!el.type || !ELEMENT_TYPES.includes(el.type)) fail(`bad element type ${el.type}`);
      const ids = allIds(p);
      if (!el.id) el.id = newId('el', ids);
      else if (ids.has(el.id)) fail(`id ${el.id} already used`);
      const full = {
        id: el.id,
        name: el.name || (el.type === 'text'
          ? (el.style?.text || 'text')
          : el.type === 'audio'
            ? String(el.src || '').split('/').pop() || '声音'
            : el.type),
        type: el.type,
        src: el.src || '',
        segment: el.segment || null,
        start: Number(el.start ?? 0),
        duration: Number(el.duration ?? 1),
        z: Number.isFinite(el.z) ? el.z : (p.elements.reduce((m, e) => Math.max(m, e.z), -1) + 1),
        transform: { ...DEFAULT_TRANSFORM, ...(el.transform || {}) },
        style: { ...DEFAULT_STYLE, ...(el.style || {}) },
        fx: { glow: 0, ...(el.fx || {}) },
        motion: { type: 'none', amount: 0, dir: 'in', ...(el.motion || {}) },
        keyframes: Array.isArray(el.keyframes) ? el.keyframes : [],
        visible: el.visible !== false,
        meta: el.meta || {},
      };
      if (full.type === 'video' || full.type === 'audio') {
        full.srcIn = Math.max(0, Number(el.srcIn) || 0);
      }
      if (full.type === 'audio') {
        const v = el.volume == null ? 1 : Number(el.volume);
        full.volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
      }
      if (!(full.duration > 0)) fail('element duration must be > 0');
      if (full.type === 'audio' && !full.src) fail('audio element needs src');
      if (full.segment && !p.segments.some((s) => s.id === full.segment)) fail(`unknown segment ${full.segment}`);
      p.elements.push(full);
      p.elements.sort((a, b) => a.z - b.z || a.start - b.start);
      changed.push(full.id);
      return { changed, element: full };
    }

    case 'updateElement': {
      const el = findEl(p, op.id);
      let patch = op.patch;
      if (typeof patch === 'string') patch = { [patch]: op.value };
      if (!isObj(patch)) fail('updateElement needs patch object');
      const next = deepMerge(el, patch);
      if (next.segment && !p.segments.some((s) => s.id === next.segment)) fail(`unknown segment ${next.segment}`);
      Object.keys(next).forEach((k) => { el[k] = next[k]; });
      if (next.z !== undefined) p.elements.sort((a, b) => a.z - b.z || a.start - b.start);
      changed.push(el.id);
      return { changed, element: el };
    }

    case 'set': {
      const el = findEl(p, op.id);
      setPath(el, op.path, coerceValue(op.value));
      changed.push(el.id);
      return { changed };
    }

    case 'removeElement': {
      const id = typeof op === 'string' ? op : op.id;
      const i = p.elements.findIndex((e) => e.id === id);
      if (i < 0) fail(`no element ${id}`);
      p.elements.splice(i, 1);
      return { changed: [id] };
    }

    case 'duplicateElement': {
      const src = findEl(p, op.id);
      const ids = allIds(p);
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = newId('el', ids);
      copy.name = `${src.name} copy`;
      copy.start = Math.max(0, op.start != null ? Number(op.start) : src.start + Number(op.offset ?? 0));
      if (!Number.isFinite(copy.start)) fail('duplicateElement start must be a number');
      copy.z = src.z + 0.5;
      shiftTiming(copy, copy.start - src.start);
      p.elements.push(copy);
      return { changed: [copy.id], element: copy };
    }

    case 'moveElement': {
      // start only (or start with the same duration) = move: keyframes travel along.
      // start + new duration = left trim: content stays put in time, video skips ahead.
      // `keys: "shift" | "keep"` overrides the guess.
      const cam = cameraClipById(p, op.id);
      if (cam) {
        moveCameraClip(p, cam, op);
        return { changed: [cam.id], element: cam };
      }
      const el = findEl(p, op.id);
      const oldStart = el.start;
      const oldDur = el.duration;
      if (op.start != null) {
        const s0 = Number(op.start);
        if (!Number.isFinite(s0)) fail('moveElement start must be a number');
        el.start = Math.max(0, s0);
      }
      if (op.duration != null) {
        const d0 = Number(op.duration);
        if (!Number.isFinite(d0)) fail('moveElement duration must be a number');
        el.duration = Math.max(1 / 120, d0);
      }
      if (op.z != null) el.z = Number(op.z);
      if (op.segment !== undefined) {
        if (op.segment && !p.segments.some((s) => s.id === op.segment)) fail(`unknown segment ${op.segment}`);
        el.segment = op.segment || null;
      }
      const dt = el.start - oldStart;
      if (Math.abs(dt) > 1e-9) {
        const trim = Math.abs(el.duration - oldDur) > 1e-6;
        const carry = op.keys === 'shift' || (op.keys !== 'keep' && !trim);
        if (carry) shiftTiming(el, dt);
        else if (el.type === 'video' || el.type === 'audio') el.srcIn = t3(Math.max(0, (Number(el.srcIn) || 0) + dt));
      }
      changed.push(el.id);
      return { changed, element: el };
    }

    case 'splitElement': {
      const at = t3(Number(op.at));
      if (!Number.isFinite(at)) fail('splitElement needs at');
      const cam = cameraClipById(p, op.id);
      if (cam) {
        const right = splitCameraOne(p, cam, at);
        return { changed: [cam.id, right.id], camera: right };
      }
      const el = findEl(p, op.id);
      if (!(at > el.start + 0.02 && at < el.start + el.duration - 0.02)) fail('split point outside element');
      const right = splitOne(p, el, at);
      p.elements.push(right);
      return { changed: [el.id, right.id], element: right };
    }

    case 'splitAt': {
      // Split every target that crosses the playhead in one undo step. The
      // right half is inserted directly above its source in layer order; this
      // is the UI's "cut" action (button on the playhead / Ctrl+D).
      const at = t3(Number(op.at));
      if (!Number.isFinite(at)) fail('splitAt needs at');
      const wanted = Array.isArray(op.ids) && op.ids.length
        ? new Set(op.ids.map(String))
        : (op.id ? new Set([String(op.id)]) : null);
      const ordered = p.elements.slice().sort((a, b) => a.z - b.z || a.start - b.start);
      const targets = new Set();
      for (const el of ordered) {
        if (wanted && !wanted.has(el.id)) continue;
        if (at > el.start + 0.02 && at < el.start + el.duration - 0.02) targets.add(el);
      }
      if (!targets.size) fail(wanted ? 'splitAt: selected elements do not cross the playhead' : 'splitAt: no element crosses the playhead');
      const ids = allIds(p);
      const out = [];
      const rights = [];
      for (const el of ordered) {
        out.push(el);
        if (!targets.has(el)) continue;
        const right = splitOne(p, el, at, ids);
        out.push(right);
        rights.push(right);
      }
      out.forEach((el, i) => { el.z = i; });
      p.elements = out;
      return { changed: rights.map((r) => r.id), elements: rights };
    }

    case 'reorder': {
      const el = findEl(p, op.id);
      el.z = Number(op.z ?? el.z + (op.delta ?? 1));
      return { changed: [el.id] };
    }

    case 'addSegment': {
      const s = op.segment || {};
      const ids = allIds(p);
      if (!s.id) s.id = newId('seg', ids);
      else if (ids.has(s.id)) fail(`id ${s.id} already used`);
      const seg = {
        id: s.id,
        name: s.name || `seg ${p.segments.length + 1}`,
        start: Number(s.start ?? 0),
        duration: Number(s.duration ?? 2),
        intent: s.intent || '',
        status: s.status || 'draft',
      };
      if (!(seg.duration > 0)) fail('segment duration must be > 0');
      p.segments.push(seg);
      p.segments.sort((a, b) => a.start - b.start);
      return { changed: [seg.id], segment: seg };
    }

    case 'updateSegment': {
      const seg = findSeg(p, op.id);
      const patch = typeof op.patch === 'string' ? { [op.patch]: op.value } : op.patch;
      const next = deepMerge(seg, patch || {});
      Object.keys(next).forEach((k) => { seg[k] = next[k]; });
      if (op.start != null) seg.start = Number(op.start);
      if (op.duration != null) seg.duration = Number(op.duration);
      return { changed: [seg.id], segment: seg };
    }

    case 'removeSegment': {
      const seg = findSeg(p, op.id);
      p.segments = p.segments.filter((s) => s.id !== seg.id);
      // detach elements (keep them, just unassign)
      p.elements.forEach((e) => { if (e.segment === seg.id) e.segment = null; });
      return { changed: [seg.id] };
    }

    case 'setMeta': {
      const k = op.path;
      if (!k) fail('setMeta needs path');
      setPath(p.meta, k, coerceValue(op.value));
      return { changed: ['meta'] };
    }

    case 'setFx': {
      const fx = op.fx || {};
      p.meta.fx = { ...DEFAULT_FX, ...(p.meta.fx || {}), ...fx };
      return { changed: ['meta'] };
    }

    case 'keySet': {
      const el = findEl(p, op.id);
      if (!op.path) fail('keySet needs path');
      const t = Math.round(Number(op.t) * 1000) / 1000;
      if (!Number.isFinite(t)) fail('keySet needs t');
      const old = (el.keyframes || []).find((k) => k.path === op.path && Math.abs(k.t - t) < 1e-4);
      const kf = { t, path: op.path, value: coerceValue(op.value), ease: op.ease || old?.ease || 'easeInOut' };
      if (old?.curve) kf.curve = old.curve;
      el.keyframes = (el.keyframes || []).filter((k) => !(k.path === kf.path && Math.abs(k.t - t) < 1e-4));
      el.keyframes.push(kf);
      el.keyframes.sort((a, b) => a.t - b.t);
      return { changed: [el.id], keyframe: kf };
    }

    case 'keyRemove': {
      // with t: remove the one key at that time; without: clear the whole track
      const el = findEl(p, op.id);
      if (!op.path) fail('keyRemove needs path');
      // `t` deletes one key; without it the whole path goes (legacy callers).
      const t = op.t == null ? null : Math.round(Number(op.t) * 1000) / 1000;
      if (t != null && !Number.isFinite(t)) fail('keyRemove needs a finite t');
      el.keyframes = (el.keyframes || []).filter((k) => k.path !== op.path
        || (t != null && Math.abs(k.t - t) > 1e-4));
      return { changed: [el.id] };
    }

    case 'keyCurve': {
      // Attach (or clear, with curve=null) a value curve to the keyframe that
      // starts the segment [from, to). Stored on the left key.
      // Camera flights use the same op with path='path': the curve spans
      // several path keys and retimes the inner ones (arc-length timing).
      const host = String(op.host || 'element');
      const path = String(op.path || '');
      if (!path) fail('keyCurve needs path');
      const from = Math.round(Number(op.from) * 1000) / 1000;
      const to = Math.round(Number(op.to) * 1000) / 1000;
      if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) fail('keyCurve needs from < to');
      const curve = normalizeCurve(op.curve);
      if (host === 'camera' && path === 'path') {
        if (op.curve != null && !curve) fail('keyCurve: invalid curve');
        const cam = cameraById(p, op.id);
        const keys = cam.path || (cam.path = []);
        keys.sort((a, b) => a.t - b.t);
        const li = keys.findIndex((k) => Math.abs(Number(k.t) - from) <= 1e-4);
        const ri = keys.findIndex((k) => Math.abs(Number(k.t) - to) <= 1e-4);
        if (li < 0) fail(`keyCurve: no path key at ${from}`);
        if (ri <= li) fail(`keyCurve: no path key at ${to}`);
        if (curve) {
          // A span owns the timing between its endpoints; overlapping spans
          // would fight over the same keys.
          for (const k of keys) {
            if (k === keys[li] || !k.curve || !Number.isFinite(Number(k.spanTo))) continue;
            if (Number(k.spanTo) > from && Number(k.t) < to) fail('keyCurve: path spans overlap');
          }
          const retime = retimePathSpan(cam, from, to, curve);
          if (retime?.times?.length) {
            retime.times.forEach((nt, j) => { if (keys[li + 1 + j]) keys[li + 1 + j].t = nt; });
          }
          keys[li].curve = curve;
          keys[li].spanTo = to;
          keys.sort((a, b) => a.t - b.t);
        } else {
          delete keys[li].curve;
          delete keys[li].spanTo;
        }
        return { changed: ['camera', cam.id] };
      }
      let keys;
      let changedId;
      if (host === 'element') {
        const el = findEl(p, op.id);
        keys = el.keyframes || (el.keyframes = []);
        changedId = el.id;
      } else if (host === 'object') {
        const o = findObj(p, op.id);
        const tracks = o.tracks || (o.tracks = {});
        keys = tracks[path] || (tracks[path] = []);
        changedId = o.id;
      } else if (host === 'camera') {
        const cam = cameraById(p, op.id);
        const tracks = cam.tracks || (cam.tracks = {});
        keys = tracks[path] || (tracks[path] = []);
        changedId = cam.id;
      } else {
        fail(`keyCurve host ${host} is not supported`);
      }
      const key = keys.find((k) => Math.abs(Number(k.t) - from) <= 1e-4);
      if (!key) fail(`keyCurve: no keyframe at ${from}`);
      const hasNext = keys.some((k) => Number(k.t) > from && Math.abs(Number(k.t) - to) <= 1e-4);
      if (!hasNext) fail(`keyCurve: no keyframe at ${to}`);
      if (curve) key.curve = curve;
      else delete key.curve;
      return { changed: [changedId] };
    }

    case 'cameraKey': {
      if (!Array.isArray(op.pos) || op.pos.length !== 3) fail('cameraKey needs pos:[x,y,z]');
      const t = Math.round(Number(op.t) * 1000) / 1000;
      if (!Number.isFinite(t)) fail('cameraKey needs t');
      const cam = activeCamera(p, true);
      // Keep the existing curve shape when only the position is being edited.
      const old = (cam.path || []).find((k) => Math.abs(k.t - t) <= 1e-4);
      cam.path = (cam.path || []).filter((k) => Math.abs(k.t - t) > 1e-4);
      const entry = {
        t,
        pos: op.pos.map(Number),
        look: Array.isArray(op.look) && op.look.length === 3 ? op.look.map(Number) : null,
        fov: op.fov != null ? Number(op.fov) : null,
        ease: op.ease != null ? String(op.ease) : (old?.ease ?? null),
      };
      const out = Array.isArray(op.out) ? op.out.map(Number) : (Array.isArray(old?.out) ? old.out : null);
      const inn = Array.isArray(op.in) ? op.in.map(Number) : (Array.isArray(old?.in) ? old.in : null);
      if (out) entry.out = out;
      if (inn) entry.in = inn;
      const speed = op.speed === null
        ? null
        : (Array.isArray(op.speed) ? normSpeed(op.speed) : (Array.isArray(old?.speed) ? old.speed : null));
      if (speed) entry.speed = speed;
      if (old?.curve) entry.curve = old.curve;
      if (Number.isFinite(Number(old?.spanTo))) entry.spanTo = Number(old.spanTo);
      cam.path.push(entry);
      cam.path.sort((a, b) => a.t - b.t);
      retimeCamSpans(cam);
      return { changed: ['camera', cam.id] };
    }

    case 'cameraRemove': {
      // `id` targets a specific camera (timeline keyframe deletion); without
      // it the active camera is used, which is what the path gizmo expects.
      const cam = op.id ? cameraById(p, op.id) : activeCamera(p);
      if (!cam) fail('no camera');
      const t = Math.round(Number(op.t) * 1000) / 1000;
      if (!Number.isFinite(t)) fail('cameraRemove needs a finite t');
      cam.path = (cam.path || []).filter((k) => Math.abs(k.t - t) > 1e-4);
      cleanupPathSpans(cam);
      retimeCamSpans(cam);
      return { changed: ['camera', cam.id] };
    }

    case 'cameraSet': {
      const cam = activeCamera(p, true);
      const patch = op.patch || {};
      const next = deepMerge(cam, patch);
      Object.keys(next).forEach((k) => { cam[k] = next[k]; });
      clampCameraPicture(cam);
      if (Array.isArray(cam.path)) {
        cam.path.sort((a, b) => a.t - b.t);
        cleanupPathSpans(cam);
        retimeCamSpans(cam);
      }
      return { changed: ['camera', cam.id] };
    }

    case 'cameraPath': {
      // Whole-path write used by the 3D viewport (drag a node / pull a handle).
      if (!Array.isArray(op.path)) fail('cameraPath needs path[]');
      const cam = activeCamera(p, true);
      cam.path = op.path
        .filter((k) => k && Array.isArray(k.pos) && k.pos.length === 3 && Number.isFinite(Number(k.t)))
        .map((k) => {
          const t = Math.round(Number(k.t) * 1000) / 1000;
          const old = (cam.path || []).find((o) => Math.abs(Number(o.t) - t) <= 1e-4);
          const curve = normalizeCurve(k.curve ?? old?.curve);
          const entry = {
            t,
            pos: k.pos.map(Number),
            look: Array.isArray(k.look) && k.look.length === 3 ? k.look.map(Number) : null,
            fov: k.fov != null ? Number(k.fov) : null,
            ease: k.ease ? String(k.ease) : null,
            out: Array.isArray(k.out) && k.out.length === 3 ? k.out.map(Number) : null,
            in: Array.isArray(k.in) && k.in.length === 3 ? k.in.map(Number) : null,
            speed: normSpeed(k.speed),
          };
          if (curve) {
            entry.curve = curve;
            const spanTo = Number(k.spanTo ?? old?.spanTo);
            if (Number.isFinite(spanTo)) entry.spanTo = spanTo;
          }
          return entry;
        })
        .sort((a, b) => a.t - b.t);
      cleanupPathSpans(cam);
      retimeCamSpans(cam);
      return { changed: ['camera', cam.id] };
    }

    case 'cameraPatch': {
      ensureCameraStack(p);
      const cam = p.cameras.find((c) => c.id === op.id);
      if (!cam) fail(`no camera ${op.id}`);
      const next = deepMerge(cam, op.patch || {});
      Object.keys(next).forEach((k) => { cam[k] = next[k]; });
      clampCameraPicture(cam);
      if (cam.id === p.activeCameraId) p.camera = cam;
      return { changed: ['camera', cam.id] };
    }

    case 'cameraParamKey': {
      const cam = cameraById(p, op.id) || activeCamera(p, true);
      if (!cam) fail('no camera');
      const path = String(op.path || '');
      const t = Math.round(Number(op.t) * 1000) / 1000;
      if (!Number.isFinite(t) || t < 0) fail('cameraParamKey needs t >= 0');
      const tracks = cam.tracks || (cam.tracks = {});
      const old = (tracks[path] || []).find((k) => Math.abs(k.t - t) <= 1e-4);
      const key = { t, v: cameraTrackValue(path, op.v !== undefined ? op.v : op.value) };
      if (op.ease) key.ease = String(op.ease);
      else if (old?.ease) key.ease = old.ease;
      tracks[path] = (tracks[path] || [])
        .filter((k) => Math.abs(k.t - t) > 1e-4)
        .concat(key)
        .sort((a, b) => a.t - b.t);
      return { changed: ['camera', cam.id], key };
    }

    case 'cameraParamUnkey': {
      const cam = cameraById(p, op.id);
      if (!cam) fail('no camera');
      const path = String(op.path || '');
      if (!CAMERA_TRACK_DIMS[path]) fail(`camera ${path} is not a keyed property`);
      const t = Math.round(Number(op.t) * 1000) / 1000;
      if (!Number.isFinite(t)) fail('cameraParamUnkey needs t');
      const tracks = cam.tracks || {};
      if (!Array.isArray(tracks[path])) return { changed: [] };
      const left = tracks[path].filter((k) => Math.abs(k.t - t) > 1e-4);
      if (left.length) tracks[path] = left;
      else delete tracks[path];
      return { changed: ['camera', cam.id] };
    }

    case 'addCamera': {
      ensureCameraStack(p);
      const src = isObj(op.camera) ? op.camera : {};
      const taken = new Set(p.cameras.map((c) => c.id));
      const id = src.id && !taken.has(String(src.id)) ? String(src.id) : newId('cam', taken);
      const cam = normalizeCamera({ ...src, id });
      cam.name = src.name || `相机 ${p.cameras.length + 1}`;
      const at = Math.max(0, Math.min(p.cameras.length, Number.isFinite(Number(op.index)) ? Number(op.index) : 0));
      p.cameras.splice(at, 0, cam);
      p.cameraOrder.splice(at, 0, cam.id);
      p.activeCameraId = cam.id;
      p.camera = cam;
      return { changed: ['cameras', cam.id], camera: cam };
    }

    case 'removeCamera': {
      ensureCameraStack(p);
      const id = op.id;
      const i = p.cameras.findIndex((c) => c.id === id);
      if (i < 0) fail(`no camera ${id}`);
      const [cam] = p.cameras.splice(i, 1);
      p.cameraOrder = p.cameraOrder.filter((x) => x !== cam.id);
      if (p.activeCameraId === cam.id) {
        const next = p.cameras.find((c) => c.id === p.cameraOrder[0]) || p.cameras[0] || null;
        p.camera = next;
        p.activeCameraId = next ? next.id : null;
      } else if (p.camera === cam) {
        p.camera = p.cameras.find((c) => c.id === p.activeCameraId) || p.cameras[0] || null;
      }
      return { changed: ['cameras', cam.id] };
    }

    case 'reorderCamera': {
      ensureCameraStack(p);
      const id = op.id;
      const cam = p.cameras.find((c) => c.id === id);
      if (!cam) fail(`no camera ${id}`);
      const from = p.cameras.indexOf(cam);
      const want = Number(op.index);
      if (!Number.isFinite(want)) fail('reorderCamera needs index');
      const to = Math.max(0, Math.min(p.cameras.length - 1, want));
      p.cameras.splice(from, 1);
      p.cameras.splice(to, 0, cam);
      p.cameraOrder = p.cameras.map((c) => c.id);
      return { changed: ['cameras', cam.id] };
    }

    case 'activateCamera': {
      ensureCameraStack(p);
      const cam = p.cameras.find((c) => c.id === op.id);
      if (!cam) fail(`no camera ${op.id}`);
      p.activeCameraId = cam.id;
      p.camera = cam;
      return { changed: ['camera', cam.id] };
    }

    case 'worldSet': {
      p.world = deepMerge(p.world || {}, op.patch || {});
      return { changed: ['world'] };
    }

    case 'objectAdd': {
      const scene = rootScene(p, true);
      const src = isObj(op.object) ? op.object : {};
      const obj = normalizeObject(src);
      const taken = new Set(scene.objects.map((o) => o.id));
      if (obj.id) { if (taken.has(obj.id)) fail(`object ${obj.id} already exists`); }
      else obj.id = newId('ob', taken);
      const total = Number(p.meta?.duration) || 12;
      obj.start = Math.max(0, Math.min(total, Number(src.start) || 0));
      const remain = total - obj.start || total;
      const want = Number(src.duration);
      obj.duration = Math.max(0.001, Math.min(remain, Number.isFinite(want) && want > 0 ? want : remain));
      const g = isObj(src.geom) ? src.geom : {};
      obj.geom = {
        w: Math.max(0.01, Number(g.w) || 2),
        h: Math.max(0.01, Number(g.h) || 2),
        d: Math.max(0.01, Number(g.d) || 2),
      };
      if (isObj(src.style)) obj.style = { ...src.style };
      scene.objects.push(obj);
      return { changed: [obj.id, 'scene'] };
    }

    case 'objectRemove': {
      const scene = rootScene(p);
      const i = scene?.objects?.findIndex((o) => o.id === op.id) ?? -1;
      if (i < 0) fail(`no object ${op.id}`);
      scene.objects.splice(i, 1);
      return { changed: [op.id, 'scene'] };
    }

    case 'objectPatch': {
      const obj = findObj(p, op.id);
      const patch = isObj(op.patch) ? op.patch : {};
      delete patch.id;
      delete patch.tracks;
      const next = deepMerge(obj, patch);
      const norm = normalizeObject({ ...next, id: obj.id, tracks: obj.tracks });
      Object.keys(obj).forEach((k) => { delete obj[k]; });
      Object.assign(obj, norm);
      return { changed: [obj.id] };
    }

    case 'objectKey': {
      const obj = findObj(p, op.id);
      const path = String(op.path || '');
      const t = Math.round(Number(op.t) * 1000) / 1000;
      if (!Number.isFinite(t) || t < 0) fail('objectKey needs t >= 0');
      const key = { t, v: trackValue(path, op.v !== undefined ? op.v : op.value) };
      const old = (obj.tracks?.[path] || []).find((k) => Math.abs(k.t - t) <= 1e-4);
      if (op.ease) key.ease = String(op.ease);
      else if (old?.ease) key.ease = old.ease;
      if (VEC_TRACKS.has(path) || DIR_TRACKS.has(path)) {
        for (const h of ['out', 'in']) {
          if (Array.isArray(op[h]) && op[h].length === 3) key[h] = op[h].map(Number);
          else if (Array.isArray(old?.[h]) && old[h].length === 3) key[h] = old[h].slice();
        }
      }
      if (op.speed === null) {
        // explicit clear
      } else if (Array.isArray(op.speed)) {
        const pts = op.speed
          .filter((pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(Number(pt[0])) && Number.isFinite(Number(pt[1])))
          .map((pt) => [Math.max(0, Math.min(1, Number(pt[0]))), Math.max(0, Number(pt[1]))]);
        if (pts.length >= 2) key.speed = pts;
      } else if (Array.isArray(old?.speed)) {
        key.speed = old.speed.map((pt) => pt.slice());
      }
      const tracks = obj.tracks || (obj.tracks = {});
      tracks[path] = (tracks[path] || [])
        .filter((k) => Math.abs(k.t - t) > 1e-4)
        .concat(key)
        .sort((a, b) => a.t - b.t);
      return { changed: [obj.id], key };
    }

    case 'objectUnkey': {
      const obj = findObj(p, op.id);
      const path = String(op.path || '');
      const t = Math.round(Number(op.t) * 1000) / 1000;
      const tracks = obj.tracks || {};
      if (!Array.isArray(tracks[path])) return { changed: [] };
      const left = tracks[path].filter((k) => Math.abs(k.t - t) > 1e-4);
      if (left.length) tracks[path] = left;
      else delete tracks[path];
      return { changed: [obj.id] };
    }

    case 'batch': {
      const results = (op.ops || []).map((o) => applyOp(p, o));
      return { changed: results.flatMap((r) => r.changed) };
    }

    default: {
      // Feature modules register their ops through core/ops-ext.js instead of
      // editing this switch. They get the same validation helpers core ops use.
      const ext = applyExtOp(p, op, {
        fail,
        deepMerge,
        getPath,
        setPath,
        newId,
        coerceValue,
        findElement: (id) => findEl(p, id),
        findObject: (id) => findObj(p, id),
        findCamera: (id) => cameraById(p, id),
      });
      if (ext) return ext;
      fail(`unknown op ${kind}`);
    }
  }
}

export function applyOps(p, ops) {
  const changed = new Set();
  for (const op of ops) {
    const r = applyOp(p, op);
    (r.changed || []).forEach((c) => changed.add(c));
  }
  // keep elements ordered by z for rendering
  p.elements.sort((a, b) => a.z - b.z || a.start - b.start);
  if ((ops || []).some(touchesTiming)) syncDuration(p);
  return { changed: [...changed] };
}
