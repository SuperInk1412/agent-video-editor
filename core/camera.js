// Camera rig: Catmull-Rom path, auto look-ahead, banking, shake, fov.
// Pure math — used by the realtime viewport, the engine (bake for Blender) and the CLI.
import { clamp, speedWarp } from './time.js';
import { normalizeTracks, sampleAxes, sampleChannel, sampleVec3 } from './scene.js';
import { normalizeCurve, sampleCurve } from './curves.js';
import { firstArrival } from './curve-spans.js';
import { normalizeRotation } from './rotation.js';

export const DEFAULT_CAMERA = {
  id: null,
  name: '',
  fov: 62,
  near: 0.5,
  far: 5000,
  lookAhead: 90,
  bankGain: 1.2,
  maxRoll: 32,
  center: [0, 0, 0],
  opacity: 1,
  scale: [1, 1, 1],
  picturePivot: [0.5, 0.5],
  pictureOffset: [0, 0],
  tracks: {},
  visible: true,
  shake: { amp: 0.6, freq: 1.6, octaves: 3, speedGain: 1.0, seed: 7 },
  dof: { enabled: false, fstop: 2.8, focusOffset: 0 },
  motionBlur: { enabled: true, shutter: 0.5 },
  path: [],
};

const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u],
};
export { v3 };

/** deterministic 3D value noise (smooth, cheap, no deps) */
function hash3(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf), q = zf * zf * (3 - 2 * zf);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * w;
  const y1 = x01 + (x11 - x01) * w;
  return (y0 + (y1 - y0) * q) * 2 - 1;
}

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])];
}

function ease(name, p) {
  switch (name) {
    case 'linear': return p;
    case 'easeIn': return p * p;
    case 'easeOut': return 1 - (1 - p) * (1 - p);
    case 'smooth': return p * p * (3 - 2 * p);
    default: return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  }
}

const LOOK_FADE = 1.0;
const smooth01 = (u) => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Shortest spherical path between two unit directions. */
function slerpDir(a, b, u) {
  const d = clamp(v3.dot(a, b), -1, 1);
  if (d > 0.99999) return v3.norm(v3.lerp(a, b, u));
  if (d < -0.99999) {
    let axis = v3.cross(a, [0, 1, 0]);
    if (v3.len(axis) < 1e-6) axis = v3.cross(a, [1, 0, 0]);
    axis = v3.norm(axis);
    const th = Math.PI * u;
    return v3.norm(v3.add(v3.mul(a, Math.cos(th)), v3.mul(v3.cross(axis, a), Math.sin(th))));
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  if (Math.abs(s) < 1e-8) return a.slice();
  return v3.norm(v3.add(
    v3.mul(a, Math.sin((1 - u) * th) / s),
    v3.mul(b, Math.sin(u * th) / s),
  ));
}

/**
 * Manual look target at t plus how strongly it should override auto-look.
 * The old code held / switched hard at first.look.t ± 1 s; that snapped the
 * camera direction. Fade across the same one-second window instead.
 */
function manualLookAt(cam, t) {
  const looks = (cam.path || []).filter((k) => Array.isArray(k.look) && k.look.length >= 3);
  if (!looks.length) return null;
  const first = looks[0];
  const last = looks[looks.length - 1];
  if (t < first.t - LOOK_FADE) return null;
  if (looks.length > 1 && t > last.t + LOOK_FADE) return null;
  let weight;
  if (t < first.t) weight = smooth01((t - (first.t - LOOK_FADE)) / LOOK_FADE);
  else if (looks.length === 1) weight = 1; // a lone look target keeps aiming (static default camera)
  else if (t > last.t) weight = smooth01(((last.t + LOOK_FADE) - t) / LOOK_FADE);
  else weight = 1;
  let target;
  if (t <= first.t) {
    target = first.look.slice();
  } else if (t >= last.t) {
    target = last.look.slice();
  } else {
    for (let i = 0; i < looks.length - 1; i++) {
      if (t >= looks[i].t && t <= looks[i + 1].t) {
        const u = (t - looks[i].t) / Math.max(1e-6, looks[i + 1].t - looks[i].t);
        const s = smooth01(u);
        target = v3.lerp(looks[i].look, looks[i + 1].look, s);
        break;
      }
    }
  }
  return target ? { target, weight: clamp(weight, 0, 1) } : null;
}

const numVec = (v, n, dflt) => (Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(Number(x)))
  ? v.map(Number)
  : dflt.slice());

