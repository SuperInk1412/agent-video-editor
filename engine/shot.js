// Shot baking: one JSON package shared by the WebGL viewport and Blender.
//   { fps, frames, world, city, camera:[{f,t,pos,look,roll,fov}], fx, cameraCfg }
import fs from 'node:fs/promises';
import path from 'node:path';
import { bakeCameraTrack, cameraLayers, cameraTransform } from '../core/camera.js';
import { elementCarrier } from '../core/hierarchy.js';
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
const hasFrameParent = (cam) => !!cam?.frameParent?.id;

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
      color: o.style?.color || o.style?.fill || '#8fe0ff',
      emissive: Math.max(0, Number(o.style?.emissive) || 0),
      ...(isPlane(o) ? { media: { ...mediaSpec(o), sequence: o._sequenceDir ? { dir: o._sequenceDir, count: seqCount } : null } } : {}),
      ...(isText(o) ? { text: textSpec(o) } : {}),
      frames,
    });
  }
  return out;
}

/**
 * Camera-parented 2D elements: per-frame rigid carry (x' = rot·x + loc) that
 * Blender applies on top of the screen rig, from the same elementCarrier() the
 * viewport uses.
 */
export function bakeElementCarriers(project, { fps = 24, from = 0, to = null } = {}) {
  const els = (project.elements || []).filter((e) => e.parent?.id);
  if (!els.length) return [];
  const f0 = Math.round(from * fps) + 1;
  const f1 = Math.round((to ?? project.meta.duration) * fps) + 1;
  const param = cameraParamResolver(project);
  return els.map((el) => {
    const frames = [];
    for (let f = f0; f <= f1; f++) {
      const m = elementCarrier(project, el, (f - 1) / fps, { param });
      if (!m) continue;
      const L = m.L;
      const loc = [0, 1, 2].map((i) => m.c[i] - (L[i][0] * m.p0[0] + L[i][1] * m.p0[1] + L[i][2] * m.p0[2]));
      const k = m.scale || 1; // uniform pull-in toward the camera (see elementCarrier)
      frames.push({
        f,
        loc: loc.map((v) => Math.round(v * 1e5) / 1e5),
        rot: L.map((row) => row.map((v) => Math.round((v / k) * 1e6) / 1e6)),
        scale: Math.round(k * 1e7) / 1e7,
      });
    }
    return { id: el.id, frames };
  });
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
    elementCarriers: bakeElementCarriers(project, { fps: frameRate, from, to: end }),
    fx: project.meta.fx,
    cameraCfg: {
      near: Number(cam.near) || 0.5,
      far: Number(cam.far) || 5000,
      dof: cam.dof || { enabled: false },
      motionBlur: cam.motionBlur || { enabled: true, shutter: 0.5 },
    },
  };
}

/** Write the shot package next to the render job; returns its path. */
export async function writeShot(dir, project, opts = {}) {
  const p = paths(dir);
  const { signal, ...options } = opts;
  // Blender overlay/sequence paths are derived data; hash the authored elements
  // only (the links themselves still invalidate the cache).
  const elements = (project.elements || []).map(({ _linkOverlay, _sequenceDir, ...el }) => el);
  const key = hashOf({ version: 2, meta: project.meta, elements,
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
