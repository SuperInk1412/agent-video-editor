// Manim layer (docs/DESIGN-BACKEND-V2.md §6.4, WP5.2): detection, the cached
// PNG sequence, determinism and the error code of a missing renderer.
//
// Real-manim tests are skipped when `manim` is not installed — the runtime is
// an optional external dependency (§6.4 / D5), and a missing one is exactly the
// `MANIM_UNAVAILABLE` case the preview and the export degrade on.
//
// The stub group needs no manim: it points `VDM_MANIM` at a tiny script that
// writes frames the way `manim --format png` does (`<Scene>0000.png` under
// `--media_dir`). It cannot prove manim itself is deterministic, but it proves
// everything around it: the command line, the JSON parameters, the frame
// order, the content-addressed cache, the "second call does not run the
// renderer" promise, the index clamping and the cache-only (bake) read.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MANIM_FRAME_PATTERN, MANIM_UNAVAILABLE,
  ensureManimSequence, findManim, manimCacheDir, manimCacheKey, manimFrame, manimFrameName,
  manimSequenceDir, readManimFrame,
} from '../engine/manim.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { ensureSpace } from '../core/space.js';
import { buildFrameIR } from '../core/frame-ir.js';
import { startServer } from '../engine/server.js';
import { saveProject } from '../engine/storage.js';
import { bakeRasterLayers } from '../engine/raster-bake.js';
import { buildShotV3 } from '../engine/shot.js';

const REPO = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'sources', 'manim-formula');
const MANIM = findManim();
const MANIFEST = JSON.parse(await fs.readFile(path.join(FIXTURE, 'manifest.json'), 'utf8'));
const SCENE = await fs.readFile(path.join(FIXTURE, 'scene.py'), 'utf8');
const SIZE = [320, 180];
const FPS = 24;
const DURATION = 0.5; // 12 frames at 24 fps: a real manim run stays quick

/** A throwaway project root with the shared manim fixture as `sources/src_m/`. */
async function makeRoot(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-manim-'));
  const dir = path.join(root, 'sources', 'src_m');
  await fs.mkdir(dir, { recursive: true });
  const manifest = { ...MANIFEST, id: 'src_m', duration: DURATION, ...overrides };
  await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(dir, 'scene.py'), SCENE);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, dir, manifest };
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Hash every frame file of a sequence, in order — "the same picture twice". */
async function hashSequence(dir) {
  const names = (await fs.readdir(dir)).filter((name) => /^f_\d{5}\.png$/.test(name)).sort();
  assert.ok(names.length > 0, `${dir} 里没有帧`);
  const hash = crypto.createHash('sha256');
  for (const name of names) hash.update(name).update(await fs.readFile(path.join(dir, name)));
  return { hash: hash.digest('hex'), count: names.length };
}

// ---------------------------------------------------------------------------
// Detection (pure, always runs)
// ---------------------------------------------------------------------------

test('manim: detection is VDM_MANIM first, then PATH — and never fabricated', () => {
  assert.equal(findManim({ env: { PATH: '', VDM_MANIM: '' } }), null, '空 PATH 上没有 manim');
  const missing = path.join(os.tmpdir(), 'vdm-no-such-manim', 'manim');
  assert.equal(findManim({ env: { PATH: '', VDM_MANIM: missing } }), null, 'VDM_MANIM 指向不存在的文件');
  if (MANIM) assert.ok(path.isAbsolute(MANIM), `findManim() 应给出绝对路径，收到 ${MANIM}`);
});