export function normalizeCamera(cam) {
  const c = { ...DEFAULT_CAMERA, ...(cam || {}) };
  c.fov = clamp(Number.isFinite(Number(c.fov)) ? Number(c.fov) : DEFAULT_CAMERA.fov, 1, 360);
  c.id = c.id != null ? String(c.id) : null;
  c.name = String(c.name || '');
  c.center = numVec(cam?.center, 3, DEFAULT_CAMERA.center);
  c.scale = numVec(cam?.scale, 3, DEFAULT_CAMERA.scale);
  c.picturePivot = numVec(cam?.picturePivot, 2, DEFAULT_CAMERA.picturePivot);
  c.pictureOffset = numVec(cam?.pictureOffset, 2, DEFAULT_CAMERA.pictureOffset);
  c.opacity = clamp(Number.isFinite(Number(c.opacity)) ? Number(c.opacity) : 1, 0, 1);
  // An absent range means "the whole project"; do not materialise defaults,
  // because the timeline and duration sync use presence to tell clips apart
  // from legacy full-length cameras.
  if (cam?.start != null && Number.isFinite(Number(cam.start))) c.start = Math.max(0, Number(cam.start));
  else delete c.start;
  if (cam?.duration != null && Number.isFinite(Number(cam.duration))) c.duration = Math.max(0.001, Number(cam.duration));
  else delete c.duration;
  c.tracks = normalizeTracks(cam?.tracks);
  // Three-axis rotation offset (core/rotation.js). A manual roll still adds
  // at runtime until core/rotation-migrate.js folds it in; a zero one is gone.
  if (!Number(c.roll) && !c.tracks.roll?.length) delete c.roll;
  if (Array.isArray(cam?.rotation) || c.roll === undefined) c.rotation = normalizeRotation(cam?.rotation);
  c.visible = c.visible !== false;
  c.shake = { ...DEFAULT_CAMERA.shake, ...(cam?.shake || {}) };
  c.dof = { ...DEFAULT_CAMERA.dof, ...(cam?.dof || {}) };
  c.motionBlur = { ...DEFAULT_CAMERA.motionBlur, ...(cam?.motionBlur || {}) };
  c.path = (Array.isArray(cam?.path) ? cam.path : [])
    .filter((k) => Array.isArray(k.pos) && k.pos.length === 3)
    .map((k) => {
      const curve = normalizeCurve(k.curve);
      const spanTo = Number.isFinite(Number(k.spanTo)) && Number(k.spanTo) > Number(k.t)
        ? Number(k.spanTo)
        : null;
      const out = {
        t: Number(k.t) || 0,
        pos: k.pos.map(Number),
        look: Array.isArray(k.look) ? k.look.map(Number) : null,
        fov: k.fov != null ? clamp(Number(k.fov), 1, 360) : null,
        ease: k.ease ? String(k.ease) : null,
        out: Array.isArray(k.out) && k.out.length === 3 ? k.out.map(Number) : null,
        in: Array.isArray(k.in) && k.in.length === 3 ? k.in.map(Number) : null,
        speed: Array.isArray(k.speed) && k.speed.length >= 2
          ? k.speed
            .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
            .map((p) => [clamp(Number(p[0]), 0, 1), Math.max(0, Number(p[1]))])
          : null,
      };
      // Span timing curve: only meaningful together with a right endpoint.
      if (curve && spanTo != null) {
        out.curve = curve;
        out.spanTo = spanTo;
      }
      return out;
    })
    .sort((a, b) => a.t - b.t);
  return c;
}

/** Cubic bezier point at u. */
function bez3(p0, p1, p2, p3, u) {
  const it = 1 - u;
  const a = it * it * it, b = 3 * it * it * u, c = 3 * it * u * u, d = u * u * u;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
  ];
}

