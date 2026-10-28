// Pure helpers for the unified timeline layer list (docs/DESIGN.md §1.5).
// The editor shows 相机 / 2D / 3D / 声音 rows in one list whose display order is
// persisted in `meta.ui.timelineOrder`; only the relative order of 2D rows is
// semantic (it is written back to `el.z`). These helpers plan both halves of a
// row insertion — where the ref goes in the list, and which z value (or
// renumber batch) makes the 2D stack agree with it — without touching the DOM.
//
// Pure ESM: the browser renderer and the Node tests share this module.

import { splitRef, elementRef } from './selection.js';

/** Midpoints closer than this are treated as "no room"; renumber instead. */
export const MIN_Z_GAP = 1e-3;

export const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const zOf = (el) => {
  const z = Number(el?.z);
  return Number.isFinite(z) ? z : 0;
};

const startOf = (el) => {
  const s = Number(el?.start);
  return Number.isFinite(s) ? s : 0;
};

// ---------------------------------------------------------------- row placement

/**
 * Host refs a selection pool points at. Property (`cam:id:fov`) and keyframe
 * (`el:id:transform.x:2.5`) refs anchor to their row's host, so adding while a
 * property is selected still lands above that row.
 */
export function poolAnchors(pool) {
  const ids = Array.isArray(pool?.ids) ? pool.ids : [];
  const out = [];
  for (const raw of ids) {
    const split = splitRef(raw);
    if (split && !out.includes(split.host)) out.push(split.host);
  }
  return out;
}

/**
 * Index a new row should be inserted at: one row above the topmost selected
 * row, or the top row (0) when nothing selected / every anchor is stale.
 */
export function rowInsertIndex(order, anchors) {
  let index = null;
  for (const ref of anchors || []) {
    const i = order.indexOf(String(ref));
    if (i >= 0 && (index == null || i < index)) index = i;
  }
  return index == null ? 0 : index;
}

/** Insert `newRef` at `index` (removing an earlier copy first). */
export function insertRow(order, newRef, index) {
  const out = (order || []).map(String).filter((ref) => ref !== String(newRef));
  const at = Math.max(0, Math.min(out.length, Number(index) || 0));
  out.splice(at, 0, String(newRef));
  return out;
}

/** `{ index, order }` for inserting `newRef` above the anchor rows. */
export function planRowInsert(order, anchors, newRef) {
  const list = Array.isArray(order) ? order.map(String) : [];
  const index = rowInsertIndex(list, anchors);
  return { index, order: insertRow(list, newRef, index) };
}

// ---------------------------------------------------------------- 2D z stack

/**
 * Elements sorted the way the timeline picks 2D slots: z high→low, then start
 * low→high (the same comparator render() uses for the layer slots).
 */
function simulatedStack(stack, zFor, startFor) {
  return stack
    .map((ref, i) => ({ ref, i, z: zFor(ref), start: startFor(ref) }))
    .sort((a, b) => (b.z - a.z) || (a.start - b.start) || (a.i - b.i))
    .map((x) => x.ref);
}

function noDuplicateZ(stack, ref, z, zFor) {
  return stack.every((r) => r === ref || Math.abs(zFor(r) - z) > 1e-9);
}

/**
 * Bottom-to-top renumber for the whole 2D stack: the top row gets
 * `stack.length - 1`, the bottom row 0. Returns one `reorder` op per element
 * whose z actually changes (the caller adds the new element's z itself).
 */
export function renumber2D(stack, byRef) {
  const ops = [];
  stack.forEach((ref, i) => {
    const el = byRef.get(ref);
    if (!el) return; // stale ref: ignore, the renderer drops it too
    const z = stack.length - 1 - i;
    if (Math.abs(zOf(el) - z) > 1e-9) ops.push({ op: 'reorder', id: el.id, z });
  });
  return ops;
}

function renumberForInsert(stack, byRef, ref) {
  let z = 0;
  const ops = [];
  stack.forEach((other, i) => {
    const target = stack.length - 1 - i;
    if (other === ref) { z = target; return; }
    const el = byRef.get(other);
    if (!el) return;
    if (Math.abs(zOf(el) - target) > 1e-9) ops.push({ op: 'reorder', id: el.id, z: target });
  });
  return { z, ops };
}

