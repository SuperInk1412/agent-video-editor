import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frameLimit, normalizeRange, rangeFromDrag, setIn, setOut,
  rangeWidth, rangeContains, clampRange,
} from '../app/renderer/js/timeline-range.js';

// Every test project here is 10 s at 24 fps: frames 0..240.
const P = { duration: 10, fps: 24 };

test('frames snap to whole numbers and stay ordered', () => {
  assert.deepEqual(normalizeRange({ from: 143.6, to: 152.4 }, P), { from: 144, to: 152 });
  assert.deepEqual(normalizeRange({ from: 152.6, to: 143.4 }, P), { from: 143, to: 153 });
  // -0 must not survive as a frame number.
  assert.deepEqual(normalizeRange({ from: -0.2, to: 1 }, P), { from: 0, to: 1 });
  assert.equal(Object.is(normalizeRange({ from: -0.2, to: 1 }, P).from, -0), false);
});

test('a backwards range is swapped, by normalize and by a drag', () => {
  assert.deepEqual(normalizeRange({ from: 200, to: 40 }, P), { from: 40, to: 200 });
  assert.deepEqual(rangeFromDrag(153.4, 144.2), { from: 144, to: 153 });
  assert.deepEqual(rangeFromDrag(144.2, 153.4), { from: 144, to: 153 });
  assert.deepEqual(normalizeRange(rangeFromDrag(20, 10), P), { from: 10, to: 20 });
});

test('ranges clamp to the project length', () => {
  assert.equal(frameLimit(P), 240);
  assert.deepEqual(normalizeRange({ from: -5, to: 999 }, P), { from: 0, to: 240 });
  assert.deepEqual(normalizeRange({ from: 999, to: -5 }, P), { from: 0, to: 240 });
  assert.deepEqual(normalizeRange({ from: 0, to: 5000 }, P), { from: 0, to: 240 });
  // fps defaults to 24; a different rate changes the ceiling.
  assert.equal(frameLimit({ duration: 10 }), 240);
  assert.equal(frameLimit({ duration: 2, fps: 30 }), 60);
  // A zero-length project still has frame 0.
  assert.deepEqual(normalizeRange({ from: 1, to: 9 }, { duration: 0, fps: 24 }), { from: 0, to: 0 });
});

test('invalid input gives null instead of a guess', () => {
  assert.equal(normalizeRange(null, P), null);
  assert.equal(normalizeRange(undefined, P), null);
  assert.equal(normalizeRange({}, P), null);
  assert.equal(normalizeRange({ from: 'a', to: 1 }, P), null);
  assert.equal(normalizeRange({ from: 0, to: NaN }, P), null);
  assert.equal(normalizeRange({ from: 0, to: Infinity }, P), null);
  assert.equal(normalizeRange({ from: 0, to: 1 }, { duration: NaN }), null);
  assert.equal(normalizeRange({ from: 0, to: 1 }, { duration: -1 }), null);
  assert.equal(normalizeRange({ from: 0, to: 1 }, null), null);
  assert.equal(rangeFromDrag(NaN, 3), null);
  assert.equal(rangeFromDrag(3, null), null);
  assert.equal(setIn(null, NaN, P), null);
  assert.equal(clampRange(undefined, P), null);
});

test('while only one end is set, the other end follows the playhead', () => {
  // I alone: a one-frame range at the playhead.
  const one = setIn(null, 144, P);
  assert.deepEqual(one, { from: 144, to: 144 });
  // O then moves only the out point: the in point was never set, so it follows.
  assert.deepEqual(setOut(one, 144, P), { from: 144, to: 144 });
  const thenOut = setOut(one, 153, P);
  assert.deepEqual(thenOut, { from: 144, to: 153 });
  // Both ends set now: I moves only its own end, and the pair is sorted.
  assert.deepEqual(setIn(thenOut, 150, P), { from: 150, to: 153 });
  assert.deepEqual(setIn(thenOut, 200, P), { from: 153, to: 200 });
  // O first, then I, reaches the same range.
  const outFirst = setOut(null, 153, P);
  assert.deepEqual(outFirst, { from: 153, to: 153 });
  assert.deepEqual(setIn(outFirst, 144, P), { from: 144, to: 153 });
});

test('the both-ends-set state survives normalization and clamping', () => {
  const one = setIn(null, 10, P);
  const kept = normalizeRange(one, P);
  assert.deepEqual(kept, { from: 10, to: 10 });
  // A lost flag would make the in point follow the new out point.
  assert.deepEqual(setOut(kept, 20, P), { from: 10, to: 20 });
  assert.deepEqual(setOut(clampRange(kept, P), 20, P), { from: 10, to: 20 });
});

test('set points clamp to frames and to the project, not past it', () => {
  assert.deepEqual(setIn(null, -3, P), { from: 0, to: 0 });
  assert.deepEqual(setIn(null, 300, P), { from: 240, to: 240 });
  assert.deepEqual(setOut(setIn(null, 140, P), 300, P), { from: 140, to: 240 });
  // Fractional frames round like a drag does.
  assert.deepEqual(setIn(null, 143.7, P), { from: 144, to: 144 });
});

test('rangeContains includes both ends', () => {
  const r = { from: 144, to: 153 };
  assert.equal(rangeContains(r, 144), true);
  assert.equal(rangeContains(r, 153), true);
  assert.equal(rangeContains(r, 148.4), true);
  assert.equal(rangeContains(r, 143), false);
  assert.equal(rangeContains(r, 154), false);
  assert.equal(rangeContains({ from: 0, to: 0 }, 0), true, 'the first frame is inside a zero-width range');
  assert.equal(rangeContains(null, 0), false);
  assert.equal(rangeContains(r, NaN), false);
});

test('rangeWidth counts frames, both ends included', () => {
  assert.equal(rangeWidth({ from: 144, to: 153 }), 10);
  assert.equal(rangeWidth({ from: 5, to: 5 }), 1);
  assert.equal(rangeWidth({ from: 9, to: 3 }), 7);
  assert.equal(rangeWidth(null), 0);
  assert.equal(rangeWidth({ from: 'x', to: 3 }), 0);
  assert.equal(rangeWidth(normalizeRange({ from: 144, to: 153 }, P)), 10);
});

test('a range that reaches frame 0 keeps its lower edge', () => {
  assert.deepEqual(normalizeRange({ from: -2, to: 3 }, P), { from: 0, to: 3 });
  assert.deepEqual(normalizeRange(rangeFromDrag(-2, 3), P), { from: 0, to: 3 });
  assert.equal(rangeContains(normalizeRange(rangeFromDrag(-2, 3), P), 0), true);
  assert.equal(rangeContains(normalizeRange(rangeFromDrag(-2, 3), P), 4), false);
  assert.equal(rangeWidth(normalizeRange({ from: 0, to: 0 }, P)), 1);
});

test('an over-long range fills the whole project', () => {
  const all = normalizeRange({ from: 0, to: 99999 }, P);
  assert.deepEqual(all, { from: 0, to: 240 });
  assert.equal(rangeWidth(all), 241);
  assert.equal(rangeContains(all, 0), true);
  assert.equal(rangeContains(all, 240), true);
  assert.equal(rangeContains(all, 241), false);
});
