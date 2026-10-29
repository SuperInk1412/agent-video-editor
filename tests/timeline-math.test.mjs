import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFps, frameIndex, frameStart, frameStep, frameBand, planRulerTicks,
  frameKeyTime, frameKeyTimeForFrame, frameWriteTime, frameClipEdit, lastFrameTime,
} from '../app/renderer/js/timeline-math.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const round3 = (v) => Math.round(v * 1000) / 1000;

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

test('timeline-math: frameKeyTime survives 3-decimal storage at 24/30/60fps', () => {
  for (const fps of [24, 30, 60]) {
    for (let f = 0; f <= fps * 20; f++) {
      const t = frameKeyTimeForFrame(f, fps);
      const where = `${fps}fps frame ${f} -> ${t}`;
      assert.equal(frameIndex(t, fps), f, where);
      assert.ok(t >= f / fps - 1e-12, `${where} is before the frame start`);
      assert.ok(t < (f + 1) / fps, `${where} crosses into the next frame`);
      assert.ok(Math.abs(t * 1000 - Math.round(t * 1000)) < 1e-6, `${where} is not 3-decimal`);
      // a raw frame start (and its in-memory integer-frame time) resolves to
      // the same stored time, so the playhead band and the key agree.
      assert.equal(frameKeyTime(f / fps, fps), t, where);
      assert.equal(frameKeyTime(frameStart(f / fps, fps), fps), t, where);
    }
  }
  // mid-frame times resolve to the frame that is visibly under the playhead
  const t = 43.9 / 24;
  assert.equal(frameKeyTime(t, 24), frameKeyTimeForFrame(43, 24));
  assert.equal(frameKeyTime(1.8, 24), frameKeyTimeForFrame(43, 24));
  assert.equal(frameKeyTimeForFrame(-5, 24), 0);
  assert.equal(frameKeyTime(-3, 24), 0);
  // 60fps: 1/60 -> 17ms, not 16ms, so it is still frame 1
  assert.equal(frameKeyTimeForFrame(1, 60), 0.017);
  assert.equal(frameIndex(0.016, 60), 0);
});

test('timeline-math: frameKeyTime rounds up because round3 falls back a frame', () => {
  // 30fps: 7/30 = 233.333ms; round3 -> 0.233 is *before* the left edge
  assert.equal(frameIndex(7 / 30, 30), 7);
  assert.equal(frameIndex(round3(7 / 30), 30), 6);
  assert.equal(frameIndex(frameKeyTime(7 / 30, 30), 30), 7);
  // 24fps: 11/24 = 458.333ms; round3 -> 0.458 is frame 10
  assert.equal(frameIndex(11 / 24, 24), 11);
  assert.equal(frameIndex(round3(11 / 24), 24), 10);
  assert.equal(frameIndex(frameKeyTime(11 / 24, 24), 24), 11);
  // 60fps: 5/60 = 83.333ms; round3 -> 0.083 is frame 4
  assert.equal(frameIndex(5 / 60, 60), 5);
  assert.equal(frameIndex(round3(5 / 60), 60), 4);
  assert.equal(frameIndex(frameKeyTime(5 / 60, 60), 60), 5);
});

test('timeline-math: frameWriteTime keeps the exact project tail', () => {
  const tail = 9.995; // 24fps: 239.88 frames, not a frame boundary
  assert.equal(frameWriteTime(tail, 24, tail), tail);
  // the frame before the tail still quantizes normally
  assert.equal(frameWriteTime(9.99, 24, tail), frameKeyTimeForFrame(239, 24));
  assert.equal(frameWriteTime(1.8, 24, tail), frameKeyTimeForFrame(43, 24));
  assert.equal(frameWriteTime(0, 24, tail), 0);
  // without a tail the same time rounds up onto the frame grid
  assert.equal(frameWriteTime(tail, 24), frameKeyTimeForFrame(239, 24));
  // float noise around the tail still keeps it exact
  assert.equal(frameWriteTime(tail + 1e-10, 24, tail), tail);
});

