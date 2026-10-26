// Project schema: defaults, normalisation, ids.
import { normalizeCamera } from './camera.js';
import { normalizeWorld } from './world.js';
// A "project" is the single source of truth on disk: <project>/project.vdm.json

export const SCHEMA = 'vdm.project/1';

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
  if (!p || typeof p !== 'object') throw new Error('project must be an object');
  p.schema = p.schema || SCHEMA;
  p.rev = Number.isFinite(p.rev) ? p.rev : 0;
  p.meta = p.meta || {};
  const m = p.meta;
  m.title = m.title || 'Untitled';
  m.fps = Number(m.fps) || 24;
  m.width = Number(m.width) || 1920;
  m.height = Number(m.height) || 1080;
  m.duration = Number(m.duration) || 12;
  m.background = m.background || '#05070d';
  m.audio = m.audio || null;
  m.beats = Array.isArray(m.beats) ? m.beats : [];
  m.tempo = Number(m.tempo) || 0;
  m.fx = { ...DEFAULT_FX, ...(m.fx || {}) };
  m.style = m.style || 'default';

  p.segments = Array.isArray(p.segments) ? p.segments : [];
  p.elements = Array.isArray(p.elements) ? p.elements : [];

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
    e.type = ELEMENT_TYPES.includes(e.type) ? e.type : 'solid';
    e.start = Number(e.start) || 0;
    e.duration = Number(e.duration) || 1;
    e.z = Number.isFinite(e.z) ? e.z : 0;
    e.transform = { ...DEFAULT_TRANSFORM, ...(e.transform || {}) };
    e.style = { ...DEFAULT_STYLE, ...(e.style || {}) };
    e.fx = { glow: 0, ...(e.fx || {}) };
    e.motion = { ...DEFAULT_MOTION, ...(e.motion || {}) };
    e.keyframes = Array.isArray(e.keyframes) ? e.keyframes : [];
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

/** Throwing validation. Returns list of problems instead when {collect:true}. */
export function validateProject(p) {
  const issues = [];
  const push = (path, msg) => issues.push({ path, msg });
  if (!p || typeof p !== 'object') return [{ path: '', msg: 'not an object' }];
  if (!p.meta) push('meta', 'missing meta');
  else {
    if (!(p.meta.fps > 0)) push('meta.fps', 'fps must be > 0');
    if (!(p.meta.width > 0)) push('meta.width', 'width must be > 0');
    if (!(p.meta.height > 0)) push('meta.height', 'height must be > 0');
    if (!(p.meta.duration > 0)) push('meta.duration', 'duration must be > 0');
  }
  const segIds = new Set();
  (p.segments || []).forEach((s, i) => {
    if (!s.id) push(`segments[${i}].id`, 'missing id');
    if (segIds.has(s.id)) push(`segments[${i}].id`, `duplicate id ${s.id}`);
    segIds.add(s.id);
    if (!(s.duration > 0)) push(`segments[${i}].duration`, 'duration must be > 0');
  });
  const ids = new Set();
  (p.elements || []).forEach((e, i) => {
    if (!e.id) push(`elements[${i}].id`, 'missing id');
    if (ids.has(e.id)) push(`elements[${i}].id`, `duplicate id ${e.id}`);
    ids.add(e.id);
    if (!ELEMENT_TYPES.includes(e.type)) push(`elements[${i}].type`, `unknown type ${e.type}`);
    if (!(e.duration > 0)) push(`elements[${i}].duration`, 'duration must be > 0');
    if (e.start < 0) push(`elements[${i}].start`, 'start must be >= 0');
    if (e.segment && !segIds.has(e.segment)) push(`elements[${i}].segment`, `unknown segment ${e.segment}`);
    (e.keyframes || []).forEach((k, j) => {
      if (typeof k.t !== 'number') push(`elements[${i}].keyframes[${j}].t`, 't must be a number');
      if (!k.path) push(`elements[${i}].keyframes[${j}].path`, 'missing path');
    });
  });
  const camIds = new Set();
  (p.cameras || []).forEach((c, i) => {
    if (!c.id) push(`cameras[${i}].id`, 'missing id');
    else if (camIds.has(c.id)) push(`cameras[${i}].id`, `duplicate id ${c.id}`);
    camIds.add(c.id);
    if (!Array.isArray(c.path)) push(`cameras[${i}].path`, 'path must be an array');
  });
  const order = Array.isArray(p.cameraOrder) ? p.cameraOrder : [];
  order.forEach((id, i) => {
    if (!camIds.has(id)) push(`cameraOrder[${i}]`, `unknown camera ${id}`);
  });
  if (p.activeCameraId != null && !camIds.has(p.activeCameraId)) {
    push('activeCameraId', `unknown camera ${p.activeCameraId}`);
  }
  return issues;
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
