// Sampled SpatialNode of a 2D element at time t.
//
// `core/spatial.js::elementNode` reads `el.node` base values only (and derives
// a legacy fallback for missing fields). The spatial migrator (S4,
// core/migrate-spatial.js) puts the 2D placement keys on the element itself:
//
//   transform.x / y / z  ->  keyframes 'pivot.x' / 'pivot.y' / 'pivot.z'
//   transform.scale      ->  keyframes 'scale.x' + 'scale.y'
//   transform.rotation   ->  keyframes 'roll'
//
// This module used to carry its own sampler; the logic now lives in
// core/spatial-parent.js::elementLocalNode (core ops bind at the playhead with
// it). Keep this thin wrapper for the renderer call sites and the tests that
// compare both paths. Property links are applied one layer above, in
// core/link-eval.js::elementNodeWithLinks.
import { elementLocalNode, elementWorldNode as coreElementWorldNode } from '../../../core/spatial-parent.js';

/** Node keyframe paths of a migrated 2D element (PLAN §2.3, S4 convention). */
export const NODE_KEY_PATHS = Object.freeze({
  pivot: ['pivot.x', 'pivot.y', 'pivot.z'],
  scale: ['scale.x', 'scale.y', 'scale.z'],
  roll: 'roll',
});

/**
 * SpatialNode of `el` at time `t`: base `el.node` (+ legacy fallback) with the
 * migrated `pivot.* / scale.* / roll` keyframes sampled. `position` and `dir`
 * are base values — the migrator keeps XY motion in `pivot` on purpose (PLAN
 * §2.3: the node basis must not rotate a screen-space key path).
 *
 * Without `el.node` or without a finite `t` this is exactly `elementNode`.
 */
export function elementNodeAt(el, meta = {}, t = null) {
  return elementLocalNode({ meta }, el, t);
}

/**
 * World SpatialNode of `el` at `t`: the sampled local node above carried by the
 * spatial-parent chain (PLAN-ui-round3 §3.1). `opts` reaches every host in the
 * chain (core/link-eval.js passes the link resolvers there).
 */
export function elementWorldNode(project, el, t = null, opts = null) {
  return coreElementWorldNode(
    project, el, t,
    (host, at) => elementNodeAt(host, project?.meta || {}, at),
    opts,
  );
}