test('timeline-math: lastFrameTime stops one frame before the duration boundary', () => {
  // 5 s @ 60 fps is 300 frames (f0 … f299): the boundary 5.0 is not a frame,
  // and the playhead must park on 299/60 or the picture shows an empty frame.
  assert.equal(lastFrameTime(5, 60), 299 / 60);
  assert.equal(lastFrameTime(12.34, 24), 295 / 24);
  assert.equal(lastFrameTime(12, 24), 287 / 24);
  assert.equal(lastFrameTime(4, 30), 119 / 30);

  // It names a real frame start, one frame before the boundary, and that frame
  // is the last one the shot bake renders (`frames = round(duration * fps)`).
  for (const [duration, fps] of [[5, 60], [12.34, 24], [9.995, 24], [4, 30]]) {
    const last = lastFrameTime(duration, fps);
    const where = `${duration}s@${fps}`;
    assert.ok(Number.isFinite(last), `${where}: not finite`);
    assert.equal(frameStart(last, fps), last, `${where}: not a frame start`);
    assert.equal(frameIndex(last, fps), Math.round(duration * fps) - 1, `${where}: not the last frame`);
    assert.ok(last < duration, `${where}: sits on the boundary`);
  }

  // On a frame boundary `frameStart(duration)` is already one frame past it,
  // and one more frame from the last start lands exactly on the duration.
  for (const [duration, fps] of [[5, 60], [12, 24], [4, 30], [2, 24]]) {
    assert.equal(frameStart(duration, fps), duration, `${duration}s@${fps}: boundary is a frame start`);
    assert.equal(lastFrameTime(duration, fps), frameStart(duration, fps) - 1 / fps);
    assert.equal(lastFrameTime(duration, fps) + 1 / fps, duration);
  }
  // Mid-frame durations keep the same rule: never past `frameStart(duration)`,
  // and equal to it once rounding up lands on the next frame (9.995 s @ 24fps
  // is 239.88 frames -> 240 frames, last start 239/24 = 9.9583…).
  assert.equal(lastFrameTime(9.995, 24), frameStart(9.995, 24));
  assert.ok(lastFrameTime(9.3, 24) < frameStart(9.3, 24));

  // A project shorter than half a frame still shows its single frame, and
  // garbage durations are 0 instead of NaN.
  assert.equal(lastFrameTime(0, 24), 0);
  assert.equal(lastFrameTime(0, 60), 0);
  assert.equal(lastFrameTime(0.001, 60), 0);
  assert.equal(lastFrameTime(undefined, 24), 0);
  assert.equal(lastFrameTime('nope', 24), 0);
  assert.equal(lastFrameTime(-5, 24), 0, 'negative durations clamp to the first frame');

  // fps goes through the same normalisation as every other helper: 0 / garbage
  // -> the 24fps default, negatives -> 1 fps, fractional rates round.
  assert.equal(lastFrameTime(5, 0), 119 / 24);
  assert.equal(lastFrameTime(5, 'nope'), 119 / 24);
  assert.equal(lastFrameTime(5), 119 / 24, '24fps by default');
  assert.equal(lastFrameTime(5, 29.6), 149 / 30, '29.6 rounds to 30');
  assert.equal(lastFrameTime(5, -5), 4, 'a negative rate clamps to 1 fps');
  assert.equal(lastFrameTime(0.2, 60), 11 / 60, '0.2 s @ 60fps is 12 frames, the last starts at 11/60');
});

test('timeline-math: frameClipEdit snaps the dragged edge only', () => {
  // move: start lands on the frame, duration is untouched
  const move = frameClipEdit({ mode: 'move', start: 1.83, duration: 2.345, fps: 24 });
  assert.equal(move.start, frameKeyTimeForFrame(43, 24));
  assert.equal(move.duration, 2.345);

  // right trim: end lands on frame 75 at 30fps (2.501 -> 2.5)
  const r = frameClipEdit({ mode: 'r', start: 1, duration: 1.501, fps: 30 });
  assert.equal(r.start, 1);
  assert.equal(r.start + r.duration, 2.5);

  // left trim: start lands on frame 41 at 30fps, the right edge stays at 2.501
  const l = frameClipEdit({ mode: 'l', start: 1.37, duration: 2.501 - 1.37, fps: 30 });
  assert.equal(l.start, frameKeyTimeForFrame(41, 30));
  close(l.start + l.duration, 2.501);

  // a right trim onto the project tail keeps the exact duration
  const tail = 9.995;
  const rt = frameClipEdit({ mode: 'r', start: 1.792, duration: tail - 1.792, fps: 24, tail });
  assert.equal(rt.start, 1.792);
  assert.equal(rt.duration, 8.203);
  close(rt.start + rt.duration, tail);
  // the frame grid would have pulled the end back to the last frame start
  assert.equal(frameKeyTime(tail, 24), frameKeyTimeForFrame(239, 24));
  assert.notEqual(frameKeyTime(tail, 24), tail);

  // the media/source limit is not a frame boundary and wins over the grid
  const capped = frameClipEdit({ mode: 'r', start: 0, duration: 5.5, fps: 24, maxDuration: 5.1234 });
  assert.equal(capped.duration, 5.123);
  // moving onto the tail start keeps it exact as well
  assert.equal(frameClipEdit({ mode: 'move', start: tail, duration: 2, fps: 24, tail }).start, tail);
});

test('timeline-math: frameClipEdit never returns negative values', () => {
  const r = frameClipEdit({ mode: 'r', start: 2, duration: 0.001, fps: 24 });
  assert.ok(r.duration >= 0);
  const l = frameClipEdit({ mode: 'l', start: 0, duration: 0, fps: 24 });
  assert.equal(l.start, 0);
  assert.equal(l.duration, 0);
  assert.deepEqual(frameClipEdit({ mode: 'move', start: -4, duration: 0, fps: 24 }), { start: 0, duration: 0 });
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
