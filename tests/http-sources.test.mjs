// HTTP: compiled sources (WP4.1, §7.1 / §7.8).
//
//   GET  /api/sources                 registry + compile status
//   GET  /api/sources/<id>/base       base.json (404 when missing / broken)
//   POST /api/sources/<id>/compile    compile + write base.json, change nothing
//   POST /api/sources/<id>/apply      upsert the compiled elements, one transaction
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { setup, getter } from './helpers/http.mjs';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'sources', 'html-title-card');

async function fixture() {
  const names = await fs.readdir(FIXTURE);
  const files = {};
  let manifest = null;
  for (const name of names) {
    const text = await fs.readFile(path.join(FIXTURE, name), 'utf8');
    if (name === 'manifest.json') manifest = JSON.parse(text);
    else files[name] = text;
  }
  return { manifest, files };
}

/** Register the fixture through the normal op endpoint. */
async function registerSource(post) {
  const { manifest, files } = await fixture();
  const response = await post('api/ops', { ops: [{ op: 'sourceAdd', id: 'html-title-card', manifest, files }] });
  assert.equal(response.status, 200);
  return response;
}

test('sources over HTTP: the four routes', async (t) => {
  const { root, service, post } = await setup(t);
  const get = getter(service);

  // Empty registry first.
  const empty = await get('api/sources');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.sources, []);

  await registerSource(post);

  const listed = await get('api/sources');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sources.length, 1);
  const entry = listed.body.sources[0];
  assert.equal(entry.id, 'html-title-card');
  assert.equal(entry.runtime, 'html');
  assert.equal(entry.entry, 'index.html');
  assert.equal(entry.compilable, true);
  assert.equal(entry.compiled, null);
  assert.ok(entry.files.includes('style.css'));

  // base.json before the first compile.
  const missing = await get('api/sources/html-title-card/base');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);
  assert.deepEqual(missing.body.problems, ['not compiled']);

  // Compile writes the snapshot and changes no project state.
  const before = await getter(service)('api/project');
  const compiled = await post('api/sources/html-title-card/compile', {});
  assert.equal(compiled.status, 200);
  const compiledBody = await compiled.json();
  assert.equal(compiledBody.ok, true);
  assert.match(compiledBody.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(compiledBody.source, 'html-title-card');
  assert.equal(compiledBody.runtime, 'html');
  assert.equal(compiledBody.base, '.vdm/sources/html-title-card/base.json');
  assert.equal(compiledBody.nodes.length, 4);
  assert.ok(compiledBody.elements.length > compiledBody.nodes.length, 'background elements come with the compile');
  assert.ok(Array.isArray(compiledBody.warnings));
  const afterCompile = await getter(service)('api/project');
  assert.equal(afterCompile.body.project.rev, before.body.project.rev, 'compile is not a project write');
  await fs.stat(path.join(root, '.vdm', 'sources', 'html-title-card', 'base.json'));

  const base = await get('api/sources/html-title-card/base');
  assert.equal(base.status, 200);
  assert.equal(base.body.ok, true);
  assert.equal(base.body.snapshot.hash, compiledBody.hash);
  assert.deepEqual(base.body.snapshot.nodes.map((node) => node.id), ['n_kicker', 'n_rule', 'n_subtitle', 'n_title']);

  const listedAgain = await get('api/sources');
  assert.equal(listedAgain.body.sources[0].compiled.valid, true);
  assert.equal(listedAgain.body.sources[0].compiled.nodes, 4);

  // Apply = one transaction, the elements appear with el.source.
  const applied = await post('api/sources/html-title-card/apply', {});
  assert.equal(applied.status, 200);
  const appliedBody = await applied.json();
  assert.equal(appliedBody.ok, true);
  assert.equal(appliedBody.hash, compiledBody.hash);
  assert.equal(appliedBody.transaction.rev, before.body.project.rev + 1);
  const bound = appliedBody.project.elements.filter((element) => element.source?.id === 'html-title-card');
  assert.equal(bound.length, 4);
  assert.ok(bound.every((element) => typeof element.source.node === 'string'));
  // The engine re-reads the project from disk, where the app-wide rotation
  // migration has already turned the legacy transform into a spatial node (the
  // same conversion `createAsNode` in core/rotation-ops.js does).
  assert.ok(bound.every((element) => element.node === undefined || Array.isArray(element.node.pivot)));

  // The engine adopted the project: reads see the same elements.
  const current = await get('api/project');
  assert.equal(current.body.project.elements.filter((element) => element.source?.id === 'html-title-card').length, 4);
  const history = await get('api/history');
  assert.equal(history.status, 200);

  // Re-applying is stable (no duplicates).
  const again = await post('api/sources/html-title-card/apply', {});
  assert.equal(again.status, 200);
  const againBody = await again.json();
  assert.equal(againBody.project.elements.filter((element) => element.source?.id === 'html-title-card').length, 4);

  // Error shapes.
  const unknown = await post('api/sources/does-not-exist/compile', {});
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'SOURCE_NOT_FOUND');
  const wrongMethod = await post('api/sources/html-title-card/base', {});
  assert.equal(wrongMethod.status, 405);
  const wrongGet = await get('api/sources/html-title-card/compile');
  assert.equal(wrongGet.status, 405);
  const unsafe = await get('api/sources/bad%20id/base');
  assert.equal(unsafe.status, 404);
});

test('sources over HTTP: a code runtime is refused as a compile source', async (t) => {
  const { post, service } = await setup(t);
  const get = getter(service);
  const registered = await post('api/ops', {
    ops: [{ op: 'sourceAdd', id: 'p5_test', manifest: { runtime: 'p5', entry: 'sketch.js' }, files: { 'sketch.js': 'export default () => {};\n' } }],
  });
  assert.equal(registered.status, 200);
  const compiled = await post('api/sources/p5_test/compile', {});
  assert.equal(compiled.status, 400);
  const body = await compiled.json();
  assert.equal(body.code, 'INVALID_ARGUMENT');
  assert.match(body.error, /runtime/);
  // The registry still lists it, marked as not compilable.
  const listed = await get('api/sources');
  assert.equal(listed.body.sources.find((entry) => entry.id === 'p5_test').compilable, false);
});
