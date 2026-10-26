// Homogeneous selection pool shared by the timeline, viewport and inspector.
// A pool contains exactly one kind of thing at a time: elements, properties or
// keyframes. Refs are stable strings so they can be compared, painted and
// carried through the legacy single-selection fields.
//
//   element   cam:cam_1 | ob:ob_1 | el:el_1
//   property  cam:cam_1:fov | ob:ob_1:pivot
//   keyframe  cam:cam_1:fov:2.5 | ob:ob_1:pivot:2.5
//
// Pure ESM, no DOM / node:* imports.

export const SELECTION_KINDS = ['element', 'property', 'keyframe'];

export const cameraRef = (id) => `cam:${id}`;
export const objectRef = (id) => `ob:${id}`;
export const elementRef = (id) => `el:${id}`;
export const propertyRef = (hostRef, path) => `${hostRef}:${path}`;
export const keyframeRef = (hostRef, path, t) => `${propertyRef(hostRef, path)}:${roundT(t)}`;

export const roundT = (t) => Math.round(Number(t) * 1000) / 1000;

export function emptySelection() {
  return { kind: null, ids: [], primary: null };
}

export function normalizeSelection(sel) {
  if (!sel || typeof sel !== 'object') return emptySelection();
  const kind = SELECTION_KINDS.includes(sel.kind) ? sel.kind : null;
  const ids = kind && Array.isArray(sel.ids) ? [...new Set(sel.ids.map(String))] : [];
  const primary = kind && sel.primary != null && ids.includes(String(sel.primary))
    ? String(sel.primary)
    : (ids[0] || null);
  return { kind, ids, primary };
}

/** Plain click: one ref of `kind`, replacing anything of another kind. */
export function selectOne(kind, id) {
  const ref = String(id);
  return { kind, ids: [ref], primary: ref };
}

/**
 * Add a ref. Same kind appends (Ctrl); a different kind starts a new pool
 * because the pool is homogeneous.
 */
export function addSelection(sel, kind, id) {
  const ref = String(id);
  const cur = normalizeSelection(sel);
  if (cur.kind !== kind) return selectOne(kind, ref);
  if (cur.ids.includes(ref)) return { ...cur, primary: ref };
  return { kind, ids: [...cur.ids, ref], primary: ref };
}

/** Ctrl-click a selected ref again removes it from the pool. */
export function toggleSelection(sel, kind, id) {
  const ref = String(id);
  const cur = normalizeSelection(sel);
  if (cur.kind !== kind) return selectOne(kind, ref);
  const ids = cur.ids.filter((x) => x !== ref);
  if (!ids.length) return emptySelection();
  return { kind, ids, primary: cur.primary === ref ? ids[ids.length - 1] : cur.primary };
}

export function hasRef(sel, id) {
  const p = normalizeSelection(sel);
  return p.ids.includes(String(id));
}

export function primaryRef(sel) {
  const p = normalizeSelection(sel);
  return p.primary;
}

/** Split a ref into its host (`cam:id` / `ob:id` / `el:id`) and leaf parts. */
export function splitRef(ref) {
  const s = String(ref || '');
  const first = s.indexOf(':');
  if (first < 0) return null;
  const type = s.slice(0, first);
  if (type !== 'cam' && type !== 'ob' && type !== 'el') return null;
  const rest = s.slice(first + 1);
  const second = rest.indexOf(':');
  const id = second < 0 ? rest : rest.slice(0, second);
  const leaf = second < 0 ? null : rest.slice(second + 1);
  const host = `${type}:${id}`;
  if (leaf == null) return { type, id, host, path: null, t: null };
  const third = leaf.lastIndexOf(':');
  const maybeT = third < 0 ? NaN : Number(leaf.slice(third + 1));
  if (Number.isFinite(maybeT)) {
    return { type, id, host, path: leaf.slice(0, third), t: roundT(maybeT) };
  }
  return { type, id, host, path: leaf, t: null };
}

/** Legacy single-selection fields -> the element pool used before P4. */
export function poolFromSelection(sel) {
  if (sel?.pool) return normalizeSelection(sel.pool);
  if (sel?.camera && sel?.activeCameraId) return selectOne('element', cameraRef(sel.activeCameraId));
  if (sel?.camera && sel?.cameraId) return selectOne('element', cameraRef(sel.cameraId));
  if (sel?.objectId) return selectOne('element', objectRef(sel.objectId));
  if (sel?.elementId) return selectOne('element', elementRef(sel.elementId));
  return emptySelection();
}
