import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createProject, normalizeProject, validateProject, elementsAt } from '../core/schema.js';
import { applyOp, applyOps, getPath, setPath, coerceValue } from '../core/ops.js';
import { evalElement, motionDelta } from '../core/evaluate.js';
import { sampleTrack, ease, kick, timecode } from '../core/time.js';
import { saveProject, loadProject, mutateProject, watchProject } from '../core/store.js';
import { extractProposal } from '../engine/agent.js';

const fresh = () => normalizeProject(createProject({ title: 't', duration: 10 }));

test('createProject + validate is clean', () => {
  const p = fresh();
  assert.equal(validateProject(p).length, 0);
  assert.equal(p.meta.fps, 24);
  assert.deepEqual(p.meta.fx.bloom, 0.25);
});

test('addElement assigns ids and sorts by z', () => {
  const p = fresh();
  applyOp(p, { op: 'addElement', element: { type: 'text', start: 0, duration: 2, style: { text: 'hi' } } });
  applyOp(p, { op: 'addElement', element: { type: 'image', src: 'media/a.png', start: 1, duration: 2, z: -1 } });
  assert.equal(p.elements.length, 2);
  assert.equal(p.elements[0].id, 'el_2', 'lower z sorts first after applyOps ordering rules');
  assert.equal(p.elements[0].type, 'image');
  assert.equal(p.elements[1].style.text, 'hi');
});

test('set / update / remove work and reject unknown ids', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 1 } });
  applyOp(p, { op: 'set', id: element.id, path: 'transform.x', value: '42' });
  assert.equal(p.elements[0].transform.x, 42, 'string values are coerced');
  applyOp(p, { op: 'updateElement', id: element.id, patch: { style: { fill: '#123456' } } });
  assert.equal(p.elements[0].style.fill, '#123456');
  applyOp(p, { op: 'removeElement', id: element.id });
  assert.equal(p.elements.length, 0);
  assert.throws(() => applyOp(p, { op: 'removeElement', id: 'nope' }), /no element/);
});

test('keyRemove drops one key when t is given, the whole path otherwise', () => {
  const p = fresh();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 3 } });
  const id = element.id;
  applyOp(p, { op: 'keySet', id, path: 'transform.scale', t: 0, value: 1 });
  applyOp(p, { op: 'keySet', id, path: 'transform.scale', t: 1, value: 2 });
  applyOp(p, { op: 'keySet', id, path: 'transform.x', t: 0, value: 5 });
  applyOp(p, { op: 'keyRemove', id, path: 'transform.scale', t: 1 });
  assert.deepEqual(p.elements[0].keyframes.map((k) => [k.path, k.t]), [['transform.scale', 0], ['transform.x', 0]]);
  applyOp(p, { op: 'keyRemove', id, path: 'transform.scale' });
  assert.deepEqual(p.elements[0].keyframes.map((k) => k.path), ['transform.x']);
});

test('splitElement keeps both halves looking exactly like the original', () => {
  const p = fresh();
  const { element } = applyOp(p, {
    op: 'addElement',
    element: { type: 'text', start: 0, duration: 4, style: { text: 'x' }, keyframes: [{ t: 0.5, path: 'transform.scale', value: 1 }, { t: 3, path: 'transform.scale', value: 2 }] },
  });
  applyOp(p, { op: 'splitElement', id: element.id, at: 2 });
  const left = p.elements.find((e) => e.start === 0);
  const right = p.elements.find((e) => e.start === 2);
  assert.equal(left.duration, 2);
  assert.equal(right.duration, 2);
  assert.deepEqual(left.keyframes.map((k) => k.t), [0.5, 3], 'left keeps the key it interpolates towards');
  assert.deepEqual(right.keyframes.map((k) => k.t), [0.5, 3], 'key times stay absolute');
});

test('addSegment sorts and element assignment validates', () => {
  const p = fresh();
  applyOp(p, { op: 'addSegment', segment: { start: 4, duration: 2, name: 'b' } });
  applyOp(p, { op: 'addSegment', segment: { start: 0, duration: 4, name: 'a' } });
  assert.deepEqual(p.segments.map((s) => s.name), ['a', 'b']);
  assert.throws(() => applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 1, segment: 'seg_9' } }));
});

