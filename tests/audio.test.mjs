import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp, applyOps } from '../core/ops.js';
import { audioVolume, ensureAudioElements, audioElements } from '../core/audio.js';
import { audioGainExpression } from '../engine/audio-mix.js';

const base = (duration = 10) => normalizeProject(createProject({ title: 'sound', duration }));

test('audio: meta.audio is surfaced as a real element on load', () => {
  const p = normalizeProject({
    schema: 'vdm.project/1', rev: 1,
    meta: { title: 'song', fps: 24, width: 1920, height: 1080, duration: 15, background: '#000', audio: { src: 'media/song.m4a', offset: 1.5, gain: -6 } },
    segments: [], elements: [],
  });
  assert.equal(ensureAudioElements(p), true);
  const el = audioElements(p)[0];
  assert.equal(el.type, 'audio');
  assert.equal(el.src, 'media/song.m4a');
  assert.equal(el.start, 0);
  assert.equal(el.duration, 15);
  assert.equal(el.srcIn, 1.5);
  assert.ok(Math.abs(el.volume - 10 ** (-6 / 20)) < 1e-9);
  assert.equal(ensureAudioElements(p), false, 'idempotent');
});

test('audio: volume keys are linear and clamped', () => {
  const el = {
    type: 'audio', volume: 0.8,
    keyframes: [
      { t: 1, path: 'audio.volume', value: 0 },
      { t: 3, path: 'audio.volume', value: 1 },
      { t: 5, path: 'audio.volume', value: 2 },
    ],
  };
  assert.equal(audioVolume(el, 0), 0);
  assert.equal(audioVolume(el, 1), 0);
  assert.equal(audioVolume(el, 2), 0.5);
  assert.equal(audioVolume(el, 3), 1);
  assert.equal(audioVolume(el, 4), 1);
  assert.equal(audioVolume(el, 9), 1);
  assert.equal(audioVolume({ type: 'audio' }, 4), 1);
});

test('audio: add/split/trim keeps source in-point, volume and keyframes', () => {
  const p = base(10);
  const { element } = applyOp(p, {
    op: 'addElement',
    element: {
      type: 'audio', name: 'song', src: 'media/song.m4a', start: 1, duration: 5, srcIn: 2, volume: 0.8,
      keyframes: [
        { t: 1, path: 'audio.volume', value: 0 },
        { t: 6, path: 'audio.volume', value: 1 },
      ],
    },
  });
  assert.equal(element.volume, 0.8);
  assert.equal(element.srcIn, 2);

  applyOp(p, { op: 'splitElement', id: element.id, at: 3 });
  const left = p.elements.find((e) => e.id === element.id);
  const right = p.elements.find((e) => e.id !== element.id && e.type === 'audio');
  assert.equal(left.duration, 2);
  assert.equal(right.start, 3);
  assert.equal(right.duration, 3);
  assert.equal(right.srcIn, 4, 'right half resumes 2 s into the clip');
  assert.equal(right.volume, 0.8);
  assert.deepEqual(right.keyframes.map((k) => k.t).sort((a, b) => a - b), [1, 6]);

  applyOp(p, { op: 'moveElement', id: right.id, start: 4, duration: 2 });
  assert.equal(right.start, 4);
  assert.equal(right.duration, 2);
  assert.equal(right.srcIn, 5, 'left trim skips further into the source');
  assert.deepEqual(right.keyframes.map((k) => k.t).sort((a, b) => a - b), [1, 6], 'trim pins keys in time');
});

test('audio: the render volume expression is linear in project time', () => {
  const el = {
    type: 'audio', volume: 1,
    keyframes: [
      { t: 2, path: 'audio.volume', value: 0.2 },
      { t: 4, path: 'audio.volume', value: 1 },
    ],
  };
  const expr = audioGainExpression(el, 0);
  assert.match(expr, /^if\(lt\(/);
  assert.match(expr, /0\.200000/);
  assert.match(expr, /1\.000000/);
});
