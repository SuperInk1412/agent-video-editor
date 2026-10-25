// Shot baking: one JSON package shared by the WebGL viewport and Blender.
//   { fps, frames, world, city, camera:[{f,t,pos,look,roll,fov}], fx, cameraCfg }
import fs from 'node:fs/promises';
import path from 'node:path';
import { bakeCameraTrack } from '../core/camera.js';
import { generateCity, cityHash } from './city.js';
import { paths } from '../core/store.js';

export const is3D = (project) => !!(project.camera && Array.isArray(project.camera.path) && project.camera.path.length > 0);

export function buildShot(project, { from = 0, to = null, fps = null } = {}) {
  const frameRate = fps || project.meta.fps || 24;
  const end = to ?? project.meta.duration;
  const city = generateCity(project.world);
  const camera = bakeCameraTrack(project, { fps: frameRate, from, to: end });
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
  const key = `${cityHash(project.world)}-${shot.fps}-${opts.from ?? 0}-${opts.to ?? project.meta.duration}`;
  const file = path.join(p.cache, `shot-${key}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(shot));
  return { file, shot };
}

/** Cached city, used by the viewport endpoint. */
const cityCache = new Map();
export function cachedCity(world) {
  const hash = cityHash(world);
  if (cityCache.has(hash)) return cityCache.get(hash);
  const city = generateCity(world);
  if (cityCache.size > 8) cityCache.delete(cityCache.keys().next().value);
  cityCache.set(hash, city);
  return city;
}