test('keyframes sample with easing and clamps at the ends', () => {
  const meta = { width: 1920, height: 1080 };
  const el = {
    id: 'e', type: 'solid', start: 0, duration: 4, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    style: { size: 96, text: 'x', color: '#fff' }, motion: { type: 'none', amount: 0 },
    keyframes: [
      { t: 0, path: 'transform.scale', value: 1, ease: 'linear' },
      { t: 2, path: 'transform.scale', value: 3, ease: 'linear' },
    ],
  };
  assert.equal(sampleTrack(el.keyframes, 'transform.scale', 1, 0), 2);
  assert.equal(sampleTrack(el.keyframes, 'transform.scale', -5, 0), 1);
  assert.equal(sampleTrack(el.keyframes, 'transform.scale', 99, 0), 3);
  assert.equal(evalElement(el, 1, meta).scale, 2);
  assert.equal(ease('linear', 0.25), 0.25);
  assert.equal(ease('easeOut', 1), 1);
});

test('motion + fades are deterministic and time based', () => {
  const meta = { width: 1920, height: 1080, beats: [0, 0.5, 1] };
  const el = {
    id: 'e', type: 'image', start: 1, duration: 2, fadeIn: 0.5,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    motion: { type: 'in', amount: 0.2 }, keyframes: [],
  };
  const a = evalElement(el, 1.25, meta);
  const b = evalElement(el, 1.25, meta);
  assert.deepEqual(a, b);
  assert.ok(a.scale > 1 && a.scale < 1.2);
  assert.ok(Math.abs(a.opacity - 0.5) < 0.01, 'fade in is half way');
  assert.ok(motionDelta(el, 2.9, meta).scale > 1.19);
  assert.equal(kick([1], 1.0, 0.1), 1);
  assert.ok(kick([1], 1.5, 0.1) < 0.01);
});

test('elementsAt respects visibility window', () => {
  const p = fresh();
  applyOp(p, { op: 'addElement', element: { type: 'solid', start: 2, duration: 2 } });
  assert.equal(elementsAt(p, 1.99).length, 0);
  assert.equal(elementsAt(p, 2).length, 1);
  assert.equal(elementsAt(p, 4).length, 0);
});

test('path helpers', () => {
  const o = { a: { b: [{ c: 1 }] } };
  assert.equal(getPath(o, 'a.b.0.c'), 1);
  setPath(o, 'a.b.0.c', 2);
  assert.equal(o.a.b[0].c, 2);
  setPath(o, 'x.y', 3);
  assert.equal(o.x.y, 3);
  assert.deepEqual(coerceValue('{"a":1}'), { a: 1 });
  assert.equal(coerceValue('1.5'), 1.5);
});

test('store roundtrip bumps rev and locks safely', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdm-'));
  const p = fresh();
  await saveProject(dir, p);
  assert.equal((await loadProject(dir)).rev, 1);
  const r = await mutateProject(dir, (proj) => {
    applyOp(proj, { op: 'addElement', element: { type: 'solid', start: 0, duration: 1 } });
  });
  assert.equal(r.changed, true);
  const back = await loadProject(dir);
  assert.equal(back.elements.length, 1);
  assert.equal(back.rev, 2);
  // concurrent mutations must not lose writes
  await Promise.all([1, 2, 3].map((i) => mutateProject(dir, (proj) => {
    applyOp(proj, { op: 'addElement', element: { type: 'solid', start: i, duration: 1 } });
  })));
  assert.equal((await loadProject(dir)).elements.length, 4);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('watchProject notices writes from another process', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vdm-'));
  await saveProject(dir, fresh());
  let hits = 0;
  const stop = watchProject(dir, () => { hits++; });
  try {
    await new Promise((r) => setTimeout(r, 300));
    await mutateProject(dir, (proj) => { proj.meta.title = 'changed elsewhere'; });
    const t0 = Date.now();
    while (!hits && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(hits > 0, 'the watcher fired');
  } finally {
    stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('timecode formatting', () => {
  assert.equal(timecode(0, 24), '00:00:00');
  assert.equal(timecode(61.5, 24), '01:01:12');
});

test('agent proposals are extracted from chatty answers', () => {
  const p = extractProposal('sure!\n```json\n{"note":"n","ops":[{"op":"setFx","fx":{"bloom":0.5}}]}\n```');
  assert.equal(p.ops.length, 1);
  assert.equal(p.note, 'n');
  assert.equal(extractProposal('no json'), null);
  assert.ok(extractProposal('{"op":"removeElement","id":"el_1"}').ops.length === 1);
});
