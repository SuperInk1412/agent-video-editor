// HTTP: the project lifecycle and the one write path.
//
//   POST /api/projects/create, /api/projects/delete, GET /api/projects
//   POST /api/ops, GET/POST /api/project, GET /api/history, /api/undo, /api/redo
//
// These are the tests that prove "HTTP and CLI share one application contract":
// same validation, same CAS, same history.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProject } from '../engine/storage.js';
import { elementLocalNode } from '../core/spatial-parent.js';
import { presetCurve } from '../core/curves.js';
import { setup } from './helpers/http.mjs';

test('creating a project over HTTP starts from unified space', async (t) => {
  const { root, post } = await setup(t);
  const dir = path.join(root, 'created');
  const response = await post('api/projects/create', {
    dir, title: 'created', width: 640, height: 360, duration: 3,
  });
  assert.equal(response.status, 200);
  const created = (await response.json()).project;
  assert.equal(created.meta.title, 'created');
  assert.equal(created.cameras.length, 1);
  assert.equal(created.world.source, 'none');
  assert.equal(created.camera.id, created.cameras[0].id);
  assert.equal((await loadProject(dir)).cameras.length, 1, 'the file on disk is already 3D');
});

test('audio elements (including loop) pass the shared HTTP op contract', async (t) => {
  const { post } = await setup(t);
  const response = await post('api/ops', { ops: [{
    op: 'addElement',
    element: { type: 'audio', src: 'media/song.m4a', start: 0, duration: 2, loop: true, volume: 0.5 },
  }] });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const project = (await response.json()).project;
  const audio = project.elements.find((el) => el.type === 'audio');
  assert.equal(audio.loop, true);
  assert.equal(audio.duration, 2);
});

test('HTTP and CLI reject the same invalid edit and leave the project unchanged', async (t) => {
  const { root, post } = await setup(t);
  const before = await fs.readFile(path.join(root, 'project.vdm.json'), 'utf8');
  const ops = [{ op: 'updateElement', id: 'el_1', patch: { type: 'invalid', duration: 0 } }];
  const response = await post('api/ops', { ops });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'OP_INVALID');
  await assert.rejects(promisify(execFile)(process.execPath, ['cli/vdm.js', 'ops', JSON.stringify(ops), '--project', root, '--json']), /invalid project/);
  assert.equal(await fs.readFile(path.join(root, 'project.vdm.json'), 'utf8'), before);
  const replacement = await loadProject(root);
  replacement.elements[0].duration = 0;
  assert.equal((await post('api/project', { project: replacement })).status, 400);
  assert.equal(await fs.readFile(path.join(root, 'project.vdm.json'), 'utf8'), before);
});

test('failed batches do not save earlier edits or pollute the server process', async (t) => {
  const { root, post } = await setup(t);
  const before = await loadProject(root);
  const response = await post('api/ops', { ops: [
    { op: 'setMeta', path: 'title', value: 'should not save' },
    { op: 'setMeta', path: '__proto__.vdmPolluted', value: true },
  ] });
  assert.equal(response.status, 400);
  assert.deepEqual(await loadProject(root), before);
  assert.equal(({}).vdmPolluted, undefined);
});

test('HTTP CAS, dry-run, request receipts and CLI history share one application contract', async (t) => {
  const { root, post } = await setup(t);
  const input = { expectedRev: 1, requestId: 'http-create', ops: [{ op: 'addElement', element: { type: 'text', duration: 2, style: { text: 'new' } } }] };
  const preview = await (await post('api/ops', { ...input, dryRun: true })).json();
  assert.equal(preview.rev, 1);
  const first = await (await post('api/ops', input)).json();
  const repeated = await (await post('api/ops', input)).json();
  assert.equal(repeated.replayed, true);
  assert.deepEqual(first.opResults, repeated.opResults);
  const conflict = await post('api/ops', { ...input, requestId: 'different' });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).currentRev, 2);
  const { stdout } = await promisify(execFile)(process.execPath, ['cli/vdm.js', 'undo', '--project', root, '--expected-rev', '2', '--json']);
  assert.equal(JSON.parse(stdout).rev, 3);
  assert.equal((await loadProject(root)).elements.length, 1);
});

test('the upstream curve editor can submit keyCurve through the shared HTTP transaction', async (t) => {
  const { root, post } = await setup(t);
  const response = await post('api/ops', { expectedRev: 1, requestId: 'curve-editor', ops: [
    { op: 'keySet', id: 'el_1', path: 'transform.x', t: 0, value: 0, ease: 'linear' },
    { op: 'keySet', id: 'el_1', path: 'transform.x', t: 2, value: 100 },
    { op: 'keyCurve', host: 'element', id: 'el_1', path: 'transform.x', from: 0, to: 2, curve: presetCurve('easeIn') },
  ] });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const saved = await loadProject(root);
  // transform.x keys land on the node's pivot.x (1 m = 100 px)
  const pivotX = (pr) => elementLocalNode(pr, pr.elements[0], 1).pivot[0];
  assert.ok(pivotX(saved) < 0.5);
  const repeated = await (await post('api/ops', { expectedRev: 2, requestId: 'curve-clear', ops: [
    { op: 'keyCurve', host: 'element', id: 'el_1', path: 'transform.x', from: 0, to: 2, curve: null },
  ] })).json();
  assert.equal(repeated.rev, 3);
  assert.ok(Math.abs(pivotX(repeated.project) - 0.5) < 1e-9);
});

test('audio, timeline cuts and parenting round-trip through HTTP, history and persisted projects', async (t) => {
  const { post } = await setup(t);
  const send = async (ops) => {
    const response = await post('api/ops', { ops });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const created = await send([
    { op: 'addElement', element: { id: 'sound', type: 'audio', src: 'media/song.m4a', duration: 4, volume: 0.8 } },
    { op: 'objectAdd', object: { id: 'parent', type: 'solid', duration: 4 } },
    { op: 'objectAdd', object: { id: 'child', type: 'solid', duration: 4 } },
  ]);
  assert.equal(created.project.elements.find((el) => el.id === 'sound').volume, 0.8);
  const bound = await send([
    { op: 'objectParent', id: 'child', parent: 'parent', t: 0, inherit: { pos: true, rot: true }, strength: { rot: 0.7 } },
    { op: 'objectParentKey', id: 'child', channel: 'rot', t: 1, v: 0.5 },
  ]);
  // objectParent writes the unified spatial parent (docs/DESIGN-CAMFEED-PARENTS.md §3)
  assert.equal(bound.project.scene.objects.find((obj) => obj.id === 'child').frameParent.id, 'parent');
  const unbound = await send([
    { op: 'objectParentUnkey', id: 'child', channel: 'rot', t: 1 },
    { op: 'objectUnparent', id: 'child', t: 1 },
  ]);
  assert.equal(unbound.project.scene.objects.find((obj) => obj.id === 'child').frameParent, undefined);
  const cut = await send([{ op: 'splitAt', at: 2, ids: ['sound'] }]);
  assert.equal(cut.project.elements.filter((el) => el.type === 'audio').length, 2);
  assert.equal(cut.project.elements.find((el) => el.type === 'audio' && el.start === 2).srcIn, 2);
  const restored = await (await post('api/undo', { expectedRev: cut.rev })).json();
  assert.equal(restored.project.elements.filter((el) => el.type === 'audio').length, 1);
});
