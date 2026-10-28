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
// This module samples those paths on top of the base node, exactly like
// `migrate-spatial.js::migratedNodeAt`, so the preview draws the same frame the
// migrator validated. It lives on the preview side (not in core/spatial.js) so
// the renderer branch does not have to change the shared spatial core. Relative
// core imports keep the module importable from Node tests as well.
import { elementNode, normalizeSpatialNode } from '../../../core/spatial.js';
import { isRecord } from '../../../core/json.js';
import { sampleTrack } from '../../../core/time.js';

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
