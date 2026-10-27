import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';

const fresh = () => normalizeProject(createProject({ title: 'media-loop', duration: 20 }));

test('media: loop is explicit and the source length caps the clip by default', () => {
  const p = fresh();
  const video = applyOp(p, {
    op: 'addElement',
    element: { type: 'video', src: 'media/v.mp4', duration: 9, meta: { sourceDuration: 5 } },
  }).element;
  assert.equal(video.loop, false);
  assert.equal(video.duration, 5, 'a non-looping clip cannot run past the source');

  const audio = applyOp(p, {
    op: 'addElement',
    element: { type: 'audio', src: 'media/a.m4a', duration: 9, loop: true, meta: { sourceDuration: 4 } },
  }).element;
  assert.equal(audio.loop, true);
  assert.equal(audio.duration, 9, 'loop allows a longer timeline clip');
});

test('media: stretching stops at the source, enabling loop lifts the limit, disabling clamps again', () => {
  const p = fresh();
  const el = applyOp(p, {
    op: 'addElement',
    element: { type: 'video', src: 'media/v.mp4', duration: 2, meta: { sourceDuration: 5 } },
  }).element;

  applyOp(p, { op: 'moveElement', id: el.id, start: 0, duration: 99 });
  assert.equal(el.duration, 5);

  applyOp(p, { op: 'updateElement', id: el.id, patch: { loop: true } });
  applyOp(p, { op: 'moveElement', id: el.id, start: 0, duration: 12 });
  assert.equal(el.duration, 12);

  applyOp(p, { op: 'updateElement', id: el.id, patch: { loop: false } });
  assert.equal(el.loop, false);
  assert.equal(el.duration, 5, 'turning loop off brings the length back into the source');
});

test('media: loop survives split and duplicate', () => {
  const p = fresh();
  const el = applyOp(p, {
    op: 'addElement',
    element: { type: 'video', src: 'media/v.mp4', start: 0, duration: 8, loop: true, meta: { sourceDuration: 3 } },
  }).element;
  const copy = applyOp(p, { op: 'duplicateElement', id: el.id, start: 10 }).element;
  assert.equal(copy.loop, true);
  applyOp(p, { op: 'splitElement', id: el.id, at: 2 });
  const right = p.elements.find((e) => e.id !== el.id && e.start === 2);
  assert.equal(right.loop, true);
});

test('media: loop must be a boolean', () => {
  const p = fresh();
  const el = applyOp(p, {
    op: 'addElement',
    element: { type: 'audio', src: 'media/a.m4a', duration: 1 },
  }).element;
  el.loop = 'yes';
  assert.ok(validateProject(p).some((issue) => issue.path.endsWith('.loop')), 'schema rejects non-boolean loop');
});
