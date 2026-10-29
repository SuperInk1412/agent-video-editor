// Inspect service — measurements over the frame IR
// (docs/DESIGN-BACKEND-V2.md §8.2, WP2.1).
//
// Pure Node: it opens a project with engine/storage.js (or takes a project
// object) and answers "what does this frame look like there" from
// core/frame-ir.js alone. No Electron, no WebGL, no editor process, no write.
//
// Four families of questions, each replacing a hand probe from
// docs/FIX-LAYER-ORDER-EMPTY-CLICK.md:
//
//   stackAt(project, t, { point })   draw order far -> near, per-item depth and
//                                    the item that owns a pixel (问题一 / 问题四)
//   coverage(project, { f0, f1 })    per frame, which items cover the sampled
//                                    pixel and who is in front (问题四 cam_8)
//   cutEdges(project)                element edges that miss a camera cut by
//                                    less than a frame (问题五 s1_w2, 0.99 f)
//   diff(a, b)                       one report for two revisions, in the
//                                    changed[{id,path,before,after}] shape of
//                                    §8.3, for the change-set service
//
// ... plus pxAt(), the analytic half of "what is at this pixel". It is geometry
// only: the report names what it cannot answer (it cannot read a pixel — there
// is no WebGL here; see `limitations`).
//
// Conventions shared with the renderers:
//   * a frame number is the unit of time (P5, `t = frame / fps`); `t` is rounded
//     to the nearest frame before anything is measured;
//   * pixel coordinates are project pixels of `meta.width x meta.height`, y
//     down, origin top-left — the IR's own unit. A canvas of the same aspect
//     gives the same answer at a different scale;
//   * order always comes from core/layers.js::orderLayers — the one rule the
//     preview, hit testing and the IR share. This module never invents a second
//     sort;
//   * "who is in front" is the camera ray (the same construction as
//     preview3d.js::ray) met with each item's plane, so it answers what the
//     depth buffer shows, not what the draw order happens to be;
//   * a pixel belongs to an item when the ray hits the item's quad inside its
//     local [-0.5, 0.5] box — the inverse of `itemModelMatrix`, not a projected
//     polygon. A huge plane seen almost edge-on can have a corner behind the
//     camera; the projected-polygon test the editor uses drops such a layer
//     instead of clipping it, and a measurement must not.
//
// Text: the frozen IR carries `size: null` for text until WP1.3 puts glyph
// geometry in it (§4.4), so a text quad is measured here — by the caller's
// `measureText(item)` when it has one (the editor's canvas), otherwise by
// `estimateTextBox()`, a deterministic advance-width table. Every item says
// which one it used (`sizeSource`), so an estimate is never mistaken for a
// measurement.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../engine/storage.js';
import { compileProject } from '../core/tracks.js';
import { buildFrameIR, itemModelMatrix, FRAME_IR_VERSION } from '../core/frame-ir.js';
import { cameraLayers, cameraRange } from '../core/camera.js';
import {
  layerOriginDistance, layerRayDepth, mul4, orderLayers,
} from '../core/layers.js';
import { fault } from './errors.js';

/** Repo root, for the offscreen pixel probe (the only measurement that needs Electron). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Bump when the shape of a report changes (this module never writes a project). */
export const INSPECT_VERSION = 1;

/** Grid a focus item is sampled on when it is not a single pixel (`coverage`). */
export const SAMPLE_GRID = 7;

const EPS = 1e-6;
const UNITS = { pixels: 'project pixels, y down, origin top-left', metres: 'world metres, y up' };

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const sum3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, -1];
};
const vec3 = (v) => (Array.isArray(v) && v.length >= 3 ? [num(v[0]), num(v[1]), num(v[2])] : [0, 0, 0]);
const round3 = (v) => Math.round(Number(v) * 1000) / 1000;
const round6 = (v) => Math.round(Number(v) * 1e6) / 1e6;

// ------------------------------------------------------------------ project

/**
 * Read a project from disk and prepare it for the IR (the same two calls
 * scripts/dump-ir.mjs makes). Read-only: nothing is locked or written, and no
 * runtime is started, so an inspector never queues behind the editor.
 */
export async function openProject(dir) {
  const project = await loadProject(dir);
  compileProject(project);
  return project;
}

/** `{ project, fps, size, duration }` — the small view every measurement needs. */
function prepare(project) {
  if (!project || typeof project !== 'object' || !project.meta) {
    throw fault('INVALID_ARGUMENT', 'inspect needs a loaded project object (use openProject(dir) or the runtime read)');
  }
  compileProject(project);
  const meta = project.meta;
  return {
    project,
    fps: num(meta.fps, 24) || 24,
    size: [num(meta.width, 1920) || 1920, num(meta.height, 1080) || 1080],
    duration: num(meta.duration),
  };
}

function assertTime(t) {
  const value = num(t, NaN);
  if (!Number.isFinite(value) || value < 0) throw fault('INVALID_ARGUMENT', 'time must be a finite number >= 0');
  return value;
}

/** Whole frame for a time (P5: only `/fps` instants exist). */
export function frameAt(project, t) {
  const p = prepare(project);
  return Math.round(assertTime(t) * p.fps);
}

/** `'live'` or an existing camera id; an unknown id is an error, not a fallback. */
function cameraIdOf(project, camera) {
  if (camera == null || camera === 'live') return 'live';
  const id = String(camera);
  const ids = (project.cameras || []).map((c) => c.id);
  if (!ids.includes(id)) throw fault('INVALID_ARGUMENT', `unknown camera ${id}`, { cameras: ids });
  return id;
}

