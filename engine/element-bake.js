// 2D elements placed by a SpatialNode or a spatial parent, baked per frame in
// JS with the viewport's math (docs/DESIGN-CAMFEED-PARENTS.md §4):
//
//   _world  {f0, frames: [16 numbers, column-major]}  the plane's world matrix
//           per project pixel (core/frame-ir.js::elementPixelMatrix, one pixel
//           as the unit quad), links included (core/link-eval.js); the IR's
//           items[].world is the same number, so vdm_build.py and the preview
//           cannot drift
//
// The Python 2D builder only knows flat nodes and no parents, so without this
// a parented or tilted element renders at its local placement.
// Frames are absolute render frames (frame = round(t * fps) + 1).
//
// Since WP0.1 the matrix itself lives in core/frame-ir.js (the IR is the single
// placement source); this file keeps the bake, which rounds the numbers it
// serialises to 6 decimals so the Blender job stays the same size it was.
//
// Since WP1.1 this file also owns the **shot v3** half of the bake
// (docs/DESIGN-BACKEND-V2.md §10.2): the frame IR compressed to static fields
// plus per-field tracks, so WP1.2's Blender reader only reads numbers (P2).
//
// A v3 record is `{ id, span: [f0, f1], static: {...}, tracks: {...} }`:
//
//   * `span` is 1-based render frames, inclusive — the same base as the legacy
//     shot `f` field: render frame `f` is IR frame `f - 1` (§4.4). An entity
//     is present in every frame of its span (entries that leave and come back
//     are split into one record per contiguous run, same id);
//   * `static` holds, once, every value that never changes over the span
//     (nested exactly like the IR, dotted paths are only used by `tracks`);
//   * `tracks["<path>"] = { f0, values }` is the dense per-frame value of a
//     field that really changes, `values[i]` at frame `f0 + i`. Dotted paths
//     reach into objects (`content.text`) and into arrays by index
//     (`world.12`), so a matrix that only translates writes three tracks
//     instead of a copy of the matrix per frame. Arrays stay whole in
//     `static` (first frame) and only the moving indices get a track.
//
// `packV3` / `unpackV3` are inverses (tests/shot.test.mjs round-trips every
// frame); `frameFromShotV3` (engine/shot.js) rebuilds a whole IR frame.
import { elementWorldParent } from '../core/spatial-parent.js';
import { linksEvalOptions } from '../core/link-eval.js';
import { buildFrameIR, elementPixelMatrix } from '../core/frame-ir.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const r6 = (v) => Math.round(v * 1e6) / 1e6 + 0; // + 0: JSON cannot hold -0

export { elementPixelMatrix };

/** Does `el` need a baked world matrix (node placement or spatial parent)? */
export const needsWorldBake = (el) => isObj(el?.node) || !!elementWorldParent(el);

/**
 * Add `_world` bakes to the node / spatially parented 2D elements of `project`
 * (mutates the job copy) for frames [f0, f1]; other elements are untouched.
 *
 * Still the legacy Python path (`vdm_build.py::baked_world`); its output is
 * unchanged by WP1.1. The v3 package carries the same matrix as
 * `items[].tracks.world` / `static.world` instead.
 */
export function bakeElementPlacements(project, [f0, f1], fps) {
  const opts = linksEvalOptions(project);
  for (const el of project.elements || []) {
    if (el.type === 'audio' || el.visible === false || !needsWorldBake(el)) continue;
    const start = Number(el.start) || 0;
    const end = start + (Number(el.duration) || 0);
    const lo = Math.max(f0, Math.round(start * fps) + 1);
    const hi = Math.min(f1, Math.round(end * fps) + 1);
    if (hi < lo) continue;
    const frames = [];
    for (let f = lo; f <= hi; f++) frames.push(elementPixelMatrix(project, el, (f - 1) / fps, opts).map(r6));
    el._world = { f0: lo, frames };
  }
  return project;
}

// ---------------------------------------------------------------- v3 records

/**
 * Flatten a record value into `dotted path -> leaf`; arrays (and empty objects)
 * are leaves. `undefined` is skipped: the package is JSON, and a record cannot
 * carry a key that JSON drops (`{"id": undefined}` → `{}`) — the IR itself
 * round-trips through JSON the same way.
 */
