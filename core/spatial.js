// Unified spatial node: one transform model for 2D elements, 3D objects and
// cameras (docs/DESIGN-UNIFIED-SPACE.md, PLAN-ui-round3 §2–§3).
// Pure ESM (no node:*): the preview, the Blender bake, the editor and tests
// all read the same node/frame math.
//
//   node = {
//     pivot:    [x, y, z],  // rotation centre / anchor point, metres
//     position: [x, y, z],  // geometry offset from the pivot, rotated by the basis
//     dir:      [x, y, z],  // forward direction (where the node faces), unit
//     roll:     number,     // degrees around `dir`
//     scale:    [x, y, z],
//   }
//
//   basis    = basisFromDir(dir, roll)                  // core/scene.js
//   worldPos = pivot + basis · position                 // geometry centre
//   frame    = { pos: worldPos, basis: [right, up, forward], scale }
//
// 3D objects are read straight from their existing scene fields (no duplicate
// data). A 2D element with `el.node` uses it as its only transform source;
// without one, `legacyElementNode` derives a read-only node from the old pixel
// `transform` (this module never writes it back). Cameras are driven by their
// path: pivot = sampled center, position = path position, orientation from
// evalCamera. A camera's *world position* is the legacy additive center + path
// (see cameraWorldFrame), not the geometry-centre formula above — which is why
// camera-as-child callers transform its frame instead of frameOf(node).
//
// Parent math is the same "motion since the bind" affine map the 3D hierarchy
// uses: `parent.bind` stores the parent frame at binding, and at time t
//
//   parentDelta = frame(t) · frame(bind)⁻¹ :  x' = c + L · (x − bind.pivot)
//
// Parent rotation orbits the child around the parent frame pivot; `inherit.pos`
// / `inherit.rot` / `inherit.scale` switch the three axes independently; binding
// at time t is a no-op. `@live` screen locking is intentionally NOT a world
// parent: it stays the legacy render-time carrier (`core/hierarchy.js::
// elementCarrier`), and `isScreenParent` keeps it out of this path.
import { normalizeCamera, evalCamera } from './camera.js';
import { basisFromDir, objectPose, sampleChannel } from './scene.js';
import { normalizeSpatialNode } from './schema.js';
import { screenToWorld } from './space.js';
import { clamp, sampleTrack } from './time.js';
import { isRecord } from './json.js';

export { normalizeSpatialNode, spatialNodeIssues, isValidSpatialNode } from './schema.js';

export const MAX_DEPTH = 32; // same limit as core/hierarchy.js
export const SCREEN_PARENT = '@live';
/** The old 2D plane faces the default camera (core/migrate.js uses the same). */
export const LEGACY_ELEMENT_DIR = Object.freeze([0, 0, 1]);

const isNum = (n) => Number.isFinite(Number(n));
const num = (n, d = 0) => (isNum(n) ? Number(n) : d);
const vec3 = (v, d = [0, 0, 0]) => (Array.isArray(v) && v.length >= 2 && v.slice(0, 3).every(isNum)
  ? [Number(v[0]), Number(v[1]), Number(v[2] ?? d[2])]
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

// 3x3 matrices are row-major arrays of rows: M[r][c].
const M3 = {
  ident: () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  /** Matrix whose columns are the given vectors. */
  cols: (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]],
  T: (m) => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]],
  mul: (a, b) => a.map((row) => [0, 1, 2].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c])),
  apply: (m, v) => [V.dot(m[0], v), V.dot(m[1], v), V.dot(m[2], v)],
  diag: (d) => [[d[0], 0, 0], [0, d[1], 0], [0, 0, d[2]]],
};

const IDENTITY_BASIS = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** [right, up, forward] -> { right, up, forward }. */
const basisOf = (basis) => ({ right: basis[0], up: basis[1], forward: basis[2] });

/** Apply a node basis to a local vector (same columns as poseMatrix). */
function applyBasis(basis, v) {
  const [r, u, f] = [basis.right, basis.up, basis.forward];
  return [
    r[0] * v[0] + u[0] * v[1] + f[0] * v[2],
    r[1] * v[0] + u[1] * v[1] + f[1] * v[2],
    r[2] * v[0] + u[2] * v[1] + f[2] * v[2],
  ];
}