function irAt(p, frame, camera) {
  return buildFrameIR(p.project, frame, { fps: p.fps, camera });
}

function frameOfOpts(p, t, opts) {
  if (opts.frame != null) {
    const f = num(opts.frame, NaN);
    if (!Number.isFinite(f) || f < 0) throw fault('INVALID_ARGUMENT', 'frame must be a finite number >= 0');
    return Math.round(f);
  }
  return Math.round(assertTime(t) * p.fps);
}

/** `[x, y]` or `{ x, y }` in project pixels. */
function normalizePoint(point) {
  if (point == null) return null;
  let x;
  let y;
  if (Array.isArray(point)) [x, y] = point;
  else ({ x, y } = point);
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw fault('INVALID_ARGUMENT', 'point needs finite x and y (project pixels)');
  }
  return [Number(x), Number(y)];
}

// -------------------------------------------------------------- projection

/** The perspective preview3d.js draws with (camera.fov is horizontal). */
function viewProjectionOf(ir) {
  const cam = ir.camera;
  const W = num(ir.size[0], 1920) || 1920;
  const H = num(ir.size[1], 1080) || 1080;
  const aspect = W / H;
  const vfov = (2 * Math.atan(Math.tan(((num(cam.fov, 50) || 50) * Math.PI) / 180 / 2) / aspect) * 180) / Math.PI;
  const proj = perspective(vfov, aspect, num(cam.near, 0.5) || 0.5, num(cam.far, 5000) || 5000);
  const view = lookAt(cam.pos, cam.look, [0, 1, 0], (num(cam.roll) * Math.PI) / 180);
  return mul4(proj, view);
}

function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan(((fovDeg * Math.PI) / 180) / 2);
  const nf = 1 / (near - far);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ];
}

function lookAt(eye, target, up, rollRad) {
  const f = norm3(sub3(vec3(target), vec3(eye)));
  let s = norm3(cross3(f, up));
  let u = cross3(s, f);
  if (rollRad) {
    const c = Math.cos(rollRad);
    const si = Math.sin(rollRad);
    const s2 = [s[0] * c + u[0] * si, s[1] * c + u[1] * si, s[2] * c + u[2] * si];
    const u2 = [u[0] * c - s[0] * si, u[1] * c - s[1] * si, u[2] * c - s[2] * si];
    s = s2;
    u = u2;
  }
  return [
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot3(s, vec3(eye)), -dot3(u, vec3(eye)), dot3(f, vec3(eye)), 1,
  ];
}

/** World -> project pixels for the IR's camera; null when behind it. */
function projectPoint(vp, point, W, H) {
  const x = vp[0] * point[0] + vp[4] * point[1] + vp[8] * point[2] + vp[12];
  const y = vp[1] * point[0] + vp[5] * point[1] + vp[9] * point[2] + vp[13];
  const w = vp[3] * point[0] + vp[7] * point[1] + vp[11] * point[2] + vp[15];
  if (w <= 1e-6) return null;
  return [((x / w) * 0.5 + 0.5) * W, (1 - ((y / w) * 0.5 + 0.5)) * H];
}

/**
 * Project pixel -> world ray, the exact construction of preview3d.js::ray, so
 * "which plane does this pixel show" is decided by the same geometry the
 * renderer's depth buffer sees.
 */
function rayOf(ir, sx, sy) {
  const cam = ir.camera;
  const W = num(ir.size[0], 1920) || 1920;
  const H = num(ir.size[1], 1080) || 1080;
  const aspect = W / H;
  const vfov = 2 * Math.atan(Math.tan(((num(cam.fov, 50) || 50) * Math.PI) / 180 / 2) / aspect);
  const eye = vec3(cam.pos);
  const f = norm3(sub3(vec3(cam.look), eye));
  let right = norm3(cross3(f, [0, 1, 0]));
  let up = cross3(right, f);
  const roll = (num(cam.roll) * Math.PI) / 180;
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    right = norm3([right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s]);
    up = norm3([up[0] * c - right[0] * s, up[1] * c - right[1] * s, up[2] * c - right[2] * s]);
  }
  const nx = (sx / W) * 2 - 1;
  const ny = 1 - (sy / H) * 2;
  const th = Math.tan(vfov / 2);
  const dir = norm3([
    f[0] + right[0] * nx * th * aspect + up[0] * ny * th,
    f[1] + right[1] * nx * th * aspect + up[1] * ny * th,
    f[2] + right[2] * nx * th * aspect + up[2] * ny * th,
  ]);
  return { origin: eye, dir };
}

/**
 * The projection a frame is drawn with: the IR camera's perspective.
 *
 * WP0.2 retired the legacy screen path — every frame draws the same world
 * quads. The one exception is the handful of frames before the (always
 * generated) city snapshot arrives, which go through a flat world -> canvas
 * map; that is a transient renderer state with no field in the IR, so a
 * measurement is taken from the steady state (the camera).
 */
function projectorOf(ir) {
  const W = num(ir.size[0], 1920) || 1920;
  const H = num(ir.size[1], 1080) || 1080;
  const vp = viewProjectionOf(ir);
  return {
    mode: 'world',
    W,
    H,
    project: (w) => projectPoint(vp, w, W, H),
  };
}

// ------------------------------------------------------------------- quads

