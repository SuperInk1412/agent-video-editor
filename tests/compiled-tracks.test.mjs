import test from 'node:test';
import assert from 'node:assert/strict';
import { evalElement } from '../core/evaluate.js';
import { sampleChannel, sampleVec3, sampleDir } from '../core/scene.js';
import { compileTrack, compileProject, clearCompiledTracks } from '../core/tracks.js';
import { createProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';

test('compiled element/channel indices preserve exact boundary and interpolation values', () => {
  const element = { start: 0, duration: 5, keyframes: [
    { t: 4, path: 'transform.x', value: 8 }, { t: 0, path: 'transform.x', value: 0, ease: 'outExpo' },
    { t: 2, path: 'transform.x', value: 4 }, { t: 0, path: 'style.text', value: 'a' }, { t: 2, path: 'style.text', value: 'b' },
  ] };
  const times = [-1, 0, 0.01, 0.5, 1, 1.99, 2, 2.01, 3, 4, 5];
  clearCompiledTracks();
  const expected = times.map((time) => evalElement(element, time, {}));
  compileTrack(element.keyframes, 'element');
  assert.deepEqual(times.map((time) => evalElement(element, time, {})), expected);
  for (const sample of [sampleChannel, sampleVec3, sampleDir]) {
    const keys = sample === sampleChannel ? [{ t: 2, v: 20 }, { t: 0, v: 0 }, { t: 1, v: 5 }]
      : [{ t: 2, v: [1, 2, 3] }, { t: 0, v: [0, 0, -1] }, { t: 1, v: [1, 0, 0] }];
    const before = times.map((time) => sample(keys, time));
    compileTrack(keys);
    assert.deepEqual(times.map((time) => sample(keys, time)), before);
  }
});

test('editing invalidates compiled snapshots before mutable paths are changed', () => {
  const project = createProject();
  applyOp(project, { op: 'addElement', element: { type: 'solid', duration: 5,
    keyframes: [{ t: 0, path: 'transform.x', value: 0, ease: 'linear' }, { t: 4, path: 'transform.x', value: 4 }] } });
  compileProject(project);
  applyOp(project, { op: 'set', id: 'el_1', path: 'keyframes.1.t', value: 2 });
  assert.equal(evalElement(project.elements[0], 1).x, 2);
});