// ---------------------------------------------------------------- path timing
// A span curve lives on the left key of a camera path span (`curve` + `spanTo`)
// and maps time-progress to *arc-length* progress along the whole path. The
// trajectory never changes: only the rate at which the camera travels it.
// Inner keys are retimed to their first forward arrival; their own ease/speed/
// curve is ignored while the span curve is active.

const ARC_SUBDIV = 32;
const ARC_CACHE = new WeakMap();

/** Geometry of one path segment (same handles as the legacy pathPos math). */
function segmentPoint(cam, i) {
  const keys = cam.path;
  const k1 = keys[i], k2 = keys[i + 1];
  const k0 = keys[Math.max(0, i - 1)], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const p1 = k1.pos, p2 = k2.pos;
  const out = k1.out || [(p2[0] - k0.pos[0]) / 6, (p2[1] - k0.pos[1]) / 6, (p2[2] - k0.pos[2]) / 6];
  const inn = k2.in || [-(k3.pos[0] - p1[0]) / 6, -(k3.pos[1] - p1[1]) / 6, -(k3.pos[2] - p1[2]) / 6];
  const c1 = [p1[0] + out[0], p1[1] + out[1], p1[2] + out[2]];
  const c2 = [p2[0] + inn[0], p2[1] + inn[1], p2[2] + inn[2]];
  return (s) => bez3(p1, c1, c2, p2, s);
}

function pathSignature(cam) {
  // Only geometry matters for the arc table; retiming the keys (span curves)
  // must not invalidate it.
  return cam.path.map((k) => `${k.pos.join(',')}|${k.out ? k.out.join(',') : ''}|${k.in ? k.in.join(',') : ''}`).join(';');
}

/** Cumulative arc length at every key + a 32-step table per segment. */
export function pathArcTable(cam) {
  const sig = pathSignature(cam);
  const hit = ARC_CACHE.get(cam);
  if (hit && hit.sig === sig) return hit.table;
  const keys = cam.path || [];
  const segments = [];
  const keyArc = [0];
  let total = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    const at = segmentPoint(cam, i);
    let prev = at(0);
    let len = 0;
    const arcs = [0];
    for (let j = 1; j <= ARC_SUBDIV; j++) {
      const cur = at(j / ARC_SUBDIV);
      len += v3.len(v3.sub(cur, prev));
      arcs.push(len);
      prev = cur;
    }
    segments.push({ len, arcs, at });
    total += len;
    keyArc.push(total);
  }
  const table = { segments, keyArc, total };
  ARC_CACHE.set(cam, { sig, table });
  return table;
}

/** Position at an absolute arc length along the path. */
export function pathPointAtArc(cam, arc) {
  const keys = cam.path || [];
  if (!keys.length) return [0, 20, 0];
  const table = pathArcTable(cam);
  if (keys.length === 1 || table.total <= 1e-9) return keys[0].pos.slice();
  const target = clamp(Number(arc), 0, table.total);
  let i = 0;
  while (i < table.segments.length - 1 && table.keyArc[i + 1] < target) i++;
  const seg = table.segments[i];
  if (seg.len <= 1e-9) return keys[i].pos.slice();
  const local = clamp(target - table.keyArc[i], 0, seg.len);
  let j = 1;
  while (j < seg.arcs.length - 1 && seg.arcs[j] < local) j++;
  const across = seg.arcs[j] - seg.arcs[j - 1];
  const frac = across > 1e-12 ? (local - seg.arcs[j - 1]) / across : 0;
  return seg.at((j - 1 + frac) / ARC_SUBDIV);
}

/** Active span curve for t (left key with `curve` + `spanTo`), or null. */
function spanAt(cam, t) {
  const keys = cam.path || [];
  for (let i = 0; i < keys.length - 1; i++) {
    const left = keys[i];
    if (!left.curve || !Number.isFinite(Number(left.spanTo))) continue;
    let ri = -1;
    for (let j = i + 1; j < keys.length; j++) {
      if (Math.abs(keys[j].t - Number(left.spanTo)) <= 1e-4) { ri = j; break; }
    }
    if (ri < 0) continue;
    if (t >= left.t && t <= keys[ri].t) return { i, ri, left, right: keys[ri] };
  }
  return null;
}

