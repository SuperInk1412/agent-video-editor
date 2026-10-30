import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { createProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { saveProject, loadProject } from '../engine/storage.js';
import { startServer } from '../engine/server.js';
import { elementLocalNode } from '../core/spatial-parent.js';
import { presetCurve } from '../core/curves.js';

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-http-'));
  const p = createProject();
  applyOp(p, { op: 'addElement', element: { id: 'el_1', type: 'solid', duration: 2 } });
  await saveProject(root, p);
  await fs.mkdir(path.join(root, 'media'));
  const service = await startServer({ root, port: 0, ...options });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const post = (route, body) => fetch(service.info.url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { root, service, post };
}

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

test('HTTP blocks sibling traversal, symlinks, foreign origins and malformed URL encoding', async (t) => {
  const { root, service } = await setup(t);
  await fs.mkdir(path.join(root, 'media-private'));
  await fs.writeFile(path.join(root, 'media-private', 'secret.txt'), 'private');
  await fs.writeFile(path.join(root, 'media', 'ok.txt'), 'public');
  const get = (route, options) => fetch(service.info.url + route, options);
  assert.equal((await get('media/..%2fmedia-private/secret.txt')).status, 403);
  assert.equal((await get('media/%')).status, 400);
  assert.equal((await get('api/context', { headers: { origin: 'https://outside.example' } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    http.get(service.info.url + 'api/context', { headers: { host: 'outside.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(foreignHost, 403);
  try {
    await fs.symlink(path.join(root, 'media-private', 'secret.txt'), path.join(root, 'media', 'link.txt'));
    assert.equal((await get('media/link.txt')).status, 403);
  } catch (e) { if (e.code !== 'EPERM') throw e; }
  assert.equal(await (await get('media/ok.txt')).text(), 'public');
  assert.equal((await get('api/context')).status, 200, 'the service remains available');
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

test('media range requests reject malformed bounds and support suffix ranges', async (t) => {
  const { root, service } = await setup(t);
  await fs.writeFile(path.join(root, 'media', 'sample.bin'), '0123456789');
  const get = (range) => fetch(service.info.url + 'media/sample.bin', { headers: { range } });
  for (const range of ['bytes=8-2', 'bytes=50-', 'bytes=-0', 'bytes=abc', 'bytes=0-1,4-5']) assert.equal((await get(range)).status, 416, range);
  const suffix = await get('bytes=-3');
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get('content-range'), 'bytes 7-9/10');
  assert.equal(await suffix.text(), '789');
});

test('request shapes and imports outside configured roots fail without changing media', async (t) => {
  const { root, post, service } = await setup(t);
  assert.equal((await post('api/ops', null)).status, 400);
  assert.equal((await post('api/import', { files: [path.join(os.tmpdir(), 'not-authorized.txt')] })).status, 403);
  assert.deepEqual(await fs.readdir(path.join(root, 'media')), []);
  assert.equal((await fetch(service.info.url + 'api/probe?src=' + encodeURIComponent('../outside.txt'))).status, 403);
});

test('uploads are bounded and concurrent equal filenames never overwrite each other', async (t) => {
  const { root, service } = await setup(t, { uploadLimit: 8 });
  const upload = (body) => fetch(service.info.url + 'api/upload?name=sample.txt', { method: 'POST', body });
  assert.equal((await upload('too large')).status, 413);
  assert.deepEqual(await fs.readdir(path.join(root, 'media')), []);
  const responses = await Promise.all(['first', 'second'].map(upload));
  const names = await Promise.all(responses.map(async (res) => {
    assert.equal(res.status, 200);
    return (await res.json()).imported[0].name;
  }));
  assert.notEqual(names[0], names[1]);
  assert.deepEqual(await Promise.all(names.map((name) => fs.readFile(path.join(root, 'media', name), 'utf8'))), ['first', 'second']);
  assert.equal((await fs.readdir(path.join(root, 'media'))).some((name) => name.startsWith('.upload-')), false);
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

test('change sets over HTTP: propose, shadow preview, apply, list, show, revert', async (t) => {
  const { root, service, post } = await setup(t);
  const get = async (route) => {
    const response = await fetch(service.info.url + route);
    return { status: response.status, body: await response.json() };
  };
  const file = path.join(root, 'project.vdm.json');
  const before = await fs.readFile(file, 'utf8');
  const beforeRev = (await get('api/project')).body.project.rev;
  const ops = [{ op: 'set', id: 'el_1', path: 'start', value: 0.5 }];

  // A preview is a shadow project: same revision, nothing on disk.
  const preview = await post('api/changesets', { action: 'preview', includeProject: true, ops });
  assert.equal(preview.status, 200);
  const shadow = await preview.json();
  assert.equal(shadow.equal, false);
  assert.equal(shadow.project.rev, beforeRev);
  assert.equal(shadow.project.elements.find((el) => el.id === 'el_1').start, 0.5);
  assert.equal(await fs.readFile(file, 'utf8'), before, 'a preview never writes');

  // Propose keeps the record; applying it is one transaction (one undo step).
  const proposed = await (await post('api/changesets', { action: 'propose', intent: 'http test', ops })).json();
  assert.equal(proposed.changeset.status, 'proposed');
  const byId = await post('api/changesets', { action: 'preview', id: proposed.changeset.id, includeProject: true });
  assert.equal(byId.status, 200);
  assert.equal((await byId.json()).project.elements.find((el) => el.id === 'el_1').start, 0.5);

  const applied = await post('api/changesets', { action: 'apply', id: proposed.changeset.id });
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()));
  const record = (await applied.json()).changeset;
  assert.equal(record.status, 'applied');
  assert.equal(record.rev, beforeRev + 1);
  assert.ok(record.changed.some((entry) => entry.id === 'el_1'), 'the diff names the host');

  const listed = await get('api/changesets');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.changesets.some((entry) => entry.id === record.id));
  const shown = await get(`api/changesets/${record.id}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.body.changeset.status, 'applied');

  const reverted = await post('api/changesets', { action: 'revert', id: record.id });
  assert.equal(reverted.status, 200);
  assert.equal((await reverted.json()).changeset.status, 'reverted');
  const current = (await get('api/project')).body.project;
  assert.equal(current.elements.find((el) => el.id === 'el_1').start, 0);
  assert.equal(current.rev, beforeRev + 2);

  const missing = await get('api/changesets/cs_missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'CHANGESET_NOT_FOUND');
});

test('measure over HTTP answers the report tool and rejects unknown kinds', async (t) => {
  const { post } = await setup(t);
  const edges = await post('api/measure', { kind: 'cutEdges' });
  assert.equal(edges.status, 200);
  const edgeBody = await edges.json();
  assert.equal(edgeBody.kind, 'cutEdges');
  assert.ok(Array.isArray(edgeBody.result.edges));

  const stack = await post('api/measure', { kind: 'stackAt', t: 0.5 });
  assert.equal(stack.status, 200);
  const stackBody = (await stack.json()).result;
  assert.ok(Array.isArray(stackBody.order), 'far -> near rows');
  assert.equal(stackBody.items, stackBody.order.length);

  const px = await post('api/measure', { kind: 'pxAt', x: 320, y: 180, frame: 12 });
  assert.equal(px.status, 200);
  assert.equal((await px.json()).result.readPixels, false);

  const bad = await post('api/measure', { kind: 'nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'INVALID_ARGUMENT');
});

test('the approve route is honest while no agent loop is running', async (t) => {
  const { post } = await setup(t);
  const response = await post('api/agent/approve', { planId: 'plan_1' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'NO_PENDING_PLAN');
});

test('the change set list is summaries by default and full records with detail=1', async (t) => {
  const { service, post } = await setup(t);
  const get = async (route) => {
    const response = await fetch(service.info.url + route);
    return { status: response.status, body: await response.json() };
  };
  const proposed = await (await post('api/changesets', { action: 'propose', intent: 'detail', ops: [{ op: 'set', id: 'el_1', path: 'start', value: 0.5 }] })).json();
  const id = proposed.changeset.id;

  const summaries = await get('api/changesets?status=proposed');
  const summary = summaries.body.changesets.find((record) => record.id === id);
  assert.equal(summary.changed, undefined, 'a summary carries counts, not the diff');
  assert.equal(summary.counts.changed, 1);

  const full = await get('api/changesets?status=proposed&detail=1');
  const record = full.body.changesets.find((entry) => entry.id === id);
  assert.ok(Array.isArray(record.changed));
  assert.ok(record.changed.some((entry) => entry.path === 'start'), 'the full record names the property');
  assert.equal(record.opsCount, 1);
});