// ---------------------------------------------------------------- node model

/** World basis of a node (basisFromDir convention). */
export function nodeBasis(node) {
  const n = normalizeSpatialNode(node);
  return basisFromDir(n.dir, n.roll);
}

/** Geometry centre / world position of a node: pivot + basis · position. */
export function nodeWorldPos(node) {
  const n = normalizeSpatialNode(node);
  return V.add(n.pivot, applyBasis(basisFromDir(n.dir, n.roll), n.position));
}

/**
 * The frame a node hands to its children / the renderers:
 * `{ pos, basis: [right, up, forward], scale }`. `pos` is the geometry centre.
 */
export function frameOf(node) {
  const n = normalizeSpatialNode(node);
  const basis = basisFromDir(n.dir, n.roll);
  return {
    pos: V.add(n.pivot, applyBasis(basis, n.position)),
    basis: [basis.right.slice(), basis.up.slice(), basis.forward.slice()],
    scale: n.scale.slice(),
  };
}

/** Build a node that has the exact world frame of `frame` (pivot = frame.pos). */
export function frameToNode(frame) {
  const f = normalizeFrame(frame);
  const basis = basisOf(f.basis);
  return {
    pivot: f.pos.slice(),
    position: [0, 0, 0],
    dir: basis.forward.slice(),
    roll: rollOf(basis),
    scale: f.scale.slice(),
  };
}

/** Column-major 4x4 (WebGL/Blender), same layout as core/scene.js::poseMatrix. */
export function nodeMatrix(node) {
  const f = frameOf(node);
  const [r, u, fw] = f.basis;
  const [sx, sy, sz] = f.scale;
  return new Float32Array([
    r[0] * sx, r[1] * sx, r[2] * sx, 0,
    u[0] * sy, u[1] * sy, u[2] * sy, 0,
    fw[0] * sz, fw[1] * sz, fw[2] * sz, 0,
    f.pos[0], f.pos[1], f.pos[2], 1,
  ]);
}

// ---------------------------------------------------------------- readers

/**
 * SpatialNode of a 3D object. Without `t` this is the object's own local data;
 * with `t` the keyed channels are sampled (core/scene.js::objectPose).
 */
export function objectNode(obj, t = null) {
  const o = obj || {};
  if (t != null && Number.isFinite(Number(t))) {
    const pose = objectPose(o, Number(t));
    return {
      pivot: pose.pivot.slice(),
      position: pose.position.slice(),
      dir: V.norm(pose.dir),
      roll: num(pose.roll, 0),
      scale: pose.scale.slice(),
    };
  }
  return normalizeSpatialNode({
    pivot: o.pivot,
    position: o.position,
    dir: o.rot?.dir,
    roll: o.rot?.roll,
    scale: o.scale,
  });
}

/**
 * Read-only node derived from a legacy 2D element (`transform.x/y/z` in pixels,
 * screen y down; `scale` uniform; `rotation` in degrees). The old 2D plane is
 * the fixed XY plane facing the default camera, so the node's `position` is
 * zero and the pivot carries the whole placement:
 *
 *   pivot = screenToWorld(meta, x, y, z),  dir = [0, 0, 1],
 *   roll  = transform.rotation,            scale = [s, s, 1]
 *
 * `t` samples `transform.*` keyframes (base values when omitted). Motion
 * presets / punch / fades are legacy modifiers layered on top and are not part
 * of the node. Nothing is written back to `el`.
 */
export function legacyElementNode(el, meta = {}, t = null) {
  const tr = (isRecord(el) && isRecord(el.transform) ? el.transform : {});
  const at = t == null ? null : Number(t);
  const sample = (path, base) => (at != null && Number.isFinite(at)
    ? sampleTrack(el?.keyframes, path, at, base)
    : base);
  const x = num(sample('transform.x', tr.x), 0);
  const y = num(sample('transform.y', tr.y), 0);
  const z = num(sample('transform.z', tr.z), 0);
  const scale = num(sample('transform.scale', tr.scale), 1);
  const rotation = num(sample('transform.rotation', tr.rotation), 0);
  return {
    pivot: screenToWorld(meta || {}, x, y, z),
    position: [0, 0, 0],
    dir: LEGACY_ELEMENT_DIR.slice(),
    roll: rotation,
    scale: [scale, scale, 1],
  };
}

