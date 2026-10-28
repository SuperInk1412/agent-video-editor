import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFps, frameIndex, frameStart, frameStep, frameBand, planRulerTicks,
} from '../app/renderer/js/timeline-math.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('timeline-math: fps normalizes to a positive integer rate', () => {
  assert.equal(normalizeFps(24), 24);
  assert.equal(normalizeFps('30'), 30);
  assert.equal(normalizeFps(29.6), 30);
  assert.equal(normalizeFps(undefined), 24);
  assert.equal(normalizeFps('nope'), 24);
  assert.equal(normalizeFps(0), 24, '0 falls back to the 24fps default');
  assert.equal(normalizeFps(-5), 1, 'negative rates clamp to 1');
  assert.equal(normalizeFps(0.4), 1);
});

test('timeline-math: frameIndex floors, clamps at 0, and is stable at boundaries', () => {
  assert.equal(frameIndex(0, 24), 0);
  assert.equal(frameIndex(1 / 24, 24), 1);
  assert.equal(frameIndex(43 / 24, 24), 43);
  assert.equal(frameIndex(1.8, 24), 43);
  assert.equal(frameIndex(-3, 24), 0, 'negative time clamps to frame 0');
  assert.equal(frameIndex(-1e-12, 24), 0);
  // fps 30: 123/30 * 30 === 122.99999999999999 in IEEE — the epsilon is in
  // frame units, so this still resolves to frame 123, not 122.
  assert.equal(frameIndex(123 / 30, 30), 123);
  assert.equal(frameIndex(123 / 30 - 1e-3, 30), 122, 'genuinely mid-frame stays below');
  assert.equal(frameIndex(1 / 60, 60), 1);
  assert.equal(frameIndex(0.999, 30), 29);
  assert.equal(frameStart(43 / 24, 24), 43 / 24);
  assert.equal(frameStart(1.8, 24), 43 / 24);
});

test('timeline-math: frameStep answers the frame grid without drift', () => {
  assert.equal(frameStep(1 / 24, 1, 24), 2 / 24);
  assert.equal(frameStep(2 / 24, -1, 24), 1 / 24);
  assert.equal(frameStep(0, -1, 24), 0, 'never steps before 0');
  assert.equal(frameStep(1.8, 1, 24), 44 / 24);
  assert.equal(frameStep(1.8, -1, 24), 42 / 24);
  for (const fps of [24, 30, 60]) {
    let t = 0;
    for (let i = 0; i < 1000; i++) t = frameStep(t, 1, fps);
    assert.equal(t, 1000 / fps, `${fps}fps drifts after 1000 steps`);
    for (let i = 0; i < 1000; i++) t = frameStep(t, -1, fps);
    assert.equal(t, 0, `${fps}fps does not return to 0`);
  }
});

test('timeline-math: frameBand spans one frame and hides when useless', () => {
  const band = frameBand({ t: 1, fps: 24, pps: 480, duration: 10 });
  assert.deepEqual(band, { frame: 24, left: 480, width: 20, atEnd: false });

  // a 30fps frame at 9px/s is 0.3px: below minPx, so no band at all
  assert.equal(frameBand({ t: 1, fps: 30, pps: 9, duration: 10 }).width, 0);
  assert.equal(frameBand({ t: 1, fps: 24, pps: 9, duration: 10 }).width, 0);
  assert.ok(frameBand({ t: 1, fps: 24, pps: 24, duration: 10 }).width >= 1);

  // at/after the end the duration itself is exact and the band is gone
  const end = frameBand({ t: 10, fps: 24, pps: 480, duration: 10 });
  assert.equal(end.atEnd, true);
  assert.equal(end.width, 0);
  assert.equal(end.frame, 240);
  assert.equal(frameBand({ t: 11, fps: 24, pps: 480, duration: 10 }).width, 0);

  // the last frame stops at the duration instead of running past it
  const last = frameBand({ t: 9.99, fps: 24, pps: 480, duration: 9.995 });
  assert.equal(last.frame, 239);
  close(last.left, (239 / 24) * 480);
  close(last.width, (9.995 - 239 / 24) * 480);
  assert.ok(last.width > 0 && last.width < 20);

  // a frame shorter than minPx is dropped, one at or above it is kept
  assert.equal(frameBand({ t: 0.5, fps: 24, pps: 11.9, duration: 10 }).width, 0);
  assert.ok(frameBand({ t: 0.5, fps: 24, pps: 12, duration: 10 }).width >= 0.5);
});

test('timeline-math: ruler keeps its labels on whole seconds when zoomed out', () => {
  // pps 60 / 30fps: NICE_FRAMES would pick 48 frames (1.6s); labels must snap
  // to the 2s grid so they read 0s / 2s / 4s instead of drifting.
  const wide = planRulerTicks({ duration: 10, fps: 30, pps: 60 });
  assert.equal(wide.majorFrames % 30, 0);
  assert.equal(wide.useTimecode, false);
  assert.ok(wide.majorFrames * 2 >= 68, 'labels stay at least 68px apart');
  assert.ok(wide.minorFrames > 0 && wide.minorFrames < wide.majorFrames);

  // zoomed in: labels become frame timecodes and the minor grid is one frame
  const tight = planRulerTicks({ duration: 10, fps: 24, pps: 480 });
  assert.equal(tight.useTimecode, true);
  assert.equal(tight.minorFrames, 1);
  assert.ok(tight.majorFrames < 24);
});

test('timeline-math: long durations still bound the ruler node counts', () => {
  const long = planRulerTicks({ duration: 5000, fps: 24, pps: 60 });
  const totalLong = Math.floor(5000 * 24 + 1e-6);
  assert.ok(totalLong / long.majorFrames <= 2000);
  assert.ok(totalLong / long.minorFrames <= 4000);
  assert.equal(long.majorFrames % 24, 0, 'rounded up after the node caps');
  assert.equal(long.useTimecode, false);

  const huge = planRulerTicks({ duration: 200000, fps: 30, pps: 480 });
  const totalHuge = Math.floor(200000 * 30 + 1e-6);
  assert.ok(totalHuge / huge.majorFrames <= 2000);
  assert.ok(totalHuge / huge.minorFrames <= 4000);
  assert.equal(huge.majorFrames % 30, 0);
  assert.equal(huge.useTimecode, false);

  // the whole-second rounding never reduces the requested spacing
  assert.ok(long.majorFrames * (60 / 24) >= 68);
  assert.ok(huge.majorFrames * (480 / 30) >= 68);
});
