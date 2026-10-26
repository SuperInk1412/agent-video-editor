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
import { evalElement } from '../core/evaluate.js';
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
  assert.ok(evalElement(saved.elements[0], 1, saved.meta).x < 50);
  const repeated = await (await post('api/ops', { expectedRev: 2, requestId: 'curve-clear', ops: [
    { op: 'keyCurve', host: 'element', id: 'el_1', path: 'transform.x', from: 0, to: 2, curve: null },
  ] })).json();
  assert.equal(repeated.rev, 3);
  assert.equal(evalElement(repeated.project.elements[0], 1, repeated.project.meta).x, 50);
});