// Coarse advance widths per character class, in em. CJK is exact (full width);
// Latin is the average of a UI sans and only ever used when nobody measured the
// text, which is why every report names the source.
const advanceEm = (ch) => {
  if (/\s/.test(ch)) return 0.28;
  if (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(ch)) return 1;
  if (/[0-9]/.test(ch)) return 0.58;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[ilI.,:;'!|]/.test(ch)) return 0.28;
  return 0.52;
};

/**
 * Deterministic text box in project pixels, shaped exactly like the preview's
 * raster (`preview.js::_textTexture`): max line advance + `pad`, line height ×
 * lines + `pad`, `pad = max(8, size * 0.35)`.
 */
export function estimateTextBox(content = {}) {
  const fontSize = num(content.fontSize, 96) || 96;
  const spacing = num(content.letterSpacing);
  const lineHeight = fontSize * (num(content.lineHeight, 1.18) || 1.18);
  const lines = String(content.text ?? '').split('\n');
  let maxW = 0;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) w += advanceEm(ch) * fontSize + spacing;
    maxW = Math.max(maxW, w || fontSize * 0.5);
  }
  const pad = Math.max(8, fontSize * 0.35);
  return [maxW + pad * 2, lineHeight * lines.length + pad * 2];
}

/**
 * Quad size of an IR item. `size` from the IR is final (WP0.1 froze it); text
 * is typeset by the consumer until WP1.3, so a supplied measurement wins and
 * the estimate is the deterministic fallback.
 */
function sizeOf(item, measureText) {
  if (Array.isArray(item.size) && item.size.length >= 2) return { size: item.size, source: 'ir' };
  if (item.kind === 'text') {
    const measured = typeof measureText === 'function' ? measureText(item) : null;
    if (Array.isArray(measured) && num(measured[0]) > 0 && num(measured[1]) > 0) {
      return { size: [num(measured[0]), num(measured[1])], source: 'measured' };
    }
    return { size: estimateTextBox(item.content), source: 'text-estimate' };
  }
  return { size: null, source: 'missing' };
}

/**
 * The IR quad of one item: the two world basis columns of `itemModelMatrix`
 * plus its origin (bias included — the depth pass pushes the quad too).
 *
 * Local `(lx, ly)` in [-0.5, 0.5] maps to `origin + ax * lx + ay * ly`; that is
 * the same quad every backend draws, and it stays defined when a corner is
 * behind the camera.
 */
function quadGeometryOf(item, measureText) {
  const sized = sizeOf(item, measureText);
  if (!sized.size) return null;
  const model = itemModelMatrix(item, sized.size);
  if (!model) return null;
  const ax = [model[0], model[1], model[2]];
  const ay = [model[4], model[5], model[6]];
  const a2 = dot3(ax, ax);
  const b2 = dot3(ay, ay);
  if (!(a2 > 1e-12) || !(b2 > 1e-12)) return null;
  return { sized, origin: [model[12], model[13], model[14]], ax, ay, a2, b2 };
}

/** Quad-local coordinates of a world point (inverse of the quad basis). */
function localOf(geom, point) {
  const d = sub3(point, geom.origin);
  return [dot3(d, geom.ax) / geom.a2, dot3(d, geom.ay) / geom.b2];
}

/** World point inside a quad's box from local coordinates. */
function worldOf(geom, lx, ly) {
  return [
    geom.origin[0] + geom.ax[0] * lx + geom.ay[0] * ly,
    geom.origin[1] + geom.ax[1] * lx + geom.ay[1] * ly,
    geom.origin[2] + geom.ax[2] * lx + geom.ay[2] * ly,
  ];
}

// ------------------------------------------------------------------- depth

/**
 * Ray depth of an item's plane (null when the ray runs parallel or the plane is
 * behind the camera). `depth.bias` is the metres a coplanar layer is pushed
 * toward the viewer (§4.4), and a pushed plane meets the ray slightly earlier,
 * exactly like the depth pass.
 */
function depthAt(item, ray) {
  const plane = item.plane;
  if (!plane || !ray) return null;
  const bias = num(item.depth?.bias);
  const p = bias ? sum3(vec3(plane.p), vec3(plane.n).map((v) => v * bias)) : vec3(plane.p);
  return layerRayDepth({ plane: { p, n: plane.n } }, ray);
}

/** Camera -> infinite plane distance (classifies "one plane", never orders them). */
function planeDistanceOf(item, camPos) {
  const plane = item.plane;
  if (!plane) return null;
  return Math.abs(dot3(sub3(camPos, vec3(plane.p)), norm3(vec3(plane.n))));
}

/**
 * Where a ray meets an item's quad, in quad-local coordinates, or null when it
 * misses the plane or lands outside [-0.5, 0.5]².
 */
function quadHit(item, geom, ray) {
  const depth = depthAt(item, ray);
  if (depth == null) return null;
  const hit = [
    ray.origin[0] + ray.dir[0] * depth,
    ray.origin[1] + ray.dir[1] * depth,
    ray.origin[2] + ray.dir[2] * depth,
  ];
  const [lx, ly] = localOf(geom, hit);
  if (Math.abs(lx) > 0.5 + 1e-9 || Math.abs(ly) > 0.5 + 1e-9) return null;
  return { depth, lx, ly };
}

// ---------------------------------------------------------------- sampling

/**
 * What a single pixel shows: the items whose quad contains it, the item the
 * depth buffer puts in front, and the item drawn last.
 *
 * `hit` follows preview.js::hitTest (nearest ray depth, `el.z` breaks a tie);
 * `front` is the nearest item that owns depth (`depth.write`), i.e. the one that
 * hides the rest; `drawTop` is the top of `orderLayers` for the same pixel.
 * `sortAgrees` compares the *depth writers*: the last one drawn must be the
 * nearest one. Where it is not, a sort-only backend would have shown a
 * different element than the depth buffer does — that is exactly 问题四.
 */
