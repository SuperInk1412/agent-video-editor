import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectService } from '../engine/projects.js';
import { findBlender, renderStill } from '../engine/blender.js';
import { findBin } from '../engine/media.js';

test('Blender consumes extracted 3D video frames instead of a missing-media placeholder', { timeout: 45000 }, async (t) => {
  let ffmpeg;
  try { await findBlender(); ffmpeg = await findBin('ffmpeg'); }
  catch { return t.skip('Blender and ffmpeg are required'); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-video-plane-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'media'));
  const run = promisify(execFile);
  await run(ffmpeg, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=32x32:r=4:d=0.5',
    '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=4:d=0.5',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-pix_fmt', 'yuv420p', path.join(root, 'media', 'clip.mp4')]);
  const projects = projectService(root);
  await projects.transact({ command: { type: 'initialize', options: { width: 64, height: 64, duration: 1, fps: 4, background: '#000000' } } });
  const { project } = await projects.transact({ ops: [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    { op: 'worldSet', patch: { fog: { strength: 0.05, color: '#000000' } } },
    { op: 'objectAdd', object: { id: 'plane', type: 'video', src: 'media/clip.mp4', duration: 1,
      pivot: [0, 0.32, 0], geom: { w: 0.64, h: 0.64, d: 0.01 } } },
  ] });
  const pixels = [];
  for (const time of [0.25, 0.75]) {
    const out = path.join(root, `frame-${time}.png`);
    await renderStill({ dir: root, project, time, out, scale: 1, samples: 2 });
    const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', out, '-vf', 'crop=1:1:32:32', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    pixels.push([...stdout.subarray(0, 3)]);
  }
  assert.ok(pixels[0][0] > 120 && pixels[0][2] < 100, `first half must be red, got ${pixels[0]}`);
  assert.ok(pixels[1][2] > 120 && pixels[1][0] < 100, `second half must be blue, got ${pixels[1]}`);
  const files = await fs.readdir(path.join(root, '.vdm', 'cache'));
  const shot = JSON.parse(await fs.readFile(path.join(root, '.vdm', 'cache', files.find((name) => name.startsWith('shot-'))), 'utf8'));
  const sequence = shot.objects.find((obj) => obj.id === 'plane').media.sequence;
  assert.equal(sequence.count, 4);
  assert.equal((await fs.readdir(sequence.dir)).filter((name) => name.endsWith('.png')).length, 4);
});
