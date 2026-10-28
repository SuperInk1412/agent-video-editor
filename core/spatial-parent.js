// Unified spatial parents: the matrix parent of PLAN-ui-round3 §3.1 for 2D
// elements, 3D objects AND cameras. Pure ESM (no node:*): the op, the preview
// sampling, the Blender bake and the tests share it.
//
//   element.parent      = { id, mode: 'world', inherit, bind }   (existing field)
//   object.frameParent  = { id, mode: 'world', inherit, bind }   (new field)
//   camera.frameParent  = { id, mode: 'world', inherit, bind }   (new field)
//
// `bind` is the parent's world frame at binding time (core/spatial.js::
// bindFrameFor / hostFrameAt). At time t a child's world frame is
//
//   applyParentToFrame(childLocalFrame(t), parentFrame(t), bind, inherit)
//
// so the parent's motion since the bind carries the child: parent rotation
// orbits the child around the parent's frame pivot, parent translation moves it
// and parent scale stretches it. Because the delta at the bind time is the
// identity, binding never moves the child at the playhead.
//
// 3D objects keep their old 3D hierarchy in `obj.parent` (core/hierarchy.js:
// empties, strength tracks) — that graph is unchanged and evaluated first. A
// `frameParent` is an extra matrix layer applied on top of that world pose, so
// old projects and old ops behave exactly as before. Cameras have no legacy
// parent field; their frameParent is applied on the evaluated camera frame
// (core/spatial.js::cameraWorldFrame) and re-emitted as an evalCamera-compatible
// state by `evalCameraWorld`.
//
// Two rules keep the legacy screen lock intact:
//   - `@live` (mode:'screen') and the old camera lock written by
//     core/hierarchy.js::applyElementParentOp (`parent.kind === 'camera'`, no
//     `mode`) are NOT world parents. They stay the render-time carrier
//     (core/hierarchy.js::elementCarrier) and `elementWorldParent` rejects them.
//   - `spatialUnparent` only deletes a world parent and never rewrites the
//     child's local node/keyframes (for 3D objects the old `obj.parent` is left
//     alone; remove it with objectUnparent).
//
// A parent chain may mix elements, objects and cameras. `hostFrameAt` resolves
// any host id recursively (objects through worldPose + frameParent, cameras
// through cameraWorldFrame + frameParent, elements through their own parent
// chain), guarded by MAX_DEPTH and a `seen` set so hand-edited loops cannot
// crash the preview or the bake.
import { isRecord } from './json.js';
import { sampleTrack } from './time.js';
import { evalCamera, cameraAtTime, normalizeCamera } from './camera.js';
import { frameOf as poseFrameOf, inverseMapPoint, inverseMapVector, toLocalPoint, toLocalVector, worldPose } from './hierarchy.js';
import {
  MAX_DEPTH, SCREEN_PARENT, applyParentToFrame, applyParentToNode, bindFrameFor,
  bindFrameFrom, cameraWorldFrame, elementNode, findSpatialHost, frameOf,
  frameToNode, mapParentPoint, normalizeInherit, normalizeSpatialNode,
  parentDelta, parentStrengthAt, rollOf, spatialAncestors, wouldSpatialCycle,
} from './spatial.js';

/** Ops owned by this module (registered in core/ops.js and core/contracts.js). */
export const SPATIAL_PARENT_OP_KINDS = ['spatialParent', 'spatialUnparent'];

const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;
const roundT = (t) => Math.round(Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0) * 1000) / 1000;
const num = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(n) : d);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * The element's world-parent record, or null. Only an explicit `mode:'world'`
 * counts: the legacy camera screen lock has no `mode` (and keeps `kind:
 * 'camera'`), and `@live` is the screen mode.
 */
export function elementWorldParent(el) {
  const parent = isRecord(el) ? el.parent : null;
  if (!isRecord(parent) || parent.id == null || String(parent.id) === '') return null;
  if (String(parent.id) === SCREEN_PARENT || parent.mode !== 'world' || parent.kind === 'camera') return null;
  return parent;
}

/**
 * The unified world-parent record stored on a 3D object / camera in
 * `frameParent`, or null. Same shape as `el.parent` (PLAN §3.1); the old
 * `obj.parent` is a different graph and is never read here.
 */
export function worldFrameParent(host) {
  const parent = isRecord(host) ? host.frameParent : null;
  if (!isRecord(parent) || parent.id == null || String(parent.id) === '') return null;
  if (String(parent.id) === SCREEN_PARENT || parent.mode === 'screen') return null;
  if (parent.mode != null && parent.mode !== 'world') return null;
  return parent;
}