function samplePixel(ir, point, measureText) {
  const ordered = orderLayers(ir.items, ir.camera.pos);
  const ray = rayOf(ir, point[0], point[1]);
  const covering = [];
  for (const item of ordered) {
    const geom = quadGeometryOf(item, measureText);
    if (!geom) continue;
    const hit = quadHit(item, geom, ray);
    if (!hit) continue;
    covering.push({ item, geom, rayDepth: hit.depth, local: [hit.lx, hit.ly] });
  }
  const byDepth = covering.slice().sort((a, b) => (a.rayDepth - b.rayDepth) || (num(b.item.z) - num(a.item.z)));
  const drawTop = covering.length ? covering[covering.length - 1].item.id : null;
  const frontEntry = byDepth.find((c) => c.item.depth?.write) || null;
  // Sorting can only be wrong about *depth writers* (translucent layers blend on
  // top by design, docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §四): the last depth
  // writer drawn must be the nearest one. Where it is not, a sort-only backend
  // would have shown the wrong element — that is 问题四.
  const lastWriter = covering.filter((c) => c.item.depth?.write).pop()?.item.id ?? drawTop;
  return {
    ordered,
    covering,
    byId: new Map(covering.map((c) => [c.item.id, c])),
    depthSorted: byDepth,
    hit: byDepth[0]?.item.id ?? null,
    front: frontEntry?.item.id ?? null,
    drawTop,
    sortAgrees: lastWriter === (frontEntry?.item.id ?? drawTop),
  };
}

function pointSummary(sample) {
  return {
    covering: sample.covering.map((c) => c.item.id),
    depthOrder: sample.depthSorted.map((c) => c.item.id),
    hit: sample.hit,
    front: sample.front,
    drawTop: sample.drawTop,
    sortAgrees: sample.sortAgrees,
  };
}

function itemRow(item, ctx) {
  const { proj, point, ray, sized, covers } = ctx;
  const camPos = vec3(ctx.ir.camera.pos);
  const depth = ray ? depthAt(item, ray) : null;
  return {
    drawOrder: item.drawOrder,
    id: item.id,
    kind: item.kind,
    z: round3(item.z),
    depth: item.depth
      ? { write: !!item.depth.write, cut: round3(num(item.depth.cut)), bias: round6(num(item.depth.bias)) }
      : null,
    plane: item.plane
      ? { p: vec3(item.plane.p).map(round3), n: vec3(item.plane.n).map(round3) }
      : null,
    distance: round3(layerOriginDistance(item, camPos)),
    planeDistance: round3(planeDistanceOf(item, camPos)),
    rayDepth: depth == null ? null : round3(depth),
    coversPoint: point ? !!covers : null,
    size: Array.isArray(item.size) ? item.size : null,
    sizeSource: sized?.source || (Array.isArray(item.size) ? 'ir' : null),
    projectedCenter: proj.project(vec3(item.plane?.p))?.map(round3) ?? null,
    opacity: round3(item.opacity),
  };
}

// ------------------------------------------------------------------ stackAt

/**
 * Draw order of the 2D planes at time `t`, far to near, plus each item's depth
 * numbers (docs/DESIGN-BACKEND-V2.md §8.2 `stackAt`; 问题一 / 问题四).
 *
 * `opts.point` (project pixels) also answers which item owns that pixel; it
 * defaults to the frame centre, and `null` skips the pixel test entirely.
 * `opts.camera` is `'live'` (default) or a camera id; `opts.frame` overrides the
 * time. `opts.measureText(item)` supplies a real text box when the caller can
 * measure; otherwise the deterministic estimate is used and `sizeSource` says
 * so.
 */
export function stackAt(project, t, opts = {}) {
  const p = prepare(project);
  const frame = frameOfOpts(p, t, opts);
  const camera = cameraIdOf(project, opts.camera);
  const ir = irAt(p, frame, camera);
  const proj = projectorOf(ir);
  const point = opts.point === null ? null : normalizePoint(opts.point ?? [proj.W / 2, proj.H / 2]);
  const sample = point ? samplePixel(ir, point, opts.measureText) : null;
  const ray = point ? rayOf(ir, point[0], point[1]) : null;
  const rows = (sample ? sample.ordered : orderLayers(ir.items, ir.camera.pos)).map((item) => itemRow(item, {
    ir,
    proj,
    point,
    ray,
    sized: sample?.byId.get(item.id)?.geom.sized || null,
    covers: sample?.byId.has(item.id) || false,
  }));

  const report = {
    version: INSPECT_VERSION,
    ir: FRAME_IR_VERSION,
    rule: 'core/layers.js::orderLayers',
    projection: proj.mode,
    frame,
    t: round3(frame / p.fps),
    fps: p.fps,
    camera: { id: ir.camera.id, mode: ir.camera.mode, fov: round3(ir.camera.fov) },
    point,
    pointInsideFrame: point ? point[0] >= 0 && point[1] >= 0 && point[0] <= proj.W && point[1] <= proj.H : null,
    units: UNITS,
    // Far -> near, i.e. drawOrder. `distance` is camera -> element origin (the
    // rule that groups planes); `rayDepth` is where the pixel's ray meets the
    // plane (what the depth buffer compares).
    order: rows,
    items: rows.length,
  };
  // No point = nothing sampled, but the same keys stay (as null) so a caller
  // branches on values instead of on key presence.
  Object.assign(report, sample
    ? pointSummary(sample)
    : { covering: null, depthOrder: null, hit: null, front: null, drawTop: null, sortAgrees: null });
  return report;
}

