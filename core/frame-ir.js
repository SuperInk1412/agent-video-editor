// Frame IR — the per-frame draw list both backends read
// (docs/DESIGN-BACKEND-V2.md §4, WP0.1).
//
// One evaluation of the project produces, for ONE frame, everything needed to
// draw that frame: what is on screen, where its quad sits in the world, which
// pixel each plane owns, and what the content is. The WebGL preview
// (app/renderer/js/preview.js) and the Blender bake (blender/vdm_build.py)
// both only consume this — they no longer decide visibility, order or
// placement themselves (P2/P3 of §3).
//
// Pure ESM: no DOM, no node:*. Every number is final — keyframes, easing,
// property links, motion presets, parent chains and spatial nodes are already
// evaluated, so a backend that reads the IR cannot disagree with another one.
//
// Conventions (frozen in §4 after the WP0.1 review):
//
// * `t = frame / fps` — only whole frames exist (P5). A frame number is what
//   the caller passes; nothing here samples between frames.
// * `world` is a column-major 4x4 mapping **quad-local project-pixel** offsets
//   to world metres: a quad of `size` project pixels spans
//   `world * (lx * size[0], ly * size[1], 0, 1)` for lx, ly in [-0.5, 0.5].
//   One local unit along any axis is one project pixel (0.01 m, `PIXEL_M`).
//   `world` for a node / parented element is exactly `elementPixelMatrix()`;
//   a legacy (screen-space) element gets the same-shaped matrix derived from
//   the screen placement, so one backend path draws both.
// * Quad-local +ly points UP and the picture's top edge is ly = +0.5, so a
//   backend samples uv `(lx + 0.5, 0.5 - ly)`. `content.uv` is expressed in
//   image space (0,0 = the content's own top-left), whatever the texture's
//   orientation on disk.
// * `depth.bias` metres along the plane normal separates coplanar layers
//   (`LAYER_DEPTH_M * el.z`, docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §四 2);
//   `depth.write` says whether an opaque fragment owns the depth buffer.
// * `items` are already in `drawOrder`; `drawOrder` only decides translucent
//   stacking (the picture itself is decided by depth since 问题四).
// * A `raster` item (a code layer, §6, WP3.3) carries no pixels: `content`
//   holds exactly the request the RenderWorkerPool needs for this frame
//   (`source`, `params`, `seed`, `size`, `mode`) and the raster fills the quad
//   (uv [0,0,1,1]). Every consumer fetches it from the one rasteriser (P4).
import { clamp } from './time.js';
import { evalElement, motionDelta, parseColor } from './evaluate.js';
import { elementOverlay } from './links.js';
import {
  cameraParamResolver, elementWorldNodeWithLinks, evalCameraWorldWithLinks,
  linksEvalOptions, objectWorldPoseWithLinks,
} from './link-eval.js';
import { cameraLayers, cameraTransform, cameraAtTime } from './camera.js';
import { elementWorldParent } from './spatial-parent.js';
import { frameOf } from './spatial.js';
import { normalizeFeed } from './camfeed.js';
import { basisFromDir } from './scene.js';
import { mediaSpec, textSpec, videoFrame } from './objects-media.js';
import { LAYER_DEPTH_M, nodePlaneModel, orderLayers, planeOfFrame } from './layers.js';
import { codeLayerPlan } from './code-layer.js';

/** Bump when the shape of a FrameIR changes (frozen key, §4 / §12). */
export const FRAME_IR_VERSION = 3;

/** One project pixel in metres (unified space, docs/DESIGN-UNIFIED-SPACE.md). */
export const PIXEL_M = 0.01;

/**
 * A 2D plane fragment at least this opaque owns its pixel (FIX §四 1). Mirrors
 * `preview.js::DEPTH_ALPHA`, which drew the depth-only pass before this rule
 * moved into the IR.
 */
export const DEPTH_ALPHA = 0.5;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6;

/**
 * World matrix of one project pixel of a plane whose SpatialNode frame is
 * already known — the half of `elementPixelMatrix` that does not walk the
 * parent chain again. The IR builds each node once per frame and passes the
 * frame here, so a 138-element frame walks its parents once, not twice.
 */
