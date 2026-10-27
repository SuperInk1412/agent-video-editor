// Parenting for v3 scene objects: empties, inherit switches, weighted strength.
// Pure ESM (no node:*): the viewport, the bake (engine/shot.js) and tests share it.
//
//   obj.parent = {
//     id: 'ob_3',
//     inherit:  { pos: true, rot: true, scale: true },
//     strength: { rot: 1, scale: 1 },               // 0..1; keyable as tracks 'parent.rot' / 'parent.scale'
//     bind:     { pos: [x,y,z], basis: [right, up, forward], scale: [sx,sy,sz] },  // parent's world frame when bound
//   }
//
// A child's own values stay what they were when it was bound, so binding never
// moves it. At time t the child is carried by the parent's motion since the bind:
//
//   x' = c + L · (x - bind.pos)
//   c  = parent world position          (bind.pos when `pos` is off)
//   L  = Rd^w · B · diag(k) · Bᵀ          Rd = parentBasis · bindBasisᵀ, w = rot strength (I when `rot` is off)
//                                         k  = 1 + (parentScale / bind.scale - 1) · scale strength (1 when `scale` is off)
//
// The parent's frame is its geometry centre + basis + scale (what objectPose
// returns), resolved recursively up to MAX_DEPTH; cycles and missing parents
// fall back to "no parent". Opacity and other non-transform values are not inherited.
import { clamp } from './time.js';
import { objectPose, sampleChannel, basisFromDir } from './scene.js';

export const MAX_DEPTH = 32;
export const STRENGTH_TRACKS = { rot: 'parent.rot', scale: 'parent.scale' };

const isNum = (n) => Number.isFinite(Number(n));
const num = (n, d = 0) => (isNum(n) ? Number(n) : d);
const vec3 = (v, d = [0, 0, 0]) => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(isNum)
  ? [Number(v[0]), Number(v[1]), Number(v[2])]
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

const objectList = (src) => (Array.isArray(src) ? src : (src?.scene?.objects || []));

export function parentIdOf(obj) {
  const id = obj?.parent?.id;
  return id ? String(id) : null;
}

/** Ancestors nearest-first. Stops (without throwing) at a cycle, a missing id or MAX_DEPTH. */
export function ancestors(src, id) {
  const list = objectList(src);
  const byId = new Map(list.map((o) => [o.id, o]));
  const out = [];
  const seen = new Set([id]);
  let cur = byId.get(id);
  while (cur && out.length < MAX_DEPTH) {
    const pid = parentIdOf(cur);
    if (!pid || seen.has(pid) || !byId.has(pid)) break;
    seen.add(pid);
    cur = byId.get(pid);
    out.push(cur);
  }
  return out;
}

/** True when making `parentId` the parent of `childId` would close a loop. */
export function wouldCycle(src, childId, parentId) {
  if (!parentId) return false;
  if (childId === parentId) return true;
  return ancestors(src, parentId).some((o) => o.id === childId);
}

/** Direct children ids. */
export function childrenOf(src, id) {
  return objectList(src).filter((o) => parentIdOf(o) === id).map((o) => o.id);
}

/** Effective inherit switches and (keyed) strengths at time t. */
export function parentWeights(obj, t) {
  const p = obj?.parent || {};
  const inh = p.inherit || {};
  const str = p.strength || {};
  const tr = obj?.tracks || {};
  return {
    pos: inh.pos !== false,
    rot: inh.rot !== false,
    scale: inh.scale !== false,
    wRot: clamp(num(sampleChannel(tr[STRENGTH_TRACKS.rot], t, num(str.rot, 1)), 1), 0, 1),
    wScale: clamp(num(sampleChannel(tr[STRENGTH_TRACKS.scale], t, num(str.scale, 1)), 1), 0, 1),
  };
}

/** The frame a parent hands to its children: geometry centre, orthonormal basis, scale. */
export function frameOf(pose) {
  return {
    pos: pose.worldPos.slice(),
    basis: [pose.basis.right.slice(), pose.basis.up.slice(), pose.basis.forward.slice()],
    scale: pose.scale.slice(),
  };
}