function spanPosition(cam, span, t) {
  const { i, ri, left, right } = span;
  const u = clamp((t - left.t) / Math.max(1e-6, right.t - left.t), 0, 1);
  const q = sampleCurve(left.curve, u);
  const table = pathArcTable(cam);
  const a0 = table.keyArc[i];
  const a1 = table.keyArc[ri];
  // Overshoot continues along the rest of the path; reverse overshoot holds
  // at the start of the span (the approved symmetric-clamp rule).
  const arc = q > 1 ? a1 + (q - 1) * (a1 - a0) : q < 0 ? a0 : a0 + q * (a1 - a0);
  return pathPointAtArc(cam, clamp(arc, a0, table.total));
}

/**
 * Retimed inner-key times for the span [from, to]. `times` is aligned with the
 * inner keys in path order. Returns null when the endpoints are not path keys.
 */
export function retimePathSpan(cam, from, to, curve) {
  const keys = cam.path || [];
  const li = keys.findIndex((k) => Math.abs(Number(k.t) - Number(from)) <= 1e-4);
  const ri = keys.findIndex((k) => Math.abs(Number(k.t) - Number(to)) <= 1e-4);
  if (li < 0 || ri <= li) return null;
  const table = pathArcTable(cam);
  const a0 = table.keyArc[li];
  const a1 = table.keyArc[ri];
  const spanLen = a1 - a0;
  const inner = keys.slice(li + 1, ri);
  if (!inner.length || spanLen <= 1e-9) return { times: [], fractions: [] };
  const fractions = inner.map((k, j) => clamp((table.keyArc[li + 1 + j] - a0) / spanLen, 0, 1));
  const times = [];
  let last = keys[li].t;
  const end = keys[ri].t;
  for (let j = 0; j < inner.length; j++) {
    const u = firstArrival(curve, fractions[j]);
    let nt = u == null ? inner[j].t : keys[li].t + u * (end - keys[li].t);
    nt = Math.max(last + 0.0005, Math.min(end - 0.0005, nt));
    nt = Math.round(nt * 1000) / 1000;
    if (nt <= last) nt = Math.round((last + 0.001) * 1000) / 1000;
    if (nt >= end) nt = Math.round((end - 0.001) * 1000) / 1000;
    times.push(nt);
    last = nt;
  }
  return { times, fractions };
}

/** Re-apply every valid span's retiming after the path geometry changed. */
export function retimeCamSpans(cam) {
  const keys = cam.path || [];
  const spans = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!k.curve || !Number.isFinite(Number(k.spanTo))) continue;
    const ri = keys.findIndex((x) => Math.abs(x.t - Number(k.spanTo)) <= 1e-4);
    if (ri > i) spans.push({ from: k.t, to: keys[ri].t, curve: k.curve });
  }
  for (const span of spans) {
    const res = retimePathSpan(cam, span.from, span.to, span.curve);
    if (!res?.times?.length) continue;
    const li = keys.findIndex((k) => Math.abs(Number(k.t) - Number(span.from)) <= 1e-4);
    res.times.forEach((nt, j) => { if (keys[li + 1 + j]) keys[li + 1 + j].t = nt; });
  }
  keys.sort((a, b) => a.t - b.t);
  return cam;
}

