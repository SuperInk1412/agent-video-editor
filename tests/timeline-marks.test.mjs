// Timeline marks — docs/DESIGN-WP2.5-REVIEW.md §10.3 (WP2.5b).
//
// What this file guards:
//   * the three mark types: whole-segment rows, keyframe rings, ruler moments;
//   * applied records land in `accepted` (painted faintly) and pending ones in
//     the main lists; a pending mark wins when both hit the same place;
//   * an accepted entry disappears once the current project no longer holds the
//     value the change set wrote (the user edited it by hand, §10.3-2);
//   * hosts that no longer exist are skipped, and a keyframe path without a
//     time is reported in `skipped` instead of guessing;
//   * `Math.round(seconds * fps)` frames, `start` before/after taking the
//     smaller one, one ruler entry per frame with a merged count.
import test from 'node:test';
import assert from 'node:assert/strict';

import { marksFor } from '../core/timeline-marks.js';

const FPS = 24;

/** A project with one keyed element, a plain element, a camera and a 3D object. */
const project = () => ({
  rev: 7,
  meta: { fps: FPS, duration: 10, width: 1280, height: 720 },
  elements: [
    {
      id: 'el_a', type: 'solid', start: 0, duration: 4, z: 1,
      style: { size: 96, color: '#ffd400' },
      keyframes: [{ t: 1.5, path: 'style.size', value: 96 }],
    },
    { id: 'el_b', type: 'solid', start: 2, duration: 3, z: 2 },
  ],
  cameras: [{
    id: 'cam_1', name: 'camera',
    path: [{ t: 1, pos: [0, 0, 0] }, { t: 2, pos: [1, 0, 0] }],
    tracks: { fov: [{ t: 1.25, v: 50 }] },
  }],
  scene: { objects: [{ id: 'ob_1', start: 0, duration: 5, tracks: { pivot: [{ t: 0.5, v: [0, 0, 0] }] } }] },
});

let seq = 0;
const record = (status, changed = [], extra = {}) => ({
  id: `cs_${String(++seq).padStart(4, '0')}`,
  status,
  actorId: 'agent:dsh',
  intent: 'test',
  changed,
  added: [],
  removed: [],
  ...extra,
});

const entry = (kind, id, path, before, after, change = 'modified') => ({
  id, kind, path, before, after, change,
});

test('a whole-segment property marks the host row', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_a', 'style.size', 96, 150)]),
    record('proposed', [entry('camera', 'cam_1', 'fov', 51, 62)]),
    record('proposed', [entry('object', 'ob_1', 'opacity', 1, 0.5)]),
  ], project());

  assert.deepEqual(marks.rows, [
    { id: 'el_a', kind: 'element', bar: true, outline: true },
    { id: 'cam_1', kind: 'camera', bar: true, outline: true },
    { id: 'ob_1', kind: 'object', bar: true, outline: true },
  ]);
  assert.deepEqual(marks.keys, []);
  assert.deepEqual(marks.ruler, []);
});

test('a keyframe path becomes a key mark with the parsed time and property', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_a', 'keyframes[1.5].style.size.value', 96, 150)]),
  ], project());

  assert.deepEqual(marks.keys, [{ id: 'el_a', kind: 'element', path: 'style.size', t: 1.5 }]);
  assert.deepEqual(marks.rows, []);
  assert.deepEqual(marks.ruler, []);
});

test('an added key uses its own path as the mark path (no trailing field)', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_a', 'keyframes[2].style.color', null, { t: 2, path: 'style.color', value: '#fff' }, 'added')]),
  ], project());

  assert.deepEqual(marks.keys, [{ id: 'el_a', kind: 'element', path: 'style.color', t: 2 }]);
});

test('object and camera track leaves resolve their time from the project', () => {
  const marks = marksFor([
    record('proposed', [entry('object', 'ob_1', 'tracks.pivot.0.v', [0, 0, 0], [1, 0, 0])]),
    record('proposed', [entry('camera', 'cam_1', 'tracks.fov.0.v', 50, 62)]),
    record('proposed', [entry('camera', 'cam_1', 'path.1.pos', [1, 0, 0], [2, 0, 0])]),
  ], project());

  assert.deepEqual(marks.keys, [
    { id: 'ob_1', kind: 'object', path: 'pivot', t: 0.5 },
    { id: 'cam_1', kind: 'camera', path: 'fov', t: 1.25 },
    { id: 'cam_1', kind: 'camera', path: 'path', t: 2 },
  ]);
  assert.deepEqual(marks.rows, []);
});