export function pixelMatrixOf(frame, el, t, meta = {}) {
  const d = motionDelta(el, t, meta);
  // Same motion placement as preview.js::_nodePlane: screen px along the
  // plane's unrolled axes, extra roll around the normal, size multiplier.
  const base = basisFromDir(frame.basis[2], 0);
  const dx = (Number(d.x) || 0) / 100;
  const dy = -(Number(d.y) || 0) / 100;
  const offset = [0, 1, 2].map((i) => -base.right[i] * dx + base.up[i] * dy);
  // Bug-compatible with preview.js::_nodePlane (`Math.abs(x || 1)`): a node
  // scale of 0 draws at full size, not as a sliver. The screen path below has
  // no such fallback because M3.S(0, 0) really did collapse the quad — the two
  // branches disagree on scale 0 in the old renderer and this keeps that.
  const sc = frame.scale || [];
  const { model: m } = nodePlaneModel(
    frame,
    PIXEL_M * (Math.abs(num(sc[0], 1)) || 1),
    PIXEL_M * (Math.abs(num(sc[1], 1)) || 1),
    { offset, roll: d.rotation, scale: d.scale },
  );
  // nodePlaneModel keeps the normal at unit length; the IR is in pixels along
  // the normal too (layer offsets and Blender's pixel geometry): scale it.
  for (let i = 8; i < 11; i++) m[i] *= PIXEL_M;
  // `-0` is not JSON (it serialises as `0`), and a frozen IR must survive a
  // round trip unchanged: normalise it where negations create it.
  return m.map((v) => v + 0);
}

/**
 * World matrix of one project pixel of `el`'s plane at t (column-major 4x4),
 * links included. Shared by the IR and the Blender bake (`engine/element-bake.js`
 * re-exports it) so `items[].world` and the baked `_world` can never drift.
 *
 * The matrix is NOT rounded here: callers that serialise it (the bake writes
 * 6-decimal numbers) round at their own boundary.
 */
export function elementPixelMatrix(project, el, t, opts = null) {
  const meta = project.meta || {};
  const frame = frameOf(elementWorldNodeWithLinks(project, el, t, opts || linksEvalOptions(project)));
  return pixelMatrixOf(frame, el, t, meta);
}

/**
 * World matrix of one project pixel of a legacy (screen-space) 2D element: the
 * same placement the 2x3 screen matrix produced, expressed in the unified
 * space so one draw path serves both kinds of layer.
 *
 * `st` is `core/evaluate.js::evalElement`; the quad size is not needed because
 * a pixel matrix has no notion of extent.
 *
 * The screen matrix puts canvas y DOWN; the IR's local +ly is UP, so column 1
 * flips sign here. Backends sample `(lx + 0.5, 0.5 - ly)`, which cancels the
 * flip exactly — the picture is bit-identical to the old screen path (the
 * WP0.2 comparison is what proves it).
 */
export function screenPixelMatrix(st, meta = {}) {
  const cyW = (Number(meta.height) || 1080) / 200;
  const rad = ((Number(st?.rotation) || 0) * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // The legacy screen matrix multiplied by st.scale verbatim: scale 0 was an
  // invisible quad, and it stays one (no `|| 1` fallback here, unlike nodes).
  const k = PIXEL_M * (Number.isFinite(Number(st?.scale)) ? Number(st.scale) : 1);
  return [
    k * c, -k * s, 0, 0,
    k * s, k * c, 0, 0,
    0, 0, PIXEL_M, 0,
    (Number(st?.x) || 0) / 100, cyW - (Number(st?.y) || 0) / 100, Number(st?.z) || 0, 1,
  ].map((v) => v + 0); // `-0` is not JSON (same reason as pixelMatrixOf)
}

/**
 * The 4x4 a renderer feeds to its vertex shader for one item: `world` scaled by
 * the quad's size in project pixels, with the normal made unit-length and the
 * depth bias pushed along it.
 *
 * `size` defaults to `item.size` and exists for kinds whose box is typeset by
 * the consumer (text, until WP1.3 brings the glyph geometry into the IR): the
 * caller passes the box it measured, so placement stays IR-owned even while
 * the measurement lives elsewhere.
 */
export function itemModelMatrix(item, size = item.size) {
  const m = item?.world;
  if (!Array.isArray(m) || m.length < 16) return null;
  // `size: null` means the content typesets its own box (text until WP1.3):
  // there is no matrix without one, and pretending there is would draw a
  // collapsed quad instead of failing loudly.
  if (!Array.isArray(size)) return null;
  const w = num(size[0]);
  const h = num(size[1]);
  const bias = num(item?.depth?.bias);
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    out[i] = m[i] * w;
    out[4 + i] = m[4 + i] * h;
    out[8 + i] = m[8 + i] * 100;
  }
  out[12] = m[12] + out[8] * bias;
  out[13] = m[13] + out[9] * bias;
  out[14] = m[14] + out[10] * bias;
  out[15] = m[15];
  return out;
}

