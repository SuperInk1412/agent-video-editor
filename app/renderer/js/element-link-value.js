// Effective-value bridge for the 2D element rows (PLAN-ui-round3 §4.2).
//
// The inspector and the timeline edit legacy 2D rows in screen units
// (`transform.x/y` pixels, `transform.scale` ratio, `transform.rotation` deg),
// while property links live on the spatial-node paths (`pivot.x`, `scale.x`,
// `roll`, …; see core/links.js). This module is the only place that translates
// between the two, so the panel can show the effective value and write the
// local value back without duplicating the inverse formula:
//
//   effective row value = resolveEffectiveValue(project, el, target, t)
//   local row value     = writeBackLocalValue(project, el, target, t, desired)
//
// Only legacy 2D elements are covered for now: a migrated `el.node` has a full
// pivot/position/dir/roll/scale model whose UI rows are still the old
// transform.* rows (the unified node editor is a separate step). For a node
// element this module deliberately falls back to the local row value instead of
// inventing a lossy conversion.
import { isRecord } from '../../../core/json.js';
import { resolveEffectiveValue, writeBackLocalValue } from '../../../core/links.js';
import { elementRowLinkPaths } from './link-menu.js';

const PX_PER_M = 100;

const centerY = (meta) => (Number(meta?.height) || 1080) / 2 / PX_PER_M;

/** Link target path behind a 2D row (`transform.x` -> `pivot.x`). */
export function elementRowTarget(el, rowPath) {
  if (!isRecord(el) || isRecord(el.node)) return null;
  return elementRowLinkPaths(el, rowPath)[0] || null;
}

/** A node-unit target value (metres / ratio / deg) -> the row's display unit. */
export function targetToRow(el, meta, target, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  switch (String(target ?? '')) {
    case 'pivot.x': return v * PX_PER_M;
    case 'pivot.y': return (centerY(meta) - v) * PX_PER_M;
    case 'pivot.z': return v;
    default: return v;
  }
}

/** The row's display unit -> a node-unit target value (inverse of targetToRow). */
export function rowToTarget(el, meta, target, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  switch (String(target ?? '')) {
    case 'pivot.x': return v / PX_PER_M;
    case 'pivot.y': return centerY(meta) - v / PX_PER_M;
    case 'pivot.z': return v;
    default: return v;
  }
}

/**
 * Effective value of a 2D row at `t`, in that row's own units. `localValue` is
 * returned unchanged when the row has no link/target (this keeps the existing
 * behavior for unlinked rows and for migrated node elements).
 */
export function effectiveElementRowValue(project, el, rowPath, t, localValue) {
  const local = Number(localValue);
  const fallback = Number.isFinite(local) ? local : localValue;
  const target = elementRowTarget(el, rowPath);
  if (!target || !project) return fallback;
  const effective = resolveEffectiveValue(project, { host: 'el', id: el.id }, target, t);
  if (effective == null) return fallback;
  const row = targetToRow(el, project.meta, target, effective);
  return row == null ? fallback : row;
}

/**
 * Local value that makes the linked + local rows produce `effectiveRowValue` at
 * `t`. Returns the input unchanged when the row is unlinked or cannot be
 * inverted (mul against a zero parent ratio, node element, …).
 */
export function localElementRowValue(project, el, rowPath, t, effectiveRowValue) {
  const row = Number(effectiveRowValue);
  const fallback = Number.isFinite(row) ? row : effectiveRowValue;
  const target = elementRowTarget(el, rowPath);
  if (!target || !project) return fallback;
  const targetValue = rowToTarget(el, project.meta, target, row);
  if (targetValue == null) return fallback;
  const local = writeBackLocalValue(project, { host: 'el', id: el.id }, target, t, targetValue);
  if (local == null) return fallback;
  const localRow = targetToRow(el, project.meta, target, local);
  return localRow == null ? fallback : localRow;
}