/** position at time t along the smoothed path (cubic bezier between keys) */
export function pathPos(cam, t) {
  const keys = cam.path;
  if (!keys.length) return [0, 20, 0];
  // Always return a fresh array: callers (evalCamera's shake) mutate `pos`,
  // and handing back a key's own array would corrupt the project over time.
  if (keys.length === 1) return keys[0].pos.slice();
  if (t <= keys[0].t) return keys[0].pos.slice();
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].pos.slice();
  const span = spanAt(cam, t);
  if (span) return spanPosition(cam, span, t);
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const k1 = keys[i], k2 = keys[i + 1];
  const k0 = keys[Math.max(0, i - 1)], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const spanTime = Math.max(1e-6, k2.t - k1.t);
  const u = clamp((t - k1.t) / spanTime);
  // Per-segment speed curve wins; ease is the legacy fallback.
  const s = Array.isArray(k1.speed) && k1.speed.length >= 2
    ? speedWarp(k1.speed, u)
    : ease(k1.ease || 'easeInOut', u);
  const p1 = k1.pos, p2 = k2.pos;
  // Auto handles are the Catmull-Rom tangents, so legacy paths (and any path
  // that never had its handles dragged) evaluate exactly as before.
  const out = k1.out || [(p2[0] - k0.pos[0]) / 6, (p2[1] - k0.pos[1]) / 6, (p2[2] - k0.pos[2]) / 6];
  const inn = k2.in || [-(k3.pos[0] - p1[0]) / 6, -(k3.pos[1] - p1[1]) / 6, -(k3.pos[2] - p1[2]) / 6];
  const c1 = [p1[0] + out[0], p1[1] + out[1], p1[2] + out[2]];
  const c2 = [p2[0] + inn[0], p2[1] + inn[1], p2[2] + inn[2]];
  return bez3(p1, c1, c2, p2, s);
}

/** Active camera of a project (falls back to the legacy single-camera alias). */
export function activeCameraOf(project) {
  const id = project?.activeCameraId;
  const found = id && Array.isArray(project?.cameras)
    ? project.cameras.find((c) => c.id === id)
    : null;
  return found || project?.camera || null;
}

/**
 * Effective timeline range of a camera clip. Cameras without an explicit
 * `start` / `duration` cover the whole project (the old behaviour); only
 * `duration` sets the end, and a missing `start` begins at 0. A camera clip is
 * half-open: [start, end).
 */
export function cameraRange(project, cam) {
  const total = Math.max(0, Number(project?.meta?.duration) || 0);
  const hasStart = Number.isFinite(Number(cam?.start));
  const hasDuration = Number.isFinite(Number(cam?.duration));
  const start = hasStart ? Math.max(0, Number(cam.start)) : 0;
  const end = hasDuration ? start + Math.max(0, Number(cam.duration)) : Math.max(start, total);
  return { start, end, duration: Math.max(0, end - start), explicit: hasStart || hasDuration };
}

/** Does camera `cam` cover time t? Un-ranged cameras cover every time. */
export function cameraCovers(project, cam, t) {
  const at = Number(t);
  if (!Number.isFinite(at)) return true;
  const r = cameraRange(project, cam);
  if (!r.explicit) return true;
  return at >= r.start - 1e-6 && at < r.end - 1e-6;
}

/**
 * Cameras that contribute to the viewport / render, in timeline order
 * (top of the stack first). Hidden cameras and cameras without a path are
 * skipped; `solo` is a viewport-only set of camera ids. Passing `t` keeps only
 * the clips covering that time; omitting it preserves the old full-stack
 * behaviour used by the renderer and camera UI.
 */
export function cameraLayers(project, solo = null, t = null) {
  const cams = Array.isArray(project?.cameras) && project.cameras.length
    ? project.cameras
    : (project?.camera ? [project.camera] : []);
  if (!cams.length) return [];
  const byId = new Map(cams.map((c) => [c.id, c]));
  const order = Array.isArray(project.cameraOrder) && project.cameraOrder.length
    ? project.cameraOrder
    : cams.map((c) => c.id);
  const only = solo instanceof Set ? solo : new Set(solo || []);
  const hasT = t != null && Number.isFinite(Number(t));
  return order
    .map((id) => byId.get(id))
    .filter((cam) => cam
      && cam.visible !== false
      && Array.isArray(cam.path) && cam.path.length > 0
      && (!only.size || only.has(cam.id))
      && (!hasT || cameraCovers(project, cam, t)));
}

/**
 * Camera that is live at t ("current shot"): the active camera when its clip
 * covers t, otherwise the topmost visible camera whose clip covers t. Falls
 * back to the active camera, then the first stack entry, when nothing covers
 * the time (e.g. a gap or past the end of every clip).
 */
export function cameraAtTime(project, t) {
  const active = activeCameraOf(project);
  if (active && cameraCovers(project, active, t)) return active;
  const covering = cameraLayers(project, null, t);
  if (covering.length) return covering[0];
  return active || cameraLayers(project)[0] || null;
}