/** Spatial-parent record of any host kind ('element' uses `parent`, others `frameParent`). */
export function hostSpatialParent(project, id) {
  const kind = spatialHostKind(project, id);
  if (!kind) return null;
  const host = findSpatialHost(project, id);
  if (!host) return null;
  return kind === 'element' ? elementWorldParent(host) : worldFrameParent(host);
}

/** Host kind of a spatial id: 'element' | 'object' | 'camera' | null. */
export function spatialHostKind(project, id) {
  const key = id == null ? '' : String(id);
  if (!key || key === SCREEN_PARENT) return null;
  const elements = Array.isArray(project?.elements) ? project.elements : [];
  if (elements.some((el) => String(el?.id) === key)) return 'element';
  const objects = Array.isArray(project?.scene?.objects) ? project.scene.objects : [];
  if (objects.some((ob) => String(ob?.id) === key)) return 'object';
  const cameras = Array.isArray(project?.cameras) ? project.cameras : (project?.camera ? [project.camera] : []);
  if (cameras.some((cam) => String(cam?.id) === key)) return 'camera';
  return null;
}

function elementById(project, id) {
  const key = String(id);
  return (Array.isArray(project?.elements) ? project.elements : []).find((el) => String(el?.id) === key) || null;
}

/**
 * Local (unparented) node of an element at t: `elementNode` (base node with the
 * legacy fallback) plus the migrated `pivot.* / scale.* / roll` keyframes,
 * exactly like `app/renderer/js/node-at.js::elementNodeAt`. Kept here so core
 * ops can bind at a playhead without importing the renderer; keep the two
 * samplers in sync (tests cross-check them).
 *
 * `core/links.js::elementNodeWithLinks` wraps this with property links.
 */
export function elementLocalNode(project, el, t) {
  const meta = isRecord(project?.meta) ? project.meta : {};
  const base = normalizeSpatialNode(elementNode(el, meta, t));
  if (!isRecord(el?.node)) return base;
  const at = t == null ? null : Number(t);
  if (at == null || !Number.isFinite(at)) return base;
  const sample = (path, fallback) => sampleTrack(el.keyframes, path, at, fallback);
  return {
    pivot: [
      sample('pivot.x', base.pivot[0]),
      sample('pivot.y', base.pivot[1]),
      sample('pivot.z', base.pivot[2]),
    ],
    position: base.position.slice(),
    dir: base.dir.slice(),
    roll: sample('roll', base.roll),
    scale: [
      sample('scale.x', base.scale[0]),
      sample('scale.y', base.scale[1]),
      sample('scale.z', base.scale[2]),
    ],
  };
}

// ---------------------------------------------------------------- world frames

/**
 * World frame + fresh bind snapshot of ANY spatial host id at t, or null when
 * the host is missing / the chain is cyclic or deeper than MAX_DEPTH.
 *
 *   element -> its `parent` chain (world parents only; the screen lock is not
 *              part of this graph)
 *   object  -> core/hierarchy.js::worldPose (the old 3D `obj.parent` graph),
 *              then its own `frameParent` delta
 *   camera  -> core/spatial.js::cameraWorldFrame, then its own `frameParent`
 *
 * `opts.localNodeAt(host, t)` overrides how element local nodes are sampled
 * (the renderer passes the sampled `el.node` reader); without it the core
 * sampler above is used. `opts.seen` / `opts.depth` are internal recursion
 * guards and are safe to omit.
 */
export function hostFrameAt(project, id, t = 0, opts = {}) {
  opts = opts || {};
  const key = id == null ? '' : String(id);
  if (!key) return null;
  const depth = Number(opts.depth) || 0;
  if (depth > MAX_DEPTH) return null;
  const seen = opts.seen instanceof Set ? opts.seen : new Set();
  if (seen.has(key)) return null;
  const kind = spatialHostKind(project, key);
  if (!kind) return null;
  const host = findSpatialHost(project, key);
  if (!host) return null;
  seen.add(key);
  const where = { ...opts, depth, seen };
  if (kind === 'element') {
    const node = elementWorldNodeAt(project, host, t, opts.localNodeAt, depth, seen, opts);
    return { kind, host, frame: frameOf(node), node, bind: bindFrameFor(node) };
  }
  const base = kind === 'object'
    ? poseFrameOf(worldPose(project, host, t, null, 0, opts.poseAt))
    : cameraWorldFrame(host, t, opts.param ? { param: opts.param } : null);
  const parent = worldFrameParent(host);
  if (!parent || depth >= MAX_DEPTH || seen.has(String(parent.id))) {
    return { kind, host, frame: base, bind: bindFrameFrom(base) };
  }
  const resolved = hostFrameAt(project, parent.id, t, { ...where, depth: depth + 1 });
  if (!resolved) return { kind, host, frame: base, bind: bindFrameFrom(base) };
  const frame = applyParentToFrame(base, resolved.frame, parent.bind, parent.inherit, parentStrengthAt(parent, t));
  return { kind, host, frame, bind: bindFrameFrom(frame) };
}

