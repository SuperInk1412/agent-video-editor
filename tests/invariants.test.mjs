import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { applyOp, applyOps, setPath, getPath } from '../core/ops.js';
import { evalElement } from '../core/evaluate.js';
import { saveProject, loadProject, mutateProject } from '../engine/storage.js';

test('created element retains source timing, fades and beat response after storage', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-fields-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const p = createProject();
  applyOp(p, { op: 'setMeta', path: 'beats', value: [1] });
  const input = { type: 'video', src: 'media/a.mp4', start: 1, duration: 4, srcIn: 2, fadeIn: 0.5, fadeOut: 1, punch: 1 };
  applyOp(p, { op: 'addElement', element: input });
  assert.equal(input.id, undefined, 'the operation input is not mutated');
  await saveProject(dir, p);
  const saved = await loadProject(dir);
  const el = saved.elements[0];
  assert.deepEqual([el.srcIn, el.fadeIn, el.fadeOut, el.punch], [2, 0.5, 1, 1]);
  assert.equal(evalElement(el, 1.25, saved.meta).opacity, 0.5);
  assert.equal(evalElement(el, 4.5, saved.meta).opacity, 0.5);
  assert.equal(evalElement(el, 1, saved.meta).scale, 1.05);
  await mutateProject(dir, (project) => applyOp(project, { op: 'splitElement', id: el.id, at: 3 }));
  assert.equal((await loadProject(dir)).elements.find((item) => item.start === 3).srcIn, 4);
});

test('property writes and recursive patches cannot reach object prototypes', () => {
  const p = createProject();
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', duration: 1 } });
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => setPath({}, `${key}.vdmPolluted`, true), { code: 'OP_INVALID' });
    assert.throws(() => applyOp(p, { op: 'setMeta', path: `${key}.vdmPolluted`, value: true }), { code: 'OP_INVALID' });
    const patch = JSON.parse(`{"style":{"${key}":{"vdmPolluted":true}}}`);
    assert.throws(() => applyOp(p, { op: 'updateElement', id: element.id, patch }), { code: 'OP_INVALID' });
  }
  assert.equal(({}).vdmPolluted, undefined);
  assert.equal(getPath({}, 'toString'), undefined);
  assert.throws(() => setPath({}, 'a..b', 1), { code: 'OP_INVALID' });
  assert.throws(() => setPath({ a: 1 }, 'a.b', 1), { code: 'OP_INVALID' });
  assert.throws(() => setPath({}, 'items.100000', 1), { code: 'OP_INVALID' });
  assert.throws(() => applyOp(p, { op: 'set', id: element.id, path: 'id', value: 'new' }), /immutable/);
});

test('default filling does not turn invalid element values into valid edits', () => {
  const p = createProject();
  p.elements = [{ id: 'invalid', type: 'unknown', start: 0, duration: 0, keyframes: 'invalid' }];
  normalizeProject(p);
  assert.equal(p.elements[0].type, 'unknown');
  assert.equal(p.elements[0].duration, 0);
  for (const field of ['type', 'duration', 'keyframes']) assert.ok(validateProject(p).some((issue) => issue.path === `elements[0].${field}`));
});

test('unsafe input anywhere in a batch is rejected before any operation is applied', () => {
  const p = createProject();
  const before = JSON.stringify(p);
  const bad = JSON.parse('{"op":"worldSet","patch":{"__proto__":{"vdmPolluted":true}}}');
  assert.throws(() => applyOps(p, [{ op: 'setMeta', path: 'title', value: 'changed' }, { op: 'batch', ops: [bad] }]), { code: 'OP_INVALID' });
  assert.equal(JSON.stringify(p), before);
});

test('validation reports malformed arrays, unsupported versions and invalid scene objects', () => {
  const p = createProject();
  p.schema = 'vdm.project/999';
  p.elements = 'invalid';
  p.segments = [null];
  p.scene = { version: 3, units: 'm', objects: [
    { id: 'o', type: 'solid', start: 0, duration: -1 },
    { id: 'o', type: 'unknown', start: 0, duration: 1 },
  ] };
  const issues = validateProject(p);
  for (const expected of ['schema', 'elements', 'segments[0]', 'scene.objects[0].duration', 'scene.objects[1].id', 'scene.objects[1].type']) {
    assert.ok(issues.some((issue) => issue.path === expected), expected);
  }
  assert.ok(validateProject({ ...createProject(), meta: { ...p.meta, fps: Infinity } }).length);
});
