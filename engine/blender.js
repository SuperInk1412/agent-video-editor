// Blender render backend: prepare assets, build a job, run headless, report progress.
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { paths } from './storage.js';
import { audioElements } from '../core/audio.js';
import { elementLinkOverlayTable } from '../core/link-eval.js';
import { encodeSequence, extractSequence, fileExists, hashOf, hashFile } from './media.js';
import { buildShotV3, is3D, loadProjectFonts, writeShot } from './shot.js';
import { prepareObjectSequences } from './media-objects.js';
import { jobFrames, prepareFeeds } from './camfeed-render.js';
import { bakeElementPlacements } from './element-bake.js';
import { buildAudioMix } from './audio-mix.js';
import { which } from './which.js';
import { runProcess } from './process.js';

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
export async function prepareSequences(dir, project, { onLog, signal } = {}) {
  const p = paths(dir);
  const { width, height, fps } = project.meta;
  const out = JSON.parse(JSON.stringify(project));
  const seqRoot = path.join(p.cache, 'src');
  await fs.mkdir(seqRoot, { recursive: true });
  for (const el of out.elements) {
    if (el.type !== 'video' || !el.src) continue;
    const src = path.isAbsolute(el.src) ? el.src : path.join(p.root, el.src);
    if (!(await fileExists(src))) continue;
    const before = await fs.stat(src);
    const digest = await hashFile(src, { signal });
    const key = hashOf({ version: 2, digest, in: el.srcIn || 0, d: el.duration, fps, w: width, h: height, fit: el.style?.fit || 'cover', loop: el.loop === true });
    const seqDir = path.join(seqRoot, key);
    const marker = path.join(seqDir, '.ok');
    if (!(await fileExists(marker))) {
      onLog?.(`extract ${el.id} -> ${seqDir}`);
      const temporary = await fs.mkdtemp(path.join(seqRoot, '.building-'));
      try {
        const result = await extractSequence({
          src, outDir: temporary, srcIn: el.srcIn || 0, duration: el.duration,
          fps, width, height, fit: el.style?.fit || 'cover', loop: el.loop === true, onLog, signal,
        });
        if (!result.count) throw new Error(`no video frames extracted for ${el.id}`);
        const after = await fs.stat(src);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw Object.assign(new Error('source changed during extraction'), { code: 'SOURCE_CHANGED' });
        await fs.writeFile(path.join(temporary, '.ok'), JSON.stringify({ version: 2, digest, count: result.count }));
        try { await fs.rename(temporary, seqDir); }
        catch (e) {
          // Another process may have published this immutable content first.
          // Windows reports an existing directory as EPERM/EACCES instead of
          // EEXIST, so accept those when the completion marker is there.
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(e.code) || !(await fileExists(marker))) throw e;
        }
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    }
    el._sequenceDir = seqDir;
  }
  await prepareObjectSequences(dir, out, { onLog });
  // 2D property links have no Python evaluator: sample the effective values JS
  // would draw (per render frame) and let vdm_build.py override its local `st`.
  // Only linked elements get a table, so existing jobs stay byte-identical.
  const linkFps = Number(out.meta?.fps) || 24;
  for (const el of out.elements || []) {
    const table = elementLinkOverlayTable(out, el, { fps: linkFps });
    if (table) el._linkOverlay = table;
  }
  return out;
}

/**
 * The frame IR of one job (`engine/shot.js::buildShotV3`), for a project that
 * has no 3D shot of its own. The Python builder reads these numbers instead of
 * evaluating the project itself (WP1.2, docs/DESIGN-BACKEND-V2.md §10.2).
 *
 * The range covers what `blender/vdm_render.py` will ask for: a still is the
 * one frame it clamps to, a frame range is `[f0, f1]`. It asks for the frame
 * number with Python's `round()`, whose halves go to the even number, while
 * `jobFrames` rounds them up — a time landing exactly between two frames can
 * therefore be one frame off, so one frame of slack is baked on each side.
 * No city snapshot is needed: a job on this path has no 3D world to draw
 * (`world.hash` stays null).
 */
function shotV3ForJob(project, job, fonts = null) {
  const fps = Number(project.meta?.fps) || 24;
  const duration = Number(project.meta?.duration) || 0;
  let [f0, f1] = jobFrames(job, fps, duration);
  if (job.mode === 'still') {
    // vdm_render.py::still clamps the frame to the last one the project covers
    const total = Math.max(1, Math.round(duration * fps));
    const frame = Math.min(total, Math.max(1, Math.round(f0)));
    f0 = frame;
    f1 = frame;
  }
  return buildShotV3(project, {
    fps,
    from: (Math.max(1, f0 - 1) - 1) / fps,
    to: (f1 + 1 - 1) / fps,
    city: { hash: null },
    fonts,
  });
}

