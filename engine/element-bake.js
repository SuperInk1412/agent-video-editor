// 2D elements placed by a SpatialNode or a spatial parent, baked per frame in
// JS with the viewport's math (docs/DESIGN-CAMFEED-PARENTS.md §4):
//
//   _world  {f0, frames: [16 numbers, column-major]}  the plane's world matrix
//           per project pixel (preview.js::_nodePlane through
//           spatial-layers.js::nodePlaneMatrix, one pixel as the unit quad),
//           links included (core/link-eval.js); vdm_build.py applies it
//
// The Python 2D builder only knows flat nodes and no parents, so without this
// a parented or tilted element renders at its local placement.
// Frames are absolute render frames (frame = round(t * fps) + 1).
import { motionDelta } from '../core/evaluate.js';
import { basisFromDir } from '../core/scene.js';
import { frameOf } from '../core/spatial.js';
import { elementWorldParent } from '../core/spatial-parent.js';
import { elementWorldNodeWithLinks, linksEvalOptions } from '../core/link-eval.js';
import { nodePlaneMatrix } from '../app/renderer/js/spatial-layers.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** World matrix of one project pixel of `el`'s plane at t (column-major 4×4). */
export function elementPixelMatrix(project, el, t, opts = null) {
  const meta = project.meta || {};
  const frame = frameOf(elementWorldNodeWithLinks(project, el, t, opts || linksEvalOptions(project)));
  const d = motionDelta(el, t, meta);
  // Same motion placement as preview.js::_nodePlane: screen px along the
  // plane's unrolled axes, extra roll around the normal, size multiplier.
  const base = basisFromDir(frame.basis[2], 0);
  const dx = (Number(d.x) || 0) / 100;
  const dy = -(Number(d.y) || 0) / 100;
  const offset = [0, 1, 2].map((i) => -base.right[i] * dx + base.up[i] * dy);
  const px = 0.01; // one project pixel in metres
  const { model } = nodePlaneMatrix(
    frame,
    px * Math.abs(Number(frame.scale[0]) || 1),
    px * Math.abs(Number(frame.scale[1]) || 1),
    { offset, roll: d.rotation, scale: d.scale },
  );
  // nodePlaneMatrix keeps the normal at unit length; Blender geometry is in
  // pixels along the normal too (layer offsets, text depth): scale it to match.
  const m = Array.from(model);
  for (let i = 8; i < 11; i++) m[i] *= px;
  return m.map(r6);
}

/** Does `el` need a baked world matrix (node placement or spatial parent)? */
export const needsWorldBake = (el) => isObj(el?.node) || !!elementWorldParent(el);

/**
 * Add `_world` bakes to the node / spatially parented 2D elements of `project`
 * (mutates the job copy) for frames [f0, f1]; other elements are untouched.
 */
export function bakeElementPlacements(project, [f0, f1], fps) {
  const opts = linksEvalOptions(project);
  for (const el of project.elements || []) {
    if (el.type === 'audio' || el.visible === false || !needsWorldBake(el)) continue;
    const start = Number(el.start) || 0;
    const end = start + (Number(el.duration) || 0);
    const lo = Math.max(f0, Math.round(start * fps) + 1);
    const hi = Math.min(f1, Math.round(end * fps) + 1);
    if (hi < lo) continue;
    const frames = [];
    for (let f = lo; f <= hi; f++) frames.push(elementPixelMatrix(project, el, (f - 1) / fps, opts));
    el._world = { f0: lo, frames };
  }
  return project;
}