/** World SpatialNode of any host id at t, or null (objects/cameras rebuild a node from their frame). */
export function hostWorldNode(project, id, t = 0, opts = {}) {
  const resolved = hostFrameAt(project, id, t, opts);
  return resolved ? frameToNode(resolved.frame) : null;
}

/**
 * World pose of a 3D object at t: the shipped `worldPose` (objectPose + the old
 * 3D parent chain) plus an optional `frameParent` matrix layer. Without
 * `frameParent` this is byte-for-byte `worldPose`, so every existing render /
 * bake stays identical. `src` may be the project or its scene.objects array;
 * `cache` is the same Map `worldPose` takes.
 *
 * `opts.poseAt(obj, t)` overrides every local pose in both graphs (property
 * links: core/links.js::objectWorldPoseWithLinks); `opts.param`,
 * `opts.localNodeAt` and `opts.poseAt` also reach the frameParent host.
 */
export function objectWorldPose(project, obj, t, cache = null, opts = null) {
  const src = Array.isArray(project) ? { scene: { objects: project } } : project;
  const base = worldPose(src, obj, t, cache, 0, opts?.poseAt);
  const parent = worldFrameParent(obj);
  if (!parent) return base;
  const resolved = hostFrameAt(src, parent.id, t, opts);
  if (!resolved) return base;
  const delta = parentDelta(resolved.frame, parent.bind, parent.inherit, parentStrengthAt(parent, t));
  if (!delta) return base;
  const local = poseFrameOf(base);
  const frame = applyParentToFrame(local, resolved.frame, parent.bind, parent.inherit, parentStrengthAt(parent, t));
  const basis = { right: frame.basis[0], up: frame.basis[1], forward: frame.basis[2] };
  const pivot = mapParentPoint(delta, base.pivot);
  const rel = sub(frame.pos, pivot);
  return {
    ...base,
    pivot,
    position: [dot(rel, basis.right), dot(rel, basis.up), dot(rel, basis.forward)],
    worldPos: frame.pos,
    basis,
    dir: basis.forward,
    roll: rollOf(basis),
    scale: frame.scale,
    frameParentId: String(parent.id),
  };
}

/**
 * evalCamera-compatible camera state with the camera's `frameParent` applied:
 * `pos` / `look` / `roll` are the parented world frame, everything else
 * (`fov`, `opacity`, picture transform, dof, ...) is the local evaluation.
 * Without `frameParent` this returns exactly `evalCamera`.
 *
 * `opts.param(cam, path, t)` resolves property links for both the camera itself
 * and its frameParent host (core/links.js::evalCameraWorldWithLinks).
 *
 * Pass `cam` to evaluate a specific camera (camera stack layer); omit it for
 * the shot that is live at t (evalCamera's current-shot rule).
 */
export function evalCameraWorld(project, t = 0, cam = null, opts = null) {
  const at = Number.isFinite(Number(t)) ? Number(t) : 0;
  const host = cam
    ? normalizeCamera(cam)
    : (cameraAtTime(project, at) || normalizeCamera(project?.camera || null));
  const base = cam
    ? evalCamera({ camera: host, cameras: [host], activeCameraId: host.id }, at, opts)
    : evalCamera(project, at, opts);
  const parent = worldFrameParent(host);
  if (!parent) return base;
  const resolved = hostFrameAt(project, parent.id, at, opts);
  if (!resolved) return base;
  const frame = applyParentToFrame(
    cameraWorldFrame(host, at, opts?.param ? { param: opts.param } : null),
    resolved.frame, parent.bind, parent.inherit, parentStrengthAt(parent, at),
  );
  const forward = frame.basis[2].slice();
  const pos = frame.pos.slice();
  const distance = Math.max(1e-3, len(sub(base.look, base.pos)) || 1);
  const look = add(pos, mul(forward, distance));
  return {
    ...base,
    pos,
    look,
    roll: rollOf({ right: frame.basis[0], up: frame.basis[1], forward }),
    frameParentId: String(parent.id),
  };
}