test('manim: the cache key is a content address of every render input', () => {
  const snapshot = { files: [{ path: 'manifest.json', sha256: 'aaa' }, { path: 'scene.py', sha256: 'bbb' }] };
  const base = { snapshot, manifestRaw: '{"runtime":"manim"}', params: { tint: '#9fd8ff' }, size: [960, 540], fps: 24 };
  assert.equal(manimCacheKey(base), manimCacheKey({ ...base }), '同样的输入 -> 同样的哈希');
  assert.equal(manimCacheKey(base), manimCacheKey({ ...base, params: { tint: '#9fd8ff' } }), '参数相等（不同对象）-> 同样的哈希');
  assert.notEqual(manimCacheKey(base), manimCacheKey({ ...base, params: { tint: '#ff8800' } }));
  assert.notEqual(manimCacheKey(base), manimCacheKey({ ...base, fps: 30 }));
  assert.notEqual(manimCacheKey(base), manimCacheKey({ ...base, size: [1920, 1080] }));
  assert.notEqual(manimCacheKey(base), manimCacheKey({ ...base, snapshot: { files: [{ path: 'scene.py', sha256: 'ccc' }] } }));
  assert.notEqual(manimCacheKey(base), manimCacheKey({ ...base, manifestRaw: '{"runtime":"manim","duration":2}' }));
});

test('manim: a manim source is a code layer and becomes a raster item in the IR', () => {
  const project = normalizeProject(createProject({ title: 'manim layer', width: 1920, height: 1080, duration: 2 }));
  ensureSpace(project);
  applyOps(project, [
    { op: 'sourceAdd', id: 'src_ir', manifest: { ...MANIFEST, id: 'src_ir' }, files: { 'scene.py': SCENE } },
    {
      op: 'addElement',
      element: {
        id: 'el_manim', type: 'code', start: 0, duration: 2, z: 1,
        code: { source: 'src_ir', params: {}, seed: 0, size: [960, 540], cache: 'live' },
      },
    },
  ]);
  assert.deepEqual(validateProject(project), [], 'manim 是合法的代码图层运行时（不是编译源）');
  const ir = buildFrameIR(project, 12, { fps: 24 });
  const item = (ir.items || []).find((entry) => entry.kind === 'raster' && entry.content?.source?.id === 'src_ir');
  assert.ok(item, 'IR 里 manim 图层是 raster item —— 预览/导出复用 WP3.3 / WP3.4 的路径，不是另一套');
  assert.equal(item.content.source.runtime, 'manim');
  assert.deepEqual(item.content.size, [960, 540]);
  assert.equal(item.content.mode, 'live');
});

// ---------------------------------------------------------------------------
// Missing renderer: the error code every caller degrades on
// ---------------------------------------------------------------------------

test('manim: without a renderer the layer fails with MANIM_UNAVAILABLE', {
  skip: MANIM ? `manim is installed (${MANIM}); the missing-install path does not apply here` : false,
}, async (t) => {
  const { root } = await makeRoot(t);
  await assert.rejects(
    manimFrame({
      root, sourceId: 'src_m', frame: 0, size: SIZE, fps: FPS,
      env: { PATH: '', VDM_MANIM: '' },
    }),
    (error) => {
      assert.equal(error.code, MANIM_UNAVAILABLE);
      assert.equal(error.status, 503, '503 是 route 报给预览的状态码');
      assert.match(error.message, /manim/);
      assert.match(String(error.hint), /VDM_MANIM/, '错误要说清怎么修（§6.4 D5）');
      return true;
    },
  );
  // Nothing was half-written: the cache directory stays absent.
  await assert.rejects(fs.stat(manimCacheDir(root)), { code: 'ENOENT' });
});

// ---------------------------------------------------------------------------
// Real manim (skipped when it is not installed)
// ---------------------------------------------------------------------------

const realManimSkip = MANIM ? false : 'manim 未安装（§6.4：可选外部运行时）—— 这一组跳过';

test('manim: the same scene renders to the same bytes twice', { skip: realManimSkip }, async (t) => {
  const { root } = await makeRoot(t);
  const options = { root, sourceId: 'src_m', frame: 0, size: SIZE, fps: FPS };
  const first = await ensureManimSequence({ ...options, useCache: false });
  const firstHash = await hashSequence(first.dir);
  assert.equal(first.cached, false);
  assert.ok(first.count > 1, `一个 ${DURATION}s 的动画应该不止一帧（收到 ${first.count}）`);
  // Force a second render by removing the content-addressed directory.
  await fs.rm(manimCacheDir(root), { recursive: true, force: true });
  const second = await ensureManimSequence({ ...options, useCache: false });
  assert.equal(second.key, first.key, '同样的输入必须落在同一个哈希目录');
  const secondHash = await hashSequence(second.dir);
  assert.equal(secondHash.hash, firstHash.hash, '同场景两次渲染的帧逐字节相同');
  assert.equal(secondHash.count, firstHash.count);
});