// ---------------------------------------------------------------- helpers

/** `#rgb` / `#rrggbb` exactly like preview.js::hexRgb, CSS colours otherwise. */
function colorOf(c) {
  const s = String(c || '#000').replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return s.split('').map((x) => parseInt(x + x, 16) / 255);
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
  }
  return parseColor(c);
}

/** The eye this frame is seen through: the free editor camera, a named one, or live. */
function eyeOf(project, t, opts) {
  const edit = opts.edit;
  if (edit && edit.mode) {
    const cam = edit.cam || null;
    return { mode: 'editor', cam, state: evalCameraWorldWithLinks(project, t, cam) };
  }
  const asked = opts.camera;
  const named = asked && asked !== 'live'
    ? (project.cameras || []).find((c) => c.id === asked) || null
    : null;
  const cam = named || (asked === 'live' || !asked ? cameraAtTime(project, t) : null);
  return { mode: named ? 'camera' : 'live', cam, state: evalCameraWorldWithLinks(project, t, named) };
}

/** Screen-space effect numbers, already clamped the way the compositor reads them. */
function screenFxOf(meta) {
  const fx = meta?.fx || {};
  return {
    bloom: clamp(Number(fx.bloom) || 0, 0, 3),
    ca: Number(fx.ca) || 0,
    grain: Number(fx.grain) || 0,
    scanline: Number(fx.scanline) || 0,
    vignette: Number(fx.vignette) || 0,
    grade: Number(fx.grade) || 0,
    contrast: Number(fx.contrast) || 0,
    saturation: Number.isFinite(Number(fx.saturation)) ? Number(fx.saturation) : 1,
  };
}

function cameraRecord(cam) {
  return {
    near: num(cam?.near, 0.5) || 0.5,
    far: num(cam?.far, 5000) || 5000,
    dof: cam?.dof || { enabled: false },
    motionBlur: cam?.motionBlur || { enabled: true, shutter: 0.5 },
  };
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, -1];
}

/**
 * Camera-to-world matrix (column-major, GL convention: looks down -Z, +X right,
 * +Y up, roll around the forward axis). `pos` / `look` / `roll` / `fov` stay the
 * authoritative fields; this is the same pose in matrix form for a backend that
 * only eats matrices.
 */
export function cameraWorld16(state) {
  const pos = Array.isArray(state?.pos) ? state.pos : [0, 0, 0];
  const fw = norm3(sub3(Array.isArray(state?.look) ? state.look : [0, 0, -1], pos));
  let right = cross3(fw, [0, 1, 0]);
  if (Math.hypot(right[0], right[1], right[2]) < 1e-9) right = cross3(fw, [0, 0, 1]);
  right = norm3(right);
  let up = norm3(cross3(right, fw));
  const roll = ((num(state?.roll) * Math.PI) / 180);
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    const r = [right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s];
    up = [up[0] * c - right[0] * s, up[1] * c - right[1] * s, up[2] * c - right[2] * s];
    right = r;
  }
  return [
    right[0], right[1], right[2], 0,
    up[0], up[1], up[2], 0,
    -fw[0], -fw[1], -fw[2], 0,
    pos[0], pos[1], pos[2], 1,
  ].map((v) => v + 0); // `-0` is not JSON
}

