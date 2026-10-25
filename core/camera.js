// Camera rig: Catmull-Rom path, auto look-ahead, banking, shake, fov.
// Pure math — used by the realtime viewport, the engine (bake for Blender) and the CLI.
import { clamp } from './time.js';

export const DEFAULT_CAMERA = {
  fov: 62,
  near: 0.5,
  far: 5000,
  lookAhead: 90,
  bankGain: 1.2,
  maxRoll: 32,
  roll: 0,
  shake: { amp: 0.6, freq: 1.6, octaves: 3, speedGain: 1.0, seed: 7 },
  dof: { enabled: false, fstop: 2.8, focusOffset: 0 },
  motionBlur: { enabled: true, shutter: 0.5 },
  path: [],
};

const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u],
};
export { v3 };

/** deterministic 3D value noise (smooth, cheap, no deps) */
function hash3(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf), q = zf * zf * (3 - 2 * zf);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * u;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * u;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * u;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * w;
  const y1 = x01 + (x11 - x01) * w;
  return (y0 + (y1 - y0) * q) * 2 - 1;
}

function catmull(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])];
}

function ease(name, p) {
  switch (name) {
    case 'linear': return p;
    case 'easeIn': return p * p;
    case 'easeOut': return 1 - (1 - p) * (1 - p);
    case 'smooth': return p * p * (3 - 2 * p);
    default: return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  }
}

export function normalizeCamera(cam) {
  const c = { ...DEFAULT_CAMERA, ...(cam || {}) };
  c.shake = { ...DEFAULT_CAMERA.shake, ...(cam?.shake || {}) };
  c.dof = { ...DEFAULT_CAMERA.dof, ...(cam?.dof || {}) };
  c.motionBlur = { ...DEFAULT_CAMERA.motionBlur, ...(cam?.motionBlur || {}) };
  c.path = (Array.isArray(cam?.path) ? cam.path : [])
    .filter((k) => Array.isArray(k.pos) && k.pos.length === 3)
    .map((k) => ({ t: Number(k.t) || 0, pos: k.pos.map(Number), look: Array.isArray(k.look) ? k.look.map(Number) : null, fov: k.fov != null ? Number(k.fov) : null }))
    .sort((a, b) => a.t - b.t);
  return c;
}

/** position at time t along the smoothed path */
export function pathPos(cam, t) {
  const keys = cam.path;
  if (!keys.length) return [0, 20, 0];
  if (keys.length === 1) return keys[0].pos;
  if (t <= keys[0].t) return keys[0].pos;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].pos;
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const k1 = keys[i], k2 = keys[i + 1];
  const k0 = keys[Math.max(0, i - 1)], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const span = Math.max(1e-6, k2.t - k1.t);
  const u = clamp((t - k1.t) / span);
  return catmull(k0.pos, k1.pos, k2.pos, k3.pos, ease(k1.ease || 'easeInOut', u));
}

/** fov at time t (keyframe override, else default) */
export function pathFov(cam, t) {
  const k = cam.path;
  if (!k.length) return cam.fov;
  let prev = null, next = null;
  for (const p of k) {
    if (p.fov == null) continue;
    if (p.t <= t) prev = p; else if (!next) next = p;
  }
  if (!prev && !next) return cam.fov;
  if (!prev) return next.fov;
  if (!next) return prev.fov;
  const u = (t - prev.t) / Math.max(1e-6, next.t - prev.t);
  return prev.fov + (next.fov - prev.fov) * ease('easeInOut', u);
}

/** total flown distance up to t (for speed-driven effects) */
export function pathSpeed(cam, t, dt = 0.1) {
  const a = pathPos(cam, Math.max(0, t - dt));
  const b = pathPos(cam, t + dt);
  return v3.len(v3.sub(b, a)) / (2 * dt);
}

/**
 * Full camera state at time t.
 * @returns {{pos:number[], look:number[], up:number[], fov:number, roll:number, speed:number, focus:number}}
 */
