// Shot baking: one JSON package shared by the WebGL viewport and Blender.
//   { fps, frames, world, city, camera:[{f,t,pos,look,roll,fov}], fx, cameraCfg }
//
// Since WP1.1 (docs/DESIGN-BACKEND-V2.md §10.2) the package also carries `v3`:
// the frame IR of the whole shot compressed to `{ static, tracks }` records.
// It is added *beside* the legacy fields — vdm_build.py still reads the old
// ones (deleting them is WP1.2), so every existing render is unchanged.
//
// `v3` is what makes a backend that only reads numbers possible (P2): no
// curves, easing, links, motion presets or parent chains are left for Python,
// every frame's draw list is already in the package. Frames are 1-based render
// frames (`f = round(t·fps) + 1`, §4.4); `frameFromShotV3(v3, f)` rebuilds the
// IR frame the preview would build at `core/frame-ir.js` frame `f - 1`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { bakeCameraTrack, cameraLayers, cameraTransform } from '../core/camera.js';
import { FRAME_IR_VERSION, buildFrameIR } from '../core/frame-ir.js';
import { QUANTIZE, packV3, packV3Runs, unpackV3 } from './element-bake.js';
import {
  cameraParamResolver, evalCameraWorldWithLinks, linksEvalOptions, objectWorldPoseWithLinks,
} from '../core/link-eval.js';
import { isPlane, isText, mediaSpec, textSpec, videoFrame } from '../core/objects-media.js';
import { generateCity, cityHash } from './city.js';
import { paths } from './storage.js';
import { compileProject } from '../core/tracks.js';
import { compute } from './compute.js';
import { hashOf } from './media.js';
import { atomicJson } from './storage.js';
import { RENDER_PLAN_VERSION } from '../core/version.js';

const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const OBJ_TYPES = new Set(['solid', 'shape', 'text', 'image', 'video', 'container']);

/** A camera with a unified spatial parent needs the world wrapper; others keep the shipped bake. */
// ...or a three-axis rotation offset (core/rotation.js), which only that path applies.
const hasFrameParent = (cam) => !!cam?.frameParent?.id
  || (Array.isArray(cam?.rotation) && cam.rotation.some((v) => Number(v)))
  || ['rotation.x', 'rotation.y', 'rotation.z'].some((p) => Array.isArray(cam?.tracks?.[p]) && cam.tracks[p].length);

/**
 * Same shape / rounding as core/camera.js::bakeCameraTrack, but reads
 * evalCameraWorld so a camera with `frameParent` bakes the parented frame the
 * viewport draws. Only used when such a camera exists, which keeps every
 * existing project's shot.json byte-identical.
 */
function bakeCameraTrackWorld(project, { fps = 24, from = 0, to = null, camera = null } = {}) {
  const dur = to ?? project.meta.duration;
  const f0 = Math.round(from * fps), f1 = Math.round(dur * fps);
  const out = [];
  for (let f = f0; f <= f1; f++) {
    const t = f / fps;
    const c = evalCameraWorldWithLinks(project, t, camera);
    out.push({
      f: f + 1,
      t: Math.round(t * 1000) / 1000,
      pos: c.pos.map((v) => Math.round(v * 1000) / 1000),
      look: c.look.map((v) => Math.round(v * 1000) / 1000),
      roll: Math.round(c.roll * 1000) / 1000,
      fov: Math.round(c.fov * 1000) / 1000,
      focus: Math.round((c.focus || 0) * 1000) / 1000,
      dof: { enabled: !!c.dof?.enabled, fstop: Math.round((c.dof?.fstop ?? 2.8) * 1000) / 1000 },
    });
  }
  return out;
}

/** Bake one specific camera: the world wrapper only when it has a frameParent. */
function bakeCameraOf(project, cam, opts) {
  return hasFrameParent(cam)
    ? bakeCameraTrackWorld(project, { ...opts, camera: cam })
    : bakeCameraTrack(forCamera(project, cam), { ...opts, param: cameraParamResolver(project) });
}