function normalizeBind(b) {
  if (!b || typeof b !== 'object') return { pos: [0, 0, 0], basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], scale: [1, 1, 1] };
  const basis = Array.isArray(b.basis) && b.basis.length === 3
    ? b.basis.map((v, i) => V.norm(vec3(v, [[1, 0, 0], [0, 1, 0], [0, 0, 1]][i])))
    : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return { pos: vec3(b.pos), basis, scale: vec3(b.scale, [1, 1, 1]) };
}

/**
 * The affine map a parent applies to its child at time t, or null when the
 * child has no (valid) parent. `{ c, p0, L }`: x' = c + L·(x - p0).
 */
export function parentMap(src, obj, t, cache = null, depth = 0) {
  const pid = parentIdOf(obj);
  if (!pid || depth >= MAX_DEPTH) return null;
  const list = objectList(src);
  const parent = list.find((o) => o.id === pid);
  if (!parent || wouldCycle(list, obj.id, pid)) return null;
  const pf = frameOf(worldPose(list, parent, t, cache, depth + 1));
  const bind = normalizeBind(obj.parent.bind);
  const w = parentWeights(obj, t);

  const B0 = M3.cols(...bind.basis);
  const Bt = M3.cols(...pf.basis);
  const Rd = w.rot ? rotPow(M3.mul(Bt, M3.T(B0)), w.wRot) : M3.ident();
  const k = w.scale
    ? [0, 1, 2].map((i) => 1 + ((pf.scale[i] / (Math.abs(bind.scale[i]) > 1e-9 ? bind.scale[i] : 1)) - 1) * w.wScale)
    : [1, 1, 1];
  const L = M3.mul(Rd, M3.mul(B0, M3.mul(M3.diag(k), M3.T(B0))));
  return { c: w.pos ? pf.pos : bind.pos, p0: bind.pos, L };
}

export const mapPoint = (m, x) => V.add(m.c, M3.apply(m.L, V.sub(x, m.p0)));
export const mapVector = (m, v) => M3.apply(m.L, v);

