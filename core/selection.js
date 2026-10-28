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

/**
 * One pointer pick. Without the additive modifier the pool is replaced; an
 * additive pick toggles within the same kind (a first pick also enters an empty
 * or foreign pool) and starts a fresh pool when the kind changes.
 */
export function pickSelection(sel, kind, id, additive = false) {
  const ref = String(id);
  if (!additive) return selectOne(kind, ref);
  const cur = normalizeSelection(sel);
  if (cur.kind !== kind) return selectOne(kind, ref);
  // toggleSelection only removes; a new ref has to be appended first.
  return cur.ids.includes(ref) ? toggleSelection(cur, kind, ref) : addSelection(cur, kind, ref);
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

// ---------------------------------------------------------------- keyframes
// A keyframe ref carries enough information to delete the key it points at.
// Objects keep one track per axis (`pivot`, `pivot.x`…), so a single dot in
// the timeline can span several tracks; camera keys live either in `path` or
// in `cam.tracks[channel]`; element keys are a flat `keyframes` list.

const KEY_AXES = ['x', 'y', 'z'];

function keyframeHost(project, split) {
  if (split.type === 'cam') {
    return (project?.cameras || []).find((c) => c.id === split.id)
      || (project?.camera?.id === split.id ? project.camera : null);
  }
  if (split.type === 'ob') return (project?.scene?.objects || []).find((o) => o.id === split.id) || null;
  return (project?.elements || []).find((e) => e.id === split.id) || null;
}

const hasKeyAt = (list, t) => (list || []).some((k) => Math.abs(Number(k?.t) - t) <= 1e-4);

function objectKeyTracks(obj, path, t) {
  const tracks = obj?.tracks || {};
  return [path, ...KEY_AXES.map((a) => `${path}.${a}`)].filter((name) => hasKeyAt(tracks[name], t));
}

/** Does the keyframe ref still resolve in `project`? Stale refs get dropped. */
export function keyframeExists(project, ref) {
  const s = splitRef(ref);
  if (!s || s.path == null || s.t == null) return false;
  const host = keyframeHost(project, s);
  if (!host) return false;
  if (s.type === 'cam') {
    return s.path === 'path' ? hasKeyAt(host.path, s.t) : hasKeyAt(host.tracks?.[s.path], s.t);
  }
  if (s.type === 'ob') return objectKeyTracks(host, s.path, s.t).length > 0;
  return (host.keyframes || []).some((k) => k.path === s.path && Math.abs(Number(k.t) - s.t) <= 1e-4);
}

/**
 * Keyframe refs -> object ops that delete exactly those keys. Refs that no
 * longer resolve are skipped, so a stale pool is harmless. The ops are meant
 * to run as one `batch`: one save, one undo step.
 */
export function keyframeDeleteOps(refs, project) {
  const ops = [];
  const seen = new Set();
  const push = (op, key) => { if (!seen.has(key)) { seen.add(key); ops.push(op); } };
  for (const ref of refs || []) {
    const s = splitRef(ref);
    if (!s || s.path == null || s.t == null) continue;
    if (!keyframeExists(project, ref)) continue;
    const host = keyframeHost(project, s);
    if (s.type === 'cam') {
      if (s.path === 'path') push({ op: 'cameraRemove', id: host.id, t: s.t }, `cameraRemove:${host.id}:${s.t}`);
      else push({ op: 'cameraParamUnkey', id: host.id, path: s.path, t: s.t }, `cameraParamUnkey:${host.id}:${s.path}:${s.t}`);
      continue;
    }
    if (s.type === 'ob') {
      for (const track of objectKeyTracks(host, s.path, s.t)) {
        push({ op: 'objectUnkey', id: host.id, path: track, t: s.t }, `objectUnkey:${host.id}:${track}:${s.t}`);
      }
      continue;
    }
    push({ op: 'keyRemove', id: host.id, path: s.path, t: s.t }, `keyRemove:${host.id}:${s.path}:${s.t}`);
  }
  return ops;
}

/**
 * Legacy single-selection fields (`elementId / objectId / camera`) for a pool.
 * A pool is homogeneous in *kind*, but its element ids mix `cam:` / `ob:` /
 * `el:` refs, so the primary decides which legacy field is set. Explicit values
 * win: the pool only fills what the caller left empty and never clears an
 * explicit id, so callers can pass `{ objectId, pool }` and keep both.
 */
export function legacyFields(pool, explicit = {}) {
  const elementId = explicit.elementId || null;
  const objectId = explicit.objectId || null;
  const camera = !!explicit.camera;
  if (elementId || objectId || camera) return { elementId, objectId, camera };
  const split = splitRef(primaryRef(pool));
  if (!split) return { elementId: null, objectId: null, camera: false };
  if (split.type === 'cam') return { elementId: null, objectId: null, camera: true };
  if (split.type === 'ob') return { elementId: null, objectId: split.id, camera: false };
  return { elementId: split.id, objectId: null, camera: false };
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
