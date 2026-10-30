// Code layers through the Blender backend (docs/DESIGN-BACKEND-V2.md §6.1,
// §10.2 WP3.4).
//
// `engine/blender.js` bakes every `raster` item through the one render pool
// (`engine/raster-bake.js`) before Blender starts, and `blender/vdm_build.py`
// draws the resulting image sequence as a plane. This test renders a small job
// twice and asserts:
//
//   (a) `.vdm/cache/raster/` holds the frames the job needs;
//   (b) Blender writes exactly the job's frame range;
//   (c) a layer whose request never changes is rendered ONCE and held, while a
//       layer whose `params` are keyed is rendered per frame;
//   (d) the second run re-renders nothing — the pool answers from the cache
//       (`0 rendered, N cached` in the log) and no cache directory is added;
//   (e) the picture really is the raster: the plane shows the source's colours,
//       and the keyed layer's colour changes at its keyframe (so the image
//       sequence is sampled by IR frame, not by paint order).
//
// Blender is required for the render and Electron for the rasteriser; the test
// skips with a reason when either is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { projectService } from '../engine/projects.js';
import { findBlender, renderFrames } from '../engine/blender.js';
import { findElectron } from '../engine/render-workers/pool.js';
import { findBin } from '../engine/media.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { buildShotV3 } from '../engine/shot.js';
import { rasterPlan } from '../engine/raster-bake.js';

const run = promisify(execFile);

const MANIFEST = {
  format: 'vdm.source/1',
  runtime: 'canvas2d',
  entry: 'sketch.js',
  deterministic: true,
  params: [
    { id: 'tint', type: 'color', default: '#ff0000' },
    { id: 'band', type: 'number', default: 0.2 },
  ],
};

// A white band at the top of the raster, then the field colour from `tint`:
// the band makes "this is the raster, not a placeholder" visible, and the field
// colour is what a keyed parameter changes.
const SKETCH = `export function draw(ctx, vdm) {
  const [w, h] = vdm.size;
  ctx.fillStyle = vdm.param('tint');
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, Math.max(1, h * Number(vdm.param('band'))));
}
`;

const FPS = 8;
const TO = 0.5;            // 4 frames: render frames 1..4 = IR frames 0..3
const KEY_T = 0.25;        // the moving layer's colour steps here (IR frame 2)
const STATIC_TINT = '#00ccff';
const MOVING_FROM = '#ff0000';
const MOVING_TO = '#0000ff';
const FIXED_TINT = '#ffcc00';

/** `src_box` renders from the frame; `src_fixed` is the same code declaring it does not. */
const FIXED_MANIFEST = { ...MANIFEST, id: 'src_fixed', timeIndependent: true };

async function build() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-blender-raster-'));
  for (const [id, manifest] of [['src_box', { ...MANIFEST, id: 'src_box' }], ['src_fixed', FIXED_MANIFEST]]) {
    const sourceDir = path.join(root, 'sources', id);
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(sourceDir, 'sketch.js'), SKETCH);
  }

  const projects = projectService(root);
  await projects.transact({
    command: { type: 'initialize', options: { width: 320, height: 180, duration: 1, fps: FPS, background: '#000000' } },
  });
  const { project } = await projects.transact({ ops: [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    { op: 'sourceAdd', id: 'src_box', manifest: { ...MANIFEST, id: 'src_box' }, files: { 'sketch.js': SKETCH } },
    { op: 'sourceAdd', id: 'src_fixed', manifest: FIXED_MANIFEST, files: { 'sketch.js': SKETCH } },
    // Top half: constant params, but no `timeIndependent` — every frame is
    // still requested, because `vdm.t` may animate the sketch.
    { op: 'addElement', element: {
      id: 'el_static', type: 'code', start: 0, duration: 1, z: 1,
      node: { pivot: [0, 1.35, 0], position: [0, 0, 0], rotation: [0, 0, 0], scale: [0.5, 0.5, 1] },
      code: { source: 'src_box', params: { tint: STATIC_TINT, band: 0.2 }, seed: 1, size: [160, 90], cache: 'live' },
    } },
    // Bottom half: `code.params.tint` is keyed, so every frame is its own raster.
    { op: 'addElement', element: {
      id: 'el_moving', type: 'code', start: 0, duration: 1, z: 2,
      node: { pivot: [0, 0.45, 0], position: [0, 0, 0], rotation: [0, 0, 0], scale: [0.5, 0.5, 1] },
      code: { source: 'src_box', params: { tint: MOVING_FROM, band: 0.2 }, seed: 1, size: [160, 90], cache: 'live' },
    } },
    // `src_fixed` declares `timeIndependent: true`: one render covers the range.
    // Parked out of frame so it cannot change the pixels below.
    { op: 'addElement', element: {
      id: 'el_fixed', type: 'code', start: 0, duration: 1, z: 3,
      node: { pivot: [0, 10, 0], position: [0, 0, 0], rotation: [0, 0, 0], scale: [0.2, 0.2, 1] },
      code: { source: 'src_fixed', params: { tint: FIXED_TINT, band: 0.2 }, seed: 1, size: [160, 90], cache: 'live' },
    } },
    { op: 'keySet', id: 'el_moving', path: 'code.params.tint', t: 0, value: MOVING_FROM },
    { op: 'keySet', id: 'el_moving', path: 'code.params.tint', t: KEY_T, value: MOVING_TO },
  ] });
  return { root, project };
}

