// Spatial parents of 2D elements: the matrix parent of PLAN-ui-round3 §3.1.
// Pure ESM (no node:*): the op, the preview sampling and the tests share it.
//
//   el.parent = {
//     id: 'el_2' | 'ob_1' | 'cam_1',
//     mode: 'world',
//     inherit: { pos: true, rot: true, scale: true },
//     bind:    { pivot: [x,y,z], basis: [right, up, forward], scale: [x,y,z] },
//   }
//
// `bind` is the parent's world frame at binding time (core/spatial.js::
// bindFrameFor / cameraWorldFrame). At time t the child's world node is
//
//   applyParentToNode(childLocalNode(t), parentFrame(t), bind, inherit)
//
// so the parent's motion since the bind carries the child: parent rotation
// orbits the child around the parent's frame pivot, parent translation moves it
// and parent scale stretches it. Because the delta at the bind time is the
// identity, binding never moves the child at the playhead.
//
// Two rules keep the legacy screen lock intact:
//   - `@live` (mode:'screen') and the old camera lock written by
//     core/hierarchy.js::applyElementParentOp (`parent.kind === 'camera'`, no
//     `mode`) are NOT world parents. They stay the render-time carrier
//     (core/hierarchy.js::elementCarrier) and `elementWorldParent` rejects them.
//   - `spatialUnparent` only deletes a world parent and never rewrites the
//     child's local node/keyframes.
//
// Boundary (PLAN §3.1 / task): objects and cameras as *children* are not
// supported yet — only 2D elements can be parented here. A parent chain may mix
// elements, objects and cameras; objects/cameras resolve through their own
// existing evaluation (core/hierarchy.js::worldPose / core/spatial.js::
// cameraWorldFrame).
import { isRecord } from './json.js';
import { sampleTrack } from './time.js';
import { frameOf as poseFrameOf, worldPose } from './hierarchy.js';
import {
  MAX_DEPTH, SCREEN_PARENT, applyParentToNode, bindFrameFor, bindFrameFrom,
  cameraWorldFrame, elementNode, findSpatialHost, frameOf, normalizeInherit,
  normalizeSpatialNode, spatialAncestors, wouldSpatialCycle,
} from './spatial.js';

/** Ops owned by this module (registered in core/ops.js and core/contracts.js). */
export const SPATIAL_PARENT_OP_KINDS = ['spatialParent', 'spatialUnparent'];

const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;
const roundT = (t) => Math.round(Math.max(0, Number.isFinite(Number(t)) ? Number(t) : 0) * 1000) / 1000;

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
 */
