// RenderWorkerPool (docs/DESIGN-BACKEND-V2.md §5, WP3.1).
//
// Two groups:
//   * plain Node — everything that must work with no Electron installed:
//     error codes, the cache key, manifest parameter resolution, the path
//     policy. These always run.
//   * Electron — the contract that needs a real Chromium: the same input must
//     rasterise to the same hash, the sandbox must not reach Node / the network,
//     a runaway frame must be killed, and a frame range must reuse the cache.
//     Skipped (with a reason) when this machine has no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  RenderWorkerPool, createRenderPool, findElectron, cacheKey, resolveParams,
} from '../engine/render-workers/pool.js';
import { ERROR_CODES } from '../engine/render-workers/errors.js';

const REPO = path.resolve(import.meta.dirname, '..');

async function tmpProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vdm-rw-'));
}

const SOURCE_SOLID = `
export function draw(ctx, vdm) {
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, vdm.size[0], vdm.size[1]);
}
`;

/** A sketch whose picture depends on the frame number, so hashes can differ. */
const SOURCE_FRAME = `
export function draw(ctx, vdm) {
  const g = (vdm.frame * 37) % 255;
  ctx.fillStyle = 'rgb(' + g + ',0,0)';
  ctx.fillRect(0, 0, vdm.size[0], vdm.size[1]);
}
`;

/** Logs what the page can see; the test reads pool.console. */
const SOURCE_PROBE = `
export function draw(ctx, vdm) {
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, vdm.size[0], vdm.size[1]);
  const seen = {
    process: typeof process,
    require: typeof require,
    module: typeof module,
    Buffer: typeof Buffer,
    fetch: typeof fetch,
    XMLHttpRequest: typeof XMLHttpRequest,
    WebSocket: typeof WebSocket,
    importScripts: typeof importScripts,
    frame: vdm.frame,
    param: vdm.param('density'),
    rnd: vdm.random(1),
  };
  // the host forwards error-level console entries only (host.js::onConsole)
  console.error('VDM_PROBE ' + JSON.stringify(seen));
}
`;

const SOURCE_HANG = `
export function draw(ctx, vdm) {
  const until = Date.now() + 60000;
  while (Date.now() < until) { /* burn the frame budget */ }
}
`;

