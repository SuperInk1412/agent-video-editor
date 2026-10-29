// GET /api/raster — the door the preview uses to reach the single rasteriser
// (docs/DESIGN-BACKEND-V2.md §5 / §6.1, WP3.3).
//
//   GET /api/raster?source=<id>&frame=<n>&w=<px>&h=<px>&params=<json>&seed=<n>
//                                  [&mode=live|bake]   ->  image/png, no-store
//
// Plain Node group: request validation, the pool's error codes mapped to HTTP
// statuses, and `mode=bake` reading `.vdm/cache/raster/` without ever starting
// the render pool (a bake layer must not render on demand, §6.1).
// Electron group (skipped with a reason when no Electron is installed): a live
// frame really comes back as a PNG and the same frame twice is byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';
import { startServer } from '../engine/server.js';
import {
  cacheKey, entryDir, frameFileName, readManifest, resolveParams, runtimeKey, sha256,
  sourceSnapshot, META_FILE,
} from '../engine/render-workers/cache.js';
import { createRenderPool, findElectron } from '../engine/render-workers/pool.js';

const REPO = path.resolve(import.meta.dirname, '..');
const MANIFEST = {
  runtime: 'canvas2d',
  entry: 'sketch.js',
  deterministic: true,
  params: [
    { id: 'density', type: 'number', default: 0.5 },
    { id: 'tint', type: 'color', default: '#ff00ff' },
  ],
};
const SOURCE = 'export function draw(ctx, vdm) {\n  ctx.fillStyle = vdm.param(\'tint\');\n  ctx.fillRect(0, 0, vdm.size[0] * (0.2 + vdm.param(\'density\')), vdm.size[1]);\n}\n';

/** A project with one code element and the matching `sources/<id>/` on disk. */
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-raster-'));
  const p = normalizeProject(createProject({ title: 'raster', duration: 2, width: 320, height: 180 }));
  applyOp(p, { op: 'sourceAdd', id: 'src_a', manifest: MANIFEST, files: { 'sketch.js': SOURCE } });
  applyOp(p, {
    op: 'addElement',
    element: { id: 'el_code', type: 'code', start: 0, duration: 2, z: 1, code: { source: 'src_a', seed: 7, size: [160, 90] } },
  });
  await saveProject(root, p);
  const dir = path.join(root, 'sources', 'src_a');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify({ ...MANIFEST, id: 'src_a' }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'sketch.js'), SOURCE);
  const service = await startServer({ root, port: 0 });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const raster = (query) => fetch(`${service.info.url}api/raster?${new URLSearchParams(query)}`);
  return { root, service, raster };
}

test('raster route: bad arguments are 400s with the shared error shape', async (t) => {
  const { raster } = await setup(t);
  const cases = [
    [{ frame: '0' }, 'source 必须是源 id（[A-Za-z0-9][A-Za-z0-9_-]{0,63}）'],
    [{ source: '../etc', frame: '0' }, 'source 必须是源 id（[A-Za-z0-9][A-Za-z0-9_-]{0,63}）'],
    [{ source: 'src_a', frame: '-1' }, 'frame 必须是非负整数'],
    [{ source: 'src_a', frame: '1.5' }, 'frame 必须是非负整数'],
    [{ source: 'src_a', frame: '0', w: '0' }, 'w / h 必须是 1..8192 的整数'],
    [{ source: 'src_a', frame: '0', h: '9000' }, 'w / h 必须是 1..8192 的整数'],
    [{ source: 'src_a', frame: '0', params: '{bad' }, 'params 必须是 URL 编码的 JSON 对象'],
    [{ source: 'src_a', frame: '0', params: '[1,2]' }, 'params 必须是 JSON 对象'],
    [{ source: 'src_a', frame: '0', seed: 'nope' }, 'seed 必须是数字'],
  ];
  for (const [query, message] of cases) {
    const response = await raster(query);
    assert.equal(response.status, 400, JSON.stringify(query));
    const body = await response.json();
    assert.equal(body.code, 'INVALID_ARGUMENT', JSON.stringify(query));
    assert.equal(body.error, message, JSON.stringify(query));
  }
  // the service is still healthy after a batch of bad requests
  assert.equal((await fetch(`${(await raster({ source: 'src_a', frame: '0' })).url.replace(/\/api\/raster.*/, '')}/api/state`)).status, 200);
});