test('an added element marks the ruler at its new start', () => {
  const p = project();
  p.elements.push({ id: 'el_new', type: 'solid', start: 1.25, duration: 2, z: 3 });
  const marks = marksFor([
    record('proposed', [], { added: [{ id: 'el_new', kind: 'element', index: 2, object: { start: 1.25, duration: 2 } }] }),
  ], p);

  assert.deepEqual(marks.ruler, [{ frame: 30, count: 1 }]);
  assert.deepEqual(marks.rows, []);
});

test('a removed host still marks the frame it left from', () => {
  const marks = marksFor([
    record('proposed', [], { removed: [{ id: 'el_gone', kind: 'element', index: 0, object: { start: 2.5, duration: 1 } }] }),
  ], project());

  assert.deepEqual(marks.ruler, [{ frame: 60, count: 1 }]);
  assert.deepEqual(marks.skipped.filter((s) => s.reason === 'host no longer exists'), []);
});

test('a start change marks the earlier of before / after', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_b', 'start', 0.5, 1.75)]),
  ], project());

  assert.deepEqual(marks.ruler, [{ frame: 12, count: 1 }]);
  assert.deepEqual(marks.rows, []);
});

test('duration and z mark the host start, not a row bar', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_b', 'duration', 3, 4)]),
    record('proposed', [entry('element', 'el_b', 'z', 2, 5)]),
  ], project());

  assert.deepEqual(marks.ruler, [{ frame: 48, count: 2 }]);
  assert.deepEqual(marks.rows, []);
});

test('marks on the same frame merge into one ruler entry with a count', () => {
  const p = project();
  p.elements.push({ id: 'el_c', type: 'solid', start: 2, duration: 1, z: 4 });
  const marks = marksFor([
    record('proposed', [entry('element', 'el_b', 'start', 2, 3)]),
    record('proposed', [entry('element', 'el_c', 'start', 2, 4)]),
    record('proposed', [entry('element', 'el_b', 'duration', 3, 2)]),
  ], p);

  assert.deepEqual(marks.ruler, [{ frame: 48, count: 3 }]);
});

test('applied records go to accepted, pending ones stay in the main lists', () => {
  const p = project();
  p.elements[0].style.size = 150; // the applied value is still there
  const marks = marksFor([
    record('applied', [entry('element', 'el_a', 'style.size', 96, 150)]),
    record('proposed', [entry('element', 'el_b', 'style.color', '#000', '#fff')]),
    record('needs-decision', [entry('element', 'el_b', 'style.size', 96, 120)]),
  ], p);

  assert.deepEqual(marks.rows.map((r) => r.id), ['el_b']);
  assert.deepEqual(marks.accepted.rows.map((r) => r.id), ['el_a']);
});

test('a pending mark hides the accepted mark on the same place', () => {
  const p = project();
  p.elements[0].style.size = 150;
  const marks = marksFor([
    record('applied', [entry('element', 'el_a', 'style.size', 96, 150)]),
    record('proposed', [entry('element', 'el_a', 'style.size', 150, 170)]),
  ], p);

  assert.deepEqual(marks.rows.map((r) => r.id), ['el_a']);
  assert.deepEqual(marks.accepted.rows, []);
});

test('an accepted entry disappears once the project holds a different value', () => {
  const applied = record('applied', [entry('element', 'el_a', 'style.size', 96, 150)]);
  const kept = marksFor([applied], project()); // still 96 → the user changed nothing
  assert.deepEqual(kept.accepted.rows, []);
  assert.equal(kept.skipped[0].reason, 'changed by hand after the change set');

  const p = project();
  p.elements[0].style.size = 150;
  const accepted = marksFor([applied], p);
  assert.deepEqual(accepted.accepted.rows, [{ id: 'el_a', kind: 'element', bar: true, outline: true }]);
  assert.deepEqual(accepted.skipped, []);
});

test('an accepted keyframe mark is dropped when its key value was edited', () => {
  const applied = record('applied', [entry('element', 'el_a', 'keyframes[1.5].style.size.value', 96, 150)]);

  const p = project();
  p.elements[0].keyframes[0].value = 150;
  assert.deepEqual(marksFor([applied], p).accepted.keys,
    [{ id: 'el_a', kind: 'element', path: 'style.size', t: 1.5 }]);

  const edited = project();
  edited.elements[0].keyframes[0].value = 300;
  const marks = marksFor([applied], edited);
  assert.deepEqual(marks.accepted.keys, []);
  assert.equal(marks.skipped[0].reason, 'changed by hand after the change set');
});