/**
 * Elements -> per-frame transforms for Blender. Same worldPose() (objectPose +
 * parent chain) as the viewport, plus the unified `frameParent` matrix layer
 * (core/spatial-parent.js::objectWorldPose), so a 3D object parented to a 2D
 * element / camera renders where the preview draws it. Without a frameParent
 * the wrapper is exactly worldPose, so existing shots do not change.
 */
export function bakeObjects(project, { fps = 24, from = 0, to = null } = {}) {
  const objs = project.scene?.objects || [];
  if (!objs.length) return [];
  const f0 = Math.round(from * fps) + 1;
  // One extra frame past the (exclusive) end is baked on purpose: it carries the
  // hidden state at the boundary so a sample exactly at `to` never pops to the
  // previous pose (tests/shot.test.mjs "the time range has an exclusive end").
  const f1 = Math.round((to ?? project.meta.duration) * fps) + 1;
  const out = [];
  const poses = new Map();
  const evalOpts = linksEvalOptions(project);
  for (const o of objs) {
    if (!OBJ_TYPES.has(o.type) || o.visible === false) continue;
    const start = Number(o.start) || 0;
    const end = start + (Number(o.duration) || 0);
    const geom = o.geom || {};
    // Boxes scale a unit cube to geom; planes keep their own w×h (fitted in
    // Blender once the picture's size is known); text is built at its real size.
    const g = isPlane(o) || isText(o) ? [1, 1, 1] : [
      Math.max(0.001, Number(geom.w) || 2),
      Math.max(0.001, Number(geom.h) || 2),
      Math.max(0.001, Number(geom.d) || 2),
    ];
    const seqCount = Number(o._sequenceCount) || 0;
    const frames = [];
    for (let f = f0; f <= f1; f++) {
      const t = (f - 1) / fps;
      const live = t >= start - 1e-6 && t < end - 1e-6;
      const pose = objectWorldPoseWithLinks(project, o, t, poses, evalOpts);
      const hidden = live ? 1 : 0.0001;
      frames.push({
        f,
        loc: pose.worldPos.map(r3),
        rot: [pose.basis.right, pose.basis.up, pose.basis.forward].map((v) => v.map(r3)),
        size: [g[0] * Math.abs(pose.scale[0]) * hidden,
          g[1] * Math.abs(pose.scale[1]) * hidden,
          g[2] * Math.abs(pose.scale[2]) * hidden].map((v) => Math.max(0.0001, r3(v))),
        opacity: live ? Math.round(pose.opacity * 1000) / 1000 : 0,
        ...(o.type === 'video' ? { vf: videoFrame(o, t, fps, seqCount || Infinity) } : {}),
      });
    }
    out.push({
      id: o.id,
      name: o.name || o.id,
      type: o.type,
      // `primitive` decides the mesh for a solid (box / cylinder); the preview
      // reads the same field (app/renderer/js/preview3d.js::UNIT_CYLINDER).
      ...(o.type === 'solid' && o.primitive ? { primitive: String(o.primitive) } : {}),
      color: o.style?.color || o.style?.fill || '#8fe0ff',
      emissive: Math.max(0, Number(o.style?.emissive) || 0),
      ...(isPlane(o) ? { media: { ...mediaSpec(o), sequence: o._sequenceDir ? { dir: o._sequenceDir, count: seqCount } : null } } : {}),
      ...(isText(o) ? { text: textSpec(o) } : {}),
      frames,
    });
  }
  return out;
}

export const is3D = (project) => cameraLayers(project).length > 0;

function forCamera(project, camera) {
  return { ...project, camera, cameras: [], cameraOrder: [], activeCameraId: null };
}

/** Full-shot flight corridors are independent polylines, shared by every view. */
export function worldSnapshot(project) {
  const paths = cameraLayers(project).map((cam) => bakeCameraOf(project, cam, {
    fps: project.meta.fps,
  }).map((state) => state.pos));
  return cachedCity(project.world, null, { paths });
}

