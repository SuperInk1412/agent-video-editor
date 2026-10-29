// Scene model v3: metres, 3D elements, keyframed channels with speed curves.
// Pure ESM (no node:*): the viewport, the bake (engine/shot.js) and tests share it.
//
// Every element is a 3D object with five base properties:
//   pivot     centre point in world space (rotation + gizmo pivot), metres
//   position  geometry offset relative to the centre point, metres
//   scale     scale about the geometry's own centre
//   rot       unit direction `dir` (on the sphere) + `roll` around it
//   opacity   0..1
//
// M = T(pivot) · R(dir, roll) · T(position) · S(scale) · geometry
import { clamp, ease, speedWarp } from './time.js';
import { compiledTrack, segmentIndex } from './tracks.js';
import { SCENE_MODEL_VERSION } from './version.js';
import { sampleCurve, normalizeCurve } from './curves.js';
import { basisFromRotation, dirRollFromRotation, normalizeRotation, rotationFromDirRoll, sampleRotation, ROTATION_PATHS } from './rotation.js';

const keyedDirRoll = (tracks) => ['dir', 'roll'].some((k) => Array.isArray(tracks?.[k]) && tracks[k].length > 0);

export const SCENE_VERSION = SCENE_MODEL_VERSION;
export const PX_PER_M = 100; // v2 (pixels) -> v3 (metres) migration scale
export const OBJECT_TYPES = ['empty', 'camera', 'text', 'image', 'video', 'solid', 'shape', 'audio', 'container'];

export const pxToM = (px) => Number(px || 0) / PX_PER_M;
export const mToPx = (m) => Number(m || 0) * PX_PER_M;

const isNum = (n) => Number.isFinite(Number(n));
const num = (n, d = 0) => (isNum(n) ? Number(n) : d);
const vec3 = (v, d = [0, 0, 0]) => (Array.isArray(v) && v.length >= 2 && v.every(isNum)
  ? [Number(v[0]), Number(v[1]), Number(v[2] ?? 0)]
  : d.slice());

const V = {
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
};

// ---------------------------------------------------------------- channels

/** Re-exported from time.js so both camera and scene channels share one warp. */
export { speedWarp };

function warp(key, u) {
  const uu = clamp(u, 0, 1);
  // A per-segment value curve wins over the legacy ease/speed settings.
  if (key.curve) return sampleCurve(key.curve, uu);
  if (Array.isArray(key.speed) && key.speed.length >= 2) return speedWarp(key.speed, uu);
  return ease(key.ease || 'easeInOut', uu);
}

function sortKeys(keys) {
  const cached = Array.isArray(keys) && compiledTrack(keys, 'channel');
  if (cached) return cached;
  return (Array.isArray(keys) ? keys : [])
    .filter((k) => k && isNum(k.t) && k.v !== undefined && k.v !== null)
    .slice()
    .sort((a, b) => Number(a.t) - Number(b.t));
}

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])];
}

function cubic(p0, p1, p2, p3, u) {
  const it = 1 - u;
  const a = it * it * it, b = 3 * it * it * u, c = 3 * it * u * u, d = u * u * u;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
  ];
}

/** Scalar (or stepped string) channel. */
export function sampleChannel(keys, t, fallback = 0) {
  const k = sortKeys(keys);
  if (!k.length) return fallback;
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  for (let i = segmentIndex(k, t, true); i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = Math.max(1e-9, b.t - a.t);
      const u = warp(a, (t - a.t) / span);
      if (typeof a.v === 'number' && typeof b.v === 'number') return a.v + (b.v - a.v) * u;
      return u < 1 ? a.v : b.v;
    }
  }
  return fallback;
}

/** vec3 channel: cubic bezier through the keys (auto handles = Catmull-Rom). */
export function sampleVec3(keys, t, fallback = [0, 0, 0]) {
  const k = sortKeys(keys);
  const fb = vec3(fallback);
  if (!k.length) return fb;
  if (t <= k[0].t) return vec3(k[0].v, fb);
  const last = k[k.length - 1];
  if (t >= last.t) return vec3(last.v, fb);
  for (let i = segmentIndex(k, t, true); i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = Math.max(1e-9, b.t - a.t);
      const u = warp(a, (t - a.t) / span);
      const p1 = vec3(a.v, fb);
      const p2 = vec3(b.v, fb);
      const p0 = vec3(k[i - 1]?.v, p1);
      const p3 = vec3(k[i + 2]?.v, p2);
      // Explicit handles shape the curve; auto handles are the Catmull tangents.
      const out = Array.isArray(a.out) && a.out.length === 3
        ? a.out.map(Number)
        : [(p2[0] - p0[0]) / 6, (p2[1] - p0[1]) / 6, (p2[2] - p0[2]) / 6];
      const inn = Array.isArray(b.in) && b.in.length === 3
        ? b.in.map(Number)
        : [-(p3[0] - p1[0]) / 6, -(p3[1] - p1[1]) / 6, -(p3[2] - p1[2]) / 6];
      return cubic(
        p1,
        [p1[0] + out[0], p1[1] + out[1], p1[2] + out[2]],
        [p2[0] + inn[0], p2[1] + inn[1], p2[2] + inn[2]],
        p2,
        u,
      );
    }
  }
  return fb;
}

