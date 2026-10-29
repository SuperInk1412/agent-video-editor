// Curve-driven retiming of the inner keyframes of a span.
//
// A span is a pair of *selected* anchor keys `[from, to]` on one track. The
// keys between them are "inner" keys: applying a curve to the span keeps every
// anchor's time and value, keeps each inner key's *value*, and moves the inner
// key to the time where the curve first reaches that key's normalised value:
//
//   y = (v_inner − v_from) / (v_to − v_from)
//   t = t_from + firstArrival(curve, y) · (t_to − t_from)
//
// The rule is the same one camera flights already use
// (core/camera.js::retimePathSpan); `firstArrival` lives here and camera.js
// imports it, so the two timings can never drift apart.
//
// Multi-axis properties (rotation.x/y/z, scale.*, pivot.*): every axis of one
// host at the same instant is one inner *point* with several progress values.
// They are merged into a single progress before the lookup — otherwise the
// pose would be torn apart. An axis without a span (`v_from == v_to`) has no
// progress and drops out of the merge (see `spanProgress`).
//
// Pure ESM, no DOM/node imports.

import { CURVE_PRESETS, normalizeCurve, sampleCurve } from './curves.js';
import { EASES } from './time.js';

// One key apart is 1e-4 s everywhere (core/selection.js, core/ops.js); the
// store keeps milliseconds.
const TIME_EPS = 1e-4;
const MIN_GAP = 0.001;
// Guards from retimePathSpan: never land on (or past) an anchor.
const EDGE = 0.0005;

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const roundMs = (t) => Math.round(Number(t) * 1000) / 1000;
// `Number(null) === 0` and `Number('') === 0`: a missing value must never
// read as the number zero (a colour key has no progress, not progress 0).
const num = (v) => (v == null || v === '' || typeof v === 'boolean'
  ? null
  : (Number.isFinite(Number(v)) ? Number(v) : null));
const isNum = (v) => num(v) != null;

/**
 * Keys strictly between two anchor times, in time order.
 * @param {object[]} keys flat key list of one path (element) or one track
 */
export function innerKeys(keys, from, to) {
  const a = num(from);
  const b = num(to);
  if (a == null || b == null || !(b > a)) return [];
  return (Array.isArray(keys) ? keys : [])
    .filter((k) => Number(k.t) > a + TIME_EPS && Number(k.t) < b - TIME_EPS)
    .sort((x, y) => Number(x.t) - Number(y.t));
}

/**
 * Normalised progress of `value` between the two anchors, or null when the
 * span has no value range (nothing to retime against) or an operand is not a
 * finite number (colours, strings, objects).
 */
export function spanProgress(vFrom, vTo, value) {
  const a = num(vFrom);
  const b = num(vTo);
  const v = num(value);
  if (a == null || b == null || v == null) return null;
  if (Math.abs(b - a) <= 1e-9) return null;
  return (v - a) / (b - a);
}

/**
 * First `u` in [0,1] where the curve reaches `progress`.
 * 512-step scan + 24 bisections: the same numbers the Blender bake and the
 * camera path retiming produce, so preview and render agree.
 * @returns {number|null} null when the curve never reaches it (overshoot-only)
 */
export function firstArrival(curve, progress) {
  const target = num(progress);
  if (!curve || target == null) return null;
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  const steps = 512;
  let prevU = 0;
  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    if (sampleCurve(curve, u) >= target) {
      let lo = prevU;
      let hi = u;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (sampleCurve(curve, mid) >= target) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prevU = u;
  }
  return null;
}

/**
 * New times for the inner keys of one span.
 *
 * @param {object}   spec
 * @param {number}   spec.from   anchor time (s, kept)
 * @param {number}   spec.to     anchor time (s, kept)
 * @param {object|null} spec.curve  stored curve of the span
 * @param {object[]} spec.points `{ t, ys: number[] }` — one entry per inner key;
 *   `ys` holds one progress per axis (mean is used). A point may also carry a
 *   single `y`.
 * @returns {({t:number, y:number|null, newT:number, outOfRange:boolean}[]|null)}
 *   Aligned with `points`; null when the anchors are not a valid span.
 *   `outOfRange` means "the value sits outside the span": the time is pinned
 *   (the caller changes the key's value instead), per the approved rule.
 */
