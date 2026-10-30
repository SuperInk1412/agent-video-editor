// HTTP: media, uploads, the path guard and static file ranges.
//
//   POST /api/import, /api/upload, GET /api/media, /api/probe
//   GET /media/*, /frames/*, /renders/*, /assets/*, /app/*, /core/*
//
// Everything here is about what the server may read from disk and who may ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { setup } from './helpers/http.mjs';

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
