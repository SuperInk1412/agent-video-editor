// Blender half of scripts/check-camfeed.mjs: the same rig rendered headless.
// A live feed still must show the marker upright; a delay-1 feed rendered as
// frames must be empty on the first frame and show the marker on the next.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadProject } from '../engine/storage.js';
import { renderStill, renderFrames } from '../engine/blender.js';


/** One RGB pixel of a PNG at fractional position (fx, fy), read through ffmpeg. */
function pixel(file, fx, fy) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-v', 'error', '-i', file,
      '-vf', `crop=1:1:trunc(iw*${fx}):trunc(ih*${fy})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || buf.length < 3) reject(new Error(`pixel read failed: ${err.slice(-300)}`));
      else resolve([buf[0], buf[1], buf[2]]);
    });
  });
}

/** [top, bottom] RGB at 1/4 and 3/4 height, horizontally centred. */
const samples = async (file) => [await pixel(file, 0.5, 0.25), await pixel(file, 0.5, 0.75)];

export async function blenderStill(projectDir, { buildProject, isRed, isBlue }) {
  const dark = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;
  const results = [];

  await buildProject(projectDir, { delay: 0 });
  const live = await renderStill({
    dir: projectDir, project: await loadProject(projectDir), time: 0.5, scale: 0.25, samples: 4,
    out: path.join(projectDir, 'blender-live.png'),
  });
  const [top, bottom] = await samples(live);
  console.log(`[camfeed] blender live: top=${top} bottom=${bottom}`);
  results.push(['blender live feed shows the source picture upright', isRed(top) && isBlue(bottom)]);

  await buildProject(projectDir, { delay: 1 });
  const { framesDir, from } = await renderFrames({
    dir: projectDir, project: await loadProject(projectDir), from: 0, to: 2 / 30, scale: 0.25, samples: 4,
  });
  const first = await samples(path.join(framesDir, `f_${String(from).padStart(4, '0')}.png`));
  const next = await samples(path.join(framesDir, `f_${String(from + 1).padStart(4, '0')}.png`));
  console.log(`[camfeed] blender delay: first=${first.join(' | ')} next=${next.join(' | ')}`);
  results.push(['blender delay feed is empty on its first frame', dark(first[0]) && dark(first[1])]);
  results.push(['blender delay feed shows the previous frame next', isRed(next[0]) && isBlue(next[1])]);
  await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});

  let ok = true;
  for (const [name, pass] of results) {
    console.log(`[camfeed] ${pass ? 'PASS' : 'FAIL'} ${name}`);
    ok &&= pass;
  }
  return ok;
}
