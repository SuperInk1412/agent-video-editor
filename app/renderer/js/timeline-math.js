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