/**
 * Inverse gizmo mapping for a 3D object with a `frameParent`: world point /
 * vector -> the object's own local values. Inverts the frameParent delta first,
 * then the shipped 3D parent chain, so dragging a parented object under the
 * pointer does not jump.
 */
export function objectLocalPoint(project, obj, t, worldPoint, opts = null) {
  const parent = worldFrameParent(obj);
  const resolved = parent ? hostFrameAt(project, parent.id, t, opts) : null;
  if (!resolved) return toLocalPoint(project, obj, t, worldPoint, opts?.poseAt);
  const delta = parentDelta(resolved.frame, parent.bind, parent.inherit, parentStrengthAt(parent, t));
  const local = delta ? inverseMapPoint(delta, worldPoint) : worldPoint;
  return toLocalPoint(project, obj, t, local, opts?.poseAt);
}

/** Inverse world direction -> object local direction (frameParent aware). */
export function objectLocalVector(project, obj, t, worldVector, opts = null) {
  const parent = worldFrameParent(obj);
  const resolved = parent ? hostFrameAt(project, parent.id, t, opts) : null;
  if (!resolved) return toLocalVector(project, obj, t, worldVector, opts?.poseAt);
  const delta = parentDelta(resolved.frame, parent.bind, parent.inherit, parentStrengthAt(parent, t));
  const local = delta ? inverseMapVector(delta, worldVector) : worldVector;
  return toLocalVector(project, obj, t, local, opts?.poseAt);
}

// ---------------------------------------------------------------- element nodes

/**
 * World SpatialNode of `el` at t, carried by its `el.parent` chain.
 *
 * `localNodeAt(el, t)` optionally overrides how a local node is sampled (the
 * renderer passes `elementNodeAt`); the default is the core sampler above.
 * `opts` (poseAt / param / localNodeAt) reaches every host in the chain, so a
 * property-link-aware caller resolves links on element, object and camera
 * parents alike.
 * Cycles, missing parents and chains deeper than MAX_DEPTH fall back to the
 * local node instead of throwing (hand-edited project data must not crash the
 * preview).
 */
export function elementWorldNode(project, el, t = null, localNodeAt = null, opts = null) {
  const sampler = typeof localNodeAt === 'function'
    ? localNodeAt
    : (host, at) => elementLocalNode(project, host, at);
  return elementWorldNodeAt(project, el, t, sampler, 0, new Set([String(el?.id ?? '')]), opts);
}

function elementWorldNodeAt(project, el, t, localNodeAt, depth, seen, opts = null) {
  const sampler = typeof localNodeAt === 'function'
    ? localNodeAt
    : (host, at) => elementLocalNode(project, host, at);
  const local = normalizeSpatialNode(sampler(el, t));
  const parent = elementWorldParent(el);
  if (!parent || depth >= MAX_DEPTH) return local;
  const pid = String(parent.id);
  const visited = seen || new Set();
  if (visited.has(pid)) return local; // a stored loop: stop at the child
  const resolved = hostFrameAt(project, pid, t, {
    ...(opts || {}), depth: depth + 1, seen: visited, localNodeAt,
  });
  if (!resolved) return local; // missing parent host: keep the local placement
  return applyParentToNode(local, resolved.frame, parent.bind, parent.inherit, parentStrengthAt(parent, t));
}

// ---------------------------------------------------------------- ops

/** `{rot, scale}` clamped to 0..1, or null when both are full strength (the default). */
function normalizeStrength(src) {
  const out = {};
  for (const ch of ['rot', 'scale']) {
    const v = Number(src?.[ch]);
    if (Number.isFinite(v)) out[ch] = Math.round(Math.max(0, Math.min(1, v)) * 1e4) / 1e4;
  }
  return Object.keys(out).length && (out.rot ?? 1) + (out.scale ?? 1) < 2 ? out : null;
}

const roundBind = (bind) => ({
  pivot: bind.pivot.map(r6),
  basis: bind.basis.map((v) => v.map(r6)),
  scale: bind.scale.map(r6),
});