export function retimeSpanTimes({ from, to, curve, points } = {}) {
  const t0 = num(from);
  const t1 = num(to);
  if (t0 == null || t1 == null || !(t1 > t0)) return null;
  const list = Array.isArray(points) ? points : [];
  const out = [];
  let last = t0;
  for (const point of list) {
    const t = num(point?.t);
    if (t == null) return null;
    const raw = Array.isArray(point?.ys) ? point.ys : [point?.y];
    const ys = raw.filter(isNum).map(Number);
    const y = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    const outOfRange = y == null || y < 0 || y > 1;
    let newT = t;
    if (!outOfRange) {
      const u = firstArrival(curve, y);
      if (u != null) newT = t0 + u * (t1 - t0);
    }
    if (outOfRange) {
      // Time anchor: the key stays where it is; only its value will change.
      if (newT <= last) newT = roundMs(last + MIN_GAP);
    } else {
      newT = Math.max(last + EDGE, Math.min(t1 - EDGE, newT));
      newT = roundMs(newT);
      if (newT <= last) newT = roundMs(last + MIN_GAP);
      if (newT >= t1) newT = roundMs(t1 - MIN_GAP);
    }
    out.push({ t, y, newT, outOfRange });
    last = newT;
  }
  return out;
}

const round4 = (v) => Math.round(Number(v) * 10000) / 10000;

/** A named bezier preset whose control points match, else null. */
function bezierPresetFor(p1, p2) {
  for (const [id, def] of Object.entries(CURVE_PRESETS)) {
    if (def.type !== 'bezier') continue;
    if (Math.abs(def.p1[0] - p1[0]) > 1e-3 || Math.abs(def.p1[1] - p1[1]) > 1e-3) continue;
    if (Math.abs(def.p2[0] - p2[0]) > 1e-3 || Math.abs(def.p2[1] - p2[1]) > 1e-3) continue;
    return id;
  }
  return null;
}

/**
 * Mirror a curve left↔right (缓入 ↔ 缓出) for the "反转曲线" action.
 * Only cubic beziers have a mirror image; the dynamic presets (bounce /
 * elastic / cyclic / step) do not, so they return null and the caller refuses.
 */
export function invertCurve(curve) {
  const c = normalizeCurve(curve);
  if (!c || c.type !== 'bezier') return null;
  const p1 = [round4(1 - c.p2[0]), round4(1 - c.p2[1])];
  const p2 = [round4(1 - c.p1[0]), round4(1 - c.p1[1])];
  const preset = bezierPresetFor(p1, p2);
  return normalizeCurve(preset
    ? { type: 'bezier', preset, p1, p2 }
    : { type: 'bezier', p1, p2 });
}

/** True when `curve` differs from `other` as stored (preset id ignored). */
export function sameCurveShape(a, b) {
  const x = normalizeCurve(a);
  const y = normalizeCurve(b);
  if (!x || !y) return !x && !y;
  if (x.type !== y.type) return false;
  if (x.type === 'bezier') {
    return x.p1.every((v, i) => Math.abs(v - y.p1[i]) <= 1e-4)
      && x.p2.every((v, i) => Math.abs(v - y.p2[i]) <= 1e-4);
  }
  const keys = new Set([...Object.keys(x.params || {}), ...Object.keys(y.params || {})]);
  for (const key of keys) {
    if (Math.abs(Number(x.params?.[key] ?? 0) - Number(y.params?.[key] ?? 0)) > 1e-6) return false;
  }
  return true;
}

// ---------------------------------------------------------------- op builder
//
// The panel never writes a project by hand: it asks for the ops and sends them
// as one `batch` (one save, one undo step). Two shapes exist because the four
// hosts spell "key" differently:
//
//   element        keyRemove / keySet          (value, ease, curve)
//   object         objectUnkey / objectKey     (v, ease, curve, out/in/speed)
//   camera param   cameraParamUnkey / …Key     (v, ease, curve)
//
// Camera flights (`path`) are deliberately unsupported: they retime through
// arc length (retimePathSpan) and are out of scope for the panel.