/**
 * Vector channel with two representations: a vec3 track (`pivot`), or scalar
 * sub-tracks (`pivot.x` / `.y` / `.z`). Migration uses the sub-tracks so old
 * per-axis eases keep their exact timing.
 */
export function sampleAxes(tracks, name, t, fallback = [0, 0, 0]) {
  const vec = tracks?.[name];
  if (Array.isArray(vec) && vec.length) return sampleVec3(vec, t, fallback);
  const fb = vec3(fallback);
  return [0, 1, 2].map((i) => Number(sampleChannel(tracks?.[`${name}.${'xyz'[i]}`], t, fb[i])));
}

/** Tangent at key `i` on the sphere, projected to the tangent plane. */
function tangentAt(k, i, p, side) {
  const key = k[i];
  const raw = side === 'out' ? key.out : key.in;
  let v = null;
  if (Array.isArray(raw)) {
    v = vec3(raw);
  } else {
    const prev = k[i - 1] || key;
    const next = k[i + 1] || key;
    v = V.sub(V.norm(vec3(next.v, p)), V.norm(vec3(prev.v, p)));
  }
  let proj = V.sub(v, V.mul(p, V.dot(v, p)));
  if (V.len(proj) < 1e-6) {
    // Degenerate (e.g. 180° turn): pick any perpendicular.
    const axis = Math.abs(p[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    proj = V.cross(p, axis);
  }
  return V.norm(proj);
}

/** Direction channel: keyframes are points on the unit sphere. */
export function sampleDir(keys, t, fallback = [0, 0, -1]) {
  const k = sortKeys(keys);
  const fb = V.norm(vec3(fallback, [0, 0, -1]));
  if (!k.length) return fb;
  if (t <= k[0].t) return V.norm(vec3(k[0].v, fb));
  const last = k[k.length - 1];
  if (t >= last.t) return V.norm(vec3(last.v, fb));
  for (let i = segmentIndex(k, t, true); i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = Math.max(1e-9, b.t - a.t);
      const u = warp(a, (t - a.t) / span);
      const p1 = V.norm(vec3(a.v, fb));
      const p2 = V.norm(vec3(b.v, fb));
      const chord = V.len(V.sub(p2, p1));
      if (chord < 1e-6) return p2;
      const out = tangentAt(k, i, p1, 'out');
      const inn = tangentAt(k, i + 1, p2, 'in');
      const c1 = V.add(p1, V.mul(out, chord / 3));
      const c2 = V.add(p2, V.mul(inn, -chord / 3));
      return V.norm(cubic(p1, c1, c2, p2, u));
    }
  }
  return fb;
}

// ---------------------------------------------------------------- transform

/**
 * Orthonormal frame for a facing direction (+ optional roll around it).
 * `forward` is where the element looks/faces; `right`/`up` are its screen axes.
 */
export function basisFromDir(dir, rollDeg = 0) {
  const forward = V.norm(vec3(dir, [0, 0, -1]));
  const upRef = Math.abs(V.dot(forward, [0, 1, 0])) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  let right = V.norm(V.cross(forward, upRef));
  let up = V.cross(right, forward);
  const r = (num(rollDeg, 0) * Math.PI) / 180;
  if (r) {
    const c = Math.cos(r), s = Math.sin(r);
    const r2 = V.add(V.mul(right, c), V.mul(up, s));
    const u2 = V.add(V.mul(up, c), V.mul(right, -s));
    right = V.norm(r2);
    up = V.norm(u2);
  }
  return { right, up, forward };
}

/** Pose of an element at time t (base values + channel keys). */
export function objectPose(obj, t) {
  const o = obj || {};
  const tr = o.tracks || {};
  const pivot = sampleAxes(tr, 'pivot', t, o.pivot || [0, 0, 0]);
  const position = sampleAxes(tr, 'position', t, o.position || [0, 0, 0]);
  const scale = sampleAxes(tr, 'scale', t, o.scale || [1, 1, 1]);
  const opacity = clamp(sampleChannel(tr.opacity, t, o.opacity ?? 1), 0, 1);
  // Three-axis rotation (core/rotation.js) wins over the older dir/roll fields.
  const rotated = Array.isArray(o.rotation) || ROTATION_PATHS.some((p) => Array.isArray(tr[p]) && tr[p].length);
  let dir, roll, basis, rotation;
  if (rotated) {
    rotation = sampleRotation(o.rotation, (path, fb) => sampleChannel(tr[path], t, fb));
    basis = basisFromRotation(rotation);
    ({ dir, roll } = dirRollFromRotation(rotation));
  } else {
    dir = sampleDir(tr.dir, t, o.rot?.dir);
    roll = sampleChannel(tr.roll, t, o.rot?.roll ?? 0);
    basis = basisFromDir(dir, roll);
  }
  const worldPos = V.add(pivot, [
    basis.right[0] * position[0] + basis.up[0] * position[1] + basis.forward[0] * position[2],
    basis.right[1] * position[0] + basis.up[1] * position[1] + basis.forward[1] * position[2],
    basis.right[2] * position[0] + basis.up[2] * position[1] + basis.forward[2] * position[2],
  ]);
  return { pivot, position, scale, dir, roll, basis, worldPos, opacity, ...(rotation ? { rotation } : {}) };
}

/** Column-major 4x4 for WebGL/Blender (geometry centre at worldPos). */
export function poseMatrix(pose) {
  const { basis, scale, worldPos } = pose;
  const [r, u, f] = [basis.right, basis.up, basis.forward];
  const [sx, sy, sz] = scale;
  return new Float32Array([
    r[0] * sx, r[1] * sx, r[2] * sx, 0,
    u[0] * sy, u[1] * sy, u[2] * sy, 0,
    f[0] * sz, f[1] * sz, f[2] * sz, 0,
    worldPos[0], worldPos[1], worldPos[2], 1,
  ]);
}

// ---------------------------------------------------------------- schema

export function normalizeTracks(tracks) {
  const out = {};
  for (const [name, keys] of Object.entries(tracks || {})) {
    if (!Array.isArray(keys)) continue;
    const list = keys
      .filter((k) => k && isNum(k.t))
      .map((k) => {
        const key = { t: Math.round(Number(k.t) * 1000) / 1000 };
        if (Array.isArray(k.v)) key.v = k.v.map(Number);
        else if (typeof k.v === 'number') key.v = Number(k.v);
        else key.v = k.v;
        if (k.ease) key.ease = String(k.ease);
        if (k.curve) {
          const curve = normalizeCurve(k.curve);
          if (curve) key.curve = curve;
        }
        if (Array.isArray(k.in)) key.in = k.in.map(Number);
        if (Array.isArray(k.out)) key.out = k.out.map(Number);
        if (Array.isArray(k.speed)) {
          key.speed = k.speed
            .filter((p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]))
            .map((p) => [clamp(Number(p[0]), 0, 1), Math.max(0, Number(p[1]))]);
          if (key.speed.length < 2) delete key.speed;
        }
        return key;
      })
      .sort((a, b) => a.t - b.t);
    if (list.length) out[name] = list;
  }
  return out;
}

