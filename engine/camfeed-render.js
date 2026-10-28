// Camera feeds in the Blender render (docs/DESIGN-CAMFEED-PARENTS.md §1.3).
//
// Before a job renders, every feed source camera gets its own pass: the
// project as that camera films it (core/camfeed.js::sourceProject), its hidden
// live feeds removed, the global post chain neutral (the post runs once, on the
// final picture). Passes run dependencies first and write PNG frames into
// `.vdm/cache/feeds/<hash>/f_####.png` (absolute frame numbers, as the frames
// job writes them). Each camfeed element then carries
//   _feedDir     the directory its frames come from
//   _feedHidden  [[f0, f1], ...] frames where the camera on air must skip it
// and the Blender builder loads `f_<frame - delay>.png` every frame. A camera's
// delay-1 feed of itself inside its own pass reads the pass's own previous
// frame, which Blender has just written.
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './storage.js';
import { fileExists, hashOf } from './media.js';
import { cameraAtTime } from '../core/camera.js';
import {
  elementsFor, feedPlan, hiddenFeeds, isFeed, normalizeFeed, sourceProject,
} from '../core/camfeed.js';

const NEUTRAL_FX = { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 };
const PASS_VERSION = 1;

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Frames [f0, f1] a job writes (vdm_render.py numbering: frame = round(t * fps) + 1). */
export function jobFrames(job, fps, duration) {
  if (job.mode === 'still') {
    const f = Math.round((Number(job.time) || 0) * fps) + 1;
    return [f, f];
  }
  const f0 = Math.round((Number(job.from) || 0) * fps) + 1;
  const f1 = Math.max(f0, Math.round((job.to == null ? duration : Number(job.to)) * fps));
  return [f0, f1];
}

/** Frames of the source picture that the feed elements of `camId` show within [f0, f1]. */
export function neededFrames(project, camId, [f0, f1], fps) {
  let lo = Infinity, hi = -Infinity;
  for (const el of project.elements || []) {
    if (!isFeed(el) || el.visible === false) continue;
    const feed = normalizeFeed(el.feed);
    if (feed.camera !== camId) continue;
    const a = Math.max(f0, Math.round(Number(el.start) * fps) + 1);
    const b = Math.min(f1, Math.round((Number(el.start) + Number(el.duration)) * fps));
    if (b < a) continue;
    lo = Math.min(lo, a - feed.delay);
    hi = Math.max(hi, b - feed.delay);
  }
  if (!(hi >= lo)) return null;
  return [Math.max(1, lo), hi];
}

/** [[f0, f1], ...] runs of frames where the camera on air must not show `el`. */
export function hiddenRuns(program, plan, el, [f0, f1], fps) {
  const runs = [];
  let open = null;
  for (let f = f0; f <= f1; f++) {
    const cam = cameraAtTime(program, (f - 1) / fps);
    const hide = !!cam && hiddenFeeds(plan, cam.id).has(el.id);
    if (hide && open == null) open = f;
    if (!hide && open != null) { runs.push([open, f - 1]); open = null; }
  }
  if (open != null) runs.push([open, f1]);
  return runs;
}

/**
 * Resolve every camfeed element of `job.project` to rendered frames. `runPass`
 * is the frames runner (engine/blender.js::runJob) — passed in to avoid an
 * import cycle. Returns a new project for the job; projects without feeds come
 * back unchanged.
 */
export async function prepareFeeds(dir, job, runPass, { onLog, signal } = {}) {
  const project = job.project;
  const els = project.elements || [];
  if (!els.some((el) => isFeed(el) && !el._feedDir)) return project;
  const p = paths(dir);
  const fps = Number(project.meta.fps) || 24;
  const plan = feedPlan(project);
  const range = jobFrames(job, fps, Number(project.meta.duration) || 0);
  const resolved = clone(project);
  const dirs = new Map(); // camera id -> frames directory

  const attach = (target, viewer) => {
    for (const el of target.elements || []) {
      if (!isFeed(el)) continue;
      const feed = normalizeFeed(el.feed);
      if (feed.camera === viewer && feed.delay === 1) continue; // set by the pass itself
      if (dirs.has(feed.camera)) el._feedDir = dirs.get(feed.camera);
    }
  };

  for (const camId of plan.sources) {
    signal?.throwIfAborted();
    const need = neededFrames(project, camId, range, fps);
    if (!need) continue;
    const base = sourceProject(resolved, camId);
    if (!base) continue;
    const variant = clone({ ...base, elements: elementsFor(base, plan, camId) });
    variant.meta = { ...variant.meta, fx: { ...(variant.meta.fx || {}), ...NEUTRAL_FX } };
    attach(variant, camId);
    const key = hashOf({
      v: PASS_VERSION, camId, need, scale: job.scale ?? 1, samples: job.samples ?? 16,
      project: { ...variant, rev: undefined },
    });
    const out = path.join(p.cache, 'feeds', key);
    for (const el of variant.elements) {
      const feed = isFeed(el) ? normalizeFeed(el.feed) : null;
      if (feed && feed.camera === camId && feed.delay === 1) el._feedDir = out;
    }
    if (!(await fileExists(path.join(out, '.ok')))) {
      onLog?.(`camfeed pass ${camId} frames ${need[0]}-${need[1]} -> ${out}`);
      await fs.rm(out, { recursive: true, force: true });
      await fs.mkdir(out, { recursive: true });
      await runPass(dir, {
        mode: 'frames', from: Math.max(0, (need[0] - 1) / fps), to: need[1] / fps, framesDir: out,
        scale: job.scale ?? 1, samples: job.samples ?? 16, project: variant,
      }, { onLog, signal });
      await fs.writeFile(path.join(out, '.ok'), JSON.stringify({ camId, need }));
    }
    dirs.set(camId, out);
  }

  attach(resolved, null);
  for (const el of resolved.elements) {
    if (!isFeed(el)) continue;
    if (!el._feedDir) el._feedDir = ''; // source never rendered: the builder hides it
    el._feedHidden = hiddenRuns(resolved, plan, el, range, fps);
  }
  return resolved;
}