const HOST_OPS = {
  element: { remove: 'keyRemove', set: 'keySet' },
  object: { remove: 'objectUnkey', set: 'objectKey' },
  camera: { remove: 'cameraParamUnkey', set: 'cameraParamKey' },
};

const keyValue = (key) => (key && key.value !== undefined ? key.value : key?.v);
const bucket = (t) => Math.round(Number(t) * 1000);

/**
 * Ops that write `curve` on every sub-segment of a span and (unless
 * `retime: false`, the Alt gesture) move its inner keys to where the curve
 * first reaches their value.
 *
 * Multi-axis: pass several `tracks` (rotation.x/y/z); inner keys that share a
 * timestamp merge into one progress, so the pose lands on a single time.
 *
 * @param {object} spec
 * @param {'element'|'object'|'camera'} spec.host
 * @param {string} spec.id
 * @param {number} spec.from  left anchor time (kept)
 * @param {number} spec.to    right anchor time (kept)
 * @param {object|null} spec.curve
 * @param {{path: string, keys: object[]}[]} [spec.tracks]
 * @param {string} [spec.path]   single-track shorthand
 * @param {object[]} [spec.keys]
 * @param {boolean} [spec.retime]
 * @returns {{ops: object[], moved: number, pinned: number, times: object[]}|null}
 *   null when the span is not editable (no anchors, non-numeric values, …).
 */
export function spanCurveOps({
  host, id, tracks, path, keys, from, to, curve, retime = true,
} = {}) {
  const hostOps = HOST_OPS[String(host)];
  if (!hostOps) return null;
  const t0 = num(from);
  const t1 = num(to);
  if (t0 == null || t1 == null || !(t1 > t0)) return null;
  const list = (Array.isArray(tracks) && tracks.length ? tracks : [{ path, keys }])
    .filter((tr) => tr && tr.path && Array.isArray(tr.keys))
    .map((tr) => ({ path: String(tr.path), keys: tr.keys, inner: innerKeys(tr.keys, t0, t1) }))
    // Camera flights retime through arc length (retimePathSpan), not values.
    .filter((tr) => tr.inner.length && !(host === 'camera' && tr.path === 'path'));
  if (!list.length) return null;

  // Anchors and per-key progress per track; a non-numeric span is skipped.
  const prepared = [];
  for (const tr of list) {
    const find = (t) => tr.keys.find((k) => Math.abs(Number(k.t) - t) <= TIME_EPS);
    const left = find(t0);
    const right = find(t1);
    if (!left || !right) continue;
    const vA = num(keyValue(left));
    const vC = num(keyValue(right));
    if (vA == null || vC == null) continue;
    const inner = tr.inner.map((k) => ({
      key: k,
      t: Number(k.t),
      y: spanProgress(vA, vC, keyValue(k)),
    }));
    prepared.push({ ...tr, vA, vC, inner });
  }
  if (!prepared.length) return null;

  // One point per timestamp across the axes (design §4, multi-axis merge).
  const points = new Map();
  for (const tr of prepared) {
    for (const item of tr.inner) {
      const id2 = bucket(item.t);
      if (!points.has(id2)) points.set(id2, { t: item.t, ys: [] });
      const point = points.get(id2);
      if (item.y != null) point.ys.push(item.y);
    }
  }
  const ordered = [...points.values()].sort((a, b) => a.t - b.t);
  const timed = retime ? retimeSpanTimes({ from: t0, to: t1, curve, points: ordered }) : null;
  if (retime && !timed) return null;
  const newTimeOf = new Map();
  ordered.forEach((point, i) => {
    newTimeOf.set(bucket(point.t), retime ? timed[i].newT : point.t);
  });
  const pinnedOf = new Map();
  ordered.forEach((point, i) => {
    if (retime && timed[i].outOfRange) pinnedOf.set(bucket(point.t), i);
  });

  const removes = [];
  const sets = [];
  const curves = [];
  let moved = 0;
  let pinned = 0;
  const report = [];
  for (const tr of prepared) {
    const next = [];
    for (const item of tr.inner) {
      const at = newTimeOf.get(bucket(item.t)) ?? item.t;
      const isPinned = pinnedOf.has(bucket(item.t));
      // A non-numeric inner key (should not happen on a numeric track) is left
      // exactly where it is instead of being turned into a number.
      if (num(keyValue(item.key)) == null) { next.push(item.t); continue; }
      let value = keyValue(item.key);
      if (isPinned) {
        // Out of range: time is the anchor, the value moves onto the curve.
        const u = clamp((item.t - t0) / (t1 - t0), 0, 1);
        const progress = sampleCurve(curve, u);
        value = tr.vA + (tr.vC - tr.vA) * progress;
        pinned += 1;
      } else if (Math.abs(at - item.t) > TIME_EPS) {
        moved += 1;
      }
      if (host === 'element') {
        const v = typeof value === 'number' ? value : Number(value);
        const set = { op: hostOps.set, id, path: tr.path, t: at, value: v };
        if (item.key.ease != null) set.ease = item.key.ease;
        set.curve = item.key.curve ?? null;
        if (Math.abs(at - item.t) > TIME_EPS || isPinned) {
          removes.push({ op: hostOps.remove, id, path: tr.path, t: item.t });
          sets.push(set);
        }
      } else {
        const set = { op: hostOps.set, id, path: tr.path, t: at, v: value };
        if (item.key.ease != null) set.ease = item.key.ease;
        set.curve = item.key.curve ?? null;
        for (const h of ['out', 'in', 'speed']) {
          if (item.key[h] != null) set[h] = item.key[h];
        }
        if (Math.abs(at - item.t) > TIME_EPS || isPinned) {
          removes.push({ op: hostOps.remove, id, path: tr.path, t: item.t });
          sets.push(set);
        }
      }
      next.push(at);
      report.push({ path: tr.path, t: item.t, newT: at, pinned: isPinned });
    }
    const sorted = [...next].sort((a, b) => a - b);
    const edges = [t0, ...sorted, t1];
    for (let i = 0; i < edges.length - 1; i++) {
      curves.push({
        op: 'keyCurve',
        host,
        id,
        path: tr.path,
        from: roundMs(edges[i]),
        to: roundMs(edges[i + 1]),
        curve,
      });
    }
  }
  return { ops: [...removes, ...sets, ...curves], moved, pinned, times: report };
}

