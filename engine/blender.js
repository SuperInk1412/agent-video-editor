// Blender render backend: prepare assets, build a job, run headless, report progress.
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../core/store.js';
import { encodeSequence, extractSequence, fileExists, hashOf } from './media.js';
import { is3D, writeShot } from './shot.js';
import { prepareObjectSequences } from './media-objects.js';
import { which } from './which.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '../blender/vdm_render.py');

const CANDIDATES = () => [
  process.env.VDM_BLENDER,
  'E:/mvtools/blender/blender-5.0.1-windows-x64/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe',
  'C:/Program Files/Blender Foundation/Blender 4.2/blender.exe',
  '/Applications/Blender.app/Contents/MacOS/Blender',
].filter(Boolean);

let found = null;
export async function findBlender({ refresh = false } = {}) {
  if (found && !refresh) return found;
  const cands = [...CANDIDATES()];
  // scan the default install root for any version
  for (const root of ['C:/Program Files/Blender Foundation', 'E:/mvtools/blender']) {
    try {
      for (const d of await fs.readdir(root)) {
        cands.push(path.join(root, d, 'blender.exe'));
        cands.push(path.join(root, d, 'blender-5.0.1-windows-x64', 'blender.exe'));
      }
    } catch { /* ignore */ }
  }
  for (const c of cands) {
    if (await fileExists(c)) { found = c; return c; }
  }
  const onPath = which('blender');
  if (onPath) { found = onPath; return found; }
  throw new Error('Blender not found. Add it to PATH or set VDM_BLENDER to the blender executable');
}

export async function blenderVersion() {
  const exe = await findBlender();
  const { stdout } = await execFileP(exe, ['--version'], { windowsHide: true });
  return { exe, version: stdout.split(/\r?\n/)[0].trim() };
}

/** Extract every video element to a PNG sequence (cached by content hash). */
export async function prepareSequences(dir, project, { onLog } = {}) {
  const p = paths(dir);
  const { width, height, fps } = project.meta;
  const out = JSON.parse(JSON.stringify(project));
  const seqRoot = path.join(p.cache, 'src');
  await fs.mkdir(seqRoot, { recursive: true });
  for (const el of out.elements) {
    if (el.type !== 'video' || !el.src) continue;
    const src = path.isAbsolute(el.src) ? el.src : path.join(p.root, el.src);
    if (!(await fileExists(src))) continue;
    const key = hashOf({ src, in: el.srcIn || 0, d: el.duration, fps, w: width, h: height });
    const seqDir = path.join(seqRoot, `${el.id}-${key}`);
    const marker = path.join(seqDir, '.ok');
    if (!(await fileExists(marker))) {
      onLog?.(`extract ${el.id} -> ${seqDir}`);
      await extractSequence({
        src, outDir: seqDir, srcIn: el.srcIn || 0, duration: el.duration,
        fps, width, height, onLog,
      });
      await fs.writeFile(marker, 'ok');
    }
    el._sequenceDir = seqDir;
  }
  await prepareObjectSequences(dir, out, { onLog });
  return out;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* ignore */ }
}