/**
 * SpatialNode of a 2D element. `el.node` wins when present (missing node fields
 * fall back to the legacy derivation, so a partial node cannot move the
 * element); legacy elements never gain a `node` here.
 */
export function elementNode(el, meta = {}, t = null) {
  const legacy = legacyElementNode(el, meta, t);
  if (isRecord(el) && isRecord(el.node)) return normalizeSpatialNode(el.node, legacy);
  return legacy;
}

const cameraProject = (cam) => ({
  camera: cam || null,
  cameras: cam ? [cam] : [],
  activeCameraId: cam?.id ?? null,
});

/** Normalised camera + its whole evaluated state at t (null for no camera). */
function cameraState(cam, t, opts = null) {
  if (!cam) return null;
  const at = Number.isFinite(Number(t)) ? Number(t) : 0;
  return evalCamera(cameraProject(normalizeCamera(cam)), at, opts);
}

/**
 * SpatialNode of a camera: pivot = sampled center, position = path position,
 * dir/roll from evalCamera (look/tangent + bank/roll/shake). `scale` is the
 * keyable camera scale; it only affects children, never the camera's own
 * framing. pictureScale / picturePivot / pictureOffset / fov are NOT node
 * fields (fov is lens zoom, the picture* values are the legacy compositor).
 */
export function cameraNode(cam, t = 0, opts = null) {
  const st = cameraState(cam, t, opts);
  if (!st) return normalizeSpatialNode(null);
  let dir = V.sub(st.look, st.pos);
  if (V.len(dir) < 1e-9) dir = [0, 0, -1];
  return {
    pivot: vec3(st.center),
    position: vec3(st.position),
    dir: V.norm(dir),
    roll: num(st.roll, 0),
    scale: vec3(st.scale, [1, 1, 1]),
  };
}

/**
 * The camera's real world frame: pos = center + path (the legacy evalCamera
 * convention, shake included), basis from the evaluated look direction + roll,
 * scale from the camera scale. Use this — not frameOf(cameraNode) — whenever a
 * camera is a parent or is attached to a parent.
 *
 * `opts.param(cam, path, t)` resolves property links (core/links.js), so a
 * parented child follows the camera's *effective* roll/scale, not its local
 * value.
 */
export function cameraWorldFrame(cam, t = 0, opts = null) {
  const st = cameraState(cam, t, opts);
  if (!st) return { pos: [0, 0, 0], basis: IDENTITY_BASIS(), scale: [1, 1, 1] };
  let dir = V.sub(st.look, st.pos);
  if (V.len(dir) < 1e-9) dir = [0, 0, -1];
  const basis = basisFromDir(V.norm(dir), num(st.roll, 0));
  return {
    pos: vec3(st.pos),
    basis: [basis.right, basis.up, basis.forward],
    scale: vec3(st.scale, [1, 1, 1]),
  };
}

// ---------------------------------------------------------------- frames

function normalizeBasis(basis) {
  const fallback = IDENTITY_BASIS();
  if (!Array.isArray(basis) || basis.length !== 3) return fallback;
  return basis.map((v, i) => {
    const x = vec3(v, fallback[i]);
    const l = V.len(x);
    return l > 1e-12 ? V.mul(x, 1 / l) : fallback[i].slice();
  });
}

/** Frame `{ pos, basis, scale }`; tolerates `{ pivot, basis, scale }` too. */
function normalizeFrame(frame) {
  const f = isRecord(frame) ? frame : {};
  return {
    pos: vec3(f.pos ?? f.pivot),
    basis: normalizeBasis(f.basis),
    scale: vec3(f.scale, [1, 1, 1]),
  };
}