/**
 * Image-space uv rect of a full-frame media element: which part of the media
 * fills the quad. `stretch` uses all of it; every other fit crops to cover —
 * that is what the 2D renderer always did (`preview.js::coverUV`), including
 * `contain` (a 2D element is a full-frame plane, so there is no letterbox).
 *
 * Exported so a backend never re-invents the formula: with `content.uv = null`
 * (the project does not know the media's intrinsic size) the consumer calls
 * this with the size it decoded. WP4.1 writes that size into the element and
 * the IR starts carrying the rect itself.
 */
export function mediaUVOf(fit, iw, ih, frame) {
  const w = num(iw);
  const h = num(ih);
  if (fit === 'stretch') return [0, 0, 1, 1];
  if (!(w > 0 && h > 0)) return null;
  const fw = num(frame?.[0], 1920) || 1920;
  const fh = num(frame?.[1], 1080) || 1080;
  const ia = w / h;
  const fa = fw / fh;
  if (ia > fa) {
    const f = fa / ia;
    return [(1 - f) / 2, 0, 1 - (1 - f) / 2, 1];
  }
  const f = ia / fa;
  return [0, (1 - f) / 2, 1, 1 - (1 - f) / 2];
}

/** 3D object types that draw something (same set engine/shot.js::bakeObjects bakes). */
const DRAWABLE_OBJECTS = new Set(['solid', 'shape', 'text', 'image', 'video', 'container']);

/**
 * 3D objects live on this frame, in the same shape engine/shot.js::bakeObjects
 * bakes them: a unit-basis world matrix, `size` = geometry × |scale|, plus the
 * colour / media / text the object is made of. Objects that only organise the
 * scene (`empty`, `camera`, `audio`) are not drawable and stay out.
 */
function objectsOf(project, t, nodeOpts, fps) {
  const objs = project.scene?.objects || [];
  if (!objs.length) return [];
  const poses = new Map();
  const out = [];
  for (const o of objs) {
    if (!DRAWABLE_OBJECTS.has(o.type) || o.visible === false) continue;
    const start = num(o.start);
    const dur = num(o.duration);
    if (t < start - 1e-6 || t >= start + dur - 1e-6) continue;
    const pose = objectWorldPoseWithLinks(project, o, t, poses, nodeOpts);
    const geom = o.geom || {};
    // A plane / text carries its own w×h (media and font decide it); a box is a
    // unit cube scaled to geom — the split shot.js uses.
    const unit = o.type === 'image' || o.type === 'video' || o.type === 'text';
    const g = unit ? [1, 1, 1] : [
      Math.max(0.001, num(geom.w, 2) || 2),
      Math.max(0.001, num(geom.h, 2) || 2),
      Math.max(0.001, num(geom.d, 2) || 2),
    ];
    const sc = Array.isArray(pose.scale) ? pose.scale : [1, 1, 1];
    const basis = pose.basis || {};
    const off = (v) => (Array.isArray(v) ? v.map((x) => num(x) + 0) : [0, 0, 0]);
    const world = [
      ...off(basis.right), 0,
      ...off(basis.up), 0,
      ...off(basis.forward), 0,
      ...off(pose.worldPos), 1,
    ];
    out.push({
      id: o.id,
      type: o.type,
      // Unit basis + size (a backend scales the quad itself); worldPos already
      // carries the parent chain and the object's own pivot.
      world,
      size: [g[0] * Math.abs(num(sc[0], 1)), g[1] * Math.abs(num(sc[1], 1)), g[2] * Math.abs(num(sc[2], 1))],
      opacity: clamp(num(pose.opacity, 1), 0, 1),
      color: o.style?.color || o.style?.fill || '#8fe0ff',
      emissive: Math.max(0, num(o.style?.emissive)),
      ...(unit && o.type !== 'text' ? { media: mediaSpec(o) } : {}),
      ...(unit && o.type === 'text' ? { text: textSpec(o) } : {}),
      ...(o.type === 'video' ? { frame: videoFrame(o, t, fps, Number(o._sequenceCount) || Infinity) } : {}),
    });
  }
  return out;
}