/**
 * Keyframed camera transform at time t.
 *
 * `center` is a world point; `position` is the path offset relative to it.
 * `scale` / `picturePivot` / `pictureOffset` are picture-space values for the
 * layer compositor (normalized 0..1 for pivot/offset), `opacity` is the layer
 * alpha. Keeping this in one function means the viewport, bake and timeline
 * all show the same sampled values.
 *
 * `opts.param(cam, path, t)` resolves a property through its chain of property
 * links (core/links.js::cameraParamResolver); without it every value is the
 * local sample, exactly as before links existed.
 */
export function cameraTransform(cam, t, opts = null) {
  const c = cam || normalizeCamera(null);
  const tr = c.tracks || {};
  const center = sampleAxes(tr, 'center', t, c.center || DEFAULT_CAMERA.center);
  const position = pathPos(c, t);
  const scale = sampleAxes(tr, 'scale', t, c.scale || DEFAULT_CAMERA.scale);
  const opacity = clamp(Number(sampleChannel(tr.opacity, t, c.opacity ?? 1)), 0, 1);
  const pivotBase = c.picturePivot || DEFAULT_CAMERA.picturePivot;
  const offsetBase = c.pictureOffset || DEFAULT_CAMERA.pictureOffset;
  const picturePivot = sampleVec3(tr.picturePivot, t, [pivotBase[0], pivotBase[1], 0]).slice(0, 2);
  const pictureOffset = sampleVec3(tr.pictureOffset, t, [offsetBase[0], offsetBase[1], 0]).slice(0, 2);
  const param = opts && typeof opts.param === 'function' ? opts.param : null;
  if (param) {
    // Camera link paths use the SpatialNode names (`pivot.*` / `scale.*`): the
    // local camera calls them `center` / picture scale (see core/links.js).
    ['x', 'y', 'z'].forEach((axis, i) => {
      const pivot = Number(param(c, `pivot.${axis}`, t));
      if (Number.isFinite(pivot)) center[i] = pivot;
      const sx = Number(param(c, `scale.${axis}`, t));
      if (Number.isFinite(sx)) scale[i] = sx;
    });
    const alpha = Number(param(c, 'opacity', t));
    if (Number.isFinite(alpha)) return {
      center, position, scale, opacity: clamp(alpha, 0, 1), picturePivot, pictureOffset,
    };
  }
  return { center, position, scale, opacity, picturePivot, pictureOffset };
}

/**
 * One keyed camera parameter at time t. Transform channels come from
 * `cameraTransform`; lens/shake/DOF channels fall back to their base values
 * when no track exists. The timeline and bake share this so a row value is
 * exactly what the preview/render uses.
 */
export function cameraParamValue(cam, path, t) {
  const c = cam || normalizeCamera(null);
  const tr = c.tracks || {};
  const scalar = (name, dflt) => Number(sampleChannel(tr[name], t, dflt));
  switch (path) {
    case 'center': return cameraTransform(c, t).center;
    case 'scale': return cameraTransform(c, t).scale;
    case 'opacity': return cameraTransform(c, t).opacity;
    case 'picturePivot': return cameraTransform(c, t).picturePivot;
    case 'pictureOffset': return cameraTransform(c, t).pictureOffset;
    case 'fov': return clamp(scalar('fov', pathFov(c, t)), 1, 360);
    case 'lookAhead': return Math.max(1, scalar('lookAhead', c.lookAhead));
    case 'bankGain': return scalar('bankGain', c.bankGain);
    case 'maxRoll': return clamp(scalar('maxRoll', c.maxRoll), 0, 60);
    case 'roll': return scalar('roll', c.roll || 0);
    case 'shake.amp': return Math.max(0, scalar('shake.amp', c.shake?.amp ?? 0));
    case 'shake.freq': return Math.max(0.1, scalar('shake.freq', c.shake?.freq ?? 1.6));
    case 'shake.speedGain': return Math.max(0, scalar('shake.speedGain', c.shake?.speedGain ?? 1));
    case 'shake.seed': return scalar('shake.seed', c.shake?.seed ?? 7);
    case 'dof.enabled': return !!sampleChannel(tr['dof.enabled'], t, !!(c.dof?.enabled));
    case 'dof.fstop': return clamp(scalar('dof.fstop', c.dof?.fstop ?? 2.8), 0.5, 32);
    default: return undefined;
  }
}