function normalizeBind(bind) {
  const b = isRecord(bind) ? bind : {};
  // New binds store `pivot`; 3D objects written before the unified model store
  // the same value as `pos` (core/hierarchy.js).
  return {
    pivot: vec3(b.pivot ?? b.pos),
    basis: normalizeBasis(b.basis),
    scale: vec3(b.scale, [1, 1, 1]),
  };
}

/** `{ pos, rot, scale }` inherit switches; anything but `false` means on. */
export function normalizeInherit(inherit) {
  const i = isRecord(inherit) ? inherit : {};
  return { pos: i.pos !== false, rot: i.rot !== false, scale: i.scale !== false };
}

/**
 * Normalised parent data: `{ id, mode, inherit, bind }` with
 * `bind = { pivot, basis, scale }` (legacy `bind.pos` is accepted as `pivot`).
 * `strength` is a 3D-object-hierarchy extra and is not part of this model.
 */
export function normalizeParentData(parent) {
  if (!isRecord(parent)) return null;
  const id = parent.id != null && String(parent.id) !== '' ? String(parent.id) : null;
  return {
    id,
    mode: id === SCREEN_PARENT || parent.mode === 'screen' ? 'screen' : 'world',
    inherit: normalizeInherit(parent.inherit),
    bind: normalizeBind(parent.bind),
  };
}

/** `@live` and explicit `mode:"screen"` parents: legacy screen lock, not a world matrix. */
export function isScreenParent(parent) {
  const p = normalizeParentData(parent);
  return !!p && (p.mode === 'screen' || p.id === SCREEN_PARENT);
}

/** A real world-space parent (has an id and is not the screen-lock mode). */
export function isWorldParent(parent) {
  const p = normalizeParentData(parent);
  return !!p && !!p.id && p.mode === 'world';
}

/** The `{ pivot, basis, scale }` snapshot stored in `parent.bind`. */
export function bindFrameFrom(frame) {
  const f = normalizeFrame(frame);
  return {
    pivot: f.pos.slice(),
    basis: f.basis.map((v) => v.slice()),
    scale: f.scale.slice(),
  };
}

/** Same snapshot taken from a node's frame. */
export function bindFrameFor(node) {
  return bindFrameFrom(frameOf(node));
}

// ---------------------------------------------------------------- parent math

/**
 * Affine delta of the parent's motion since the bind:
 *   x' = c + L · (x − bind.pivot)
 *
 * - `inherit.pos`   off -> c stays at the bind pivot (rotate in place, no travel)
 * - `inherit.rot`   off -> L has no rotation
 * - `inherit.scale` off -> L has no scale change
 *
 * Returns null when there is no parent frame. `L` also carries the scale ratio
 * expressed along the parent's bind axes; `rot` and `scale` expose the pieces.
 */
/**
 * Strength of a spatial parent record at t: `{ rot, scale }` in 0..1 (default 1).
 * Base values live in `record.strength`, keyframes in `record.strengthKeys`
 * (`{ rot: [{t, v, ease}], scale: [...] }`), so every host kind (2D, 3D,
 * camera) stores them the same way.
 */
export function parentStrengthAt(record, t) {
  const base = isRecord(record?.strength) ? record.strength : {};
  const keys = isRecord(record?.strengthKeys) ? record.strengthKeys : {};
  const at = Number.isFinite(Number(t)) ? Number(t) : 0;
  const read = (ch) => {
    const fallback = Number.isFinite(Number(base[ch])) ? Number(base[ch]) : 1;
    const v = Number(sampleChannel(Array.isArray(keys[ch]) ? keys[ch] : [], at, fallback));
    return clamp(Number.isFinite(v) ? v : 1, 0, 1);
  };
  return { rot: read('rot'), scale: read('scale') };
}

