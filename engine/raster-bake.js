// Code layers, baked for the Blender backend (docs/DESIGN-BACKEND-V2.md §6.1,
// §10.2 WP3.4).
//
// A `kind: "raster"` item (core/frame-ir.js) carries no pixels: it carries the
// request for one frame of one code source — `source`, `params`, `seed`,
// `size`, `mode` — with the parameters already evaluated by core/ (P2). Their
// pixels have exactly one source, the RenderWorkerPool (§5, P4), so before a
// job is handed to Blender every raster item is turned into the frame sequence
// the Python builder draws as an image plane:
//
//   v3.rasters[<item id>] = {
//     dir, from, to, pattern, width, height, frameOffset, count,
//     static, rendered, cached, fallbacks,
//   }
//
//   dir          `.vdm/cache/raster/seq/<signature>/` (regenerable, §5.5)
//   from / to    first / last IR frame the sequence covers (0 based — the
//                pool's own numbering, `frame` in render-workers/cache.js)
//   pattern      printf file name template; file index = IR - from + frameOffset
//   width/height the raster's pixel size (`content.size`), for diagnostics
//   static       one frame covers the range: the request never changed AND the
//                source declared `timeIndependent: true` (see below)
//
// Which frames (§10.2 WP3.4): **every frame of the job's range is one request
// to the pool** — `render(source, frame, params, seed)`. The picture is a
// function of the frame too: `vdm.t` / `vdm.frame` are legal inputs of a sketch
// (§6.2), so unchanged parameters are not proof that the picture stands still
// (rain, noise, a bouncing bar all move through `t`). Rendering every frame and
// reusing one would freeze the export while the preview keeps moving — exactly
// the preview/render disagreement the frame IR exists to remove. `useCache`
// keeps a repeated request cheap.
//
// The one exception is a source whose manifest declares `timeIndependent: true`
// (§6.1): the author states the picture does not depend on the clock, so a
// constant request may be baked once and held for the whole range. The flag is
// collected by the caller from the job's source registry
// (`core/code-layer.js::isTimeIndependentSource`, `engine/blender.js`) and
// passed in as a set of source ids; everything else is per frame.
//
// Failure is never fatal: a frame that fails (timeout, missing Electron, a
// crashing sketch) falls back to the last good frame of the same item — the
// preview's rule — and the log says `raster fallback`. An item with no good
// frame at all is simply absent from the payload, so the Python side draws
// nothing for it, exactly like the preview while its PNG is missing.
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, rasterDir, sha256 } from './render-workers/cache.js';
import { createRenderPool } from './render-workers/pool.js';
import { DEFAULT_EXPORT_TIMEOUT_MS } from './render-workers/protocol.js';
import { shotV3FrameItems } from './shot.js';

/** File names inside a staged sequence (the video path's convention). */
export const RASTER_SEQUENCE_PATTERN = 'f_%05d.png';
/** Marker that proves a staged directory holds every frame of one signature. */
const MARKER = '.ok';
const SEQUENCE_FILE_RE = /^f_\d{5}\.png$/;

/** Sub-directory of `.vdm/cache/raster/` holding the per-item sequences. */
export const sequenceRoot = (root) => path.join(rasterDir(root), 'seq');

/** `f_%05d.png` -> `f_00007.png` (the description's printf template). */
function nameAt(pattern, index) {
  return pattern.replace(/%0?(\d*)d/, (_, width) => String(index).padStart(Number(width) || 1, '0'));
}

/**
 * What one raster item asks the pool for, over `[f0, f1]` (1-based render
 * frames, the base of `shotV3FrameItems`).
 *
 * `entries` is every frame the item draws in that range (ascending). `static`
 * means one request covers them all, so only `entries[0]` has to be rendered —
 * but only for a source whose manifest declares `timeIndependent: true`: a
 * sketch may animate through `vdm.t` / `vdm.frame` with unchanged params, and
 * reusing one frame would freeze the picture in the render while the preview
 * keeps moving. Everything else is per frame (the pool cache makes a repeated
 * request cheap).
 */