/** fov at time t (keyframe override, else default) */
export function pathFov(cam, t) {
  const k = cam.path;
  if (!k.length) return cam.fov;
  let prev = null, next = null;
  for (const p of k) {
    if (p.fov == null) continue;
    if (p.t <= t) prev = p; else if (!next) next = p;
  }
  if (!prev && !next) return cam.fov;
  if (!prev) return next.fov;
  if (!next) return prev.fov;
  const u = (t - prev.t) / Math.max(1e-6, next.t - prev.t);
  return prev.fov + (next.fov - prev.fov) * ease('easeInOut', u);
}

/** total flown distance up to t (for speed-driven effects) */
export function pathSpeed(cam, t, dt = 0.1) {
  const a = pathPos(cam, Math.max(0, t - dt));
  const b = pathPos(cam, t + dt);
  return v3.len(v3.sub(b, a)) / (2 * dt);
}

/**
 * Full camera state at time t.
 *
 * `opts.param(cam, path, t)` is the property-link resolver every linkable
 * channel goes through (core/links.js::cameraParamResolver). Omit it and the
 * result is exactly the local evaluation that shipped before links.
 * @returns {{pos:number[], look:number[], up:number[], fov:number, roll:number, speed:number, focus:number}}
 */
export function evalCamera(project, t, opts = null) {
  const param = opts && typeof opts.param === 'function' ? opts.param : cameraParamValue;
  const cam = cameraAtTime(project, t) || normalizeCamera(null);
  const tr = cameraTransform(cam, t, opts);
  const pos = v3.add(tr.center, tr.position);
  const posA = v3.add(tr.center, pathPos(cam, t - 0.16));
  const posB = v3.add(tr.center, pathPos(cam, t + 0.16));
  const tangentVec = v3.sub(posB, posA);
  let tang = v3.norm(tangentVec);
  if (v3.len(tangentVec) < 1e-6) {
    // A one-key / stationary camera has no finite-difference tangent. Use the
    // nearest manual look target when one exists, otherwise a stable forward
    // direction; never return look == pos.
    const lks = (cam.path || []).filter((k) => Array.isArray(k.look) && k.look.length >= 3);
    if (lks.length) {
      const target = t < lks[0].t ? lks[0].look : lks[lks.length - 1].look;
      const d = v3.sub(target, pos);
      tang = v3.len(d) > 1e-6 ? v3.norm(d) : [0, 0, -1];
    } else {
      tang = [0, 0, -1];
    }
  }

  // explicit look keys win inside their window; outside, blend back to the
  // tangent so entering / leaving a look range does not snap the camera.
  const lookAhead = Math.max(1, Number(param(cam, 'lookAhead', t)) || 1);
  const autoLook = v3.add(pos, v3.mul(tang, Math.max(1, lookAhead)));
  let look = autoLook;
  const manual = manualLookAt(cam, t);
  if (manual && manual.weight > 0) {
    const av = v3.sub(autoLook, pos);
    const mv = v3.sub(manual.target, pos);
    const ad = v3.len(av);
    const md = v3.len(mv);
    if (ad > 1e-6 && md > 1e-6) {
      const dir = slerpDir(v3.norm(av), v3.norm(mv), manual.weight);
      const dist = ad + (md - ad) * manual.weight;
      look = v3.add(pos, v3.mul(dir, dist));
    } else if (md > 1e-6) {
      look = manual.target.slice();
    }
  }

  const speed = v3.len(v3.sub(posB, posA)) / 0.32;

  // banking: shortest-angle yaw rate around +Y. Raw atan2 differences flip by
  // ~2π when the heading crosses ±180°, which used to slam the roll to max.
  // Near the ends the ±dt probes leave the path; hold the last valid curvature
  // instead of letting a zero vector produce a fake max bank.
  const bankGain = param(cam, 'bankGain', t);
  const maxRoll = param(cam, 'maxRoll', t);
  let bank = 0;
  const firstT = Number(cam.path?.[0]?.t) || 0;
  const lastT = Number(cam.path?.[cam.path.length - 1]?.t) || 0;
  const bLo = firstT + 0.25;
  const bHi = lastT - 0.25;
  const bt = bLo <= bHi ? clamp(t, bLo, bHi) : t;
  const da = v3.sub(pathPos(cam, bt - 0.01), pathPos(cam, bt - 0.25));
  const db = v3.sub(pathPos(cam, bt + 0.25), pathPos(cam, bt + 0.01));
  if (v3.len(da) > 1e-6 && v3.len(db) > 1e-6) {
    const dirA = v3.norm(da);
    const dirB = v3.norm(db);
    let dy = Math.atan2(dirB[0], dirB[2]) - Math.atan2(dirA[0], dirA[2]);
    dy = ((dy + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const yawRate = dy / 0.5;
    bank = clamp(-yawRate * bankGain * 57.2958, -maxRoll, maxRoll);
  }
  let roll = bank + param(cam, 'roll', t);

  // shake: value noise, stronger at speed
  const sh = {
    ...cam.shake,
    amp: param(cam, 'shake.amp', t),
    freq: param(cam, 'shake.freq', t),
    speedGain: param(cam, 'shake.speedGain', t),
    seed: param(cam, 'shake.seed', t),
  };
  const amp = Number(sh.amp) || 0;
  if (amp > 0 && cam.path.length > 1) {
    const speedK = 1 + (Number(sh.speedGain) || 0) * Math.min(2.5, speed / 25);
    const f = Number(sh.freq) || 1.5;
    const oct = Math.max(1, Math.min(4, Number(sh.octaves) || 3));
    let nx = 0, ny = 0, nz = 0, norm = 0, gain = 1;
    for (let o = 0; o < oct; o++) {
      const ff = f * Math.pow(2, o);
      nx += noise3(t * ff, 1.7, 0.3, sh.seed + o) * gain;
      ny += noise3(3.1, t * ff, 5.2, sh.seed + o + 11) * gain;
      nz += noise3(7.3, 2.2, t * ff, sh.seed + o + 23) * gain;
      norm += gain;
      gain *= 0.5;
    }
    const k = amp * speedK;
    const off = [nx / norm * k, ny / norm * k * 0.7, nz / norm * k];
    pos[0] += off[0]; pos[1] += off[1]; pos[2] += off[2];
    look[0] += off[0] * 0.6; look[1] += off[1] * 0.6; look[2] += off[2] * 0.6;
    roll += (nx / norm) * k * 0.6;
  }

  const up = [0, 1, 0];
  const fov = param(cam, 'fov', t);
  const dof = {
    enabled: cameraParamValue(cam, 'dof.enabled', t),
    fstop: param(cam, 'dof.fstop', t),
    focusOffset: Number(cam.dof?.focusOffset) || 0,
  };
  const focus = Math.max(1, v3.len(v3.sub(look, pos)) + dof.focusOffset);
  return {
    ...tr, pos, look, up, fov, roll, speed, focus, bank, dof,
    // aliases used by the timeline rows
    center: tr.center, position: tr.position,
  };
}

/** Sample the whole shot into per-frame camera states (baked for Blender). */
export function bakeCameraTrack(project, { fps = 24, from = 0, to = null, param = null } = {}) {
  const dur = to ?? project.meta.duration;
  const f0 = Math.round(from * fps), f1 = Math.round(dur * fps);
  const out = [];
  for (let f = f0; f <= f1; f++) {
    const t = f / fps;
    const c = evalCamera(project, t, param ? { param } : null);
    out.push({
      f: f + 1,
      t: Math.round(t * 1000) / 1000,
      pos: c.pos.map((v) => Math.round(v * 1000) / 1000),
      look: c.look.map((v) => Math.round(v * 1000) / 1000),
      roll: Math.round(c.roll * 1000) / 1000,
      fov: Math.round(c.fov * 1000) / 1000,
      focus: Math.round((c.focus || 0) * 1000) / 1000,
      dof: { enabled: !!c.dof?.enabled, fstop: Math.round((c.dof?.fstop ?? 2.8) * 1000) / 1000 },
    });
  }
  return out;
}