test('manim: a second request is a cache hit and the frames are the cached ones', { skip: realManimSkip }, async (t) => {
  const { root } = await makeRoot(t);
  const options = { root, sourceId: 'src_m', frame: 4, size: SIZE, fps: FPS };
  const first = await manimFrame(options);
  assert.equal(first.cached, false);
  assert.equal(first.pattern, MANIM_FRAME_PATTERN);
  assert.equal(path.basename(first.pngPath), manimFrameName(4));
  const metaFile = path.join(manimSequenceDir(root, first.key), 'meta.json');
  const before = (await fs.stat(metaFile)).mtimeMs;
  const again = await manimFrame(options);
  assert.equal(again.cached, true);
  assert.equal(again.key, first.key);
  assert.equal(again.pngPath, first.pngPath);
  assert.equal((await fs.stat(metaFile)).mtimeMs, before, '缓存命中不能重写序列');
  // The bake path reads without rendering.
  const baked = await readManimFrame({ root, sourceId: 'src_m', frame: 4, size: SIZE, fps: FPS });
  assert.equal(baked.pngPath, first.pngPath);
});

// ---------------------------------------------------------------------------
// Stub renderer: the plumbing around manim, with no manim installed
// ---------------------------------------------------------------------------

const STUB = `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('stub-manim 9.9.9'); process.exit(0); }
const at = args.indexOf('--media_dir');
if (at < 0) { console.error('stub: --media_dir missing'); process.exit(2); }
const media = args[at + 1];
const dir = path.join(media, 'videos', 'scene', '320x180');
fs.mkdirSync(dir, { recursive: true });
const log = process.env.VDM_MANIM_STUB_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({
  args, params: process.env.VDM_MANIM_PARAMS, size: process.env.VDM_MANIM_SIZE,
  fps: process.env.VDM_MANIM_FPS, duration: process.env.VDM_MANIM_DURATION,
}) + '\\n');
const frames = Number(process.env.VDM_MANIM_STUB_FRAMES || Math.max(1, Math.round(Number(process.env.VDM_MANIM_FPS) * Number(process.env.VDM_MANIM_DURATION)) || 5));
for (let i = 0; i < frames; i++) {
  fs.writeFileSync(path.join(dir, 'FormulaScene' + String(i).padStart(4, '0') + '.png'),
    'STUB-FRAME ' + i + ' ' + (process.env.VDM_MANIM_PARAMS || '') + '\\n');
}
`;

/** Write the stub + a platform launcher; returns the env that points at it. */
async function installStub(t, root, { frames = null } = {}) {
  const dir = path.join(root, 'stub');
  await fs.mkdir(dir, { recursive: true });
  const script = path.join(dir, 'stub.mjs');
  await fs.writeFile(script, STUB);
  const log = path.join(dir, 'calls.jsonl');
  const node = process.execPath;
  let bin;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'stub.cmd');
    await fs.writeFile(bin, `@echo off\r\n"${node}" "%~dp0stub.mjs" %*\r\n`);
  } else {
    bin = path.join(dir, 'stub.sh');
    await fs.writeFile(bin, `#!/bin/sh\nexec "${node}" "$(dirname "$0")/stub.mjs" "$@"\n`);
    await fs.chmod(bin, 0o755);
  }
  const env = { ...process.env, VDM_MANIM: bin, VDM_MANIM_STUB_LOG: log };
  if (frames != null) env.VDM_MANIM_STUB_FRAMES = String(frames);
  return { bin, env, log };
}

