// Link-aware evaluation: the single seam every picture producer goes through.
//
// core/links.js owns the link graph and the effective-value math; this module
// adapts it to the evaluators that paint pixels:
//
//   elementNodeWithLinks / elementWorldNodeWithLinks  -> 2D node viewport
//   objectWorldPoseWithLinks                          -> 3D viewport + bake
//   evalCameraWorldWithLinks                          -> camera viewport + bake
//   elementLinkOverlay                                -> blender/vdm_build.py
//
// Order is fixed (docs/SPEC-PROJECT.md "求值顺序"):
//   keyframes/local -> property links -> spatial parent -> motion presets -> fades
//
// It lives apart from core/links.js on purpose: core/spatial-parent.js ->
// core/spatial.js -> core/space.js -> core/ops.js imports the op lists from
// links.js, so links.js must not import the spatial modules (TDZ cycle). This
// module imports both sides and is only loaded by the preview / bake / tests.
import { clamp } from './time.js';
import { isRecord } from './json.js';
import { PX_PER_M } from './scene.js';
import {
  cameraValueWithLinks, elementOverlay, objectPoseWithLinks, resolveEffectiveValue,
} from './links.js';
import { dirRollFromRotation, rotationFromDirRoll } from './rotation.js';
import {
  elementLocalNode, elementWorldNode, evalCameraWorld, objectLocalPoint, objectLocalVector,
  objectWorldPose,
} from './spatial-parent.js';

const isNum = (v) => Number.isFinite(Number(v));
const hasLink = (host, path) => Array.isArray(host?.links)
  && host.links.some((link) => isRecord(link) && link.enabled !== false && link.to === path);

/** True when `el` has any enabled property link. */
export function hasElementLinks(el) {
  return Array.isArray(el?.links) && el.links.some((link) => isRecord(link) && link.enabled !== false);
}

/** `(cam, path, t) -> effective value` callback for core/camera.js::evalCamera. */
export function cameraParamResolver(project) {
  return (cam, path, t) => cameraValueWithLinks(project, cam, path, t);
}

/**
 * Link options threaded into core/spatial-parent.js: local poses/nodes see
 * links, and every host frame in a parent chain resolves them too.
 */
export function linksEvalOptions(project) {
  return {
    poseAt: (obj, t) => objectPoseWithLinks(project, obj, t),
    localNodeAt: (el, t) => elementNodeWithLinks(project, el, t),
    param: cameraParamResolver(project),
  };
}

/** Effective value of one linkable element property. */
const elementValue = (project, el, path, t) => resolveEffectiveValue(
  project, { host: 'el', id: el.id }, path, t,
);

/**
 * Local SpatialNode of an element at t with linked node channels applied
 * (pivot.* / position.* / scale.* / roll). The base node comes from
 * core/spatial-parent.js::elementLocalNode (base values + migrated keys + the
 * legacy fallback), so this is exactly the node the renderer used before
 * links, with only the linked channels replaced.
 */
export function elementNodeWithLinks(project, el, t) {
  const node = elementLocalNode(project, el, t);
  if (!hasElementLinks(el)) return node;
  const setVec = (group) => {
    const list = node[group].slice();
    let moved = false;
    for (let i = 0; i < 3; i += 1) {
      const path = `${group}.${'xyz'[i]}`;
      if (!hasLink(el, path)) continue;
      const value = elementValue(project, el, path, t);
      if (isNum(value)) { list[i] = Number(value); moved = true; }
    }
    return moved ? list : node[group];
  };
  const out = {
    ...node,
    pivot: setVec('pivot'),
    position: setVec('position'),
    scale: setVec('scale'),
  };
  if (hasLink(el, 'roll')) {
    const value = elementValue(project, el, 'roll', t);
    if (isNum(value)) out.roll = Number(value);
  }
  const rotPaths = ['rotation.x', 'rotation.y', 'rotation.z'];
  if (rotPaths.some((path) => hasLink(el, path))) {
    const base = Array.isArray(out.rotation)
      ? out.rotation.slice()
      : rotationFromDirRoll(out.dir, out.roll);
    for (let i = 0; i < 3; i += 1) {
      const path = rotPaths[i];
      if (!hasLink(el, path)) continue;
      const value = elementValue(project, el, path, t);
      if (isNum(value)) base[i] = Number(value);
    }
    out.rotation = base;
    const rr = dirRollFromRotation(base);
    out.dir = rr.dir;
    out.roll = rr.roll;
  }
  return out;
}

/** World SpatialNode of an element at t (property links + spatial parent chain). */
export function elementWorldNodeWithLinks(project, el, t = null, opts = null) {
  return elementWorldNode(
    project, el, t,
    (host, at) => elementNodeWithLinks(project, host, at),
    opts || linksEvalOptions(project),
  );
}