async function writeSource(root, id, code, manifest = {}) {
  const dir = path.join(root, 'sources', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify({
    id, runtime: 'canvas2d', entry: 'sketch.js', deterministic: true, params: [],
    ...manifest,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'sketch.js'), code);
  return dir;
}

// ------------------------------------------------------------------ plain Node

test('render-workers: the Electron binary comes from VDM_ELECTRON first', async () => {
  const root = await tmpProject();
  // an existing executable named by the env var wins over everything else
  assert.equal(
    findElectron({ env: { VDM_ELECTRON: process.execPath }, repoRoot: root, pathLookup: false }),
    process.execPath,
  );
  // a path that does not exist is not silently used
  const missing = path.join(root, 'no-such-electron.exe');
  assert.notEqual(findElectron({ env: { VDM_ELECTRON: missing }, repoRoot: root, pathLookup: false }), missing);
  await fs.rm(root, { recursive: true, force: true });
});

test('render-workers: rendering without Electron rejects DEPENDENCY_MISSING', async () => {
  const root = await tmpProject();
  await writeSource(root, 'solid', SOURCE_SOLID);
  const pool = new RenderWorkerPool({
    root,
    env: {},
    electronPath: path.join(root, 'definitely-not-here', 'electron.exe'),
  });
  await assert.rejects(
    () => pool.render({ sourceId: 'solid', frame: 0, fps: 30, size: [64, 48], seed: 1 }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.DEPENDENCY_MISSING, `code was ${error.code}: ${error.message}`);
      assert.ok(typeof error.message === 'string' && error.message.length > 0);
      return true;
    },
  );
  await pool.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('render-workers: the cache key covers every input the picture depends on', async () => {
  const base = {
    snapshot: { files: [{ path: 'sketch.js', sha256: 'a'.repeat(64) }] },
    manifestRaw: '{"runtime":"canvas2d"}',
    params: { density: 0.5 },
    size: [640, 360],
    seed: 7,
    frame: 3,
    fps: 30,
    versions: { runtime: 'r1', vendor: 'v1' },
  };
  const key = cacheKey(base);
  assert.match(key, /^[0-9a-f]{8,}$/);
  // stable for the same input
  assert.equal(cacheKey({ ...base }), key);
  // and different for each of: source bytes, manifest, params, size, seed, frame, fps, versions
  const variants = [
    { snapshot: { files: [{ path: 'sketch.js', sha256: 'b'.repeat(64) }] } },
    { manifestRaw: '{"runtime":"canvas2d","params":[]}' },
    { params: { density: 0.6 } },
    { size: [640, 362] },
    { seed: 8 },
    { frame: 4 },
    { fps: 24 },
    { versions: { runtime: 'r2', vendor: 'v1' } },
  ];
  for (const change of variants) {
    assert.notEqual(cacheKey({ ...base, ...change }), key, `key did not change for ${Object.keys(change)}`);
  }
});

test('render-workers: manifest params fill defaults and unknown keys are dropped', () => {
  const manifest = {
    params: [
      { id: 'density', type: 'number', default: 0.4 },
      { id: 'color', type: 'color', default: '#9fd' },
    ],
  };
  assert.deepEqual(resolveParams(manifest, { density: 0.9, nope: 1 }), { density: 0.9, color: '#9fd' });
  assert.deepEqual(resolveParams(manifest, {}), { density: 0.4, color: '#9fd' });
  // a declared parameter with no value and no default is a contract violation,
  // not a silent undefined (§6.3: the manifest is the contract)
  assert.throws(
    () => resolveParams({ params: [{ id: 'speed', type: 'number' }] }, {}),
    (error) => error.code === ERROR_CODES.INVALID_ARGUMENT && /speed/.test(error.message),
  );
  assert.deepEqual(resolveParams({ params: [{ id: 'speed', type: 'number' }] }, { speed: 2 }), { speed: 2 });
  assert.deepEqual(resolveParams(null, { a: 1 }), {});
});

test('render-workers: a source id that escapes the project is refused', async () => {
  const root = await tmpProject();
  const pool = new RenderWorkerPool({ root, env: {}, electronPath: null });
  const codes = [ERROR_CODES.PATH_OUTSIDE_SCOPE, ERROR_CODES.SOURCE_INVALID, ERROR_CODES.SOURCE_NOT_FOUND, ERROR_CODES.INVALID_ARGUMENT];
  for (const sourceId of ['../outside', '..', 'a/../../b', '']) {
    await assert.rejects(
      () => pool.render({ sourceId, frame: 0, fps: 30, size: [32, 32], seed: 1 }),
      (error) => {
        assert.ok(codes.includes(error.code), `sourceId ${JSON.stringify(sourceId)} gave ${error.code}`);
        return true;
      },
    );
  }
  await pool.close();
  await fs.rm(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------- Electron

/** Find the `VDM_PROBE {json}` payload in the page console text. */
function readProbe(text) {
  const at = text.indexOf('VDM_PROBE ');
  if (at < 0) return null;
  const raw = text.slice(at + 'VDM_PROBE '.length).split(String.fromCharCode(10))[0];
  try { return JSON.parse(raw); } catch { return null; }
}

const electronPath = findElectron();
const electronSkip = electronPath ? false : 'no Electron on this machine';

test('render-workers: the same frame rasterises to the same hash', { skip: electronSkip }, async (t) => {
  const root = await tmpProject();
  await writeSource(root, 'solid', SOURCE_SOLID);
  await writeSource(root, 'framey', SOURCE_FRAME);
  const pool = await createRenderPool({ root, timeoutMs: 20000 });
  t.after(async () => { await pool.close(); await fs.rm(root, { recursive: true, force: true }); });

  const a = await pool.render({ sourceId: 'solid', frame: 5, fps: 30, size: [64, 48], seed: 3 });
  const b = await pool.render({ sourceId: 'solid', frame: 5, fps: 30, size: [64, 48], seed: 3 });
  assert.equal(a.hash, b.hash, 'two renders of one frame must be byte-identical');
  assert.ok(a.ms >= 0 && Number.isFinite(a.ms));
  assert.equal(b.cached, true, 'the second render is served from the cache');

  // a different frame number is a different picture
  const f5 = await pool.render({ sourceId: 'framey', frame: 5, fps: 30, size: [64, 48], seed: 3 });
  const f6 = await pool.render({ sourceId: 'framey', frame: 6, fps: 30, size: [64, 48], seed: 3 });
  assert.notEqual(f5.hash, f6.hash, 'the frame number must reach the sketch');
});

test('render-workers: the sandbox cannot see Node or the network', { skip: electronSkip }, async (t) => {
  const root = await tmpProject();
  await writeSource(root, 'probe', SOURCE_PROBE, {
    params: [{ id: 'density', type: 'number', default: 0.5 }],
  });
  const pool = await createRenderPool({ root, timeoutMs: 20000 });
  t.after(async () => { await pool.close(); await fs.rm(root, { recursive: true, force: true }); });

  await pool.render({ sourceId: 'probe', frame: 2, fps: 30, size: [32, 24], seed: 11 });
  // The host forwards the page console entries; find the probe payload and
  // read it with a brace matcher (the entry wraps it as JSON-in-JSON).
  const logged = pool.console.map((entry) => entry.text || '').join(String.fromCharCode(10));
  const seen = readProbe(logged);
  assert.ok(seen, `no VDM_PROBE line in the page console (${pool.console.length} entries): ${logged.slice(0, 800)}`);
  assert.equal(seen.process, 'undefined', 'process must not exist in the sandbox');
  assert.equal(seen.require, 'undefined', 'require must not exist in the sandbox');
  assert.equal(seen.module, 'undefined', 'module must not exist in the sandbox');
  assert.equal(seen.Buffer, 'undefined', 'Buffer must not exist in the sandbox');
  assert.equal(seen.importScripts, 'undefined');
  // the network: absent, or present but blocked by the CSP / webRequest guard
  for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket']) {
    assert.ok(seen[key] === 'undefined' || seen[key] === 'function', `${key} was ${seen[key]}`);
  }
  // the SDK is what the sketch is supposed to use
  assert.equal(seen.frame, 2);
  assert.equal(seen.param, 0.5);
  assert.equal(typeof seen.rnd, 'number');
});

test('render-workers: a runaway frame is killed and the pool keeps working', { skip: electronSkip }, async (t) => {
  const root = await tmpProject();
  await writeSource(root, 'hang', SOURCE_HANG);
  await writeSource(root, 'solid', SOURCE_SOLID);
  const pool = await createRenderPool({ root, timeoutMs: 400, startupTimeoutMs: 30000 });
  t.after(async () => { await pool.close(); await fs.rm(root, { recursive: true, force: true }); });

  const started = Date.now();
  await assert.rejects(
    () => pool.render({ sourceId: 'hang', frame: 0, fps: 30, size: [32, 32], seed: 1 }),
    (error) => {
      assert.equal(error.code, ERROR_CODES.RENDER_TIMEOUT, `code was ${error.code}: ${error.message}`);
      return true;
    },
  );
  const killedAfter = Date.now() - started;
  assert.ok(killedAfter < 30000, `timeout took ${killedAfter} ms`);
  // the pool recovers: the next frame renders normally
  const ok = await pool.render({ sourceId: 'solid', frame: 0, fps: 30, size: [32, 32], seed: 1 });
  assert.ok(ok.hash, 'the pool renders again after killing a runaway frame');
});

test('render-workers: a frame range writes files and reuses the cache', { skip: electronSkip }, async (t) => {
  const root = await tmpProject();
  await writeSource(root, 'framey', SOURCE_FRAME);
  const pool = await createRenderPool({ root, timeoutMs: 20000 });
  const outDir = path.join(root, '.vdm', 'cache', 'range-a');
  const outDir2 = path.join(root, '.vdm', 'cache', 'range-b');
  t.after(async () => { await pool.close(); await fs.rm(root, { recursive: true, force: true }); });

  const first = await pool.renderRange({
    sourceId: 'framey', f0: 0, f1: 2, fps: 30, size: [32, 24], seed: 2, outDir, params: { },
  });
  assert.equal(first.count, 3);
  assert.equal(first.rendered, 3);
  assert.equal(first.cached, 0);
  for (const file of first.files) {
    const stat = await fs.stat(file);
    assert.ok(stat.size > 0, `${file} is empty`);
  }
  const second = await pool.renderRange({
    sourceId: 'framey', f0: 0, f1: 2, fps: 30, size: [32, 24], seed: 2, outDir: outDir2, params: { },
  });
  assert.equal(second.cached, 3, 'the second range is served from the cache');
  assert.deepEqual(second.frames.map((f) => f.hash), first.frames.map((f) => f.hash));
});
