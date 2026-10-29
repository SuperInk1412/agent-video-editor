// New data in the three-axis rotation format (docs/DESIGN-TRANSFORM-UNIFY.md §2).
//
// Opening a project turns old orientations into rotation.x/y/z
// (core/rotation-migrate.js). This module keeps freshly authored data in the
// same format, so an open never has to migrate it again:
//
//   addElement (node with dir/roll) -> node.rotation, 'roll' keys -> 'rotation.z'
//   addElement (2D, no node)        -> the element is created as a SpatialNode
//                                      with `rotation`; transform.* keys map to
//                                      pivot.* / scale.* / rotation.z
//   keySet / keyRemove / keyCurve transform.* -> the node paths above
//   keySet / keyRemove / keyCurve 'roll'      -> 'rotation.z' (nodes with rotation)
//   set transform.* / updateElement { transform } -> also move the node
//   propLink to / from 'roll'        -> 'rotation.z' (objects, nodes)
//   objectKey / objectUnkey dir|roll -> rotation.x/y/z keys (objects with rotation)
//
// Callers that still speak the old fields (AI ops, CLI, older UI paths) keep
// working. Camera 'roll' still adds at runtime and is left alone.
//
// Pure ESM, no `node:*`.
import { isRecord } from './json.js';
import { PX_PER_M, objectPose } from './scene.js';
import { screenCenterY, screenToWorld } from './space.js';
import { dirRollFromRotation, normalizeRotation, rotationFromDirRoll } from './rotation.js';

const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const unwrap = (v, prev) => v + 360 * Math.round((prev - v) / 360);

/** Node key paths (with values) a legacy 2D key becomes, or null when it is not spatial. */
export function nodeKeyTargets(path, value, meta) {
  const v = Number(value);
  switch (path) {
    case 'transform.x': return [['pivot.x', r6(v / PX_PER_M)]];
    case 'transform.y': return [['pivot.y', r6(screenCenterY(meta) - v / PX_PER_M)]];
    case 'transform.z': return [['pivot.z', v]];
    case 'transform.scale': return [['scale.x', v], ['scale.y', v]];
    case 'transform.rotation': return [['rotation.z', v]];
    default: return null;
  }
}

/**
 * Give a new 2D element (no `node`) its SpatialNode with `rotation`, the way an
 * open would migrate it (core/migrate-spatial.js, preserve: same picture).
 */
export function createAsNode(meta, el) {
  if (el.type === 'audio' || isRecord(el.node)) return el;
  const tr = isRecord(el.transform) ? el.transform : {};
  const scale = num(tr.scale, 1);
  el.node = {
    pivot: screenToWorld(meta, num(tr.x), num(tr.y), num(tr.z)).map(r6),
    position: [0, 0, 0],
    rotation: [0, 0, num(tr.rotation)],
    scale: [scale, scale, 1],
  };
  const keys = [];
  for (const key of Array.isArray(el.keyframes) ? el.keyframes : []) {
    const targets = isRecord(key) && Number.isFinite(Number(key.value)) ? nodeKeyTargets(key.path, key.value, meta) : null;
    if (!targets) { keys.push(key); continue; }
    for (const [path, value] of targets) keys.push({ ...key, path, value });
  }
  el.keyframes = keys;
  return el;
}

/**
 * A node given with dir / roll only gets its `rotation` (z carries the roll,
 * shifted for near-vertical facings like core/rotation-migrate.js does).
 */
export function nodeWithRotation(el) {
  const node = el.node;
  if (!isRecord(node) || Array.isArray(node.rotation)) return el;
  const rot = rotationFromDirRoll(node.dir || [0, 0, 1], num(node.roll));
  node.rotation = rot.map(r6);
  const z0 = rot[2] - num(node.roll);
  for (const key of Array.isArray(el.keyframes) ? el.keyframes : []) {
    if (key?.path === 'roll') { key.path = 'rotation.z'; key.value = r6(num(key.value) + z0); }
  }
  delete node.dir;
  delete node.roll;
  return el;
}

/** The node patch an old `transform` patch means for a node element. */
function nodePatchFromTransform(meta, el, tr) {
  const node = { ...el.node };
  const pivot = Array.isArray(node.pivot) ? node.pivot.slice() : [0, 0, 0];
  if (tr.x !== undefined) pivot[0] = r6(num(tr.x) / PX_PER_M);
  if (tr.y !== undefined) pivot[1] = r6(screenCenterY(meta) - num(tr.y) / PX_PER_M);
  if (tr.z !== undefined) pivot[2] = num(tr.z);
  node.pivot = pivot;
  if (tr.scale !== undefined) {
    const s = Array.isArray(node.scale) ? node.scale.slice() : [1, 1, 1];
    s[0] = num(tr.scale, 1); s[1] = num(tr.scale, 1);
    node.scale = s;
  }
  if (tr.rotation !== undefined) {
    const rot = normalizeRotation(node.rotation);
    rot[2] = num(tr.rotation);
    node.rotation = rot;
  }
  return node;
}

