// Pure time <-> frame math for the timeline: no DOM, no runtime dependencies,
// so the renderer and Node tests (tests/timeline-math.test.mjs) share one
// definition. Frame boundaries come from integer frame counts, never from
// accumulated seconds, so 24 / 30 / 60 fps never drift.
//
// Epsilon is in frame units (not seconds): `43/24 * 24` may land a hair below
// 43, and `123/30 * 30` really does evaluate to 122.99999999999999. Flooring
// with a 1e-6-frame cushion recovers the intended frame without turning a time
// that is genuinely mid-frame into the next one.
const FRAME_EPS = 1e-6;

/** 24 default, at least 1 fps, integer. */
export function normalizeFps(fps) {
  return Math.max(1, Math.round(Number(fps) || 24));
}

/** Frame number under `t`; clamps at 0 and floors with the epsilon above. */
export function frameIndex(t, fps) {
  const rate = normalizeFps(fps);
  const time = Math.max(0, Number(t) || 0);
  return Math.max(0, Math.floor(time * rate + FRAME_EPS));
}

/** Start time of the frame under `t`. */
export function frameStart(t, fps) {
  const rate = normalizeFps(fps);
  return frameIndex(t, rate) / rate;
}

/** Start of the next (dir > 0) or previous (dir < 0) frame, clamped at 0. */
export function frameStep(t, dir, fps) {
  const rate = normalizeFps(fps);
  const next = Math.max(0, frameIndex(t, rate) + (Number(dir) < 0 ? -1 : 1));
  return next / rate;
}

/**
 * Time to store for frame `frame` so that frameIndex(time, fps) still answers
 * `frame` after the project's 3-decimal time rounding.
 *
 * Frame starts are exact fractions (43/24 = 1.7916666…). round3() can land
 * *below* the left edge and push the key back one frame: 7/30 rounds down to
 * 0.233 (frame 6), 11/24 to 0.458 (frame 10), 5/60 to 0.083 (frame 4).
 * Rounding the millisecond *up* never leaves the frame: the result is at or
 * after the left edge, and one millisecond is less than a frame at any sane
 * rate (0.024 frame at 24fps, 0.06 at 60fps). Below 1000fps the stored time is
 * strictly inside the frame, so the frame band and the key diamond agree.
 */
export function frameKeyTimeForFrame(frame, fps) {
  const rate = normalizeFps(fps);
  const f = Math.max(0, Math.floor(Number(frame) || 0));
  return Math.ceil((f * 1000) / rate) / 1000;
}

/** frameKeyTimeForFrame(frameIndex(t, fps), fps): the stored time for `t`'s frame. */
export function frameKeyTime(t, fps) {
  const rate = normalizeFps(fps);
  return frameKeyTimeForFrame(frameIndex(t, rate), rate);
}

/**
 * Time to write for a new key or a dragged clip edge: `frameKeyTime`, except
 * that a time already sitting exactly on `duration` (the snap magnet / the end
 * playhead) keeps the project's exact tail instead of rounding past it.
 */
export function frameWriteTime(t, fps, duration = 0) {
  const time = Math.max(0, Number(t) || 0);
  const dur = Math.max(0, Number(duration) || 0);
  if (dur > 0 && Math.abs(time - dur) <= 1e-9) return dur;
  return frameKeyTime(time, fps);
}

const roundMillis = (v) => Math.round(v * 1000) / 1000;

/**
 * Start / duration to submit for a clip drag, with the dragged edge on the
 * frame's 3-decimal left edge (`frameKeyTime`).
 *
 * - 'move': only `start` changes; `duration` is kept untouched so the clip
 *   length (and its keyframes) travel with it.
 * - 'l' / 'r': one edge is dragged, the opposite edge stays exactly where the
 *   caller had it (`start`/`duration` are the previewed range).
 *
 * `tail` is the project end. When the snapped edge lands exactly there the
 * exact duration wins over the frame grid, so the last frame is not pushed
 * past the tail. `maxDuration` is the media/source limit for a right trim: the
 * source end is not a frame boundary, so it also wins over the grid.
 */