export function flattenV3(value, out = {}, prefix = '') {
  if (!isObj(value) || !Object.keys(value).length) {
    if (value !== undefined) out[prefix] = value;
    return out;
  }
  for (const k of Object.keys(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    const v = value[k];
    if (v === undefined) continue;
    if (isObj(v) && Object.keys(v).length) flattenV3(v, out, p);
    else out[p] = v;
  }
  return out;
}

/** Write `value` at a dotted path, creating the missing (object or array) nodes. */
export function setV3Path(target, path, value) {
  const parts = String(path).split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!isObj(cur[k]) && !Array.isArray(cur[k])) cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return target;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isNumArray = (v) => Array.isArray(v) && v.every((x) => Number.isFinite(Number(x)));

/**
 * Decimal places a shot-v3 track of `path` is written with (§4.4 tolerance):
 * matrices (`items[].world`, `camera.world`) to 1e-6 — the relaxation §4.4
 * grants the frozen IR matrix — matrix-derived vectors (an item's plane, the
 * camera pose) to 1e-9, everything else exact. Shared by engine/shot.js so the
 * writer and the reader's expectations agree.
 */
export const QUANTIZE = {
  /** A 2D element record: `world` to 1e-6, its plane (a copy of the matrix's
   *  translation / normal) to 1e-9 so ordering decisions stay exact. */
  element: (p) => (/^world(\.|$)/.test(p) ? 6
    : /^plane\.(p|n)(\.|$)/.test(p) ? 9 : 0),
  /**
   * Camera records (`camera.pos`) and camera-layer records (`camera.world`,
   * `picture.scale`): `world` to 1e-6, pose numbers to 1e-9 (a nanometre).
   */
  camera: (p) => {
    const leaf = p.replace(/^camera\./, '');
    if (/^world(\.|$)/.test(leaf)) return 6;
    return /^(pos|look|up|roll|fov|focus)(\.|$)/.test(leaf) ? 9 : 0;
  },
};

/**
 * Compress `values` (one value per frame from render frame `f0` on) into the v3
 * `{ static, tracks }` pair. `quantize(path)` returns the decimal places for a
 * leaf path (0 / undefined = written exactly).
 */
export function packV3(f0, values, { quantize = null } = {}) {
  const flats = values.map((v) => flattenV3(v));
  const paths = new Set();
  for (const m of flats) for (const k of Object.keys(m)) paths.add(k);
  const dpOf = (p) => (typeof quantize === 'function' ? (quantize(p) || 0) : 0);
  const rounder = (dp) => {
    if (!dp) return (v) => v;
    const k = 10 ** dp;
    // Only finite numbers are quantised: a structural change can put `null` in
    // a series, and `Math.round(null * k)` would turn it into NaN.
    return (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * k) / k + 0 : v);
  };
  const quant = (dp) => {
    const r = rounder(dp);
    return (v) => (Array.isArray(v) ? v.map(r) : r(v));
  };
  const staticFields = {};
  const tracks = {};
  for (const p of [...paths].sort()) {
    const series = flats.map((m) => (p in m ? m[p] : null));
    const first = series[0];
    const q = quant(dpOf(p));
    if (series.every((v) => same(v, first))) {
      setV3Path(staticFields, p, q(first));
      continue;
    }
    if (isNumArray(first) && series.every((v) => isNumArray(v) && v.length === first.length)) {
      // The array itself has to be reachable in full (the indices that never
      // move live here once); only the moving indices get a track.
      setV3Path(staticFields, p, q(first));
      for (let i = 0; i < first.length; i++) {
        const column = series.map((v) => v[i]);
        if (column.every((v) => v === column[0])) continue;
        tracks[`${p}.${i}`] = { f0, values: column.map(q) };
      }
      continue;
    }
    tracks[p] = { f0, values: series.map(q) };
  }
  return { static: staticFields, tracks };
}

/** Rebuild one frame's record value from a v3 record, or null when out of its span. */
export function unpackV3(record, frame) {
  const f = Math.round(Number(frame));
  const [a, b] = record.span;
  if (!(f >= a && f <= b)) return null;
  const out = JSON.parse(JSON.stringify(record.static));
  for (const [p, track] of Object.entries(record.tracks || {})) {
    const i = f - track.f0;
    if (i < 0 || i >= track.values.length) continue;
    setV3Path(out, p, track.values[i]);
  }
  return out;
}

/**
 * Group per-frame `{ i, f, value }` entries (sorted by frame) into contiguous
 * presence runs and pack each into a v3 record. An entity that leaves the
 * picture and comes back produces two records with the same id — that keeps
 * every track dense (a hole has no value to write) without inventing a
 * sparse encoding.
 */
export function packV3Runs(id, entries, opts = {}) {
  const runs = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && e.i === last[last.length - 1].i + 1) last.push(e);
    else runs.push([e]);
  }
  return runs.map((run) => {
    const { static: fields, tracks } = packV3(run[0].f, run.map((e) => e.value), opts);
    return { id, span: [run[0].f, run[run.length - 1].f], static: fields, tracks };
  });
}

/**
 * The v3 records of a single 2D element: sample the frame IR over the render
 * window and keep the frames that draw `el`. One element per call, so it
 * rebuilds the IR per frame — a convenience for tests and one-off checks;
 * `buildShot` streams the IR once for the whole project instead.
 */
export function elementV3(project, el, { fps = project.meta?.fps || 24, from = 0, to = null } = {}) {
  const end = to ?? project.meta?.duration ?? 0;
  const f0 = Math.round(from * fps) + 1;
  const f1 = Math.max(f0, Math.round(end * fps) + 1);
  const entries = [];
  for (let f = f0; f <= f1; f++) {
    const item = buildFrameIR(project, f - 1, { fps }).items.find((it) => it.id === el.id);
    if (item) entries.push({ i: f, f, value: item });
  }
  return packV3Runs(el.id, entries, { quantize: QUANTIZE.element });
}
