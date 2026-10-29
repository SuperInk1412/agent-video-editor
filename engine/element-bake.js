// 2D elements placed by a SpatialNode or a spatial parent, baked per frame in
// JS with the viewport's math (docs/DESIGN-CAMFEED-PARENTS.md §4):
//
//   _world  {f0, frames: [16 numbers, column-major]}  the plane's world matrix
//           per project pixel (core/frame-ir.js::elementPixelMatrix, one pixel
//           as the unit quad), links included (core/link-eval.js); the IR's
//           items[].world is the same number, so vdm_build.py and the preview
//           cannot drift
//
// The Python 2D builder only knows flat nodes and no parents, so without this
// a parented or tilted element renders at its local placement.
// Frames are absolute render frames (frame = round(t * fps) + 1).
//
// Since WP0.1 the matrix itself lives in core/frame-ir.js (the IR is the single
// placement source); this file keeps the bake, which rounds the numbers it
// serialises to 6 decimals so the Blender job stays the same size it was.
import { elementWorldParent } from '../core/spatial-parent.js';
import { linksEvalOptions } from '../core/link-eval.js';
import { elementPixelMatrix } from '../core/frame-ir.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const r6 = (v) => Math.round(v * 1e6) / 1e6;

export { elementPixelMatrix };

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
    for (let f = lo; f <= hi; f++) frames.push(elementPixelMatrix(project, el, (f - 1) / fps, opts).map(r6));
    el._world = { f0: lo, frames };
  }
  return project;
}