/** Run one blender job. Returns {code, log, progress, seconds}. */
export async function runJob(dir, job, { onProgress, onLog, signal } = {}) {
  const exe = await findBlender();
  const p = await (async () => { const x = paths(dir); await fs.mkdir(path.join(x.cache, 'jobs'), { recursive: true }); return x; })();
  const jobId = `${job.mode}-${Date.now()}`;
  const jobFile = path.join(p.cache, 'jobs', `${jobId}.json`);
  const projFile = path.join(p.cache, 'jobs', `${jobId}-project.json`);

  const seqProject = await prepareSequences(dir, job.project, { onLog });
  await fs.writeFile(projFile, JSON.stringify(seqProject, null, 2));
  const payload = { ...job, project: projFile, root: p.root };
  delete payload.projectData;
  // 3D shot: bake city + per-frame camera once, let Blender consume the same package
  if (is3D(job.project)) {
    // the job copy carries the extracted sequences of video planes
    const { file } = await writeShot(dir, seqProject, { fps: job.project.meta.fps });
    payload.shot = file;
  }
  await fs.writeFile(jobFile, JSON.stringify(payload, null, 2));

  const args = [
    '-b', '--factory-startup', '-noaudio', '--python-exit-code', '1',
    '-P', ENTRY, '--', '--job', jobFile,
  ];
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, cwd: p.root });
    let log = '';
    let buf = '';
    const onAbort = () => { killTree(child); reject(new Error('cancelled')); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const handleLine = (line) => {
      if (line.startsWith('VDM_PROGRESS ')) {
        try {
          const ev = JSON.parse(line.slice('VDM_PROGRESS '.length));
          onProgress?.(ev);
        } catch { /* ignore */ }
      } else if (line.trim()) {
        onLog?.(line);
      }
      log += line + '\n';
      if (log.length > 400000) log = log.slice(-200000);
    };
    child.stdout.on('data', (d) => {
      buf += String(d);
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      parts.forEach(handleLine);
    });
    child.stderr.on('data', (d) => {
      const s = String(d);
      log += s;
      onLog?.(s.trim());
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf) handleLine(buf);
      if (code === 0) resolve({ code, log, seconds: (Date.now() - t0) / 1000 });
      else {
        const err = new Error(`blender exited ${code}`);
        err.log = log.slice(-4000);
        reject(err);
      }
    });
  });
}

export async function renderStill({ dir, project, time = 0, out, scale = 1, samples = 16, onLog }) {
  const p = paths(dir);
  const outPath = out ? path.resolve(out) : path.join(p.frames, `still-${Date.now()}.png`);
  await runJob(dir, {
    mode: 'still', time, out: outPath, scale, samples, project,
  }, { onLog });
  return outPath;
}

/** Render a time range to a PNG sequence, returns {framesDir, from, to, count}. */
export async function renderFrames({ dir, project, from = 0, to = 3, scale = 1, samples = 16, onProgress, onLog, signal }) {
  const p = paths(dir);
  const fps = project.meta.fps;
  const f0 = Math.round(from * fps) + 1;
  const f1 = Math.max(f0, Math.round(to * fps));
  const framesDir = path.join(p.cache, 'frames', `job-${Date.now()}`);
  await fs.mkdir(framesDir, { recursive: true });
  await runJob(dir, {
    mode: 'frames', from, to, framesDir, scale, samples, project,
  }, { onProgress, onLog, signal });
  return { framesDir, from: f0, to: f1, count: f1 - f0 + 1, fps };
}

/** Render a range and encode it with the project audio into an mp4. */
export async function renderVideo({
  dir, project, from = 0, to = null, out, scale = 1, samples = 16, crf = 18,
  onProgress, onLog, signal,
}) {
  const p = paths(dir);
  const dur = project.meta.duration;
  const end = Math.min(to ?? dur, dur);
  const { framesDir, count, from: f0, fps } = await renderFrames({
    dir, project, from, to: end, scale, samples, onProgress, onLog, signal,
  });
  const outPath = out ? path.resolve(out) : path.join(p.renders, `render-${Date.now()}.mp4`);
  const audio = project.meta.audio?.src
    ? (path.isAbsolute(project.meta.audio.src) ? project.meta.audio.src : path.join(p.root, project.meta.audio.src))
    : null;
  const hasAudio = audio && (await fileExists(audio));
  await encodeSequence({
    framesDir,
    pattern: 'f_%04d.png',
    startNumber: f0,
    fps,
    out: outPath,
    audio: hasAudio ? audio : null,
    audioOffset: -from + (hasAudio ? (project.meta.audio.offset || 0) : 0),
    gain: project.meta.audio?.gain || 0,
    crf,
    onLog,
  });
  return { out: outPath, frames: count, seconds: count / fps };
}