// ----------------------------------------------------------------- coverage

/**
 * Per-frame coverage of one pixel and/or one item
 * (docs/DESIGN-BACKEND-V2.md §8.2 `coverage`; 问题四 cam_8 f142–158).
 *
 * `{ f0, f1 }` is an inclusive frame range. Every frame reports which items
 * cover the sampled pixel, who is in front and whether draw order agrees.
 * `opts.focus` (an element id) additionally samples that item's quad on a
 * SAMPLE_GRID grid and counts on-screen / unoccluded samples — the geometric
 * counterpart of "pixels of this lyric in the canvas", which needs a rasteriser
 * (`pxAt` explains the difference).
 */
export function coverage(project, opts = {}) {
  const p = prepare(project);
  const camera = cameraIdOf(project, opts.camera);
  const f0 = Math.max(0, Math.round(num(opts.f0, num(opts.from, 0))));
  const f1 = Math.max(f0, Math.round(num(opts.f1, num(opts.to, f0))));
  const pointOpt = opts.point === null ? null : normalizePoint(opts.point ?? null);
  const focus = opts.focus ? String(opts.focus) : null;
  const grid = Math.max(1, Math.round(num(opts.grid, SAMPLE_GRID)));
  if (focus && !(project.elements || []).some((e) => e.id === focus)) {
    throw fault('INVALID_ARGUMENT', `unknown element ${focus}`, { elements: (project.elements || []).slice(0, 50).map((e) => e.id) });
  }

  const frames = [];
  let projection = null;
  let cameraId = null;
  let sums = { samples: 0, onScreen: 0, unoccluded: 0 };
  for (let frame = f0; frame <= f1; frame++) {
    const ir = irAt(p, frame, camera);
    const proj = projectorOf(ir);
    projection = projection || proj.mode;
    cameraId = cameraId || ir.camera.id;
    const point = pointOpt || [proj.W / 2, proj.H / 2];
    const sample = samplePixel(ir, point, opts.measureText);
    const row = {
      frame,
      t: round3(frame / p.fps),
      camera: ir.camera.id,
      point: [round3(point[0]), round3(point[1])],
      present: ir.items.map((i) => i.id),
      ...pointSummary(sample),
    };
    if (focus) {
      const item = ir.items.find((i) => i.id === focus);
      if (!item) {
        row.focus = { id: focus, present: false, samples: 0, onScreen: 0, unoccluded: 0, occluders: [] };
      } else {
        const geom = quadGeometryOf(item, opts.measureText);
        // Sample the quad in its own space, so an off-screen or degenerate
        // corner never changes the number of samples.
        const onScreen = [];
        let samples = 0;
        if (geom) {
          for (let i = 0; i < grid; i++) {
            for (let j = 0; j < grid; j++) {
              samples += 1;
              const lx = (i + 0.5) / grid - 0.5;
              const ly = (j + 0.5) / grid - 0.5;
              const px = proj.project(worldOf(geom, lx, ly));
              if (!px) continue;
              if (px[0] < 0 || px[1] < 0 || px[0] > proj.W || px[1] > proj.H) continue;
              onScreen.push(px);
            }
          }
        }
        // Only an opaque plane owns depth, so only it can hide the focus item.
        const occluders = ir.items
          .filter((other) => other.id !== item.id && other.depth?.write)
          .map((other) => ({ id: other.id, item: other, geom: quadGeometryOf(other, opts.measureText) }))
          .filter((entry) => entry.geom);
        const hiddenBy = new Map();
        let unoccluded = 0;
        for (const px of onScreen) {
          const ray = rayOf(ir, px[0], px[1]);
          const own = depthAt(item, ray);
          let hidden = false;
          for (const other of occluders) {
            const hit = quadHit(other.item, other.geom, ray);
            if (hit && own != null && hit.depth < own - 1e-6) {
              hidden = true;
              hiddenBy.set(other.id, (hiddenBy.get(other.id) || 0) + 1);
            }
          }
          if (!hidden) unoccluded += 1;
        }
        row.focus = {
          id: focus,
          present: true,
          sizeSource: geom?.sized.source || 'missing',
          samples,
          onScreen: onScreen.length,
          unoccluded,
          occluders: [...hiddenBy.keys()],
        };
        sums = {
          samples: sums.samples + samples,
          onScreen: sums.onScreen + onScreen.length,
          unoccluded: sums.unoccluded + unoccluded,
        };
      }
    }
    frames.push(row);
  }

  const first = frames[0];
  return {
    version: INSPECT_VERSION,
    ir: FRAME_IR_VERSION,
    rule: 'core/layers.js::orderLayers',
    projection,
    f0,
    f1,
    frameCount: f1 - f0 + 1,
    fps: p.fps,
    camera: { id: cameraId, requested: camera },
    point: first?.point ?? null,
    focus,
    focusSummary: focus ? {
      id: focus,
      framesPresent: frames.filter((f) => f.focus?.present).length,
      framesOnScreen: frames.filter((f) => (f.focus?.onScreen || 0) > 0).length,
      framesUnoccluded: frames.filter((f) => (f.focus?.unoccluded || 0) > 0).length,
      absentFrames: frames.filter((f) => !f.focus?.present).map((f) => f.frame),
      offScreenFrames: frames.filter((f) => f.focus?.present && !(f.focus?.onScreen > 0)).map((f) => f.frame),
      hiddenFrames: frames.filter((f) => f.focus?.present && f.focus?.onScreen > 0 && !(f.focus?.unoccluded > 0)).map((f) => f.frame),
      samples: sums.samples,
      samplesOnScreen: sums.onScreen,
      samplesUnoccluded: sums.unoccluded,
    } : null,
    // A compact per-frame series, for a table or a quick scan of zero frames.
    numbers: frames.map((f) => (focus
      ? { frame: f.frame, present: !!f.focus?.present, onScreen: f.focus?.onScreen || 0, unoccluded: f.focus?.unoccluded || 0 }
      : { frame: f.frame, covering: f.covering.length, hit: f.hit })),
    framesDetail: frames,
  };
}