/** Rotation matrix scaled toward identity: angle · w around the same axis. */
function rotPow(R, w) {
  if (w >= 1 - 1e-9) return R;
  if (w <= 1e-9) return M3.ident();
  const tr = R[0][0] + R[1][1] + R[2][2];
  const ang = Math.acos(clamp((tr - 1) / 2, -1, 1));
  if (ang < 1e-9) return M3.ident();
  let axis;
  if (Math.PI - ang < 1e-6) {
    // 180°: axis from the largest diagonal entry of (R + I) / 2.
    const d = [0, 1, 2].map((i) => (R[i][i] + 1) / 2);
    const i = d.indexOf(Math.max(...d));
    const a = [0, 0, 0];
    a[i] = Math.sqrt(Math.max(0, d[i]));
    for (let j = 0; j < 3; j++) if (j !== i) a[j] = (R[i][j] + R[j][i]) / (4 * a[i] || 1);
    axis = V.norm(a);
  } else {
    axis = V.norm([R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]]);
  }
  const th = ang * w;
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const [x, y, z] = axis;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

export function parentDelta(parentFrameAtT, bind, inherit = null, strength = null) {
  if (parentFrameAtT == null) return null;
  const frame = normalizeFrame(parentFrameAtT);
  const b = normalizeBind(bind);
  const inh = normalizeInherit(inherit);
  const B0 = M3.cols(...b.basis);
  const Bt = M3.cols(...frame.basis);
  // strength (0..1, keyable): how much of the parent's rotation / scale change
  // the child takes; 1 is the full delta, 0 none (same rule as the old 3D parent)
  const wRot = strength && Number.isFinite(Number(strength.rot)) ? clamp(Number(strength.rot), 0, 1) : 1;
  const wScale = strength && Number.isFinite(Number(strength.scale)) ? clamp(Number(strength.scale), 0, 1) : 1;
  const rot = inh.rot ? rotPow(M3.mul(Bt, M3.T(B0)), wRot) : M3.ident();
  const scale = [0, 1, 2].map((i) => {
    if (!inh.scale) return 1;
    const from = Math.abs(b.scale[i]) > 1e-9 ? b.scale[i] : 1;
    return 1 + (frame.scale[i] / from - 1) * wScale;
  });
  const L = M3.mul(rot, M3.mul(B0, M3.mul(M3.diag(scale), M3.T(B0))));
  return {
    c: inh.pos ? frame.pos.slice() : b.pivot.slice(),
    p0: b.pivot.slice(),
    L,
    rot,
    scale,
  };
}

const mapPoint = (delta, x) => V.add(delta.c, M3.apply(delta.L, V.sub(x, delta.p0)));

/** World point of a local point under a parentDelta. */
export function mapParentPoint(delta, point) {
  return delta ? mapPoint(delta, vec3(point)) : vec3(point);
}

/** World vector of a local vector under a parentDelta. */
export function mapParentVector(delta, vector) {
  return delta ? M3.apply(delta.L, vec3(vector)) : vec3(vector);
}