/** Every PNG the raster cache holds, sequences aside. */
async function cachedFrames(root) {
  const dir = path.join(root, '.vdm', 'cache', 'raster');
  const names = [];
  const walk = async (at) => {
    let entries;
    try { entries = await fs.readdir(at, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/^f\d{5}\.png$/.test(entry.name)) names.push(full);
    }
  };
  await walk(dir);
  return names.sort();
}

/** The staged sequences under `.vdm/cache/raster/seq/`. */
async function stagedSequences(root) {
  const dir = path.join(root, '.vdm', 'cache', 'raster', 'seq');
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const files = await fs.readdir(path.join(dir, name));
    out.push({ name, dir: path.join(dir, name), frames: files.filter((f) => /^f_\d{5}\.png$/.test(f)).sort(), marker: files.includes('.ok') });
  }
  return out;
}

/** One RGB pixel of a rendered frame. */
async function pixel(ffmpeg, file, x, y) {
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  return [...stdout.subarray(0, 3)];
}

const isRed = ([r, g, b]) => r > 150 && g < 90 && b < 90;
const isBlue = ([r, g, b]) => b > 150 && r < 90 && g < 90;
const isCyan = ([r, g, b]) => b > 150 && g > 120 && r < 110;

const electronSkip = findElectron() ? false : 'no Electron on this machine (the rasteriser needs one)';

// ------------------------------------------------------------------ plan only
//
// Which frames a job has to bake is decided in `engine/raster-bake.js` from the
// v3 payload alone, so this half runs everywhere (no Blender, no Electron).