test('manim (stub): the raster route serves a cached sequence without a renderer', async (t) => {
  const { root } = await makeRoot(t);
  const stub = await installStub(t, root);
  const params = { tint: '#ff8800' };
  const first = await manimFrame({ root, sourceId: 'src_m', frame: 0, params, size: SIZE, fps: FPS, env: stub.env });
  // The editor only needs a project file to boot; the route reads sources/<id>/.
  const project = normalizeProject(createProject({ title: 'manim route', width: SIZE[0], height: SIZE[1], fps: FPS, duration: 1 }));
  await saveProject(root, project, { by: 'tests/manim' });
  const service = await startServer({ root, port: 0 });
  t.after(async () => { await service.close(); });
  const query = (extra = {}) => new URLSearchParams({
    source: 'src_m', frame: '3', w: String(SIZE[0]), h: String(SIZE[1]), params: JSON.stringify(params), ...extra,
  }).toString();
  // A bounded request: a router that never answers must fail the test, not hang
  // the suite (the engine's request path is the one place this file talks HTTP).
  const get = (url) => fetch(url, { signal: AbortSignal.timeout(15000) });
  // No renderer is visible to the engine here: the frame can only come from the
  // cache (`engine/routes/raster.js` -> `engine/manim.js`), which is exactly the
  // §6.4 "预览显示缓存帧" promise.
  const response = await get(`${service.info.url}api/raster?${query()}`);
  assert.equal(response.status, 200, '缓存命中时不需要 manim 也能出帧');
  assert.equal(response.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await response.arrayBuffer());
  const cached = await fs.readFile(path.join(first.dir, manimFrameName(3)));
  assert.deepEqual(bytes, cached, 'route 返回的就是缓存序列里的那一帧');
  // `mode=bake` never renders: a parameter set that was never rendered is a 404.
  const miss = await get(`${service.info.url}api/raster?${query({ params: JSON.stringify({ tint: '#000000' }), mode: 'bake' })}`);
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).code, 'RASTER_NOT_CACHED');
});

test('manim (stub): the export bake stages manim frames as one image sequence', async (t) => {
  const { root, manifest } = await makeRoot(t);
  const stub = await installStub(t, root);
  const sequence = await ensureManimSequence({ root, sourceId: 'src_m', size: SIZE, fps: FPS, env: stub.env });
  const project = normalizeProject(createProject({ title: 'manim bake', width: SIZE[0], height: SIZE[1], fps: FPS, duration: 1 }));
  ensureSpace(project);
  applyOps(project, [
    { op: 'sourceAdd', id: 'src_m', manifest, files: { 'scene.py': SCENE } },
    { op: 'addElement', element: {
      id: 'el_manim', type: 'code', start: 0, duration: 1, z: 1,
      code: { source: 'src_m', params: {}, seed: 0, size: SIZE, cache: 'live' },
    } },
  ]);
  await saveProject(root, project, { by: 'tests/manim' });
  const v3 = buildShotV3(project, { fps: FPS, from: 0, to: 1 });
  const saved = process.env.VDM_MANIM;
  process.env.VDM_MANIM = stub.bin;
  const logs = [];
  try {
    const rasters = await bakeRasterLayers(root, v3, { fps: FPS, f0: 1, f1: 25, onLog: (line) => logs.push(String(line)) });
    const raster = rasters.el_manim;
    assert.ok(raster, 'manim 图层被烤进 v3.rasters（和代码图层同一个 payload）');
    assert.equal(raster.count, 24, '1 s、24 fps 的元素跨渲染帧 1..24');
    assert.equal(raster.pattern, 'f_%05d.png');
    assert.deepEqual([raster.width, raster.height], SIZE);
    assert.equal(raster.rendered, 0);
    assert.equal(raster.cached, 24, '已经渲过的序列全部是缓存命中');
    const first = await fs.readFile(path.join(raster.dir, 'f_00000.png'));
    assert.deepEqual(first, await fs.readFile(path.join(sequence.dir, manimFrameName(0))));
    // The scene is 0.5 s: frames past the end hold the last rendered frame.
    const held = await fs.readFile(path.join(raster.dir, 'f_00023.png'));
    assert.deepEqual(held, await fs.readFile(path.join(sequence.dir, manimFrameName(11))), '超出场景时长的帧沿用最后一帧');
    assert.ok(logs.some((line) => line.includes('manim')), '日志里能看到 manim 序列');
  } finally {
    if (saved === undefined) delete process.env.VDM_MANIM;
    else process.env.VDM_MANIM = saved;
  }
});