/**
 * z value for a brand-new 2D element that must occupy `elementRef(element.id)`
 * at its place in `stack` (the desired top→bottom order, including the new
 * ref). Midpoint between the 2D neighbours; top/bottom extend the stack by one;
 * if the gap is too tight (or stale z values make the slot ambiguous) the whole
 * 2D stack is renumbered bottom-to-top.
 *
 * Returns `{ z, ops }`; `z` goes into the addElement payload and `ops` are the
 * `reorder` ops that must run in the same batch (never includes the new id).
 */
export function planInsertionZ({ stack, elements, element }) {
  const ref = elementRef(element.id);
  const byRef = new Map((elements || []).map((e) => [elementRef(e.id), e]));
  // Ignore stale refs (deleted rows still sitting in a plan) — they must not
  // influence the z slot or the neighbour search.
  const rows = stack.filter((r) => r === ref || byRef.has(r));
  const i = rows.indexOf(ref);
  if (i < 0) return { z: zOf(element), ops: [] }; // not a 2D row (or stale plan)

  const above = i > 0 ? rows[i - 1] : null;
  const below = i < rows.length - 1 ? rows[i + 1] : null;
  const rest = rows.filter((r) => r !== ref);
  const restZ = rest.map((r) => zOf(byRef.get(r))).filter(Number.isFinite);
  const zAbove = above ? zOf(byRef.get(above)) : NaN;
  const zBelow = below ? zOf(byRef.get(below)) : NaN;

  let z = NaN;
  if (above && below) {
    if (Number.isFinite(zAbove) && Number.isFinite(zBelow) && zAbove - zBelow >= MIN_Z_GAP) {
      z = (zAbove + zBelow) / 2;
    }
  } else if (above) {
    // Bottom of the stack: sit below the lowest z value.
    z = (restZ.length ? Math.min(...restZ) : zAbove) - 1;
  } else if (below) {
    // Top of the stack: sit above the highest z value.
    z = (restZ.length ? Math.max(...restZ) : zBelow) + 1;
  } else {
    z = 0;
  }

  const zFor = (r) => (r === ref ? z : zOf(byRef.get(r)));
  const startFor = (r) => (r === ref ? startOf(element) : startOf(byRef.get(r)));
  const fits = Number.isFinite(z)
    && noDuplicateZ(rows, ref, z, zFor)
    && sameOrder(simulatedStack(rows, zFor, startFor), rows);
  return fits ? { z, ops: [] } : renumberForInsert(rows, byRef, ref);
}

/**
 * `reorder` ops that move an existing 2D element to `index`'s place in `stack`
 * (same midpoint rules as an insertion). Falls back to a full stack renumber
 * when the midpoint is unusable. Returns [] when the row already sits there.
 */
export function planMoveZ({ stack, byRef, ref }) {
  const el = byRef.get(ref);
  if (!el) return [];
  // Ignore stale refs (deleted rows) — they must not influence the z slot.
  const rows = stack.filter((r) => byRef.has(r));
  const i = rows.indexOf(ref);
  const rest = rows.filter((r) => r !== ref);
  if (i < 0 || !rest.length) return [];

  const above = i > 0 ? rows[i - 1] : null;
  const below = i < rows.length - 1 ? rows[i + 1] : null;
  const restZ = rest.map((r) => zOf(byRef.get(r))).filter(Number.isFinite);
  const zAbove = above ? zOf(byRef.get(above)) : NaN;
  const zBelow = below ? zOf(byRef.get(below)) : NaN;

  let z = NaN;
  if (above && below) {
    if (Number.isFinite(zAbove) && Number.isFinite(zBelow) && zAbove - zBelow >= MIN_Z_GAP) {
      z = (zAbove + zBelow) / 2;
    }
  } else if (above) {
    // Bottom of the stack: sit below the lowest z value.
    z = (restZ.length ? Math.min(...restZ) : zAbove) - 1;
  } else if (below) {
    // Top of the stack: sit above the highest z value.
    z = (restZ.length ? Math.max(...restZ) : zBelow) + 1;
  }

  const zFor = (r) => (r === ref ? z : zOf(byRef.get(r)));
  const startFor = (r) => startOf(byRef.get(r));
  const fits = Number.isFinite(z)
    && noDuplicateZ(rows, ref, z, zFor)
    && sameOrder(simulatedStack(rows, zFor, startFor), rows);
  if (!fits) return renumber2D(rows, byRef);
  const oldZ = Number(el.z);
  if (Number.isFinite(oldZ) && Math.abs(z - oldZ) <= 1e-9) return [];
  return [{ op: 'reorder', id: el.id, z }];
}