/**
 * `[x, y, z]` that faces `dir` (in the host's own space) while keeping the
 * self-rotation (roll) of `cur`, each axis shifted by whole turns to stay near
 * `cur` so a key never spins the object around. Used by the old `dir` op
 * translation and the object menu's "面向镜头".
 */
export function facingRotation(dir, cur) {
  const base = normalizeRotation(cur);
  const { roll } = dirRollFromRotation(base);
  return rotationFromDirRoll(dir, roll).map((v, i) => r6(unwrap(v, base[i])));
}

/** Three axis keys for an object's old dir / roll key at t. */
function objectAxisOps(obj, op) {
  const t = num(op.t);
  const cur = objectPose(obj, t).rotation || normalizeRotation(obj.rotation);
  const v = op.v !== undefined ? op.v : op.value;
  const next = op.path === 'dir'
    ? facingRotation(v, cur)
    : rotationFromDirRoll(dirRollFromRotation(cur).dir, num(v)).map((x, i) => r6(unwrap(x, cur[i])));
  const { value, ...rest } = op;
  return ['x', 'y', 'z'].map((a, i) => ({ ...rest, path: `rotation.${a}`, v: next[i] }));
}

/** A link host whose 'roll' now lives in rotation.z (cameras keep their own roll). */
function hasRotation(p, host, id) {
  if (host === 'ob') return Array.isArray((p.scene?.objects || []).find((o) => o.id === id)?.rotation);
  if (host === 'el') return Array.isArray((p.elements || []).find((e) => e.id === id)?.node?.rotation);
  return false;
}

/**
 * The op to run instead of `op`, or null to run it as is. `find*` look hosts up
 * without failing (core/ops.js reports unknown ids itself).
 */
export function rotationFormatOp(p, op) {
  const kind = op?.op;
  const elementKeyOp = kind === 'keySet' || kind === 'keyRemove'
    || (kind === 'keyCurve' && String(op.host || 'element') === 'element');
  if (elementKeyOp) {
    const el = (p.elements || []).find((e) => e.id === op.id);
    if (!isRecord(el?.node)) return null;
    if (op.path === 'roll' && Array.isArray(el.node.rotation)) return { ...op, path: 'rotation.z' };
    if (!String(op.path || '').startsWith('transform.')) return null;
    if (kind !== 'keySet') {
      const paths = (nodeKeyTargets(op.path, 0, p.meta) || []).map(([path]) => path);
      return paths.length ? { op: 'batch', ops: paths.map((path) => ({ ...op, path })) } : null;
    }
    const targets = Number.isFinite(Number(op.value)) ? nodeKeyTargets(op.path, op.value, p.meta) : null;
    if (!targets) return null;
    return { op: 'batch', ops: targets.map(([path, value]) => ({ ...op, path, value })) };
  }
  if (kind === 'set' && /^transform\.(x|y|z|scale|rotation)$/.test(String(op.path))) {
    const el = (p.elements || []).find((e) => e.id === op.id);
    if (!isRecord(el?.node)) return null;
    return { op: 'updateElement', id: op.id, patch: { transform: { [String(op.path).slice(10)]: Number(op.value) } } };
  }
  if (kind === 'updateElement' && isRecord(op.patch) && isRecord(op.patch.transform)) {
    const el = (p.elements || []).find((e) => e.id === op.id);
    if (!isRecord(el?.node) || isRecord(op.patch.node)) return null;
    return { ...op, patch: { ...op.patch, node: nodePatchFromTransform(p.meta, el, op.patch.transform) } };
  }
  if (kind === 'propLink') {
    const to = op.to === 'roll' && hasRotation(p, op.host, op.id);
    const from = isRecord(op.from) && op.from.path === 'roll' && hasRotation(p, op.from.host, op.from.id);
    if (!to && !from) return null;
    return { ...op, ...(to ? { to: 'rotation.z' } : {}), ...(from ? { from: { ...op.from, path: 'rotation.z' } } : {}) };
  }
  if ((kind === 'objectKey' || kind === 'objectUnkey') && (op.path === 'dir' || op.path === 'roll')) {
    const obj = (p.scene?.objects || []).find((o) => o.id === op.id);
    if (!Array.isArray(obj?.rotation)) return null;
    if (kind === 'objectUnkey') return { op: 'batch', ops: ['x', 'y', 'z'].map((a) => ({ ...op, path: `rotation.${a}` })) };
    return { op: 'batch', ops: objectAxisOps(obj, op) };
  }
  return null;
}