test('raster route: an unknown source is a 404 before the pool is ever started', async (t) => {
  const { raster } = await setup(t);
  const response = await raster({ source: 'src_missing', frame: '0' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'SOURCE_NOT_FOUND');
});

test('raster route: mode=bake only reads the cache and never renders', async (t) => {
  const { root, raster } = await setup(t);
  // nothing cached yet -> 404, and no render pool was started (a bake layer
  // must not render on demand; only `.vdm/cache/raster/` is read)
  const miss = await raster({ source: 'src_a', frame: '3', w: '160', h: '90', params: '{"density":0.5,"tint":"#ff00ff"}', seed: '7', mode: 'bake' });
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).code, 'RASTER_NOT_CACHED');
  assert.equal(await fs.stat(path.join(root, '.vdm', 'cache', 'raster')).then(() => true, () => false), false, 'a bake miss writes nothing');

  // Write the frame exactly where §5.5 says the pool puts it, then ask again.
  const dir = path.join(root, 'sources', 'src_a');
  const [read, snapshot, versions] = await Promise.all([
    readManifest(dir, 'src_a'), sourceSnapshot(dir), runtimeKey({ repoRoot: REPO }),
  ]);
  const params = resolveParams(read.manifest, { density: 0.5, tint: '#ff00ff' });
  const key = cacheKey({ snapshot, manifestRaw: read.raw, params, size: [160, 90], seed: 7, frame: 3, fps: 24, versions });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // not a real image: bytes on the wire are enough here
  const hash = sha256(png);
  const entry = entryDir(root, key);
  await fs.mkdir(entry, { recursive: true });
  await fs.writeFile(path.join(entry, frameFileName(3)), png);
  await fs.writeFile(path.join(entry, META_FILE), JSON.stringify({ key, frame: 3, hash, bytes: png.length }));

  const hit = await raster({ source: 'src_a', frame: '3', w: '160', h: '90', params: '{"density":0.5,"tint":"#ff00ff"}', seed: '7', mode: 'bake' });
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('content-type'), 'image/png');
  assert.equal(hit.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await hit.arrayBuffer()), png);

  // a different frame number is a different cache key: still a miss
  const other = await raster({ source: 'src_a', frame: '4', w: '160', h: '90', params: '{"density":0.5,"tint":"#ff00ff"}', seed: '7', mode: 'bake' });
  assert.equal(other.status, 404);
});

// ------------------------------------------------------------------- Electron

const electronSkip = findElectron() ? false : 'no Electron on this machine';

test('raster route: a live frame comes back as a PNG and repeats byte-identically', { skip: electronSkip }, async (t) => {
  const { raster } = await setup(t);
  const query = { source: 'src_a', frame: '2', w: '160', h: '90', params: '{"density":0.5,"tint":"#ff00ff"}', seed: '7' };
  const first = await raster(query);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const png = Buffer.from(await first.arrayBuffer());
  assert.ok(png.length > 8 && png.subarray(1, 4).toString() === 'PNG', 'a real PNG signature');
  const second = await raster(query);
  assert.equal(second.status, 200);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), png, 'the pool cache answers the repeat');

  // the raster really is a pure function of (source, params, frame, size, seed)
  const params = await raster({ ...query, params: '{"density":0.9,"tint":"#ff00ff"}' });
  assert.equal(params.status, 200);
  assert.notDeepEqual(Buffer.from(await params.arrayBuffer()), png, 'a different parameter value is a different picture');
});

test('raster route: a broken source is a coded 4xx/5xx with a JSON body, not a crash', { skip: electronSkip }, async (t) => {
  const { root, raster } = await setup(t);
  await fs.writeFile(path.join(root, 'sources', 'src_a', 'manifest.json'), '{ not json');
  const response = await raster({ source: 'src_a', frame: '0', w: '160', h: '90' });
  assert.equal(response.status, 422, 'the pool calls an unreadable manifest SOURCE_INVALID');
  const body = await response.json();
  assert.equal(body.code, 'SOURCE_INVALID');
  assert.equal(typeof body.error, 'string');
  // and the service keeps working afterwards
  assert.equal((await fetch(new URL('/api/state', response.url))).status, 200);
});

// A stale pool from another test would keep an Electron host alive; make sure
// the module-level helper used by the route is what the tests exercised.
test('raster route: the pool helper builds lazy pools (no process before the first render)', async () => {
  const pool = createRenderPool({ root: os.tmpdir() });
  assert.equal(pool.child, null);
  assert.equal(pool.socket, null);
  await pool.close();
});