/** Orthonormal basis (basisFromDir convention) from transformed forward + up. */
function rebasis(m, basis) {
  const f = V.norm(mapVector(m, basis.forward));
  let r = V.cross(f, mapVector(m, basis.up));
  if (V.len(r) < 1e-9) r = V.cross(f, Math.abs(f[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]);
  const right = V.norm(r);
  return { right, up: V.cross(right, f), forward: f };
}

/** Roll (degrees) of `basis` relative to basisFromDir(basis.forward, 0). */
export function rollOf(basis) {
  const b0 = basisFromDir(basis.forward, 0);
  return (Math.atan2(V.dot(basis.right, b0.up), V.dot(basis.right, b0.right)) * 180) / Math.PI;
}

/** Apply a parent map to a local pose -> world pose (same shape as objectPose). */
export function applyMapToPose(m, pose) {
  const basis = rebasis(m, pose.basis);
  const stretch = [pose.basis.right, pose.basis.up, pose.basis.forward].map((b) => V.len(mapVector(m, b)));
  const pivot = mapPoint(m, pose.pivot);
  const worldPos = mapPoint(m, pose.worldPos);
  const rel = V.sub(worldPos, pivot);
  return {
    ...pose,
    pivot,
    position: [V.dot(rel, basis.right), V.dot(rel, basis.up), V.dot(rel, basis.forward)],
    scale: pose.scale.map((s, i) => s * stretch[i]),
    dir: basis.forward,
    roll: rollOf(basis),
    basis,
    worldPos,
  };
}

/**
 * World pose of an object at time t (objectPose + the parent chain).
 * `src` is the project or its scene.objects array. Pass a Map as `cache`
 * when posing many objects for the same t.
 */
export function worldPose(src, obj, t, cache = null, depth = 0) {
  const key = cache ? `${obj?.id}@${t}` : null;
  if (cache?.has(key)) return cache.get(key);
  const local = objectPose(obj, t);
  const m = parentMap(src, obj, t, cache, depth);
  const pose = m ? { ...applyMapToPose(m, local), parentId: parentIdOf(obj) } : local;
  if (cache) cache.set(key, pose);
  return pose;
}

// ---------------------------------------------------------------- rewriting

const VEC_AXES = (name) => ['x', 'y', 'z'].map((a) => `${name}.${a}`);
const isDiagonal = (L) => [0, 1, 2].every((r) => [0, 1, 2].every((c) => r === c || Math.abs(L[r][c]) < 1e-9));

function mapKeyHandles(key, fn) {
  for (const h of ['out', 'in']) if (Array.isArray(key[h]) && key[h].length === 3) key[h] = fn(key[h].map(Number));
}

/**
 * Rewrite a point channel (pivot) through x' = c + L·(x - p0): base, vec3 track
 * and x/y/z sub-tracks. Sub-tracks stay per-axis when L is diagonal; otherwise
 * they are merged into one vec3 track keyed at the union of their times
 * (per-axis eases are lost — documented in SPEC-OBJECTS).
 */
function rewritePoint(obj, name, m, sampleAt) {
  obj[name] = mapPoint(m, vec3(obj[name]));
  const tr = obj.tracks || {};
  if (Array.isArray(tr[name]) && tr[name].length) {
    for (const k of tr[name]) {
      if (Array.isArray(k.v)) k.v = mapPoint(m, vec3(k.v));
      mapKeyHandles(k, (h) => mapVector(m, h));
    }
    return;
  }
  const axes = VEC_AXES(name).filter((a) => Array.isArray(tr[a]) && tr[a].length);
  if (!axes.length) return;
  if (isDiagonal(m.L)) {
    VEC_AXES(name).forEach((a, i) => {
      for (const k of tr[a] || []) if (isNum(k.v)) k.v = m.c[i] + m.L[i][i] * (Number(k.v) - m.p0[i]);
    });
    return;
  }
  const times = [...new Set(axes.flatMap((a) => tr[a].map((k) => Number(k.t))))].sort((a, b) => a - b);
  tr[name] = times.map((t) => ({ t, v: mapPoint(m, sampleAt(t)) }));
  for (const a of VEC_AXES(name)) delete tr[a];
}

/** Multiply a per-axis channel (position, scale) by f: base, vec3 track, sub-tracks. */
function rewriteScaled(obj, name, f, fallback) {
  obj[name] = vec3(obj[name], fallback).map((v, i) => v * f[i]);
  const tr = obj.tracks || {};
  for (const k of tr[name] || []) {
    if (Array.isArray(k.v)) k.v = vec3(k.v, fallback).map((v, i) => v * f[i]);
    mapKeyHandles(k, (h) => h.map((v, i) => v * f[i]));
  }
  VEC_AXES(name).forEach((a, i) => {
    for (const k of tr[a] || []) if (isNum(k.v)) k.v = Number(k.v) * f[i];
  });
}

/**
 * Bake a parent map into the object's own values so that, without the
 * parent, its world pose at time t is unchanged ("clear parent, keep
 * transform"). Exact at t for rigid + uniform-scale parents; with
 * non-uniform parent scale the result is the closest unsheared pose.
 */
export function bakeMapIntoObject(obj, m, t) {
  const local = objectPose(obj, t);
  const world = applyMapToPose(m, local);
  const stretch = [local.basis.right, local.basis.up, local.basis.forward].map((b) => V.len(mapVector(m, b)));
  const dRoll = world.roll - local.roll;
  const sampleAt = (tt) => objectPose(obj, tt).pivot;

  rewritePoint(obj, 'pivot', m, sampleAt);
  rewriteScaled(obj, 'position', stretch, [0, 0, 0]);
  rewriteScaled(obj, 'scale', stretch, [1, 1, 1]);

  const rotDir = (d) => V.norm(mapVector(m, V.norm(vec3(d, [0, 0, -1]))));
  obj.rot = { ...(obj.rot || {}), dir: rotDir(obj.rot?.dir), roll: num(obj.rot?.roll, 0) + dRoll };
  const tr = obj.tracks || {};
  for (const k of tr.dir || []) {
    if (Array.isArray(k.v)) k.v = rotDir(k.v);
    mapKeyHandles(k, (h) => mapVector(m, h));
  }
  for (const k of tr.roll || []) if (isNum(k.v)) k.v = Number(k.v) + dRoll;
  return world;
}

// ---------------------------------------------------------------- ops (dispatched by core/ops-ext.js)

export const HIERARCHY_OP_KINDS = ['objectParent', 'objectUnparent', 'objectParentKey', 'objectParentUnkey'];

const roundT = (t) => Math.round(Math.max(0, num(t, 0)) * 1000) / 1000;
const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;
const channelTrack = (op, fail) => {
  const ch = String(op.channel || '');
  if (!STRENGTH_TRACKS[ch]) fail(`${op.op} channel must be rot|scale`);
  return STRENGTH_TRACKS[ch];
};

/** Drop the parent, keeping the world pose at time t. */
export function unparentKeep(list, obj, t) {
  const m = parentMap(list, obj, t);
  if (m) bakeMapIntoObject(obj, m, t);
  delete obj.parent;
  if (obj.tracks) for (const name of Object.values(STRENGTH_TRACKS)) delete obj.tracks[name];
}

/**
 * objectParent      {id, parent, t?, inherit?:{pos,rot,scale}, strength?:{rot,scale}}
 *                   re-parenting (or changing inherit/strength) keeps the world pose at t.
 * objectUnparent    {id, t?}                    keeps the world pose at t.
 * objectParentKey   {id, channel:'rot'|'scale', t, v:0..1, ease?}
 * objectParentUnkey {id, channel, t}
 */
export function applyHierarchyOp(p, op, api) {
  const { fail, findObject } = api;
  const list = p.scene?.objects || [];
  switch (op.op) {
    case 'objectParent': {
      const obj = findObject(op.id);
      if (op.parent == null || op.parent === '') return applyHierarchyOp(p, { ...op, op: 'objectUnparent' }, api);
      const pid = String(op.parent);
      const parent = findObject(pid);
      if (wouldCycle(list, obj.id, pid)) fail(`parenting ${obj.id} to ${pid} makes a loop`);
      if (ancestors(list, pid).length + 1 >= MAX_DEPTH) fail(`hierarchy deeper than ${MAX_DEPTH}`);
      const t = roundT(op.t);
      const prev = obj.parent || {};
      const inh = { ...(prev.inherit || {}), ...(op.inherit || {}) };
      const str = { ...(prev.strength || {}), ...(op.strength || {}) };
      unparentKeep(list, obj, t);
      const frame = frameOf(worldPose(list, parent, t));
      obj.parent = {
        id: pid,
        inherit: { pos: inh.pos !== false, rot: inh.rot !== false, scale: inh.scale !== false },
        strength: { rot: clamp(num(str.rot, 1), 0, 1), scale: clamp(num(str.scale, 1), 0, 1) },
        bind: {
          pos: frame.pos.map(r6),
          basis: frame.basis.map((v) => v.map(r6)),
          scale: frame.scale.map(r6),
        },
      };
      return { changed: [obj.id] };
    }
    case 'objectUnparent': {
      const obj = findObject(op.id);
      if (!obj.parent) return { changed: [] };
      unparentKeep(list, obj, roundT(op.t));
      return { changed: [obj.id] };
    }
    case 'objectParentKey': {
      const obj = findObject(op.id);
      if (!obj.parent) fail(`object ${obj.id} has no parent`);
      const name = channelTrack(op, fail);
      const v = Number(op.v !== undefined ? op.v : op.value);
      if (!Number.isFinite(v)) fail(`${op.op} needs v in 0..1`);
      const t = roundT(op.t);
      const tracks = obj.tracks || (obj.tracks = {});
      const old = (tracks[name] || []).find((k) => Math.abs(k.t - t) <= 1e-4);
      const key = { t, v: clamp(v, 0, 1) };
      if (op.ease || old?.ease) key.ease = String(op.ease || old.ease);
      tracks[name] = (tracks[name] || []).filter((k) => Math.abs(k.t - t) > 1e-4).concat(key).sort((a, b) => a.t - b.t);
      return { changed: [obj.id], key };
    }
    case 'objectParentUnkey': {
      const obj = findObject(op.id);
      const name = channelTrack(op, fail);
      const t = roundT(op.t);
      const tracks = obj.tracks || {};
      if (!Array.isArray(tracks[name])) return { changed: [] };
      const left = tracks[name].filter((k) => Math.abs(k.t - t) > 1e-4);
      if (left.length) tracks[name] = left;
      else delete tracks[name];
      return { changed: [obj.id] };
    }
    default:
      return null;
  }
}