// -------------------------------------------------------------------- pxAt

/**
 * What is at one pixel of one frame (docs/DESIGN-BACKEND-V2.md §8.2), answered
 * analytically.
 *
 * It cannot return a colour: the picture is produced by WebGL in the editor
 * (Electron/Chromium), and this module is a pure-Node read of the IR. What it
 * returns is the geometry behind the pixel — every item whose quad contains it,
 * the ray depth of each plane, the front one and the top of the draw order —
 * which is what decides the colour, not the colour itself. `limitations` lists
 * what stays unknown, so a caller never mistakes this for a pixel read.
 */
export function pxAt(project, opts = {}) {
  const p = prepare(project);
  if (opts.x == null || opts.y == null) throw fault('INVALID_ARGUMENT', 'pxAt needs x and y (project pixels)');
  if (opts.frame == null && opts.time == null) throw fault('INVALID_ARGUMENT', 'pxAt needs frame or time');
  const frame = frameOfOpts(p, num(opts.time), opts);
  const camera = cameraIdOf(project, opts.camera);
  const ir = irAt(p, frame, camera);
  const proj = projectorOf(ir);
  const point = normalizePoint([num(opts.x), num(opts.y)]);
  const sample = samplePixel(ir, point, opts.measureText);
  return {
    version: INSPECT_VERSION,
    ir: FRAME_IR_VERSION,
    mode: 'geometry',
    readPixels: false,
    frame,
    t: round3(frame / p.fps),
    fps: p.fps,
    camera: { id: ir.camera.id, mode: ir.camera.mode },
    projection: proj.mode,
    pixel: { x: point[0], y: point[1] },
    insideFrame: point[0] >= 0 && point[1] >= 0 && point[0] <= proj.W && point[1] <= proj.H,
    // Summary first, then the richer array: `pointSummary` also carries a
    // `covering` key (ids), so spreading it last would replace these rows.
    ...pointSummary(sample),
    coveringIds: sample.covering.map((c) => c.item.id),
    covering: sample.covering.map((c) => ({
      id: c.item.id,
      kind: c.item.kind,
      drawOrder: c.item.drawOrder,
      z: round3(c.item.z),
      writesDepth: !!c.item.depth?.write,
      opacity: round3(c.item.opacity),
      sizeSource: c.geom.sized.source,
      rayDepth: round3(c.rayDepth),
      local: [round3(c.local[0]), round3(c.local[1])],
    })),
    limitations: [
      'no colour: a pure-Node read has no WebGL, so nothing is rasterised or read back',
      'text glyphs: a text quad is measured (or estimated) as a box; glyph alpha inside it is unknown, so "the quad covers the pixel" is not "a glyph paints it"',
      '3D objects and city geometry are not depth-tested here (objects3d is a list of boxes, not a depth buffer)',
      'blending, anti-aliasing, glow and screen effects are not applied',
      'frames drawn before the city snapshot arrives use a flat world -> canvas map; measurements assume the steady state (the camera)',
    ],
  };
}

// --------------------------------------------------------------- cutEdges

/**
 * Element edges that do not sit on a camera cut
 * (docs/DESIGN-BACKEND-V2.md §8.2 `cutEdges`; docs/FIX-LAYER-ORDER-EMPTY-CLICK.md
 * 问题五).
 *
 * A camera's start is a cut: the instant the picture switches shot. An element
 * edge that misses a cut by less than `maxGapFrames` (and does not hit it) is
 * the dangerous kind — a tail that lives 0.99 frames into the next shot is what
 * the space bar showed and the export never draws. `maxGapFrames` defaults to 1
 * (§8.2); the FIX document's full scan used 1.5 and found the same single edge.
 *
 * `includeSpans` lists elements that cross a cut and are aligned at neither
 * edge. That is normal for plates and audio, so it is off by default; it is a
 * question to look at, not a finding.
 */
