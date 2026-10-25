// Edit operations: the ONE way anything (UI, CLI, AI) mutates a project.
// Ops are plain JSON so they can be logged, replayed, diffed and undone.
import { DEFAULT_TRANSFORM, DEFAULT_STYLE, DEFAULT_FX, ELEMENT_TYPES, newId } from './schema.js';

export const OP_KINDS = [
  'addElement', 'updateElement', 'set', 'removeElement', 'moveElement',
  'splitElement', 'duplicateElement', 'reorder', 'addSegment', 'updateSegment',
  'removeSegment', 'setMeta', 'setFx', 'keySet', 'keyRemove', 'batch',
  'cameraKey', 'cameraRemove', 'cameraSet', 'cameraPath', 'worldSet',
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

function findEl(p, id) {
  const el = p.elements.find((e) => e.id === id);
  if (!el) fail(`no element ${id}`);
  return el;
}

function findSeg(p, id) {
  const s = p.segments.find((x) => x.id === id);
  if (!s) fail(`no segment ${id}`);
  return s;
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
      el.keyframes = (el.keyframes || []).filter((k) => k.path !== op.path);
      return { changed: [el.id] };
    }

    case 'cameraKey': {
      if (!Array.isArray(op.pos) || op.pos.length !== 3) fail('cameraKey needs pos:[x,y,z]');
      const t = Math.round(Number(op.t) * 1000) / 1000;
      if (!Number.isFinite(t)) fail('cameraKey needs t');
      const cam = p.camera || (p.camera = { path: [] });
      cam.path = (cam.path || []).filter((k) => Math.abs(k.t - t) > 1e-4);
      cam.path.push({
        t,
        pos: op.pos.map(Number),
        look: Array.isArray(op.look) && op.look.length === 3 ? op.look.map(Number) : null,
        fov: op.fov != null ? Number(op.fov) : null,
      });
      cam.path.sort((a, b) => a.t - b.t);
      return { changed: ['camera'] };
    }

    case 'cameraRemove': {
      if (!p.camera) fail('no camera');
      const t = Math.round(Number(op.t) * 1000) / 1000;
      p.camera.path = (p.camera.path || []).filter((k) => Math.abs(k.t - t) > 1e-4);
      return { changed: ['camera'] };
    }

    case 'cameraSet': {
      const cam = p.camera || (p.camera = { path: [] });
      const patch = op.patch || {};
      const next = deepMerge(cam, patch);
      Object.keys(next).forEach((k) => { cam[k] = next[k]; });
      if (Array.isArray(cam.path)) cam.path.sort((a, b) => a.t - b.t);
      return { changed: ['camera'] };
    }

    case 'cameraPath': {
      // Whole-path write used by the 3D viewport (drag a node / pull a handle).
      if (!Array.isArray(op.path)) fail('cameraPath needs path[]');
      const cam = p.camera || (p.camera = { path: [] });
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
        }))
        .sort((a, b) => a.t - b.t);
      return { changed: ['camera'] };
    }

    case 'worldSet': {
      p.world = deepMerge(p.world || {}, op.patch || {});
      return { changed: ['world'] };
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