/**
 * What frame `frame` looks like.
 *
 * `opts.camera`: `'live'` (the shot camera at this time — the default) or a
 * camera id. `opts.edit = { cam, mode }` is the free editor view.
 * `opts.soloCameras` is the viewport's isolate set. `opts.viewport` is accepted
 * for callers that size their own framebuffer; the IR itself is in project
 * pixels, so it changes nothing here. `opts.cache` (an IRCache) makes repeat
 * calls at the same revision free.
 */
export function buildFrameIR(project, frame, opts = {}) {
  const meta = project.meta || {};
  const fps = num(opts.fps) || num(meta.fps, 24) || 24;
  const f = Math.max(0, Math.round(num(frame)));
  const t = f / fps;
  const size = [num(meta.width, 1920) || 1920, num(meta.height, 1080) || 1080];
  const rev = num(project.rev);
  const solo = opts.soloCameras instanceof Set ? opts.soloCameras : null;
  const cache = opts.cache || null;
  const viewSig = [
    opts.camera && opts.camera !== 'live' ? `cam:${opts.camera}` : opts.camera === 'live' ? 'live' : 'auto',
    opts.edit && opts.edit.mode ? `edit:${opts.edit.cam || ''}` : '-',
    solo ? [...solo].sort().join(',') : '-',
  ].join('|');
  const sig = `${f}|${fps}|${viewSig}|${opts.city?.hash || '-'}`;
  if (cache) {
    const hit = cache.get(sig, rev);
    if (hit) return hit;
  }

  const eye = eyeOf(project, t, opts);
  const nodeOpts = linksEvalOptions(project);
  const layers = [];
  const ids = [];
  const elements = Array.isArray(project.elements) ? project.elements : [];
  for (let idx = 0; idx < elements.length; idx++) {
    const el = elements[idx];
    if (el.visible === false) continue;
    const start = num(el.start);
    const dur = num(el.duration);
    if (t < start - 1e-6 || t >= start + dur - 1e-6) continue;
    const st = evalElement(el, t, meta, elementOverlay(project, el, t));
    if (st.opacity <= 0.002) continue;
    const style = el.style || {};
    // Unified space: el.node is the placement source of truth; a spatial parent
    // carries the whole chain, so a parented legacy layer enters the world-plane
    // path too, while an unparented legacy layer stays on the screen path
    // (identical rule to preview.js::computeLayers).
    const nodeFrame = (el.node || elementWorldParent(el))
      ? frameOf(elementWorldNodeWithLinks(project, el, t, nodeOpts))
      : null;
    let kind = null;
    let content = null;
    let quad = null;
    if (el.type === 'text') {
      kind = 'text';
      // The box is the typesetting result; until WP1.3 owns glyph geometry the
      // consumer measures it and passes the size to itemModelMatrix().
      content = {
        text: String(st.text ?? ''),
        fontSize: num(st.size, 96) || 96,
        color: st.color || style.color || '#ffffff',
        font: style.font || 'SimHei',
        weight: num(style.weight, 400) || 400,
        align: style.align || 'center',
        lineHeight: num(style.lineHeight, 1.18) || 1.18,
        letterSpacing: num(style.letterSpacing),
        shadow: num(style.shadow),
        stroke: style.stroke || '',
        strokeWidth: num(style.strokeWidth),
        uv: [0, 0, 1, 1],
      };
    } else if (el.type === 'image' || el.type === 'video') {
      kind = el.type;
      content = {
        src: el.src || '',
        fit: style.fit || 'cover',
        uv: mediaUVOf(style.fit || 'cover', el.meta?.width, el.meta?.height, size),
      };
      quad = [size[0], size[1]];
    } else if (el.type === 'camfeed') {
      kind = 'camfeed';
      // uv is in image space; the preview's target texture is bottom-up, which
      // is the backend's business (wdm: it flips v when it binds).
      content = { feed: normalizeFeed(el.feed), uv: [0, 0, 1, 1] };
      quad = [size[0], size[1]];
    } else if (el.type === 'code') {
      // A code layer is one raster of the render pool (§5 / §6.1, WP3.3). Its
      // parameters are evaluated here with the same function the pool is fed
      // from, per frame, so no consumer evaluates them again (P2). `mode` is the
      // element's `cache` policy: `live` lets the consumer render on demand,
      // `bake` only reads already-cached frames.
      kind = 'raster';
      const plan = codeLayerPlan(project, el, t, { fps });
      content = {
        source: { id: plan.sourceId, runtime: plan.runtime },
        params: plan.params,
        seed: plan.seed,
        // Raster resolution in pixels (`code.size`, the project size when
        // unset). The quad below stays the full project frame like image /
        // video, so a 960x540 layer is scaled up onto it.
        size: plan.size,
        mode: plan.cache,
      };
      quad = [size[0], size[1]];
    } else if (el.type === 'solid' || el.type === 'shape') {
      kind = el.type;
      content = {
        fill: colorOf(style.fill || style.color || '#ffffff'),
        radius: num(style.radius),
        ellipse: style.shape === 'ellipse',
        uv: [0, 0, 1, 1],
      };
      quad = [num(style.w, size[0]) || size[0], num(style.h, size[1]) || size[1]];
    } else {
      continue; // audio has no picture
    }
    const z = num(el.z);
    const plane = nodeFrame
      ? planeOfFrame(nodeFrame)
      : { p: [(num(st.x)) / 100, size[1] / 200 - num(st.y) / 100, num(st.z)], n: [0, 0, 1] };
    layers.push({
      el,
      plane,
      src: idx,
      item: {
        id: el.id,
        kind,
        src: idx,
        z,
        world: nodeFrame ? pixelMatrixOf(nodeFrame, el, t, meta) : screenPixelMatrix(st, meta),
        size: quad,
        crop: [0, 0, 1, 1],
        opacity: st.opacity,
        blend: style.blend || 'normal',
        depth: {
          write: !!nodeFrame && st.opacity >= DEPTH_ALPHA,
          // A backend that owns depth must draw twice: a depth-only pass that
          // discards below `cut` (so a glyph keeps its anti-aliased rim and a
          // text box does not punch a hole), then the colour pass at cut 0
          // (docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §四 1).
          cut: DEPTH_ALPHA,
          bias: nodeFrame ? LAYER_DEPTH_M * z : 0,
        },
        drawOrder: 0,
        plane,
        content: { ...content, glow: num(st.glow) },
        effects: [],
        source: el.source && el.source.id ? { id: el.source.id, node: el.source.node ?? null } : null,
      },
    });
    ids.push(el.id);
  }

  // Draw order: `el.z` per plane (stable under a shuffled input because `src`
  // is the project index), then the shared plane-group rule of core/layers.js.
  const sorted = layers.slice().sort((a, b) => (num(a.el.z) - num(b.el.z)) || (a.src - b.src));
  const ordered = orderLayers(sorted, eye.state.pos);
  const items = new Array(ordered.length);
  for (let i = 0; i < ordered.length; i++) {
    const it = ordered[i].item;
    it.drawOrder = i;
    items[i] = it;
  }

  const rec = cameraRecord(eye.cam);
  const camera = {
    id: eye.cam?.id || null,
    mode: eye.mode,
    pos: eye.state.pos,
    look: eye.state.look,
    up: cameraWorld16(eye.state).slice(4, 7),
    roll: num(eye.state.roll),
    fov: num(eye.state.fov, 50) || 50,
    focus: num(eye.state.focus),
    near: rec.near,
    far: rec.far,
    dof: rec.dof,
    motionBlur: rec.motionBlur,
    world: cameraWorld16(eye.state),
  };

  const param = cameraParamResolver(project);
  const stack = [];
  for (const cam of cameraLayers(project, solo, t)) {
    const tr = cameraTransform(cam, t, { param });
    const sx = num(tr.scale?.[0], 1);
    const sy = num(tr.scale?.[1], 1);
    // A hidden / fully transparent / collapsed camera clip draws nothing
    // (`preview.js::_drawCameraStack` skips exactly these).
    if (!(tr.opacity > 0.002) || Math.abs(sx) < 1e-4 || Math.abs(sy) < 1e-4) continue;
    const state = evalCameraWorldWithLinks(project, t, cam, nodeOpts);
    stack.push({
      id: cam.id,
      name: cam.name || cam.id,
      active: cam.id === project.activeCameraId,
      opacity: tr.opacity,
      picture: {
        scale: [sx, sy],
        pivot: [num(tr.picturePivot?.[0], 0.5), num(tr.picturePivot?.[1], 0.5)],
        offset: [num(tr.pictureOffset?.[0]), num(tr.pictureOffset?.[1])],
      },
      camera: {
        pos: state.pos,
        look: state.look,
        roll: num(state.roll),
        fov: num(state.fov, 50) || 50,
        focus: num(state.focus),
        world: cameraWorld16(state),
      },
      ...cameraRecord(cam),
    });
    ids.push(cam.id);
  }

  const objects3d = objectsOf(project, t, nodeOpts, fps);
  for (const o of objects3d) ids.push(o.id);

  const ir = {
    version: FRAME_IR_VERSION,
    rev,
    frame: f,
    t,
    fps,
    size,
    camera,
    cameraLayers: stack,
    items,
    objects3d,
    screenFx: screenFxOf(meta),
    world: {
      source: project.world?.source || 'none',
      background: meta.background || '#000000',
      hash: opts.city?.hash || null,
    },
  };
  if (cache) cache.set(sig, ir, rev, ids);
  return ir;
}