export function cutEdges(project, opts = {}) {
  const p = prepare(project);
  const maxGapFrames = Math.max(0, num(opts.maxGapFrames, 1));
  const includeSpans = !!opts.includeSpans;
  const limit = Math.max(1, Math.round(num(opts.limit, 200)));
  const cams = cameraLayers(project);
  const cuts = [];
  for (const cam of cams) {
    const range = cameraRange(project, cam);
    if (!(range.start > EPS)) continue; // t = 0 is the head of the timeline, not a switch
    const frame = range.start * p.fps;
    if (cuts.some((c) => Math.abs(c.frame - frame) < EPS)) continue;
    cuts.push({ camera: cam.id, t: round3(range.start), frame: round3(frame) });
  }
  cuts.sort((a, b) => a.frame - b.frame);

  const edges = [];
  const spans = [];
  let edgeCount = 0;
  for (const el of project.elements || []) {
    if (el.visible === false) continue;
    const start = num(el.start);
    const end = start + num(el.duration);
    for (const [edge, time] of [['start', start], ['end', end]]) {
      const frame = time * p.fps;
      edgeCount += 1;
      let best = null;
      for (const cut of cuts) {
        const deltaFrames = frame - cut.frame;
        const gapFrames = Math.abs(deltaFrames);
        if (gapFrames <= EPS || gapFrames >= maxGapFrames) continue;
        if (!best || gapFrames < best.gapFrames) best = { cut, deltaFrames, gapFrames };
      }
      if (!best) continue;
      edges.push({
        id: el.id,
        type: el.type,
        edge,
        time: round3(time),
        frame: round3(frame),
        camera: best.cut.camera,
        cutTime: best.cut.t,
        cutFrame: best.cut.frame,
        deltaFrames: round3(best.deltaFrames),
        gapFrames: round3(best.gapFrames),
        // A positive tail delta is the 问题五 shape: the element is still alive
        // after the picture has moved to another camera.
        overlapFrames: edge === 'end' ? round3(Math.max(0, best.deltaFrames)) : 0,
        side: frame > best.cut.frame ? 'after-cut' : 'before-cut',
      });
    }
    if (includeSpans) {
      for (const cut of cuts) {
        if (start * p.fps < cut.frame - EPS && end * p.fps > cut.frame + EPS) {
          spans.push({ id: el.id, type: el.type, start: round3(start), end: round3(end), camera: cut.camera, cutFrame: cut.frame });
        }
      }
    }
  }
  edges.sort((a, b) => a.gapFrames - b.gapFrames || a.frame - b.frame);

  return {
    version: INSPECT_VERSION,
    ir: FRAME_IR_VERSION,
    fps: p.fps,
    duration: round3(p.duration),
    maxGapFrames,
    cuts,
    edges: edges.slice(0, limit),
    total: edges.length,
    truncated: edges.length > limit,
    spans: includeSpans
      ? { total: spans.length, items: spans.slice(0, limit), truncated: spans.length > limit, note: 'crossing a cut is normal for plates and audio; listed as a question, not a finding' }
      : { total: null, items: [], note: 'pass includeSpans (--spans) to list elements that cross a cut' },
    scanned: { elements: (project.elements || []).length, edges: edgeCount, cuts: cuts.length, cameras: cams.length },
  };
}

// -------------------------------------------------------------------- diff

const KEYED_COLLECTIONS = [
  ['elements', 'element', (p) => p.elements],
  ['cameras', 'camera', (p) => p.cameras],
  ['segments', 'segment', (p) => p.segments],
  ['objects', 'object', (p) => p.scene?.objects],
];

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};
const same = (a, b) => stable(a) === stable(b);

function leaves(value, prefix, out) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.push([prefix, value === undefined ? null : value]);
    return;
  }
  for (const key of Object.keys(value)) leaves(value[key], prefix ? `${prefix}.${key}` : key, out);
  return out;
}

/** `keyframes` is the one array a change set addresses entry by entry. */
function keyframeChanges(id, before = [], after = [], out) {
  const keyOf = (key) => `${round3(num(key.t))}|${key.path}`;
  const map = new Map();
  for (const key of before) map.set(keyOf(key), { before: key, after: undefined });
  for (const key of after) {
    const k = keyOf(key);
    const entry = map.get(k) || { before: undefined, after: undefined };
    entry.after = key;
    map.set(k, entry);
  }
  for (const { before: b, after: a } of map.values()) {
    if (b && a) {
      for (const field of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (field === 't' || field === 'path') continue;
        if (!same(b[field], a[field])) {
          out.push({
            id,
            kind: 'element',
            change: 'modified',
            path: `keyframes[${round3(num(a.t))}].${a.path}.${field}`,
            before: b[field] === undefined ? null : b[field],
            after: a[field] === undefined ? null : a[field],
          });
        }
      }
    } else if (a) {
      out.push({ id, kind: 'element', change: 'added', path: `keyframes[${round3(num(a.t))}].${a.path}`, before: null, after: a });
    } else if (b) {
      out.push({ id, kind: 'element', change: 'removed', path: `keyframes[${round3(num(b.t))}].${b.path}`, before: b, after: null });
    }
  }
}

function objectChanges(id, kind, before, after, out) {
  const a = leaves(before, '', []);
  const b = leaves(after, '', []);
  if (kind === 'element') {
    // `keyframes` is diffed per key instead of as a whole array.
    for (const list of [a, b]) {
      const at = list.findIndex(([path]) => path === 'keyframes');
      if (at >= 0) list.splice(at, 1);
    }
    keyframeChanges(id, before.keyframes || [], after.keyframes || [], out);
  }
  const beforeMap = new Map(a);
  const afterMap = new Map(b);
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])];
  for (const path of paths) {
    const hasA = beforeMap.has(path);
    const hasB = afterMap.has(path);
    if (hasA && hasB) {
      if (!same(beforeMap.get(path), afterMap.get(path))) {
        out.push({ id, kind, change: 'modified', path, before: beforeMap.get(path), after: afterMap.get(path) });
      }
    } else if (hasB) {
      out.push({ id, kind, change: 'added', path, before: null, after: afterMap.get(path) });
    } else {
      out.push({ id, kind, change: 'removed', path, before: beforeMap.get(path), after: null });
    }
  }
}