/** Orthonormal basis (basisFromDir convention) from a transformed forward + up. */
function rebasis(L, basis) {
  const forward = V.norm(M3.apply(L, V.norm(basis.forward)));
  let right = V.cross(forward, M3.apply(L, basis.up));
  if (V.len(right) < 1e-9) {
    right = V.cross(forward, Math.abs(forward[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]);
  }
  right = V.norm(right);
  return { right, up: V.cross(right, forward), forward };
}

/** Roll (degrees) of a basis relative to basisFromDir(basis.forward, 0). */
export function rollOf(basis) {
  const b0 = basisFromDir(basis.forward, 0);
  return (Math.atan2(V.dot(basis.right, b0.up), V.dot(basis.right, b0.right)) * 180) / Math.PI;
}

/**
 * Map a local frame `{ pos, basis, scale }` through the parent delta.
 * Exact for position; the basis is re-orthonormalised and the per-axis stretch
 * of the delta is folded into the scale (same rule as core/hierarchy.js).
 */
export function applyParentToFrame(localFrame, parentFrameAtT, bind, inherit = null, strength = null) {
  const local = normalizeFrame(localFrame);
  const delta = parentDelta(parentFrameAtT, bind, inherit, strength);
  if (!delta) return local;
  const b0 = basisOf(local.basis);
  const b1 = rebasis(delta.L, b0);
  const stretch = [b0.right, b0.up, b0.forward].map((v) => V.len(M3.apply(delta.L, v)));
  return {
    pos: mapPoint(delta, local.pos),
    basis: [b1.right, b1.up, b1.forward],
    scale: local.scale.map((s, i) => s * stretch[i]),
  };
}

/**
 * Apply a parent to a child node and return the world node (the input is not
 * mutated). The world position/frame is exact; pivot keeps its own rotation
 * centre and `position` is re-expressed in the transformed basis.
 *
 * A camera child should use `applyParentToFrame(cameraWorldFrame(cam, t), …)`:
 * the camera's own world position is the additive center + path, so mapping
 * `frameOf(cameraNode)` would use the wrong centre (the caller decides how the
 * transformed node becomes a camera).
 */
export function applyParentToNode(childNode, parentFrameAtT, bind, inherit = null, strength = null) {
  const node = normalizeSpatialNode(childNode);
  const delta = parentDelta(parentFrameAtT, bind, inherit, strength);
  if (!delta) return node;
  const b0 = basisFromDir(node.dir, node.roll);
  const b1 = rebasis(delta.L, b0);
  const stretch = [b0.right, b0.up, b0.forward].map((v) => V.len(M3.apply(delta.L, v)));
  const pivot = mapPoint(delta, node.pivot);
  const worldPos = mapPoint(delta, nodeWorldPos(node));
  const rel = V.sub(worldPos, pivot);
  return {
    pivot,
    position: [V.dot(rel, b1.right), V.dot(rel, b1.up), V.dot(rel, b1.forward)],
    dir: b1.forward,
    roll: rollOf(b1),
    scale: node.scale.map((s, i) => s * stretch[i]),
  };
}

// ---------------------------------------------------------------- project graph
//
// Cycle/depth helpers over the hosts a project can parent: 2D elements, 3D
// objects and cameras. The math above works on frames alone, so the caller can
// also resolve the chain itself; these helpers mirror core/hierarchy.js's rules
// (nearest-first, stop at a cycle / missing host / MAX_DEPTH).

function hostIndex(project) {
  const index = new Map();
  const add = (host) => {
    if (!host || host.id == null || String(host.id) === '') return;
    const id = String(host.id);
    if (!index.has(id)) index.set(id, host);
  };
  for (const el of Array.isArray(project?.elements) ? project.elements : []) add(el);
  for (const ob of Array.isArray(project?.scene?.objects) ? project.scene.objects : []) add(ob);
  for (const cam of Array.isArray(project?.cameras) ? project.cameras : []) add(cam);
  add(project?.camera);
  return index;
}

/** Host (element / object / camera) by id, or null. */
export function findSpatialHost(project, id) {
  const key = id == null ? '' : String(id);
  return key ? hostIndex(project).get(key) || null : null;
}

/**
 * Parent id stored on any host, or null. `@live` is just another id here.
 *
 * 2D elements store their spatial parent in `parent`; 3D objects and cameras
 * keep the old 3D hierarchy field `parent` for its own (different) graph and
 * write the unified spatial parent into `frameParent` instead
 * (core/spatial-parent.js). `frameParent` wins so the two graphs cannot be
 * confused when an object has both.
 */
export function spatialParentId(host) {
  const rec = host?.frameParent?.id != null && String(host.frameParent.id) !== ''
    ? host.frameParent
    : host?.parent;
  const id = rec?.id;
  return id != null && String(id) !== '' ? String(id) : null;
}

/** Ancestors nearest-first; stops (without throwing) at a cycle, a missing id or MAX_DEPTH. */
export function spatialAncestors(project, id) {
  const index = hostIndex(project);
  const out = [];
  const seen = new Set([String(id)]);
  let pid = spatialParentId(index.get(String(id)));
  while (pid && out.length < MAX_DEPTH) {
    if (seen.has(pid) || !index.has(pid)) break;
    seen.add(pid);
    const host = index.get(pid);
    out.push(host);
    pid = spatialParentId(host);
  }
  return out;
}

/** True when making `parentId` the parent of `childId` would close a loop. */
export function wouldSpatialCycle(project, childId, parentId) {
  if (parentId == null || String(parentId) === '') return false;
  const child = String(childId);
  const parent = String(parentId);
  if (!child || !parent) return false;
  if (child === parent) return true;
  return spatialAncestors(project, parent).some((host) => String(host.id) === child);
}