export function evalCamera(project, t) {
  const cam = project.camera || normalizeCamera(null);
  const pos = pathPos(cam, t);
  const posA = pathPos(cam, t - 0.16);
  const posB = pathPos(cam, t + 0.16);
  const tang = v3.norm(v3.sub(posB, posA));

  // explicit look keys win inside their window; elsewhere look ahead along the tangent
  let look = v3.add(pos, v3.mul(tang, Math.max(1, cam.lookAhead)));
  const lk = cam.path.filter((k) => k.look);
  if (lk.length) {
    const first = lk[0], last = lk[lk.length - 1];
    if (t >= first.t - 1.0 && t <= last.t + 1.0) {
      if (t <= first.t) look = first.look.slice();
      else if (t >= last.t) look = last.look.slice();
      else {
        for (let i = 0; i < lk.length - 1; i++) {
          if (t >= lk[i].t && t <= lk[i + 1].t) {
            const u = (t - lk[i].t) / Math.max(1e-6, lk[i + 1].t - lk[i].t);
            const s = u * u * (3 - 2 * u);
            look = v3.lerp(lk[i].look, lk[i + 1].look, s);
            break;
          }
        }
      }
    }
  }

  const speed = v3.len(v3.sub(posB, posA)) / 0.32;

  // banking: yaw rate around +Y
  const dirA = v3.norm(v3.sub(pathPos(cam, t - 0.01), pathPos(cam, t - 0.25)));
  const dirB = v3.norm(v3.sub(pathPos(cam, t + 0.25), pathPos(cam, t + 0.01)));
  const yawRate = (Math.atan2(dirB[0], dirB[2]) - Math.atan2(dirA[0], dirA[2])) / 0.5;
  const bank = clamp(-yawRate * cam.bankGain * 57.2958, -cam.maxRoll, cam.maxRoll);
  let roll = bank + (Number(cam.roll) || 0);

  // shake: value noise, stronger at speed
  const sh = cam.shake;
  const amp = Number(sh.amp) || 0;
  if (amp > 0 && cam.path.length > 1) {
    const speedK = 1 + (Number(sh.speedGain) || 0) * Math.min(2.5, speed / 25);
    const f = Number(sh.freq) || 1.5;
    const oct = Math.max(1, Math.min(4, Number(sh.octaves) || 3));
    let nx = 0, ny = 0, nz = 0, norm = 0, gain = 1;
    for (let o = 0; o < oct; o++) {
      const ff = f * Math.pow(2, o);
      nx += noise3(t * ff, 1.7, 0.3, sh.seed + o) * gain;
      ny += noise3(3.1, t * ff, 5.2, sh.seed + o + 11) * gain;
      nz += noise3(7.3, 2.2, t * ff, sh.seed + o + 23) * gain;
      norm += gain;
      gain *= 0.5;
    }
    const k = amp * speedK;
    const off = [nx / norm * k, ny / norm * k * 0.7, nz / norm * k];
    pos[0] += off[0]; pos[1] += off[1]; pos[2] += off[2];
    look[0] += off[0] * 0.6; look[1] += off[1] * 0.6; look[2] += off[2] * 0.6;
    roll += (nx / norm) * k * 0.6;
  }

  const up = [0, 1, 0];
  const fov = pathFov(cam, t);
  const focus = Math.max(1, v3.len(v3.sub(look, pos)) + (Number(cam.dof?.focusOffset) || 0));
  return { pos, look, up, fov, roll, speed, focus, bank };
}

/** Sample the whole shot into per-frame camera states (baked for Blender). */
export function bakeCameraTrack(project, { fps = 24, from = 0, to = null } = {}) {
  const dur = to ?? project.meta.duration;
  const f0 = Math.round(from * fps), f1 = Math.round(dur * fps);
  const out = [];
  for (let f = f0; f <= f1; f++) {
    const t = f / fps;
    const c = evalCamera(project, t);
    out.push({
      f: f + 1,
      t: Math.round(t * 1000) / 1000,
      pos: c.pos.map((v) => Math.round(v * 1000) / 1000),
      look: c.look.map((v) => Math.round(v * 1000) / 1000),
      roll: Math.round(c.roll * 1000) / 1000,
      fov: Math.round(c.fov * 1000) / 1000,
    });
  }
  return out;
}
