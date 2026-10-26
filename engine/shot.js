// Shot baking: one JSON package shared by the WebGL viewport and Blender.
//   { fps, frames, world, city, camera:[{f,t,pos,look,roll,fov}], fx, cameraCfg }
import fs from 'node:fs/promises';
import path from 'node:path';
import { bakeCameraTrack, cameraLayers, cameraTransform } from '../core/camera.js';
import { objectPose } from '../core/scene.js';
import { generateCity, cityHash } from './city.js';
import { paths } from '../core/store.js';

const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const OBJ_TYPES = new Set(['solid', 'shape', 'text', 'image', 'video', 'container']);

/**
 * Elements -> per-frame transforms for Blender. Same objectPose() as the
 * viewport, so position/rotation/scale/opacity cannot drift between the two.
 */
export function bakeObjects(project, { fps = 24, from = 0, to = null } = {}) {
  const objs = project.scene?.objects || [];
  if (!objs.length) return [];
  const f0 = Math.round(from * fps) + 1;
  const f1 = Math.round((to ?? project.meta.duration) * fps) + 1;
  const out = [];
  for (const o of objs) {
    if (!OBJ_TYPES.has(o.type)) continue;
    const start = Number(o.start) || 0;
    const end = start + (Number(o.duration) || 0);
    const geom = o.geom || {};
    const g = [
      Math.max(0.001, Number(geom.w) || 2),
      Math.max(0.001, Number(geom.h) || 2),
      Math.max(0.001, Number(geom.d) || 2),
    ];
    const frames = [];
    for (let f = f0; f <= f1; f++) {
      const t = (f - 1) / fps;
      const live = t >= start - 1e-6 && t < end - 1e-6;
      const pose = objectPose(o, t);
      const hidden = live ? 1 : 0.0001;
      frames.push({
        f,
        loc: pose.worldPos.map(r3),
        rot: [pose.basis.right, pose.basis.up, pose.basis.forward].map((v) => v.map(r3)),
        size: [g[0] * Math.abs(pose.scale[0]) * hidden,
          g[1] * Math.abs(pose.scale[1]) * hidden,
          g[2] * Math.abs(pose.scale[2]) * hidden].map((v) => Math.max(0.0001, r3(v))),
        opacity: live ? Math.round(pose.opacity * 1000) / 1000 : 0,
      });
    }
    out.push({
      id: o.id,
      name: o.name || o.id,
      type: o.type,
      color: o.style?.color || o.style?.fill || '#8fe0ff',
      emissive: Math.max(0, Number(o.style?.emissive) || 0),
      frames,
    });
  }
  return out;
}

export const is3D = (project) => cameraLayers(project).length > 0;

/** Bake one camera layer, including its per-frame picture transform. */
function bakeCameraLayer(project, cam, { fps, from, to }) {
  const sub = {
    ...project,
    camera: cam,
    cameras: [],
    cameraOrder: [],
    activeCameraId: null,
  };
  const track = bakeCameraTrack(sub, { fps, from, to });
  const frames = track.map((e) => {
    const tr = cameraTransform(cam, e.t);
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

export function buildShot(project, { from = 0, to = null, fps = null } = {}) {
  const frameRate = fps || project.meta.fps || 24;
  const end = to ?? project.meta.duration;
  const layers = cameraLayers(project).map((cam) => bakeCameraLayer(project, cam, {
    fps: frameRate, from, to: end,
  }));
  // Bake the active camera as the legacy single-camera field. Blender keeps
  // this path for one-camera projects and switches to cameraLayers when there
  // is more than one visible layer.
  const camera = bakeCameraTrack(project, { fps: frameRate, from, to: end });
  const flight = layers.length
    ? layers.flatMap((l) => l.camera.map((c) => c.pos))
    : camera.map((c) => c.pos);
  const city = generateCity(project.world, { path: flight });
  const cam = project.camera || {};
  return {
    version: 1,
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
  };
}

/** Write the shot package next to the render job; returns its path. */
export async function writeShot(dir, project, opts = {}) {
  const p = paths(dir);
  const shot = buildShot(project, opts);
  const key = `${shot.city.hash}-r${project.rev || 0}-${shot.fps}-${opts.from ?? 0}-${opts.to ?? project.meta.duration}`;
  const file = path.join(p.cache, `shot-${key}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(shot));
  return { file, shot };
}

/** Cached city, used by the viewport endpoint. */
const cityCache = new Map();
export function cachedCity(world, path = null) {
  const hash = cityHash(world, path);
  if (cityCache.has(hash)) return cityCache.get(hash);
  const city = generateCity(world, { path });
  if (cityCache.size > 8) cityCache.delete(cityCache.keys().next().value);
  cityCache.set(hash, city);
  return city;
}
