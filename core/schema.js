// Project schema: defaults, normalisation, ids.
import { normalizeCamera } from './camera.js';
import { normalizeWorld } from './world.js';
import { OBJECT_TYPES } from './scene.js';
import { assertSafeData, isRecord, pathParts } from './json.js';
import { PROJECT_SCHEMA } from './version.js';
// A "project" is the single source of truth on disk: <project>/project.vdm.json

export const SCHEMA = PROJECT_SCHEMA;

export const ELEMENT_TYPES = ['image', 'video', 'text', 'solid', 'shape'];
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

const clone = (o) => JSON.parse(JSON.stringify(o));

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

  p.segments ??= [];
  p.elements ??= [];
  if (!Array.isArray(p.segments) || !Array.isArray(p.elements)
    || !p.segments.every(isRecord) || !p.elements.every(isRecord)) {
    throw Object.assign(new Error('segments and elements must be arrays of objects'), { code: 'OP_INVALID' });
  }

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
    e.style = { ...DEFAULT_STYLE, ...(e.style || {}) };
    e.fx = { glow: 0, ...(e.fx || {}) };
    e.motion = { ...DEFAULT_MOTION, ...(e.motion || {}) };
    e.keyframes ??= [];
    e.visible = e.visible !== false;
    e.name = e.name || (e.type === 'text' ? (e.style.text || 'text') : e.type);
    return e;
  });
  elIds.clear();
  p.elements.forEach((e) => elIds.add(e.id));

  normalizeCameraStack(p);
  p.world = normalizeWorld(p.world);
  return p;
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
    for (const name of ['fadeIn', 'fadeOut', 'srcIn', 'punch']) if (e[name] !== undefined) number(e[name], `${at}.${name}`, { min: 0 });
    if (e.transform !== undefined && record(e.transform, `${at}.transform`)) {
      for (const name of Object.keys(DEFAULT_TRANSFORM)) if (e.transform[name] !== undefined) number(e.transform[name], `${at}.transform.${name}`);
    }
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
    for (const name of ['center', 'scale']) if (c[name] !== undefined) vector(c[name], `${at}.${name}`, 3);
    array(c.path, `${at}.path`).forEach((key, j) => {
      const loc = `${at}.path[${j}]`;
      if (!record(key, loc)) return;
      number(key.t, `${loc}.t`, { min: 0 });
      vector(key.pos, `${loc}.pos`, 3);
      if (key.look != null) vector(key.look, `${loc}.look`, 3);
    });
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
      if (obj.geom !== undefined && record(obj.geom, `${at}.geom`)) for (const name of ['w', 'h', 'd']) number(obj.geom[name], `${at}.geom.${name}`, { min: 0, exclusive: true });
      tracks(obj.tracks, `${at}.tracks`);
    });
  }
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
