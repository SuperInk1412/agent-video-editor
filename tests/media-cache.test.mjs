import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { prepareSequences } from '../engine/blender.js';
import { findBin, hashFile } from '../engine/media.js';

test('replacing media at the same path invalidates frames; concurrent builds publish complete caches', { timeout: 15000 }, async (t) => {
  let ffmpeg;
  try { ffmpeg = await findBin('ffmpeg'); } catch { return t.skip('ffmpeg not installed'); }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'media'));
  const src = path.join(dir, 'media', 'clip.mp4');
  const p = createProject({ width: 32, height: 32, fps: 2, duration: 1 });
  applyOp(p, { op: 'addElement', element: { type: 'video', src: 'media/clip.mp4', duration: 1 } });
  const make = (color) => promisify(execFile)(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=32x32:r=2`, '-t', '1', '-pix_fmt', 'yuv420p', src]);
  await make('red');
  const built = await Promise.all([prepareSequences(dir, p), prepareSequences(dir, p)]);
  const a = built[0].elements[0]._sequenceDir;
  assert.equal(built[1].elements[0]._sequenceDir, a);
  const first = await hashFile(path.join(a, 'f_00000.png'));
  assert.equal(JSON.parse(await fs.readFile(path.join(a, '.ok'), 'utf8')).count, 2);
  await make('blue');
  const b = (await prepareSequences(dir, p)).elements[0]._sequenceDir;
  assert.notEqual(a, b);
  assert.notEqual(await hashFile(path.join(b, 'f_00000.png')), first);
  assert.equal((await fs.readdir(path.dirname(b))).some((name) => name.startsWith('.building-')), false);
});
