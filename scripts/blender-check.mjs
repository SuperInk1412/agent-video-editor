// Smoke test for the render backend on this machine:
// find Blender + ffmpeg, build a throwaway project (text, shape, video), render one still.
//
//   npm run blender:check            # keeps nothing
//   npm run blender:check -- --keep  # keeps the temp project and prints where it is
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { saveProject } from '../engine/storage.js';
import { blenderVersion, renderStill } from '../engine/blender.js';
import { findBin } from '../engine/media.js';

const execFileP = promisify(execFile);
const keep = process.argv.includes('--keep');
const step = (msg) => console.log(`[check] ${msg}`);

async function main() {
  const { exe, version } = await blenderVersion();
  step(`blender  ${version}  (${exe})`);
  const ffmpeg = await findBin('ffmpeg');
  step(`ffmpeg   ${ffmpeg}`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-check-'));
  try {
    await fs.mkdir(path.join(dir, 'media'));
    await execFileP(ffmpeg, [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-t', '2',
      '-pix_fmt', 'yuv420p', path.join(dir, 'media', 'clip.mp4'),
    ]);
    const project = createProject({ title: 'check', width: 640, height: 360, duration: 2 });
    applyOps(project, [
      { op: 'addElement', element: { type: 'video', src: 'media/clip.mp4', start: 0, duration: 2 } },
      { op: 'addElement', element: { type: 'shape', start: 0, duration: 2, style: { fill: '#ff2a4d', w: 400, h: 40 }, transform: { y: 120 } } },
      { op: 'addElement', element: { type: 'text', start: 0, duration: 2, style: { text: '渲染检查 OK', size: 56 } } },
    ]);
    await saveProject(dir, project, { by: 'check' });

    const out = path.join(dir, 'still.png');
    const t0 = Date.now();
    await renderStill({ dir, project, time: 1, out, scale: 1, samples: 4 });
    const st = await fs.stat(out);
    step(`still    ${out} (${Math.round(st.size / 1024)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    step('PASS — Blender can build and render a project here');
    if (keep) step(`kept ${dir}`);
  } finally {
    if (!keep) await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[check] FAIL — ${e.message}`);
  if (e.log) console.error(String(e.log).trim().split(/\r?\n/).slice(-25).join('\n'));
  process.exitCode = 1;
});