/** Every frame of [f0, f1] as an IR (streaming: buildFrameIR one at a time). */
export function* buildRangeIR(project, f0, f1, opts = {}) {
  const a = Math.max(0, Math.round(num(f0)));
  const b = Math.max(a, Math.round(num(f1)));
  for (let f = a; f <= b; f++) yield buildFrameIR(project, f, opts);
}

/**
 * Per-revision IR cache (§4.1/§4.3): a frame built at one revision is reused
 * until the project changes. `invalidate(changedIds)` drops only the frames
 * whose draw list mentions those ids (a keyframe on `s2_w2` must not throw away
 * the other 137 elements' frames); no ids drops everything.
 *
 * Entries are keyed by frame + fps + view signature and are considered stale
 * as soon as `project.rev` moves on — the cache never serves a frame from a
 * revision it was not built at. Treat a returned IR as read-only.
 */
export class IRCache {
  constructor({ maxEntries = 2048 } = {}) {
    this.entries = new Map();
    this.byId = new Map();
    this.maxEntries = maxEntries;
    this.hits = 0;
    this.misses = 0;
  }

  get(sig, rev = 0) {
    const e = this.entries.get(sig);
    if (!e || e.rev !== rev) {
      if (e) this._drop(sig);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return e.ir;
  }

  set(sig, ir, rev = 0, ids = []) {
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      let keys = this.byId.get(id);
      if (!keys) { keys = new Set(); this.byId.set(id, keys); }
      keys.add(sig);
    }
    this.entries.set(sig, { ir, rev, ids: seen });
    if (this.entries.size > this.maxEntries) this._drop(this.entries.keys().next().value);
    return ir;
  }

  invalidate(changedIds) {
    if (!changedIds) { this.clear(); return this; }
    const list = typeof changedIds === 'string' ? [changedIds] : [...changedIds];
    for (const id of list) {
      const keys = this.byId.get(id);
      if (!keys) continue;
      for (const sig of [...keys]) this._drop(sig);
    }
    return this;
  }

  clear() {
    this.entries.clear();
    this.byId.clear();
    return this;
  }

  get size() { return this.entries.size; }

  _drop(sig) {
    const e = this.entries.get(sig);
    if (!e) return;
    for (const id of e.ids) {
      const keys = this.byId.get(id);
      if (!keys) continue;
      keys.delete(sig);
      if (!keys.size) this.byId.delete(id);
    }
    this.entries.delete(sig);
  }
}
