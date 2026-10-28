// Effective-value bridge for the 2D element rows (PLAN-ui-round3 §4.2).
//
// The inspector and the timeline edit 2D rows in screen units (`transform.x/y`
// pixels, `transform.scale` ratio, `transform.rotation` deg), while property
// links live on the spatial-node paths (`pivot.x`, `scale.x`, `roll`, …; see
// core/links.js). This module is the only place that translates between the two,
// so the panel can show the effective value and write the local value back
// without duplicating the inverse formula:
//
//   effective row value = resolveEffectiveValue(project, el, target, t)
//   local row value     = writeBackLocalValue(project, el, target, t, desired)
//
// Legacy elements key `transform.*`; migrated `el.node` elements key the node
// paths (`pivot.x`, `scale.x`, `roll`). `elementRowKeyPath` is the single place
// that decides which path a row's ◆ / input writes.
import { isRecord } from '../../../core/json.js';
import { resolveEffectiveValue, resolveLocalValue, writeBackLocalValue } from '../../../core/links.js';
import { elementRowLinkPaths } from './link-menu.js';

const PX_PER_M = 100;

const centerY = (meta) => (Number(meta?.height) || 1080) / 2 / PX_PER_M;

/** Link target path behind a 2D row (`transform.x` -> `pivot.x`). */
export function elementRowTarget(el, rowPath) {
  if (!isRecord(el)) return null;
  return elementRowLinkPaths(el, rowPath)[0] || null;
}

/**
 * Keyframe path behind a 2D row. Legacy elements key the UI path itself
 * (`transform.x`); migrated node elements key the node path (`pivot.x`,
 * `scale.x`, `roll`). Opacity/volume stay on their legacy paths in both cases.
 */
export function elementRowKeyPath(el, rowPath) {
  const path = String(rowPath ?? '');
  if (!isRecord(el?.node) || path === 'transform.opacity' || path === 'audio.volume') return path;
  return elementRowTarget(el, path) || path;
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
 * Current local value of a 2D row in its display units (no property-link
 * contribution). Handles both legacy `transform.*` keys and node keys.
 */
export function localElementRowValueAt(project, el, rowPath, t) {
  const target = elementRowTarget(el, rowPath);
  if (!target || !project) return null;
  const local = resolveLocalValue(project, { host: 'el', id: el.id }, target, t);
  if (local == null) return null;
  return targetToRow(el, project.meta, target, local);
}

/**
 * `updateElement` patch for a node-element row. Opacity remains on the legacy
 * `transform.opacity` channel; everything else writes the node fields.
 */
export function nodeRowPatch(el, rowPath, rowValue, meta = {}) {
  if (!isRecord(el?.node)) return null;
  const target = elementRowTarget(el, rowPath);
  const row = Number(rowValue);
  if (!target || !Number.isFinite(row)) return null;
  const v = rowToTarget(el, meta, target, row);
  if (v == null) return null;
  const node = { ...el.node };
  if (target === 'roll') {
    node.roll = v;
    return { node };
  }
  if (target.startsWith('pivot.')) {
    const i = 'xyz'.indexOf(target.slice(-1));
    if (i < 0) return null;
    const arr = Array.isArray(node.pivot) ? node.pivot.slice() : [0, 0, 0];
    arr[i] = v;
    node.pivot = arr;
    return { node };
  }
  if (target.startsWith('scale.')) {
    const i = 'xyz'.indexOf(target.slice(-1));
    if (i < 0) return null;
    const arr = Array.isArray(node.scale) ? node.scale.slice() : [1, 1, 1];
    arr[i] = v;
    // The legacy uniform-scale row edits both axes; keep the placeholder
    // square if the node still has its migrated x/y scale.
    if (String(rowPath) === 'transform.scale') { arr[0] = v; arr[1] = v; }
    node.scale = arr;
    return { node };
  }
  if (target === 'opacity') {
    const tr = { ...(isRecord(el.transform) ? el.transform : {}) };
    tr.opacity = v;
    return { transform: tr };
  }
  return null;
}

/**
 * Effective value of a 2D row at `t`, in that row's own units. `localValue` is
 * returned unchanged when the row has no link/target.
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
 * inverted (mul against a zero parent ratio, …).
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
