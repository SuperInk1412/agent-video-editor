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
