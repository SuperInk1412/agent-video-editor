// Time range selection for the timeline (docs/DESIGN-WP2.5-REVIEW.md §10.6).
// Pure frame math: no DOM, no node:*, no dependency on the editor — the
// renderer and Node tests (tests/timeline-range.test.mjs) share one definition.
//
// A range is `{ from, to }` in integer frames, both ends inclusive. Which ends
// the user has actually set rides on the object as two non-enumerable flags:
// while only one end is set the other one follows the playhead (I alone gives a
// one-frame range), and once both are set a later I / O only moves its own end
// and the pair is sorted. The flags stay invisible to JSON / deepEqual, so the
// value is still just `{ from, to }` to every other caller.
//
// The range is UI state: it never enters the project, the undo history or the
// render backend.
import { normalizeFps } from './timeline-math.js';

const IN_SET = Symbol('timeRange.inSet');
const OUT_SET = Symbol('timeRange.outSet');

// Numbers only: Number(null) and Number('') are 0, and a missing end must not
// silently become the first frame.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Integer frame for `v`; 0 (never -0); null when `v` is not a number. */
const frame = (v) => {
  const n = num(v);
  if (n == null) return null;
  const r = Math.round(n);
  return r === 0 ? 0 : r;
};

const isSet = (range, key, fallback = false) => (
  typeof range?.[key] === 'boolean' ? range[key] : fallback
);

function tagged(from, to, inSet, outSet) {
  const range = { from, to };
  Object.defineProperty(range, IN_SET, { value: inSet, enumerable: false, configurable: true });
  Object.defineProperty(range, OUT_SET, { value: outSet, enumerable: false, configurable: true });
  return range;
}

/** Clamp a frame into [0, max] (`max` already integer); null for a non-number. */
function clampFrame(v, max) {
  const f = num(v);
  if (f == null) return null;
  return Math.min(Math.max(0, Math.round(f)), max);
}

/**
 * Last frame number a project of `duration` seconds at `fps` can hold.
 * null when the duration is not a usable (finite, non-negative) number —
 * callers then have no idea where the timeline ends and must not guess.
 */
export function frameLimit(opts) {
  const duration = num(opts?.duration);
  if (duration == null || duration < 0) return null;
  return Math.round(duration * normalizeFps(opts?.fps));
}

/**
 * `{ from, to }` in integer frames, `from <= to`, clamped to
 * `[0, round(duration * fps)]`. Invalid input (no range, non-numeric ends, an
 * unusable duration) gives null.
 */
export function normalizeRange(range, opts) {
  const max = frameLimit(opts);
  if (max == null || !range || typeof range !== 'object') return null;
  const a = clampFrame(range.from, max);
  const b = clampFrame(range.to, max);
  if (a == null || b == null) return null;
  return tagged(
    Math.min(a, b), Math.max(a, b),
    isSet(range, IN_SET, true), isSet(range, OUT_SET, true),
  );
}

/** A finished drag: both ends rounded to whole frames and ordered. */
export function rangeFromDrag(a, b) {
  const from = frame(a);
  const to = frame(b);
  if (from == null || to == null) return null;
  return tagged(Math.min(from, to), Math.max(from, to), true, true);
}

/**
 * Set the in point. With no range yet (or only an out point) the other end
 * follows, so the result is always a valid `{ from, to }`; with both ends set
 * the pair is sorted afterwards.
 */
export function setIn(range, value, opts) {
  return setEnd(range, value, opts, 'in');
}

/** Set the out point; the mirror of {@link setIn}. */
export function setOut(range, value, opts) {
  return setEnd(range, value, opts, 'out');
}

function setEnd(range, value, opts, end) {
  const max = frameLimit(opts);
  if (max == null) return null;
  const f = clampFrame(value, max);
  if (f == null) return null;
  const prev = normalizeRange(range, opts);
  if (!prev) return tagged(f, f, end === 'in', end === 'out');
  const inSet = isSet(prev, IN_SET);
  const outSet = isSet(prev, OUT_SET);
  if (end === 'in') {
    const to = outSet ? prev.to : f;
    return tagged(Math.min(f, to), Math.max(f, to), true, outSet);
  }
  const from = inSet ? prev.from : f;
  return tagged(Math.min(from, f), Math.max(from, f), inSet, true);
}

/** Frames the range covers, both ends included; 0 when it is not a range. */
export function rangeWidth(range) {
  const a = frame(range?.from);
  const b = frame(range?.to);
  if (a == null || b == null) return 0;
  return Math.abs(b - a) + 1;
}

/** True when `value`'s frame is inside the range — both ends included. */
export function rangeContains(range, value) {
  if (!range) return false;
  const f = frame(value);
  const a = frame(range.from);
  const b = frame(range.to);
  if (f == null || a == null || b == null) return false;
  return f >= Math.min(a, b) && f <= Math.max(a, b);
}

/**
 * Re-fit a range to a (possibly new) project length; null when it cannot be
 * clamped. Same rules as {@link normalizeRange}, kept as its own name because
 * `setProject` reads better as "clamp".
 */
export function clampRange(range, opts) {
  return normalizeRange(range, opts);
}