test('raster bake plan: per frame by default, one frame only for a timeIndependent source', () => {
  const project = normalizeProject(createProject({ title: 'plan', duration: 1, width: 320, height: 180, fps: FPS }));
  applyOps(project, [
    { op: 'sourceAdd', id: 'src_plan', manifest: { ...MANIFEST, id: 'src_plan' }, files: { 'sketch.js': SKETCH } },
    { op: 'addElement', element: {
      id: 'el_plan', type: 'code', start: 0, duration: 1, z: 1,
      code: { source: 'src_plan', params: { tint: MOVING_FROM, band: 0.2 }, seed: 1, size: [160, 90], cache: 'live' },
    } },
  ]);
  const v3 = buildShotV3(project, { fps: FPS, from: 0, to: 1 });
  const plans = rasterPlan(v3, 1, 8);
  assert.equal(plans.length, 1, 'one code layer makes one plan');
  assert.equal(plans[0].id, 'el_plan');
  assert.equal(plans[0].fromIR, 0, 'render frame 1 is IR frame 0 (1 based render frames)');
  assert.equal(plans[0].toIR, 7, 'render frame 8 is IR frame 7');
  assert.equal(plans[0].static, false,
    'unchanged params are still per frame: a sketch may animate through vdm.t / vdm.frame');
  assert.equal(plans[0].entries.length, 8, 'every frame of the range is requested');

  // Only a source that declares it does not depend on the clock may reuse one
  // frame for the whole range.
  const [reused] = rasterPlan(v3, 1, 8, { timeIndependent: new Set(['src_plan']) });
  assert.equal(reused.static, true);
  assert.equal(reused.entries.length, 1, 'a timeIndependent source is baked once and held');

  applyOps(project, [
    { op: 'keySet', id: 'el_plan', path: 'code.params.tint', t: 0, value: MOVING_FROM },
    { op: 'keySet', id: 'el_plan', path: 'code.params.tint', t: 0.5, value: MOVING_TO },
  ]);
  const keyed = buildShotV3(project, { fps: FPS, from: 0, to: 1 });
  const [plan] = rasterPlan(keyed, 1, 8);
  assert.equal(plan.static, false, 'a keyed parameter makes the request change per frame');
  assert.equal(plan.entries.length, 8, 'every frame of the range is its own raster');
  assert.deepEqual(plan.entries.map((entry) => entry.ir), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.notEqual(plan.entries[0].key, plan.entries[7].key, 'the request of frame 0 and 7 differs');

  // A frame range outside the shot draws nothing: no plan, no bake.
  assert.deepEqual(rasterPlan(keyed, 40, 44), []);
});

test('Blender draws code layers from the shared raster cache', { timeout: 240000, skip: electronSkip }, async (t) => {
  try { await findBlender(); } catch { return t.skip('Blender is required'); }
  let ffmpeg = null;
  try { ffmpeg = await findBin('ffmpeg'); } catch { /* pixel checks are optional */ }
  const { root, project } = await build();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // ---- first job: bake, render, and both request rules -------------------
  const first = [];
  const job = await renderFrames({
    dir: root, project, from: 0, to: TO, scale: 1, samples: 2,
    onLog: (line) => first.push(String(line)),
  });
  assert.equal(job.count, 4, `the job is 4 frames, got ${job.count}`);
  const rasterLines = first.filter((line) => line.startsWith('raster '));
  const staticLine = rasterLines.find((line) => line.includes('el_static'));
  const movingLine = rasterLines.find((line) => line.includes('el_moving'));
  const fixedLine = rasterLines.find((line) => line.includes('el_fixed'));
  assert.ok(staticLine, `no raster line for el_static in:\n${first.join('')}`);
  assert.ok(movingLine, `no raster line for el_moving in:\n${first.join('')}`);
  assert.ok(fixedLine, `no raster line for el_fixed in:\n${first.join('')}`);
  assert.match(staticLine, /per-frame/, 'unchanged params are per frame: vdm.t may animate the sketch');
  assert.match(staticLine, / 4 rendered, 0 cached/, 'a per-frame layer renders every frame');
  assert.match(movingLine, /per-frame/, 'a keyed parameter is a per-frame layer');
  assert.match(movingLine, / 4 rendered, 0 cached/, 'a per-frame layer renders every frame');
  assert.match(fixedLine, /timeIndependent, one frame/, 'a declared timeIndependent source is baked once');
  assert.match(fixedLine, / 1 rendered, 0 cached, 0 fallback, 4 staged/, 'one render covers the range');

  const frames = (await fs.readdir(job.framesDir)).filter((name) => name.endsWith('.png')).sort();
  assert.equal(frames.length, job.count, `Blender must write ${job.count} frames, got ${frames.length}`);

  // (a) the cache holds one frame per distinct request: 4 + 4 per-frame frames
  // plus the single frame of the timeIndependent layer
  const cached = await cachedFrames(root);
  assert.equal(cached.length, 9, `expected 9 cached rasters (4 + 4 + 1), got ${cached.length}`);
  for (const file of cached) assert.ok((await fs.stat(file)).size > 0, `${file} is empty`);

  // (b) each item has one staged sequence covering the job range
  const sequences = await stagedSequences(root);
  assert.equal(sequences.length, 3, `expected one sequence per code layer, got ${sequences.length}`);
  for (const sequence of sequences) {
    assert.ok(sequence.marker, `${sequence.name} has no .ok marker`);
    assert.deepEqual(sequence.frames, ['f_00000.png', 'f_00001.png', 'f_00002.png', 'f_00003.png'], sequence.name);
  }

  // (c) the picture is the raster, sampled by IR frame
  if (ffmpeg) {
    const top = await pixel(ffmpeg, path.join(job.framesDir, frames[0]), 160, 50);
    const bottom0 = await pixel(ffmpeg, path.join(job.framesDir, frames[0]), 160, 140);
    const bottom3 = await pixel(ffmpeg, path.join(job.framesDir, frames[3]), 160, 140);
    assert.ok(isCyan(top), `the static layer must be cyan, got ${top}`);
    assert.ok(isRed(bottom0), `the keyed layer starts red, got ${bottom0}`);
    assert.ok(isBlue(bottom3), `the keyed layer turns blue at t=${KEY_T}, got ${bottom3}`);
  }

  // ---- second job: everything in the cache, nothing re-rendered -----------
  const second = [];
  const again = await renderFrames({
    dir: root, project, from: 0, to: TO, scale: 1, samples: 2,
    onLog: (line) => second.push(String(line)),
  });
  const repeatLines = second.filter((line) => line.startsWith('raster '));
  assert.equal(repeatLines.length, 3, `no raster lines on the second run:\n${second.join('')}`);
  for (const line of repeatLines) {
    assert.match(line, / 0 rendered,/, `the second run must render no raster: ${line.trim()}`);
    assert.match(line, /cached/, `the second run must report cache hits: ${line.trim()}`);
    assert.match(line, /staged hit/, `the sequence must not be staged twice: ${line.trim()}`);
  }
  const cachedAgain = await cachedFrames(root);
  assert.equal(cachedAgain.length, cached.length, 'the second run must not add cache entries');
  assert.equal((await fs.readdir(again.framesDir)).filter((name) => name.endsWith('.png')).length, again.count);
});