/**
 * Cubic-bezier handles that stand in for one of the stored `ease` curves.
 *
 * The panel shows handles on a segment that has no `curve` yet; drawing them
 * from the *real* ease keeps the preview honest instead of pretending every
 * uncurved segment is `easeInOut` (the old bug). The x coordinates are pinned
 * to 1/3 and 2/3, which makes the x(t) mapping the identity, so only the two
 * y values are fitted — 16 samples, least squares.
 *
 * `outExpo` and `outBack` have no exact cubic equivalent; the fit is close but
 * not identical, and it only exists until the user drags a handle (a drag
 * writes a real `curve`).
 */
export function curveFromEase(name) {
  const fn = EASES[name] || EASES.easeInOut;
  const n = 16;
  let s11 = 0, s12 = 0, s22 = 0, r1 = 0, r2 = 0;
  for (let i = 1; i < n; i++) {
    const u = i / n;
    const a = 3 * (1 - u) * (1 - u) * u;
    const b = 3 * (1 - u) * u * u;
    const target = fn(u) - u * u * u;
    s11 += a * a; s12 += a * b; s22 += b * b;
    r1 += a * target; r2 += b * target;
  }
  const det = s11 * s22 - s12 * s12;
  const y1 = det === 0 ? 1 / 3 : (r1 * s22 - r2 * s12) / det;
  const y2 = det === 0 ? 2 / 3 : (r2 * s11 - r1 * s12) / det;
  const p1 = [round4(1 / 3), round4(clamp(y1, -1, 2))];
  const p2 = [round4(2 / 3), round4(clamp(y2, -1, 2))];
  const preset = bezierPresetFor(p1, p2);
  return normalizeCurve(preset
    ? { type: 'bezier', preset, p1, p2 }
    : { type: 'bezier', p1, p2 });
}
