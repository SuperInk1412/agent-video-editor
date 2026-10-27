import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { evalElement } from '../core/evaluate.js';

const fresh = () => normalizeProject(createProject({ title: 't', duration: 20 }));
const meta = { width: 1920, height: 1080, beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5] };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

function sameLook(before, halves, from, to, step = 0.05) {
  for (let t = from; t < to - 1e-9; t += step) {
    const src = evalElement(before, t, meta);
    const half = halves.find((h) => t >= h.start - 1e-9 && t < h.start + h.duration - 1e-9);
    const got = evalElement(half, t, meta);
    for (const k of ['x', 'y', 'scale', 'rotation', 'opacity']) close(got[k], src[k], `${k} @${t.toFixed(2)}`);
  }
}

test('split: keys, motion, fades and punch are seamless across the cut', () => {
  const p = fresh();
  const { element } = applyOp(p, {
    op: 'addElement',
    element: {
      type: 'image', src: 'media/a.png', start: 1, duration: 4, fadeIn: 0.5, fadeOut: 0.5, punch: 1,
      motion: { type: 'left', amount: 0.2 },
      keyframes: [
        { t: 1, path: 'transform.y', value: 0, ease: 'outExpo' },
        { t: 2.6, path: 'transform.y', value: -80, ease: 'easeInOut' },
        { t: 4.4, path: 'transform.y', value: 30 },
        { t: 2, path: 'transform.opacity', value: 0.4 },
        { t: 4, path: 'transform.opacity', value: 1 },
      ],
    },
  });
  const before = JSON.parse(JSON.stringify(element));
  applyOp(p, { op: 'splitElement', id: element.id, at: 3.1 });
  const halves = p.elements.slice().sort((a, b) => a.start - b.start);
  assert.equal(halves.length, 2);
  assert.equal(halves[0].fadeOut, 0, 'no fade-out dip at the cut');
  assert.equal(halves[1].fadeIn, 0, 'no fade-in dip at the cut');
  assert.deepEqual(halves[1].motion.span, [1, 5]);
  sameLook(before, halves, 1, 5);
});

test('split: the right half of a video resumes where the left stopped', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'video', src: 'media/v.mp4', start: 2, duration: 6 } });
  element.srcIn = 1.5;
  applyOp(p, { op: 'splitElement', id: element.id, at: 5 });
  const right = p.elements.find((e) => e.start === 5);
  assert.equal(right.srcIn, 4.5);
  assert.equal(p.elements.find((e) => e.start === 2).srcIn, 1.5);
});

test('move carries keyframes and motion span; trim pins them in time', () => {
  const p = fresh();
  const { element } = applyOp(p, {
    op: 'addElement',
    element: {
      type: 'video', src: 'media/v.mp4', start: 2, duration: 4,
      keyframes: [{ t: 2.5, path: 'transform.x', value: 10 }, { t: 4, path: 'transform.x', value: 90 }],
    },
  });
  const look = evalElement(JSON.parse(JSON.stringify(element)), 3, meta);
  applyOp(p, { op: 'moveElement', id: element.id, start: 5 });
  assert.deepEqual(element.keyframes.map((k) => k.t), [5.5, 7]);
  close(evalElement(element, 6, meta).x, look.x, 'moved animation');
  assert.equal(element.srcIn ?? 0, 0, 'a move does not touch the source in-point');

  // timeline drags send start + same duration: still a move
  applyOp(p, { op: 'moveElement', id: element.id, start: 6, duration: 4 });
  assert.deepEqual(element.keyframes.map((k) => k.t), [6.5, 8]);

  // left trim: end stays, keys stay, the video skips ahead by the trimmed amount
  applyOp(p, { op: 'moveElement', id: element.id, start: 7, duration: 3 });
  assert.deepEqual(element.keyframes.map((k) => k.t), [6.5, 8]);
  assert.equal(element.srcIn, 1);

  // explicit override
  applyOp(p, { op: 'moveElement', id: element.id, start: 8, duration: 2, keys: 'shift' });
  assert.deepEqual(element.keyframes.map((k) => k.t), [7.5, 9]);
});

test('move/duplicate/keySet reject junk numbers and unknown segments', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 1 } });
  assert.throws(() => applyOp(p, { op: 'moveElement', id: element.id, start: 'abc' }), /number/);
  assert.throws(() => applyOp(p, { op: 'moveElement', id: element.id, segment: 'seg_9' }), /unknown segment/);
  assert.throws(() => applyOp(p, { op: 'duplicateElement', id: element.id, start: 'abc' }), /number/);
  assert.throws(() => applyOp(p, { op: 'keySet', id: element.id, path: 'transform.x', t: 'x', value: 1 }), /needs t/);
});

test('keySet over an existing key keeps its ease unless a new one is given', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 2 } });
  applyOp(p, { op: 'keySet', id: element.id, path: 'transform.x', t: 1, value: 5, ease: 'outExpo' });
  applyOp(p, { op: 'keySet', id: element.id, path: 'transform.x', t: 1, value: 9 });
  assert.deepEqual(element.keyframes.map((k) => [k.value, k.ease]), [[9, 'outExpo']]);
});

test('duplicate at a new time moves the animation with the copy', () => {
  const p = fresh();
  const { element } = applyOp(p, {
    op: 'addElement',
    element: { type: 'text', start: 1, duration: 2, style: { text: 'a' }, keyframes: [{ t: 1.5, path: 'transform.scale', value: 2 }] },
  });
  const { element: copy } = applyOp(p, { op: 'duplicateElement', id: element.id, start: 4 });
  assert.equal(copy.start, 4);
  assert.deepEqual(copy.keyframes.map((k) => k.t), [4.5]);
  assert.deepEqual(element.keyframes.map((k) => k.t), [1.5], 'source untouched');
});

test('updateElement edits the base transform without creating a keyframe', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 2, transform: { z: 0 } } });
  applyOp(p, { op: 'updateElement', id: element.id, patch: { transform: { z: 3.5, x: 40 } } });
  assert.equal(element.transform.z, 3.5);
  assert.equal(element.transform.x, 40);
  assert.deepEqual(element.keyframes, [], 'a base edit must not invent a key');
  assert.equal(evalElement(element, 1, meta).z, 3.5, 'the new base applies at every time');
});

test('beat punch works without a motion preset', () => {
  const el = { id: 'e', type: 'text', start: 0, duration: 4, punch: 1, motion: { type: 'none', amount: 0 }, keyframes: [] };
  assert.ok(evalElement(el, 1.0, meta).scale > 1.04, 'on the beat');
  close(evalElement(el, 0.2, meta).scale, 1, 'before the first beat');
});

test('motion.span pins the preset to an absolute range', () => {
  const el = { id: 'e', type: 'image', start: 2, duration: 2, motion: { type: 'in', amount: 0.2, span: [0, 4] }, keyframes: [] };
  const whole = { ...el, start: 0, duration: 4, motion: { type: 'in', amount: 0.2 } };
  for (const t of [2, 2.5, 3.9]) close(evalElement(el, t, meta).scale, evalElement(whole, t, meta).scale, `scale @${t}`);
});