test('proposed entries are never compared with the project', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_a', 'style.size', 96, 150)]),
  ], project());
  assert.deepEqual(marks.rows.map((r) => r.id), ['el_a']);
  assert.deepEqual(marks.skipped, []);
});

test('a deleted host is skipped', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_gone', 'style.size', 96, 150)]),
    record('proposed', [entry('element', 'el_a', 'style.size', 96, 150)]),
  ], project());

  assert.deepEqual(marks.rows.map((r) => r.id), ['el_a']);
  assert.deepEqual(marks.skipped.map((s) => s.reason), ['host no longer exists']);
});

test('a keyframe path without a time is skipped and reported', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_a', 'keyframes[not-a-time].style.size.value', 96, 150)]),
    record('proposed', [entry('camera', 'cam_1', 'tracks.fov.9.v', 50, 62)]),
  ], project());

  assert.deepEqual(marks.keys, []);
  assert.equal(marks.skipped.length, 2);
  assert.ok(marks.skipped.every((s) => s.reason === 'no keyframe time in this path'));
});

test('rows are deduped across records', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_a', 'style.size', 96, 150)]),
    record('proposed', [entry('element', 'el_a', 'style.color', '#000', '#fff')]),
    record('proposed', [entry('element', 'el_a', 'style.size', 150, 170)]),
  ], project());

  assert.equal(marks.rows.length, 1);
  assert.deepEqual(marks.rows[0], { id: 'el_a', kind: 'element', bar: true, outline: true });
});

test('keys are deduped across records', () => {
  const marks = marksFor([
    record('proposed', [entry('element', 'el_a', 'keyframes[1.5].style.size.value', 96, 150)]),
    record('proposed', [entry('element', 'el_a', 'keyframes[1.5].style.size.ease', 'linear', 'easeInOut')]),
  ], project());

  assert.deepEqual(marks.keys, [{ id: 'el_a', kind: 'element', path: 'style.size', t: 1.5 }]);
});

test('empty input and records without entries produce no marks', () => {
  const marks = marksFor([], project());
  assert.deepEqual(marks.rows, []);
  assert.deepEqual(marks.keys, []);
  assert.deepEqual(marks.ruler, []);
  assert.deepEqual(marks.accepted, { rows: [], keys: [], ruler: [] });
  assert.deepEqual(marks.skipped, []);

  const blank = marksFor([record('proposed', [])], project());
  assert.deepEqual(blank.rows, []);
  assert.deepEqual(blank.skipped, []);
});

test('reverted and unknown records are ignored', () => {
  const marks = marksFor([
    record('reverted', [entry('element', 'el_a', 'style.size', 96, 150)]),
    { id: 'cs_x', status: 'weird', changed: [entry('element', 'el_a', 'style.color', '#000', '#fff')] },
  ], project());

  assert.deepEqual(marks.rows, []);
  assert.deepEqual(marks.accepted.rows, []);
});

test('frames are rounded from seconds with the given fps', () => {
  const p = project();
  const at = (status, start) => marksFor([
    record(status, [], { added: [{ id: 'el_b', kind: 'element', object: { start } }] }),
  ], p).ruler[0].frame;

  assert.equal(at('proposed', 0.52), 12); // 12.48 → 12
  assert.equal(at('proposed', 0.53), 13); // 12.72 → 13
  assert.equal(marksFor([record('proposed', [entry('element', 'el_b', 'start', 0.5, 0.5)])], p).ruler[0].frame, 12);

  const at30 = marksFor([
    record('proposed', [], { added: [{ id: 'el_b', kind: 'element', object: { start: 0.52 } }] }),
  ], p, { fps: 30 }).ruler[0].frame;
  assert.equal(at30, 16); // 15.6 → 16
});

test('project-level leaves have no timeline host', () => {
  const marks = marksFor([
    record('proposed', [entry('project', null, 'meta.title', 'a', 'b')]),
    record('proposed', [entry('segment', 'seg_1', 'start', 0, 1)]),
  ], project());

  assert.deepEqual(marks.rows, []);
  assert.deepEqual(marks.ruler, []);
  assert.deepEqual(marks.skipped.map((s) => s.reason), ['no timeline host for this kind']);
});
