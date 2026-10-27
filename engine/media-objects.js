// Video planes in the 3D scene: extract each one to a PNG sequence for Blender.
// Unlike 2D video elements (scaled + cropped to the project frame), a plane keeps
// the footage's own aspect; blender/vdm_objects.py fits it into the plane.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './storage.js';
import { mediaSpec, videoSpan } from '../core/objects-media.js';
import { fileExists, findBin, hashOf } from './media.js';

const MAX_W = 1920;

async function extractPlaneSequence({ src, outDir, srcIn, span, fps }) {
  const ffmpeg = await findBin('ffmpeg');
  await fs.mkdir(outDir, { recursive: true });
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, srcIn)), '-t', String(Math.max(1 / fps, span)), '-i', src,
    '-vf', `fps=${fps},scale='min(${MAX_W},iw)':-2`,
    '-start_number', '1', path.join(outDir, 'f_%05d.png'),
  ];
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg extract failed (${code}): ${err.slice(-400)}`))));
  });
  return (await fs.readdir(outDir)).filter((f) => f.endsWith('.png')).length;
}

/**
 * Adds `_sequenceDir` / `_sequenceCount` to every video plane in `project`
 * (a job copy, mutated in place). Cached by content hash like 2D sequences.
 */
export async function prepareObjectSequences(dir, project, { onLog } = {}) {
  const objs = project.scene?.objects || [];
  if (!objs.some((o) => o.type === 'video' && o.src)) return project;
  const p = paths(dir);
  const fps = Number(project.meta?.fps) || 24;
  const seqRoot = path.join(p.cache, 'src');
  await fs.mkdir(seqRoot, { recursive: true });
  for (const o of objs) {
    if (o.type !== 'video' || !o.src) continue;
    const m = mediaSpec(o);
    const src = path.isAbsolute(m.src) ? m.src : path.join(p.root, m.src);
    if (!(await fileExists(src))) continue;
    const span = videoSpan(o);
    const key = hashOf({ src, in: m.srcIn, span, fps, plane: 1 });
    const seqDir = path.join(seqRoot, `${o.id}-${key}`);
    const marker = path.join(seqDir, '.ok');
    let count;
    if (await fileExists(marker)) {
      count = Number(await fs.readFile(marker, 'utf8')) || 0;
    } else {
      onLog?.(`extract ${o.id} -> ${seqDir}`);
      count = await extractPlaneSequence({ src, outDir: seqDir, srcIn: m.srcIn, span, fps });
      await fs.writeFile(marker, String(count));
    }
    o._sequenceDir = seqDir;
    o._sequenceCount = count;
  }
  return project;
}