/** Run one blender job. Returns {code, log, progress, seconds}. */
export async function runJob(dir, job, { onProgress, onLog, signal } = {}) {
  signal?.throwIfAborted();
  onProgress?.({ stage: 'preparing' });
  const exe = await findBlender();
  const p = await (async () => { const x = paths(dir); await fs.mkdir(path.join(x.cache, 'jobs'), { recursive: true }); return x; })();
  const jobId = `${job.mode}-${randomUUID()}`;
  const jobFile = path.join(p.cache, 'jobs', `${jobId}.json`);
  const projFile = path.join(p.cache, 'jobs', `${jobId}-project.json`);

  // Camera feeds render their source cameras first (engine/camfeed-render.js).
  const fed = await prepareFeeds(dir, job, runJob, { onLog, signal });
  const seqProject = await prepareSequences(dir, fed, { onLog, signal });
  // Node / spatially parented 2D elements: per-frame world matrices (3D route).
  if (is3D(fed)) {
    const fps = Number(seqProject.meta.fps) || 24;
    bakeElementPlacements(seqProject, jobFrames(job, fps, Number(seqProject.meta.duration) || 0), fps);
  }
  const payload = { ...job, project: projFile, root: p.root };
  delete payload.projectData;
  // 3D shot: bake city + per-frame camera once, let Blender consume the same package
  if (is3D(fed)) {
    // The prepared copy carries 3D video sequence paths and frame counts.
    const { file, shot } = await writeShot(dir, seqProject, { fps: job.project.meta.fps, signal });
    payload.shot = file;
    // WP1.2: vdm_build.py draws the frame IR, so the 2D layer reads the same
    // numbers the preview does. Added beside the legacy fields; nothing reads
    // it unless the Python builder is on the v3 path.
    seqProject.v3 = shot.v3;
  } else {
    // Text geometry (§4.4 v4): the meshes are typeset here, in JS, from the
    // project's font files — Blender only draws the vertices, so it needs no
    // font of its own. A font that cannot be found leaves the old FONT-curve
    // path in place for that element.
    seqProject.v3 = shotV3ForJob(seqProject, job, loadProjectFonts(seqProject, p.root));
  }
  await fs.writeFile(projFile, JSON.stringify(seqProject, null, 2));
  await fs.writeFile(jobFile, JSON.stringify(payload, null, 2));

  const args = [
    '-b', '--factory-startup', '-noaudio', '--python-exit-code', '1',
    '-P', ENTRY, '--', '--job', jobFile,
  ];
  onProgress?.({ stage: 'rendering' });
  let buffer = '';
  const result = await runProcess(exe, args, { cwd: p.root, signal, onLog,
    onStdout(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('VDM_PROGRESS ')) {
          let event;
          try { event = JSON.parse(line.slice(13)); } catch { continue; }
          onProgress?.(event);
        } else onLog?.(line);
      }
    },
  });
  return result;
}

export async function renderStill({ dir, project, time = 0, out, scale = 1, samples = 16, onLog, onProgress, signal }) {
  const p = paths(dir);
  const outPath = out ? path.resolve(out) : path.join(p.frames, `still-${Date.now()}.png`);
  await runJob(dir, {
    mode: 'still', time, out: outPath, scale, samples, project,
  }, { onLog, onProgress, signal });
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
  const hasElementAudio = audioElements(project).length > 0;
  const mixed = hasElementAudio ? await buildAudioMix({ dir: p.root, project, from, to: end }) : null;
  const legacyAudio = !hasElementAudio && !project.meta.audioMigrated && project.meta.audio?.src
    ? (path.isAbsolute(project.meta.audio.src) ? project.meta.audio.src : path.join(p.root, project.meta.audio.src))
    : null;
  const audio = mixed || legacyAudio;
  const hasAudio = audio && (await fileExists(audio));
  signal?.throwIfAborted();
  onProgress?.({ stage: 'encoding' });
  await encodeSequence({
    framesDir,
    pattern: 'f_%04d.png',
    startNumber: f0,
    fps,
    out: outPath,
    audio: hasAudio ? audio : null,
    audioOffset: mixed ? 0 : (-from + (hasAudio ? (project.meta.audio.offset || 0) : 0)),
    gain: mixed ? 0 : (project.meta.audio?.gain || 0),
    crf,
    onLog, signal,
  });
  return { out: outPath, frames: count, seconds: count / fps };
}