export function normalizeObject(o = {}) {
  const type = OBJECT_TYPES.includes(o.type) ? o.type : 'solid';
  const rot = o.rot || {};
  return {
    ...o,
    id: String(o.id || ''),
    type,
    name: String(o.name || type),
    start: Math.max(0, num(o.start, 0)),
    duration: Math.max(0, num(o.duration, 1)),
    visible: o.visible !== false,
    pivot: vec3(o.pivot),
    position: vec3(o.position),
    scale: vec3(o.scale, [1, 1, 1]),
    // three-axis rotation replaces the older dir/roll (core/rotation.js)
    // (a static dir/roll converts exactly; keyed ones wait for core/rotation-migrate.js)
    ...(Array.isArray(o.rotation)
      ? { rotation: normalizeRotation(o.rotation), rot: undefined }
      : keyedDirRoll(o.tracks)
        ? { rot: { dir: V.norm(vec3(rot.dir, [0, 0, -1])), roll: num(rot.roll, 0) } }
        : { rotation: rotationFromDirRoll(V.norm(vec3(rot.dir, [0, 0, -1])), num(rot.roll, 0)), rot: undefined }),
    opacity: clamp(num(o.opacity, 1), 0, 1),
    tracks: normalizeTracks(o.tracks),
  };
}

export function normalizeScene(s = {}) {
  const objects = Array.isArray(s.objects) ? s.objects.map(normalizeObject) : [];
  const cameraId = s.cameraId || objects.find((o) => o.type === 'camera')?.id || null;
  return {
    version: SCENE_VERSION,
    units: 'm',
    name: String(s.name || ''),
    world: s.world ?? null,
    lights: s.lights ?? null,
    background: s.background ?? 'transparent',
    cameraId: cameraId || null,
    objects,
    annotations: (Array.isArray(s.annotations) ? s.annotations : [])
      .map((a) => ({
        id: String(a.id || ''),
        t: Math.max(0, num(a.t, 0)),
        duration: Math.max(0, num(a.duration, 0)),
        text: String(a.text || ''),
        author: a.author ? String(a.author) : null,
      }))
      .sort((a, b) => a.t - b.t),
  };
}

/**
 * A project is a tree of scenes: the root scene plus one full scene per
 * flattened container. Every scene has its own world, lights, background,
 * objects and camera — the editor enters them the same way.
 */
export function normalizeSceneTree(tree = {}) {
  const src = tree.scenes && typeof tree.scenes === 'object' ? tree.scenes : {};
  const scenes = {};
  for (const [id, sc] of Object.entries(src)) scenes[String(id)] = normalizeScene(sc || {});
  let sceneId = tree.sceneId && scenes[tree.sceneId] ? tree.sceneId : null;
  if (!sceneId) sceneId = Object.keys(scenes)[0] || 'root';
  if (!scenes[sceneId]) scenes[sceneId] = normalizeScene({});
  return { version: SCENE_VERSION, sceneId, scenes };
}