/** Bake one camera layer, including its per-frame picture transform. */
function bakeCameraLayer(project, cam, { fps, from, to }) {
  const track = bakeCameraOf(project, cam, { fps, from, to });
  const param = cameraParamResolver(project);
  const frames = track.map((e) => {
    const tr = cameraTransform(cam, e.t, { param });
    return {
      f: e.f,
      t: e.t,
      opacity: Math.round(tr.opacity * 1000) / 1000,
      scale: [tr.scale[0], tr.scale[1]].map((v) => Math.round(v * 1000) / 1000),
      picturePivot: tr.picturePivot.map((v) => Math.round(v * 1000) / 1000),
      pictureOffset: tr.pictureOffset.map((v) => Math.round(v * 1000) / 1000),
    };
  });
  return {
    id: cam.id,
    name: cam.name || cam.id,
    camera: track,
    frames,
    cameraCfg: {
      near: Number(cam.near) || 0.5,
      far: Number(cam.far) || 5000,
      dof: cam.dof || { enabled: false },
      motionBlur: cam.motionBlur || { enabled: true, shutter: 0.5 },
    },
  };
}

/**
 * Camera clips that simply follow one another (each with its own start /
 * duration, no overlap, default picture transform): a cut sequence. Blender
 * then renders them as ONE camera whose baked track jumps at the cuts (the
 * current-shot rule of evalCamera), so the single-camera path keeps the 2D
 * elements in the world, the screen-locked type and the compositor.
 */
export function isCutSequence(project) {
  const cams = cameraLayers(project);
  if (cams.length < 2) return false;
  const near1 = (v) => Math.abs(Number(v) - 1) < 1e-4;
  const clips = [];
  for (const c of cams) {
    if (!Number.isFinite(Number(c.start)) || !(Number(c.duration) > 0)) return false;
    const tr = c.tracks || {};
    if (['opacity', 'scale', 'picturePivot', 'pictureOffset'].some((k) => Array.isArray(tr[k]) && tr[k].length)) return false;
    const sc = c.scale || [1, 1, 1];
    const pv = c.picturePivot || [0.5, 0.5];
    const po = c.pictureOffset || [0, 0];
    if (!near1(c.opacity ?? 1) || !near1(sc[0]) || !near1(sc[1])) return false;
    if (Math.abs(pv[0] - 0.5) > 1e-4 || Math.abs(pv[1] - 0.5) > 1e-4 || Math.abs(po[0]) > 1e-4 || Math.abs(po[1]) > 1e-4) return false;
    clips.push([Number(c.start), Number(c.start) + Number(c.duration)]);
  }
  clips.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < clips.length; i++) if (clips[i][0] < clips[i - 1][1] - 1e-4) return false;
  return true;
}

/** Push one frame's entity under its id (a Map of frame entries). */
const pushFrame = (map, id, f, value) => {
  let list = map.get(id);
  if (!list) { list = []; map.set(id, list); }
  list.push({ i: f, f, value });
};

/**
 * The v3 payload (WP1.1): one pass over the frame IR of `[f0, f1]`, compressed
 * into `{ static, tracks }` records (engine/element-bake.js packV3).
 *
 *   * one record per 2D element (`items`) — the draw list, not the project:
 *     presence, `world`, `size`, `opacity`, `depth`, `content` and the frozen
 *     `drawOrder` are all in here, evaluated once by core/;
 *   * one record per 3D object (`objects`) and per camera layer
 *     (`cameraLayers`), plus the main eye (`camera`) and the frame constants
 *     (`size` / `world` / `screenFx` / `rev` / `irVersion`).
 *
 * `static` is written once per record; a field only gets a track when its value
 * really changes (a matrix that only translates writes 3 index tracks, not 451
 * copies). Matrix leaves are quantised — `world` to 1e-6, the tolerance §4.4
 * grants the frozen IR matrix; the plane and camera pose to 1e-9 — every other
 * number is exact.
 */