export function frameClipEdit({
  mode = 'move', start = 0, duration = 0, fps = 24, tail = null, maxDuration = null,
} = {}) {
  const rate = normalizeFps(fps);
  const s0 = Math.max(0, Number(start) || 0);
  const d0 = Math.max(0, Number(duration) || 0);
  const at = (t) => (tail != null && Math.abs(t - tail) <= 1e-9 ? tail : frameKeyTime(t, rate));
  const limit = maxDuration == null || !Number.isFinite(Number(maxDuration))
    ? null : Math.max(0, Number(maxDuration));

  if (mode === 'move') return { start: at(s0), duration: d0 };
  const end = s0 + d0;
  if (mode === 'r') {
    const next = at(end) - s0;
    return { start: s0, duration: roundMillis(Math.max(0, limit == null ? next : Math.min(next, limit))) };
  }
  const s = at(s0);
  const next = end - s;
  return { start: s, duration: roundMillis(Math.max(0, limit == null ? next : Math.min(next, limit))) };
}

/**
 * The frame under the playhead as a pixel band inside one track:
 * `left` = frame start, `width` = one frame clipped to `duration`.
 * At/after the end, or when a frame is thinner than `minPx`, width is 0 (the
 * band is hidden: at 9px/s a 30fps frame is 0.3px and would just smear).
 */
export function frameBand({ t = 0, fps = 24, pps = 0, duration = 0, minPx = 0.5 } = {}) {
  const rate = normalizeFps(fps);
  const scale = Math.max(0, Number(pps) || 0);
  const dur = Math.max(0, Number(duration) || 0);
  const time = Math.max(0, Number(t) || 0);
  const frame = frameIndex(time, rate);
  const start = frame / rate;
  const atEnd = time >= dur || start >= dur;
  let width = Math.min(scale / rate, Math.max(0, (dur - start) * scale));
  if (atEnd || width < Math.max(0, Number(minPx) || 0)) width = 0;
  return { frame, left: start * scale, width, atEnd };
}

// Tick spacings in frames, in px terms of the ruler (68px major, ~7px minor).
// The list intentionally stops at a day's worth of frames at 24fps.
export const NICE_FRAMES = [
  1, 2, 3, 5, 6, 10, 12, 15, 20, 24, 30, 48, 60, 90, 120, 150, 240, 300,
  600, 1200, 1800, 3600, 7200, 18000, 36000,
];

/**
 * Ruler grid for the current zoom: frame spacing of the major (labelled) and
 * minor ticks. Preserves the historical NICE_FRAMES choice and the 2000 / 4000
 * node caps; after those caps a major tick that spans at least a second is
 * rounded up to a whole-second multiple, so zoomed-out labels read 0s / 10s /
 * 20s instead of drifting 1.6s apart. Below one second the labels are frame
 * timecodes (`useTimecode`).
 */
export function planRulerTicks({ duration = 0, fps = 24, pps = 0 } = {}) {
  const rate = normalizeFps(fps);
  const scale = Math.max(0, Number(pps) || 0);
  const dur = Math.max(0, Number(duration) || 0);
  const totalFrames = Math.max(0, Math.floor(dur * rate + FRAME_EPS));
  const pxPerFrame = scale / rate;
  const atLeast = (minPx) => NICE_FRAMES.find((n) => n * pxPerFrame >= minPx)
    || NICE_FRAMES[NICE_FRAMES.length - 1];

  let minorFrames = pxPerFrame >= 6 ? 1
    : pxPerFrame >= 3 ? 2
      : pxPerFrame >= 1.5 ? 5
        : pxPerFrame >= 0.75 ? 10
          : atLeast(7);
  let majorFrames = atLeast(68);
  if (totalFrames / majorFrames > 2000) {
    majorFrames = NICE_FRAMES.find((n) => n >= majorFrames && totalFrames / n <= 2000)
      || Math.ceil(totalFrames / 2000);
  }
  minorFrames = Math.min(minorFrames, majorFrames);
  // A very long timeline at a high zoom must not create tens of thousands of
  // nodes; widen the minor grid until the count is bounded.
  if (totalFrames / minorFrames > 4000) {
    minorFrames = NICE_FRAMES.find((n) => n >= minorFrames && totalFrames / n <= 4000)
      || Math.ceil(totalFrames / 4000);
  }
  // Whole-second major labels: a major tick >= 1s snaps up to a multiple of fps.
  if (majorFrames >= rate) majorFrames = Math.ceil(majorFrames / rate) * rate;
  return { majorFrames, minorFrames, useTimecode: majorFrames < rate };
}