const readCalls = async (log) => (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('manim (stub): one render, then cached frames — the renderer is not run again', async (t) => {
  const { root } = await makeRoot(t);
  const stub = await installStub(t, root);
  const params = { tint: '#ff8800' };
  const options = { root, sourceId: 'src_m', frame: 3, params, size: SIZE, fps: FPS, env: stub.env };
  const first = await manimFrame(options);
  assert.equal(first.cached, false);
  assert.equal(first.count, 12, 'duration 0.5s @24fps -> 12 帧');
  assert.equal(path.basename(first.pngPath), manimFrameName(3));
  const metaFile = path.join(manimSequenceDir(root, first.key), 'meta.json');
  const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  assert.equal(meta.key, first.key);
  assert.equal(meta.source, 'src_m');
  assert.equal(meta.scene, 'FormulaScene');
  assert.deepEqual(meta.size, SIZE);
  assert.equal(meta.fps, FPS);
  assert.equal(meta.count, 12);
  assert.equal(meta.manim.version, '9.9.9', '--version 写进 meta（诊断用）');
  const before = (await fs.stat(metaFile)).mtimeMs;

  const again = await manimFrame(options);
  assert.equal(again.cached, true);
  assert.equal(again.key, first.key);
  assert.equal((await fs.stat(metaFile)).mtimeMs, before, '缓存命中不能重写序列');

  const calls = await readCalls(stub.log);
  assert.equal(calls.length, 1, '第二次请求不能调用渲染器');
  assert.equal(calls[0].size, '320x180');
  assert.equal(calls[0].fps, '24');
  assert.equal(calls[0].duration, '0.5');
  assert.deepEqual(JSON.parse(calls[0].params), { formula: 'E = mc²', scale: 1.6, tint: '#ff8800' },
    '参数以 manifest 默认值补齐后，再以 JSON 交给场景（§6.4）');
  assert.ok(calls[0].args.includes('--format') && calls[0].args.includes('png'), '命令里有 --format png');
  assert.ok(calls[0].args.includes('--transparent'), '命令里有 --transparent');
  assert.ok(calls[0].args.includes('--disable_caching'));

  // Frame indices clamp to the last rendered frame (the preview's fallback rule).
  const last = await manimFrame({ ...options, frame: 999 });
  assert.equal(path.basename(last.pngPath), manimFrameName(11));
  // The bake path never renders: a fresh root has nothing to read.
  const baked = await readManimFrame({ root, sourceId: 'src_m', frame: 2, params, size: SIZE, fps: FPS });
  assert.equal(path.basename(baked.pngPath), manimFrameName(2));
  const fresh = await makeRoot(t);
  assert.equal(await readManimFrame({ root: fresh.root, sourceId: 'src_m', frame: 2, params, size: SIZE, fps: FPS }), null,
    'mode=bake 只读缓存，绝不渲染');
});

test('manim (stub): a changed parameter starts a new sequence; the old one stays', async (t) => {
  const { root } = await makeRoot(t);
  const stub = await installStub(t, root);
  const base = { root, sourceId: 'src_m', frame: 0, size: SIZE, fps: FPS, env: stub.env };
  const one = await manimFrame({ ...base, params: { tint: '#ff8800' } });
  const two = await manimFrame({ ...base, params: { tint: '#00cc60' } });
  assert.notEqual(two.key, one.key, '参数不同 -> 不同的内容地址');
  assert.notEqual(two.dir, one.dir);
  const hashes = [await hashSequence(one.dir), await hashSequence(two.dir)];
  assert.notEqual(hashes[0].hash, hashes[1].hash, '参数真的传到了场景（帧内容不同）');
  assert.equal((await readCalls(stub.log)).length, 2);
  // The first sequence is still a hit: nothing invalidated it.
  const again = await manimFrame({ ...base, params: { tint: '#ff8800' } });
  assert.equal(again.cached, true);
  assert.equal(again.key, one.key);
  assert.equal((await readCalls(stub.log)).length, 2);
});

test('manim (stub): a frame number beyond the rendered count clamps, a short render is kept', async (t) => {
  const { root } = await makeRoot(t);
  const stub = await installStub(t, root, { frames: 5 });
  const sequence = await ensureManimSequence({
    root, sourceId: 'src_m', size: SIZE, fps: FPS, env: stub.env,
  });
  assert.equal(sequence.count, 5, '缓存的帧数以渲染器实际产出为准');
  const frame = await manimFrame({ root, sourceId: 'src_m', frame: 4, size: SIZE, fps: FPS, env: stub.env });
  assert.equal(path.basename(frame.pngPath), manimFrameName(4));
});

test('manim (stub): a manifest without duration is SOURCE_INVALID and never runs the renderer', async (t) => {
  const { root } = await makeRoot(t, { duration: undefined });
  const stub = await installStub(t, root);
  await assert.rejects(
    manimFrame({ root, sourceId: 'src_m', frame: 0, size: SIZE, fps: FPS, env: stub.env }),
    (error) => {
      assert.equal(error.code, 'SOURCE_INVALID');
      assert.match(error.message, /duration/);
      return true;
    },
  );
  await assert.rejects(fs.readFile(stub.log, 'utf8'), { code: 'ENOENT' }, '参数不合法时不该启动 manim');
});

test('manim (stub): a renderer that produces no frame is MANIM_RENDER_FAILED and is not retried per frame', async (t) => {
  const { root } = await makeRoot(t);
  const dir = path.join(root, 'broken');
  const log = path.join(dir, 'calls.log');
  await fs.mkdir(dir, { recursive: true });
  const script = path.join(dir, 'broken.mjs');
  await fs.writeFile(script, `import fs from 'node:fs';
if (process.argv.slice(2).includes('--version')) { console.log('broken 0.0.0'); process.exit(0); }
fs.appendFileSync(process.env.VDM_MANIM_CALLS, 'render\\n');
console.error('no scene');
process.exit(3);
`);
  let bin;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'broken.cmd');
    await fs.writeFile(bin, `@echo off\r\n"${process.execPath}" "%~dp0broken.mjs" %*\r\n`);
  } else {
    bin = path.join(dir, 'broken.sh');
    await fs.writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/broken.mjs" "$@"\n`);
    await fs.chmod(bin, 0o755);
  }
  const env = { ...process.env, VDM_MANIM: bin, VDM_MANIM_CALLS: log };
  const options = { root, sourceId: 'src_m', frame: 0, size: SIZE, fps: FPS, env };
  const expected = (error) => {
    assert.equal(error.code, 'MANIM_RENDER_FAILED');
    assert.match(error.message, /no scene/, '失败要带上渲染器最后几行输出');
    return true;
  };
  await assert.rejects(manimFrame(options), expected);
  assert.equal((await fs.readFile(log, 'utf8')).trim(), 'render', '一次失败的渲染只启动一次 manim');
  // A preview asks one frame at a time: the same broken scene must not spawn a
  // render for every frame (the failure is remembered for a short while).
  await assert.rejects(manimFrame({ ...options, frame: 1 }), expected);
  assert.equal((await fs.readFile(log, 'utf8')).trim(), 'render', '30 秒内同一序列的失败不重试');
  // ... but an explicit re-render (the determinism test, a repair) still tries.
  await assert.rejects(manimFrame({ ...options, frame: 0, useCache: false }), expected);
  assert.equal((await fs.readFile(log, 'utf8')).trim().split('\n').length, 2, 'useCache: false 绕过失败记忆');
});