/** `objectWorldPose` with links on the object and every parent in both graphs. */
export function objectWorldPoseWithLinks(project, obj, t, cache = null, opts = null) {
  return objectWorldPose(project, obj, t, cache, opts || linksEvalOptions(project));
}

/** Inverse gizmo mapping with links applied (dragging a linked object does not jump). */
export function objectLocalPointWithLinks(project, obj, t, worldPoint, opts = null) {
  return objectLocalPoint(project, obj, t, worldPoint, opts || linksEvalOptions(project));
}

export function objectLocalVectorWithLinks(project, obj, t, worldVector, opts = null) {
  return objectLocalVector(project, obj, t, worldVector, opts || linksEvalOptions(project));
}

/** `evalCameraWorld` with camera/parent links applied (fov, roll, dof, …). */
export function evalCameraWorldWithLinks(project, t = 0, cam = null, opts = null) {
  return evalCameraWorld(project, t, cam, opts || linksEvalOptions(project));
}

/**
 * Per-frame overlay table for one 2D element, attached to the Blender project
 * copy as `el._linkOverlay = { fps, values }` (engine/blender.js). Frames are
 * indexed by `round(t * fps)`, so a Blender frame or still always hits the
 * value JS computed for the same time. Returns null when the element has no
 * link that changes the picture.
 */
export function elementLinkOverlayTable(project, el, { fps = 24, to = null } = {}) {
  if (!hasElementLinks(el)) return null;
  const rate = Number(fps) > 0 ? Number(fps) : 24;
  const end = Number(to ?? project?.meta?.duration) || 0;
  const count = Math.max(1, Math.ceil(end * rate) + 1);
  const values = [];
  let changed = false;
  for (let f = 0; f < count; f += 1) {
    const overlay = elementLinkOverlay(project, el, f / rate);
    values.push(overlay || {});
    if (overlay) changed = true;
  }
  return changed ? { fps: rate, values } : null;
}

/**
 * Blender overlay for a 2D element at t, in the legacy evalElement units
 * (`x/y` project px, `z` metres, rotation degrees). Returns null when no linked
 * field changes the picture.
 *
 * Legacy elements reuse core/links.js::elementOverlay verbatim. A migrated node
 * element is flattened the same way `blender/vdm_build.py::eval_element` does it
 * (flat ±Z node; a tilted node keeps its pivot only), so the Python side only
 * has to write these fields over its locally sampled `st` before motion/fades.
 */
export function elementLinkOverlay(project, el, t) {
  if (!hasElementLinks(el)) return null;
  if (!isRecord(el.node)) return elementOverlay(project, el, t);
  const node = elementNodeWithLinks(project, el, t);
  const meta = project?.meta || {};
  const height = Number(meta.height) || 1080;
  const dir = node.dir;
  const flat = Math.abs(dir[0]) < 1e-4 && Math.abs(dir[1]) < 1e-4 && Math.abs(dir[2]) > 0.999;
  const fz = dir[2] >= 0 ? 1 : -1;
  const out = {};
  const linkedPosition = hasLink(el, 'position.x') || hasLink(el, 'position.y') || hasLink(el, 'position.z');
  const linkedPivot = hasLink(el, 'pivot.x') || hasLink(el, 'pivot.y') || hasLink(el, 'pivot.z');
  if (linkedPivot || (flat && linkedPosition)) {
    let wx = node.pivot[0];
    let wy = node.pivot[1];
    let wz = node.pivot[2];
    if (flat && linkedPosition) {
      wx = node.pivot[0] - fz * node.position[0];
      wy = node.pivot[1] + node.position[1];
      wz = node.pivot[2] + fz * node.position[2];
    }
    out.x = wx * PX_PER_M;
    out.y = height / 2 - wy * PX_PER_M;
    out.z = wz;
  }
  if (hasLink(el, 'scale.x')) out.scale = node.scale[0];
  if (hasLink(el, 'roll')
    || hasLink(el, 'rotation.x') || hasLink(el, 'rotation.y') || hasLink(el, 'rotation.z')) {
    out.rotation = node.roll;
  }
  if (hasLink(el, 'opacity')) out.opacity = clamp(elementValue(project, el, 'opacity', t));
  if (hasLink(el, 'style.size')) out.size = elementValue(project, el, 'style.size', t);
  if (hasLink(el, 'fx.glow')) out.glow = elementValue(project, el, 'fx.glow', t);
  for (const key of Object.keys(out)) if (!isNum(out[key])) delete out[key];
  return Object.keys(out).length ? out : null;
}