export function rasterPlan(v3, f0, f1, { timeIndependent = new Set() } = {}) {
  const first = Math.max(1, Math.round(Number(f0) || 1));
  const last = Math.max(first, Math.round(Number(f1) || first));
  const groups = new Map();
  for (let frame = first; frame <= last; frame++) {
    for (const item of shotV3FrameItems(v3, frame)) {
      if (!item || item.kind !== 'raster') continue;
      const content = item.content || {};
      const sourceId = content.source && content.source.id ? String(content.source.id) : '';
      if (!sourceId) continue;
      const runtime = content.source.runtime || null;
      const params = content.params || {};
      const seed = Number(content.seed) || 0;
      const size = Array.isArray(content.size) && content.size.length >= 2
        ? [Math.floor(Number(content.size[0])), Math.floor(Number(content.size[1]))]
        : (Array.isArray(item.size) && item.size.length >= 2 ? [Math.floor(Number(item.size[0])), Math.floor(Number(item.size[1]))] : null);
      const mode = content.mode === 'bake' ? 'bake' : 'live';
      // Everything the pool's cache key calls an input, so "the same request"
      // means "the same picture" (render-workers/cache.js::cacheKey).
      const key = canonicalJson({ source: sourceId, runtime, params, seed, size, mode });
      let group = groups.get(item.id);
      if (!group) {
        group = { id: String(item.id), entries: [] };
        groups.set(group.id, group);
      }
      group.entries.push({ frame, ir: frame - 1, sourceId, runtime, params, seed, size, mode, key });
    }
  }
  const plans = [];
  for (const group of groups.values()) {
    const head = group.entries[0];
    const tail = group.entries[group.entries.length - 1];
    const reusable = timeIndependent instanceof Set ? timeIndependent.has(head.sourceId) : false;
    const isStatic = reusable && group.entries.every((entry) => entry.key === head.key);
    plans.push({
      id: group.id,
      static: isStatic,
      entries: isStatic ? [head] : group.entries,
      fromIR: head.ir,
      toIR: tail.ir,
      size: head.size,
    });
  }
  plans.sort((a, b) => (a.fromIR - b.fromIR) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return plans;
}

/**
 * Bake every raster item of a job and return the `v3.rasters` description.
 *
 * `timeIndependent` is the set of source ids whose manifest declares
 * `timeIndependent: true` (`core/code-layer.js::isTimeIndependentSource`);
 * `engine/blender.js` builds it from the job's source registry. The default is
 * empty — every frame is rendered, which is always correct.
 *
 * The pool is created here, used for every item and closed again (one pool per
 * job, §5.1); a caller that already owns one may pass `pool`.
 */
export async function bakeRasterLayers(root, v3, {
  fps = 24, f0 = 1, f1 = 1, onLog, signal, pool = null, timeIndependent = new Set(),
} = {}) {
  if (!v3 || !Array.isArray(v3.items) || !v3.items.length) return {};
  const plans = rasterPlan(v3, f0, f1, { timeIndependent });
  if (!plans.length) return {};
  const own = pool ? null : createRenderPool({ root, timeoutMs: DEFAULT_EXPORT_TIMEOUT_MS });
  const active = pool || own;
  const rasters = {};
  let gaveUp = false;
  try {
    for (const plan of plans) {
      if (gaveUp) break;
      signal?.throwIfAborted();
      let result;
      try {
        result = await bakeRaster(active, root, plan, { fps, onLog, signal });
      } catch (error) {
        if (error?.code === 'CANCELLED' || signal?.aborted) throw error;
        onLog?.(`raster fallback: ${plan.id} — ${error?.code || 'RASTER_FAILED'}: ${error?.message || error}`);
        continue;
      }
      if (result?.giveUp) {
        gaveUp = true;
        onLog?.(`raster fallback: the render pool is unavailable (${result.reason}) — code layers are left out of this job`);
        continue;
      }
      if (result?.raster) rasters[plan.id] = result.raster;
    }
  } finally {
    if (own) await own.close().catch(() => {});
  }
  return rasters;
}

/** Render one item's frames and stage them as a contiguous sequence. */
async function bakeRaster(pool, root, plan, { fps, onLog, signal }) {
  const log = (line) => onLog?.(line);
  const size = plan.size || [1920, 1080];
  const rendered = [];
  let renderedCount = 0;
  let cachedCount = 0;
  let fallbacks = 0;
  for (const entry of plan.entries) {
    signal?.throwIfAborted();
    try {
      // `useCache: true`: a frame already in `.vdm/cache/raster/` is copied,
      // not rendered. `mode` (`live` / `bake`) is a *preview* policy (§6.1) —
      // an export job is the bake, so it fills the cache in either mode.
      const out = await pool.render({
        sourceId: entry.sourceId,
        runtime: entry.runtime,
        params: entry.params,
        frame: entry.ir,
        fps,
        size: entry.size || size,
        seed: entry.seed,
        useCache: true,
      });
      if (!out || !out.pngPath) throw Object.assign(new Error('the pool returned no PNG'), { code: 'RASTER_FAILED' });
      rendered.push({ ir: entry.ir, pngPath: out.pngPath, cacheKey: out.cacheKey });
      if (out.cached) cachedCount += 1; else renderedCount += 1;
    } catch (error) {
      if (error?.code === 'DEPENDENCY_MISSING') return { giveUp: true, reason: error.message };
      if (signal?.aborted) throw error;
      fallbacks += 1;
      log(`raster fallback: ${plan.id} f${entry.frame} (ir${entry.ir}) — ${error?.code || 'RASTER_FAILED'}: ${error?.message || error}`);
    }
  }
  if (!rendered.length) {
    log(`raster fallback: ${plan.id} has no frame (${plan.entries.length} tried) — the layer is left out`);
    return null;
  }
  const fromIR = plan.fromIR;
  const count = plan.toIR - fromIR + 1;
  // The signature covers every input the staged bytes depend on: the item, the
  // frame range and each frame's own cache key (source snapshot, params, size,
  // seed, fps, runtime/vendor versions). It is therefore an immutable content
  // address — a changed source or parameter set stages a new directory.
  const signature = sha256(canonicalJson({
    v: 1,
    id: plan.id,
    fps,
    from: fromIR,
    to: plan.toIR,
    size,
    frames: rendered.map((record) => [record.ir, record.cacheKey]),
  })).slice(0, 32);
  const dir = path.join(sequenceRoot(root), signature);
  const pattern = RASTER_SEQUENCE_PATTERN;
  let staged = 0;
  if (!(await stagedComplete(dir, signature, count))) {
    staged = await stageSequence(dir, pattern, fromIR, count, rendered);
  }
  const rel = path.relative(root, dir).split(path.sep).join('/');
  log(`raster ${plan.id}: ir${fromIR}..${plan.toIR} ${count} frame${count === 1 ? '' : 's'}`
    + ` (${plan.static ? 'timeIndependent, one frame' : 'per-frame'}) — ${renderedCount} rendered,`
    + ` ${cachedCount} cached, ${fallbacks} fallback, ${staged ? `${staged} staged` : 'staged hit'}`
    + ` -> ${rel}`);
  return {
    raster: {
      dir,
      from: fromIR,
      to: plan.toIR,
      pattern,
      width: size[0],
      height: size[1],
      frameOffset: 0,
      count,
      static: plan.static,
      rendered: renderedCount,
      cached: cachedCount,
      fallbacks,
    },
  };
}

/** True when this signature's directory already holds every frame. */
async function stagedComplete(dir, signature, count) {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8'));
    if (!marker || marker.signature !== signature || Number(marker.count) !== count) return false;
    const names = await fs.readdir(dir);
    return names.filter((name) => SEQUENCE_FILE_RE.test(name)).length >= count;
  } catch {
    return false;
  }
}