function sampledElementNode(project, el, t) {
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

/**
 * World frame + fresh bind snapshot of a spatial parent id at t. Returns null
 * when the host is missing. Elements resolve through their own parent chain
 * (recursion guarded by MAX_DEPTH and `seen`); objects use the shipped 3D
 * hierarchy; cameras use their evaluated world frame.
 */
function parentWorldFrame(project, id, t, localNodeAt, depth, seen) {
  const kind = spatialHostKind(project, id);
  if (!kind) return null;
  if (kind === 'element') {
    const host = elementById(project, id);
    if (!host) return null;
    const node = elementWorldNodeAt(project, host, t, localNodeAt, depth, seen);
    return { kind, frame: frameOf(node), bind: bindFrameFor(node) };
  }
  const host = findSpatialHost(project, id);
  if (!host) return null;
  if (kind === 'object') {
    const frame = poseFrameOf(worldPose(project, host, t));
    return { kind, frame, bind: bindFrameFrom(frame) };
  }
  const frame = cameraWorldFrame(host, t);
  return { kind, frame, bind: bindFrameFrom(frame) };
}

/**
 * World SpatialNode of `el` at t, carried by its `el.parent` chain.
 *
 * `localNodeAt(el, t)` optionally overrides how a local node is sampled (the
 * renderer passes `elementNodeAt`); the default is the core sampler above.
 * Cycles, missing parents and chains deeper than MAX_DEPTH fall back to the
 * local node instead of throwing (hand-edited project data must not crash the
 * preview).
 */
export function elementWorldNode(project, el, t = null, localNodeAt = null) {
  const sampler = typeof localNodeAt === 'function'
    ? localNodeAt
    : (host, at) => sampledElementNode(project, host, at);
  return elementWorldNodeAt(project, el, t, sampler, 0, null);
}

function elementWorldNodeAt(project, el, t, localNodeAt, depth, seen) {
  const local = normalizeSpatialNode(localNodeAt(el, t));
  const parent = elementWorldParent(el);
  if (!parent || depth >= MAX_DEPTH) return local;
  const pid = String(parent.id);
  const visited = seen || new Set([String(el?.id ?? '')]);
  if (visited.has(pid)) return local; // a stored loop: stop at the child
  visited.add(pid);
  const resolved = parentWorldFrame(project, pid, t, localNodeAt, depth + 1, visited);
  if (!resolved) return local; // missing parent host: keep the local placement
  return applyParentToNode(local, resolved.frame, parent.bind, parent.inherit);
}

// ---------------------------------------------------------------- ops

const roundBind = (bind) => ({
  pivot: bind.pivot.map(r6),
  basis: bind.basis.map((v) => v.map(r6)),
  scale: bind.scale.map(r6),
});

/** The child must be a 2D element: objects/cameras as children are not supported yet. */
function spatialChild(project, id, fail) {
  const key = id == null ? '' : String(id);
  const el = elementById(project, key);
  if (el) {
    if (el.type === 'audio') fail(`element ${el.id} is audio and has no spatial node`);
    return el;
  }
  const kind = spatialHostKind(project, key);
  if (kind) fail(`spatialParent only takes 2D element children; ${key} is a ${kind}`);
  fail(`no element ${key}`);
  return null;
}

/**
 * spatialParent   {id, parent, t?, inherit?:{pos,rot,scale}}
 *                 binds a 2D element to an element / object / camera frame at t;
 *                 the child's local values are untouched and t does not jump.
 * spatialUnparent {id}
 *                 deletes `el.parent` only; local values (and keys) stay as-is.
 */
export function applySpatialParentOp(project, op, api = {}) {
  const fail = typeof api.fail === 'function'
    ? api.fail
    : (msg) => { throw Object.assign(new Error(msg), { code: 'OP_INVALID' }); };
  switch (op?.op) {
    case 'spatialParent': {
      const child = spatialChild(project, op.id, fail);
      const pid = op.parent == null ? '' : String(op.parent);
      if (!pid) fail('spatialParent needs a parent id');
      if (pid === String(child.id)) fail(`element ${child.id} cannot be its own spatial parent`);
      if (pid === SCREEN_PARENT) fail('spatialParent does not take @live (use elementParent for the screen lock)');
      const kind = spatialHostKind(project, pid);
      if (!kind) fail(`no element, object or camera ${pid}`);
      if (kind === 'element') {
        const host = elementById(project, pid);
        if (isRecord(host?.parent) && host.parent.id && !elementWorldParent(host)) {
          fail(`parent element ${pid} is screen-locked (@live / legacy camera); unparent it before using it as a spatial parent`);
        }
      }
      if (wouldSpatialCycle(project, child.id, pid)) fail(`parenting ${child.id} to ${pid} makes a loop`);
      if (spatialAncestors(project, pid).length + 1 >= MAX_DEPTH) fail(`spatial hierarchy deeper than ${MAX_DEPTH}`);
      const t = roundT(op.t);
      const sampler = (host, at) => sampledElementNode(project, host, at);
      const resolved = parentWorldFrame(project, pid, t, sampler, 0, new Set([String(child.id)]));
      if (!resolved) fail(`cannot resolve the world frame of ${pid} at ${t}`);
      const prev = elementWorldParent(child);
      const inherit = normalizeInherit({
        ...(prev?.inherit || {}),
        ...(isRecord(op.inherit) ? op.inherit : {}),
      });
      child.parent = { id: pid, mode: 'world', inherit, bind: roundBind(resolved.bind) };
      return { changed: [child.id] };
    }
    case 'spatialUnparent': {
      const child = spatialChild(project, op.id, fail);
      if (!isRecord(child.parent)) return { changed: [] };
      if (!elementWorldParent(child)) {
        fail(`element ${child.id} has a screen/legacy camera parent; use elementUnparent`);
      }
      delete child.parent;
      return { changed: [child.id] };
    }
    default:
      return null;
  }
}
