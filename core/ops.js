// Edit operations: the ONE way anything (UI, CLI, AI) mutates a project.
// Ops are plain JSON so they can be logged, replayed, diffed and undone.
import { DEFAULT_TRANSFORM, DEFAULT_STYLE, DEFAULT_FX, ELEMENT_TYPES, newId } from './schema.js';
import { SCENE_VERSION, normalizeObject } from './scene.js';
import { normalizeCamera } from './camera.js';

export const OP_KINDS = [
  'addElement', 'updateElement', 'set', 'removeElement', 'moveElement',
  'splitElement', 'duplicateElement', 'reorder', 'addSegment', 'updateSegment',
  'removeSegment', 'setMeta', 'setFx', 'keySet', 'keyRemove', 'batch',
  'cameraKey', 'cameraRemove', 'cameraSet', 'cameraPath', 'cameraPatch',
  'cameraParamKey', 'cameraParamUnkey', 'worldSet',
  'addCamera', 'removeCamera', 'reorderCamera', 'activateCamera',
  'objectAdd', 'objectRemove', 'objectPatch', 'objectKey', 'objectUnkey',
];

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

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
  return out;
}

function cameraById(p, id) {
  ensureCameraStack(p);
  if (!id) return p.camera || null;
  const cam = p.cameras.find((c) => c.id === String(id));
  if (!cam) fail(`no camera ${id}`);
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
        name: el.name || (el.type === 'text' ? (el.style?.text || 'text') : el.type),
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
      if (!(full.duration > 0)) fail('element duration must be > 0');
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
      copy.start = op.start != null ? Number(op.start) : src.start + (op.offset ?? 0);
      copy.z = src.z + 0.5;
      p.elements.push(copy);
      return { changed: [copy.id], element: copy };
    }

    case 'moveElement': {
      const el = findEl(p, op.id);
      if (op.start != null) el.start = Math.max(0, Number(op.start));
      if (op.duration != null) el.duration = Math.max(1 / 120, Number(op.duration));
      if (op.z != null) el.z = Number(op.z);
      if (op.segment !== undefined) el.segment = op.segment;
      changed.push(el.id);
      return { changed, element: el };
    }

    case 'splitElement': {
      const el = findEl(p, op.id);
      const at = Number(op.at);
      if (!(at > el.start + 0.02 && at < el.start + el.duration - 0.02)) fail('split point outside element');
      const ids = allIds(p);
      const right = JSON.parse(JSON.stringify(el));
      right.id = newId('el', ids);
      right.start = at;
      right.duration = el.start + el.duration - at;
      // shift keyframes that belong to the right half
      right.keyframes = (right.keyframes || [])
        .filter((k) => k.t >= at)
        .map((k) => ({ ...k, t: k.t - at }));
      el.duration = at - el.start;
      el.keyframes = (el.keyframes || []).filter((k) => k.t < at);
      p.elements.push(right);
      return { changed: [el.id, right.id], element: right };
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
      const kf = { t, path: op.path, value: coerceValue(op.value), ease: op.ease || 'easeInOut' };
      el.keyframes = (el.keyframes || []).filter((k) => !(k.path === kf.path && Math.abs(k.t - t) < 1e-4));
      el.keyframes.push(kf);
      el.keyframes.sort((a, b) => a.t - b.t);
      return { changed: [el.id], keyframe: kf };
    }

    case 'keyRemove': {
      const el = findEl(p, op.id);
      // `t` deletes one key; without it the whole path goes (legacy callers).
      const t = op.t == null ? null : Math.round(Number(op.t) * 1000) / 1000;
      if (t != null && !Number.isFinite(t)) fail('keyRemove needs a finite t');
      el.keyframes = (el.keyframes || []).filter((k) => k.path !== op.path
        || (t != null && Math.abs(k.t - t) > 1e-4));
      return { changed: [el.id] };
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
      cam.path.push(entry);
      cam.path.sort((a, b) => a.t - b.t);
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
      return { changed: ['camera', cam.id] };
    }

    case 'cameraSet': {
      const cam = activeCamera(p, true);
      const patch = op.patch || {};
      const next = deepMerge(cam, patch);
      Object.keys(next).forEach((k) => { cam[k] = next[k]; });
      if (Array.isArray(cam.path)) cam.path.sort((a, b) => a.t - b.t);
      return { changed: ['camera', cam.id] };
    }

    case 'cameraPath': {
      // Whole-path write used by the 3D viewport (drag a node / pull a handle).
      if (!Array.isArray(op.path)) fail('cameraPath needs path[]');
      const cam = activeCamera(p, true);
      cam.path = op.path
        .filter((k) => k && Array.isArray(k.pos) && k.pos.length === 3 && Number.isFinite(Number(k.t)))
        .map((k) => ({
          t: Math.round(Number(k.t) * 1000) / 1000,
          pos: k.pos.map(Number),
          look: Array.isArray(k.look) && k.look.length === 3 ? k.look.map(Number) : null,
          fov: k.fov != null ? Number(k.fov) : null,
          ease: k.ease ? String(k.ease) : null,
          out: Array.isArray(k.out) && k.out.length === 3 ? k.out.map(Number) : null,
          in: Array.isArray(k.in) && k.in.length === 3 ? k.in.map(Number) : null,
          speed: normSpeed(k.speed),
        }))
        .sort((a, b) => a.t - b.t);
      return { changed: ['camera', cam.id] };
    }

    case 'cameraPatch': {
      ensureCameraStack(p);
      const cam = p.cameras.find((c) => c.id === op.id);
      if (!cam) fail(`no camera ${op.id}`);
      const next = deepMerge(cam, op.patch || {});
      Object.keys(next).forEach((k) => { cam[k] = next[k]; });
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

    default:
      fail(`unknown op ${kind}`);
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
  return { changed: [...changed] };
}