/** Child host of a spatial op: element (not audio), 3D object or camera. */
function spatialChildHost(project, id, fail) {
  const key = id == null ? '' : String(id);
  const kind = spatialHostKind(project, key);
  if (!kind) fail(`no element, object or camera ${key}`);
  const host = findSpatialHost(project, key);
  if (!host) fail(`no element, object or camera ${key}`);
  if (kind === 'element' && host.type === 'audio') {
    fail(`element ${host.id} is audio and has no spatial node`);
  }
  if (kind === 'camera' && !(Array.isArray(host.path) && host.path.length)) {
    fail(`camera ${host.id} has no path and no spatial frame`);
  }
  return { kind, host };
}

/** The spatial-parent record currently stored on a child host, or null. */
function childSpatialParent(kind, host) {
  return kind === 'element' ? elementWorldParent(host) : worldFrameParent(host);
}

function setChildSpatialParent(kind, host, record) {
  if (kind === 'element') host.parent = record;
  else host.frameParent = record;
}

/**
 * spatialParent   {id, parent, t?, inherit?:{pos,rot,scale}}
 *                 binds an element / object / camera to any element / object /
 *                 camera frame at t; the child's local values are untouched and
 *                 t does not jump.
 * spatialUnparent {id}
 *                 deletes the child's world parent only (`el.parent` /
 *                 `obj.frameParent` / `cam.frameParent`); local values (and
 *                 keys) stay as-is. The old 3D `obj.parent` is not touched.
 */
export function applySpatialParentOp(project, op, api = {}) {
  const fail = typeof api.fail === 'function'
    ? api.fail
    : (msg) => { throw Object.assign(new Error(msg), { code: 'OP_INVALID' }); };
  switch (op?.op) {
    case 'spatialParent': {
      const child = spatialChildHost(project, op.id, fail);
      const pid = op.parent == null ? '' : String(op.parent);
      if (!pid) fail('spatialParent needs a parent id');
      if (pid === String(child.host.id)) fail(`element ${child.host.id} cannot be its own spatial parent`);
      if (pid === SCREEN_PARENT) fail('spatialParent does not take @live (the screen lock is retired; use a camera feed / HUD rig)');
      const kind = spatialHostKind(project, pid);
      if (!kind) fail(`no element, object or camera ${pid}`);
      if (kind === 'element') {
        const host = elementById(project, pid);
        if (isRecord(host?.parent) && host.parent.id && !elementWorldParent(host)) {
          fail(`parent element ${pid} is screen-locked (@live / legacy camera); unparent it before using it as a spatial parent`);
        }
      }
      if (wouldSpatialCycle(project, child.host.id, pid)) fail(`parenting ${child.host.id} to ${pid} makes a loop`);
      if (spatialAncestors(project, pid).length + 1 >= MAX_DEPTH) fail(`spatial hierarchy deeper than ${MAX_DEPTH}`);
      const t = roundT(op.t);
      const resolved = hostFrameAt(project, pid, t, { seen: new Set([String(child.host.id)]) });
      if (!resolved) fail(`cannot resolve the world frame of ${pid} at ${t}`);
      const prev = childSpatialParent(child.kind, child.host);
      const inherit = normalizeInherit({
        ...(prev?.inherit || {}),
        ...(isRecord(op.inherit) ? op.inherit : {}),
      });
      // Strength (base + keys) stays with a re-bind to the same parent; a new
      // parent starts from the op's strength or full strength.
      const same = prev && String(prev.id) === pid;
      const strength = normalizeStrength({
        ...(same && isRecord(prev.strength) ? prev.strength : {}),
        ...(isRecord(op.strength) ? op.strength : {}),
      });
      const record = { id: pid, mode: 'world', inherit, bind: roundBind(resolved.bind) };
      if (strength) record.strength = strength;
      if (same && isRecord(prev.strengthKeys)) record.strengthKeys = prev.strengthKeys;
      setChildSpatialParent(child.kind, child.host, record);
      return { changed: [child.host.id] };
    }
    case 'spatialUnparent': {
      const child = spatialChildHost(project, op.id, fail);
      if (child.kind === 'element') {
        if (!isRecord(child.host.parent)) return { changed: [] };
        if (!elementWorldParent(child.host)) {
          fail(`element ${child.host.id} has a screen/legacy camera parent; use elementUnparent`);
        }
        delete child.host.parent;
        return { changed: [child.host.id] };
      }
      if (!isRecord(child.host.frameParent)) return { changed: [] };
      if (!worldFrameParent(child.host)) {
        fail(`${child.kind} ${child.host.id} has a non-world frameParent; remove it by hand`);
      }
      delete child.host.frameParent;
      return { changed: [child.host.id] };
    }
    default:
      return null;
  }
}