/**
 * Difference report for two project objects, in the shape the change-set
 * service consumes (§8.1/§8.3): `changed: [{ id, kind, path, before, after }]`,
 * plus `added` / `removed` for whole objects.
 *
 * `path` is the property path inside the object (`style.size`, `node.rotation.x`,
 * `keyframes[4.2].style.color`); `kind` says which collection the id belongs to
 * (`element` / `camera` / `segment` / `object` / `project`). Arrays other than
 * `elements[].keyframes` are single leaves — a path list or a `node.pivot` is
 * reported whole, because a change set replaces it whole.
 *
 * `ignore` defaults to the fields that differ between any two revisions of the
 * same file (`rev`, `meta.savedAt`); pass more paths to hide editor state.
 */
/**
 * Real pixels: how many pixels does `elementId` contribute in each frame?
 *
 * The geometric `coverage()` above answers "does this element cover this point
 * and who is in front"; this answers "how much of the picture is it", which is
 * the number the FIX document reports for problem four (歌词像素). It needs the
 * real preview, so it boots the app offscreen and renders each frame twice —
 * with the element and with it hidden — then counts the difference
 * (`app/renderer/js/inspect-probe.js` + `scripts/inspect-pixels.mjs`).
 *
 * `projectDir` is a project directory (a `.scratch/` copy when you do not want
 * to touch the user's project; the probe never writes to it).
 */
export async function pixelCoverage(projectDir, opts = {}) {
  const elementId = opts.elementId || opts.element;
  if (!elementId) throw fault('INVALID_ARGUMENT', 'pixelCoverage needs elementId');
  const dir = path.resolve(projectDir);
  const f0 = Math.max(0, Math.round(num(opts.f0, num(opts.from, 0))));
  const f1 = Math.max(f0, Math.round(num(opts.f1, num(opts.to, f0))));
  const args = [
    path.join(REPO_ROOT, 'scripts', 'inspect-pixels.mjs'),
    '--project', dir,
    '--element', String(elementId),
    '--frames', `${f0}:${f1}`,
    '--json',
  ];
  if (opts.camera) args.push('--camera', String(opts.camera));
  const run = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (error) => resolve({ code: -1, out, err: String(error.message) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
  if (run.code !== 0) {
    throw fault('PIXEL_PROBE_FAILED', `pixel coverage failed: ${(run.err || run.out).trim().split(String.fromCharCode(10)).slice(-3).join(' | ')}`, {
      exitCode: run.code,
    });
  }
  const line = run.out.trim().split(String.fromCharCode(10)).filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch (error) {
    throw fault('PIXEL_PROBE_FAILED', `pixel coverage printed something unexpected: ${line.slice(0, 200)}`, { error: error.message });
  }
}

export function diff(a, b, opts = {}) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    throw fault('INVALID_ARGUMENT', 'diff needs two project objects');
  }
  const ignore = [...new Set(['rev', 'meta.savedAt', ...(opts.ignore || [])])];
  const limit = Math.max(1, Math.round(num(opts.limit, 2000)));
  const changed = [];
  const added = [];
  const removed = [];

  // Keyed collections first: one id at a time, so a change is locatable.
  for (const [, kind, pick] of KEYED_COLLECTIONS) {
    const from = pick(a) || [];
    const to = pick(b) || [];
    const before = new Map(from.filter((item) => item && item.id != null).map((item) => [item.id, item]));
    const after = new Map(to.filter((item) => item && item.id != null).map((item) => [item.id, item]));
    const ids = [...before.keys(), ...[...after.keys()].filter((id) => !before.has(id))];
    for (const id of ids) {
      const va = before.get(id);
      const vb = after.get(id);
      if (va && !vb) removed.push({ id, kind });
      else if (!va && vb) added.push({ id, kind });
      else objectChanges(id, kind, va, vb, changed);
    }
  }

  // Everything outside the keyed collections is project-level: meta, world,
  // schema, cameraOrder, activeCameraId, scene (minus objects), …
  function stripIgnored(value, prefix) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (ignore.includes(path)) continue;
      out[key] = stripIgnored(entry, path);
    }
    return out;
  }
  function rest(project) {
    const copy = { ...project };
    for (const [collection] of KEYED_COLLECTIONS) {
      if (collection === 'objects') {
        const scene = { ...(copy.scene || {}) };
        delete scene.objects;
        copy.scene = scene;
      } else delete copy[collection];
    }
    return stripIgnored(copy, '');
  }
  const aLeaves = new Map(leaves(rest(a), '', []));
  const bLeaves = new Map(leaves(rest(b), '', []));
  for (const path of [...new Set([...aLeaves.keys(), ...bLeaves.keys()])].sort()) {
    const hasA = aLeaves.has(path);
    const hasB = bLeaves.has(path);
    if (hasA && hasB) {
      if (!same(aLeaves.get(path), bLeaves.get(path))) {
        changed.push({ id: null, kind: 'project', change: 'modified', path, before: aLeaves.get(path), after: bLeaves.get(path) });
      }
    } else if (hasB) {
      changed.push({ id: null, kind: 'project', change: 'added', path, before: null, after: bLeaves.get(path) });
    } else {
      changed.push({ id: null, kind: 'project', change: 'removed', path, before: aLeaves.get(path), after: null });
    }
  }

  const equal = !changed.length && !added.length && !removed.length;
  return {
    version: INSPECT_VERSION,
    equal,
    before: { rev: num(a.rev), title: a.meta?.title ?? null },
    after: { rev: num(b.rev), title: b.meta?.title ?? null },
    changed: changed.slice(0, limit),
    added,
    removed,
    total: changed.length,
    truncated: changed.length > limit,
    counts: {
      changed: changed.length,
      added: added.length,
      removed: removed.length,
      byKind: changed.reduce((acc, entry) => {
        acc[entry.kind] = (acc[entry.kind] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}
