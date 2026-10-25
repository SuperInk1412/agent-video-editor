// Shot baking: one JSON package shared by the WebGL viewport and Blender.
//   { fps, frames, world, city, camera:[{f,t,pos,look,roll,fov}], fx, cameraCfg }
import fs from 'node:fs/promises';
import path from 'node:path';
import { bakeCameraTrack } from '../core/camera.js';
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

export const is3D = (project) => !!(project.camera && Array.isArray(project.camera.path) && project.camera.path.length > 0);

export function buildShot(project, { from = 0, to = null, fps = null } = {}) {
  const frameRate = fps || project.meta.fps || 24;
  const end = to ?? project.meta.duration;
  // Bake the camera first: the corridor is cut from the path the camera
  // actually flies, not from the raw keyframes.
  const camera = bakeCameraTrack(project, { fps: frameRate, from, to: end });
  const city = generateCity(project.world, { path: camera.map((c) => c.pos) });
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