export function buildShotV3(project, { fps = null, from = 0, to = null, city = null } = {}) {
  const frameRate = fps || project.meta?.fps || 24;
  const end = to ?? project.meta.duration;
  // 1-based render frames, `f = IR frame + 1` (§4.4). The last baked frame sits
  // one past the (exclusive) render end on purpose: it carries the hidden state
  // at the boundary, exactly like the legacy camera / object bakes (e82f7d1).
  const f0 = Math.round(from * frameRate) + 1;
  const f1 = Math.max(f0, Math.round(end * frameRate) + 1);
  const citySnapshot = city || worldSnapshot(project);
  const itemFrames = new Map();
  const layerFrames = new Map();
  const objectFrames = new Map();
  const cameraFrames = [];
  let head = null;
  for (let f = f0; f <= f1; f++) {
    // The IR is already in `drawOrder`; nothing here re-decides anything.
    const ir = buildFrameIR(project, f - 1, { fps: frameRate, city: citySnapshot });
    if (!head) head = ir;
    cameraFrames.push({ i: f, f, value: ir.camera });
    for (const it of ir.items) pushFrame(itemFrames, it.id, f, it);
    for (const l of ir.cameraLayers) pushFrame(layerFrames, l.id, f, l);
    for (const o of ir.objects3d) pushFrame(objectFrames, o.id, f, o);
  }
  // Array positions of the entities whose IR order is static (items carry a
  // per-frame `drawOrder` instead).
  const layerOrder = new Map(cameraLayers(project).map((c, i) => [c.id, i]));
  const objectOrder = new Map((project.scene?.objects || []).map((o, i) => [o.id, i]));
  const pack = (map, { quantize = null, orderOf = null } = {}) => {
    const out = [];
    for (const [id, entries] of map) {
      for (const rec of packV3Runs(id, entries, { quantize })) {
        out.push(orderOf ? { id, order: orderOf.get(id) ?? 0, ...rec } : rec);
      }
    }
    out.sort((a, b) => (a.span[0] - b.span[0])
      || ((a.order ?? 0) - (b.order ?? 0))
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  };
  return {
    version: RENDER_PLAN_VERSION,
    irVersion: FRAME_IR_VERSION,
    rev: Number(project.rev) || 0,
    fps: frameRate,
    from,
    to: end,
    f0,
    f1,
    frames: f1 - f0 + 1,
    size: head.size,
    world: head.world,
    screenFx: head.screenFx,
    camera: {
      span: [f0, f1],
      ...packV3(f0, cameraFrames.map((e) => e.value), { quantize: QUANTIZE.camera }),
    },
    cameraLayers: pack(layerFrames, {
      quantize: QUANTIZE.camera,
      orderOf: layerOrder,
    }),
    items: pack(itemFrames, { quantize: QUANTIZE.element }),
    objects: pack(objectFrames, { quantize: QUANTIZE.element, orderOf: objectOrder }),
  };
}

/** Items of one frame in draw order, from a v3 payload (empty outside the range). */
export function shotV3FrameItems(v3, frame) {
  const f = Math.round(Number(frame));
  const items = [];
  for (const rec of v3.items) {
    const it = unpackV3(rec, f);
    if (it) items.push(it);
  }
  return items.sort((a, b) => a.drawOrder - b.drawOrder);
}

/**
 * Rebuild the frame IR that `buildFrameIR(project, frame - 1)` would have
 * built, from a v3 payload alone — the reader side of `buildShotV3`, and the
 * contract WP1.2's Blender path implements. `frame` is a 1-based render frame,
 * the same base as the pack's `f0` / `tracks.f0` / `span`.
 */
export function frameFromShotV3(v3, frame) {
  const f = Math.round(Number(frame));
  const layers = [];
  const objects3d = [];
  for (const rec of v3.cameraLayers) {
    const v = unpackV3(rec, f);
    if (v) layers.push({ order: rec.order ?? 0, value: v });
  }
  for (const rec of v3.objects) {
    const v = unpackV3(rec, f);
    if (v) objects3d.push({ order: rec.order ?? 0, value: v });
  }
  layers.sort((a, b) => a.order - b.order);
  objects3d.sort((a, b) => a.order - b.order);
  return {
    version: v3.irVersion,
    rev: v3.rev,
    frame: f - 1,
    t: (f - 1) / v3.fps,
    fps: v3.fps,
    size: v3.size,
    camera: unpackV3(v3.camera, f),
    cameraLayers: layers.map((l) => l.value),
    items: shotV3FrameItems(v3, f),
    objects3d: objects3d.map((o) => o.value),
    screenFx: v3.screenFx,
    world: v3.world,
  };
}

export function buildShot(project, { from = 0, to = null, fps = null } = {}) {
  compileProject(project);
  const frameRate = fps || project.meta.fps || 24;
  const end = to ?? project.meta.duration;
  // a cut sequence renders through the single live-camera track below
  const layers = isCutSequence(project) ? [] : cameraLayers(project).map((cam) => bakeCameraLayer(project, cam, {
    fps: frameRate, from, to: end,
  }));
  // Bake the active camera as the legacy single-camera field. Blender keeps
  // this path for one-camera projects and switches to cameraLayers when there
  // is more than one visible layer. A camera with a spatial `frameParent` (or a
  // stack that can go live with one) bakes through evalCameraWorld; otherwise
  // the shipped bakeCameraTrack is used untouched.
  const liveParented = hasFrameParent(project.camera)
    || cameraLayers(project).some(hasFrameParent);
  const camera = liveParented
    ? bakeCameraTrackWorld(project, { fps: frameRate, from, to: end })
    : bakeCameraTrack(project, {
      fps: frameRate, from, to: end, param: cameraParamResolver(project),
    });
  const city = worldSnapshot(project);
  const cam = project.camera || {};
  return {
    version: RENDER_PLAN_VERSION,
    fps: frameRate,
    frames: camera.length,
    from,
    to: end,
    width: project.meta.width,
    height: project.meta.height,
    city,
    camera,
    cameraLayers: layers,
    objects: bakeObjects(project, { fps: frameRate, from, to: end }),
    fx: project.meta.fx,
    cameraCfg: {
      near: Number(cam.near) || 0.5,
      far: Number(cam.far) || 5000,
      dof: cam.dof || { enabled: false },
      motionBlur: cam.motionBlur || { enabled: true, shutter: 0.5 },
    },
    // v3 reads the same project once more through the IR; the legacy fields
    // above are untouched so vdm_build.py keeps rendering exactly as before.
    v3: buildShotV3(project, { fps: frameRate, from, to: end, city }),
  };
}

/** Write the shot package next to the render job; returns its path. */
export async function writeShot(dir, project, opts = {}) {
  const p = paths(dir);
  const { signal, ...options } = opts;
  // Blender overlay/sequence paths are derived data; hash the authored elements
  // only (the links themselves still invalidate the cache).
  const elements = (project.elements || []).map(({ _linkOverlay, _sequenceDir, ...el }) => el);
  const key = hashOf({ version: RENDER_PLAN_VERSION, meta: project.meta, elements,
    cameras: project.cameras, camera: project.camera,
    cameraOrder: project.cameraOrder, scene: project.scene, world: project.world, options });
  const file = path.join(p.cache, `shot-${key}.json`);
  try { return { file, shot: JSON.parse(await fs.readFile(file, 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  const shot = await compute('shot', { project, options }, { signal });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, shot);
  return { file, shot };
}

/** Cached city, used by the viewport endpoint. */
const cityCache = new Map();
export function cachedCity(world, path = null, { paths = path ? [path] : [] } = {}) {
  const hash = cityHash(world, path, { paths });
  if (cityCache.has(hash)) return cityCache.get(hash);
  const city = generateCity(world, { paths });
  if (cityCache.size > 8) cityCache.delete(cityCache.keys().next().value);
  cityCache.set(hash, city);
  return city;
}