/**
 * Copy the rendered frames into `dir` as `f_00000.png … f_<count-1>.png`.
 *
 * A frame inside the range that was never rendered (the item is hidden there,
 * or the render failed) holds its predecessor — the preview's "nearest good
 * frame" rule — so the sequence is contiguous and Blender never asks for a
 * file that is not there. Leading gaps hold the first good frame.
 */
async function stageSequence(dir, pattern, fromIR, count, rendered) {
  const slots = new Array(count).fill(null);
  for (const record of rendered) {
    const index = record.ir - fromIR;
    if (index >= 0 && index < count) slots[index] = record.pngPath;
  }
  let lastGood = null;
  let firstGood = null;
  for (let i = 0; i < count; i++) {
    if (slots[i]) {
      lastGood = slots[i];
      if (!firstGood) firstGood = slots[i];
    } else if (lastGood) {
      slots[i] = lastGood;
    }
  }
  if (!firstGood) return 0;
  for (let i = 0; i < count; i++) if (!slots[i]) slots[i] = firstGood;

  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    await fs.copyFile(slots[i], path.join(dir, nameAt(pattern, i)));
  }
  await fs.writeFile(path.join(dir, MARKER), JSON.stringify({
    signature: path.basename(dir),
    count,
    pattern,
    from: fromIR,
    at: new Date().toISOString(),
  }, null, 2));
  return count;
}

export default bakeRasterLayers;
