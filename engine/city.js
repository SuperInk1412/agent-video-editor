// Procedural neon city: deterministic from world params + seed.
import { normalizeWorld } from '../core/world.js';
export { DEFAULT_WORLD, normalizeWorld } from '../core/world.js';
// The SAME json feeds the WebGL viewport and the Blender render, so what you
// scrub is what you render. Coordinates are metres, y is up, ground at y=0.

// How far above a roof the camera may pass before the tower counts as clear.
const CORRIDOR_CLEARANCE = 8;

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hexRgb = (h) => {
  const s = String(h || '#ffffff').replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [parseInt(f.slice(0, 2), 16) / 255, parseInt(f.slice(2, 4), 16) / 255, parseInt(f.slice(4, 6), 16) / 255];
};

/**
 * Build the city. Returns plain data (no three.js, no bpy):
 *   buildings: [{x,y,z,w,h,d,tint,seed}]  y = base (0)
 *   neons:     [{x,y,z,w,h,d,color,seed}]
 *   ground/bounds/fog/sky for the renderers
 *
 * `path` (camera positions) is optional. When world.corridor.enabled, buildings
 * the camera would fly through are dropped, so a new seed can never park a
 * tower in the drone's way. The RNG sequence is untouched by the corridor, so
 * changing radius only adds/removes the affected blocks — the rest of the city
 * stays identical.
 */
export function generateCity(worldInput, { path = null, paths = path ? [path] : [] } = {}) {
  const w = normalizeWorld(worldInput);
  const rng = mulberry32(w.seed | 0);
  // An empty world keeps the same shape (sky, fog, light, empty lists) so the
  // viewport, the bake and Blender never branch on missing fields.
  const empty = w.source === 'none';
  const { block, street } = w.grid;
  const nx = empty ? 0 : w.grid.nx;
  const nz = empty ? 0 : w.grid.nz;
  const spanX = empty ? 100 : nx * (block + street);
  const spanZ = empty ? 100 : nz * (block + street);
  const buildings = [];
  const neons = [];
  const palette = w.palette.map(hexRgb);
  const neonCols = (w.neon.colors || w.neonColors || []).map(hexRgb);

  const radius = Number(w.corridor.radius) || 0;
  const samples = w.corridor.enabled && radius > 0 ? paths.flatMap((flight) => pathSamples(flight)) : [];
  const corridor = samples.length >= 2;
  let cleared = 0;

  const hMin = Number(w.height.min) || 20;
  const hMax = Math.max(hMin + 1, Number(w.height.max) || 200);
  const power = Math.max(0.2, Number(w.height.power) || 2);

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const cx = (i - (nx - 1) / 2) * (block + street);
      const cz = (j - (nz - 1) / 2) * (block + street);
      if (rng() > w.density) continue; // plaza / gap
      const lots = 1 + (rng() < 0.55 ? 1 : 0) + (rng() < 0.22 ? 1 : 0);
      const lotW = block / lots;
      for (let l = 0; l < lots; l++) {
        const bw = Math.max(8, lotW * (0.5 + rng() * 0.36));
        const bd = Math.max(8, block * (0.45 + rng() * 0.45));
        const h = hMin + (hMax - hMin) * Math.pow(rng(), power);
        const x = cx - block / 2 + lotW * (l + 0.5) + (rng() - 0.5) * 4;
        const z = cz + (rng() - 0.5) * (block - bd) * 0.8;
        const tint = palette[Math.floor(rng() * palette.length)].map((c) => Math.min(1, c * (0.8 + rng() * 0.5)));
        const seed = Math.floor(rng() * 100000);

        const keep = !corridor || !corridorHit(x, z, bw, bd, h, samples, radius);
        if (!keep) cleared++;
        if (keep) {
          buildings.push({
            x: r2(x), y: 0, z: r2(z), w: r2(bw), h: r2(h), d: r2(bd),
            tint: tint.map((c) => r3(c)), seed,
          });
        }

        // Neons are generated unconditionally (same RNG draws) and only kept
        // with their building, so a corridor never leaves a sign floating.
        const nRoll = rng();
        if (nRoll < 0.72 && h > 32) {
          const col = neonCols[Math.floor(rng() * neonCols.length)];
          const side = Math.floor(rng() * 4);
          const off = side === 0 ? [-bw / 2 - 0.6, 0, 0] : side === 1 ? [bw / 2 + 0.6, 0, 0]
            : side === 2 ? [0, 0, -bd / 2 - 0.6] : [0, 0, bd / 2 + 0.6];
          const tall = h * (0.3 + rng() * 0.45);
          const ny = h * (0.05 + rng() * 0.2);
          const nseed = Math.floor(rng() * 100000);
          if (keep) {
            neons.push({
              x: r2(x + off[0]), y: r2(ny), z: r2(z + off[2]),
              w: side < 2 ? 0.75 : Math.min(bw * 0.35, 6),
              h: r2(tall * 0.8),
              d: side < 2 ? 0.75 : Math.min(bw * 0.35, 6),
              color: col.map((c) => r3(c)), seed: nseed,
            });
          }
        }
        if (nRoll > 0.5 && h > 24) {
          const col = neonCols[Math.floor(rng() * neonCols.length)];
          // street-level / mid-height sign band on a facade
          const side = Math.floor(rng() * 4);
          const off2 = side === 0 ? [-bw / 2 - 0.35, 0, 0] : side === 1 ? [bw / 2 + 0.35, 0, 0]
            : side === 2 ? [0, 0, -bd / 2 - 0.35] : [0, 0, bd / 2 + 0.35];
          const ny = 6 + rng() * Math.max(8, h * 0.5);
          const nseed = Math.floor(rng() * 100000);
          if (keep) {
            neons.push({
              x: r2(x + off2[0]),
              y: r2(ny),
              z: r2(z + off2[2]),
              w: side < 2 ? 0.6 : r2(Math.min(bw * 0.5, 9)),
              h: 1.8,
              d: side < 2 ? r2(Math.min(bd * 0.5, 9)) : 0.6,
              color: col.map((c) => r3(c)), seed: nseed,
            });
          }
        }
      }
    }
  }

  return {
    hash: cityHash(w, path, { paths }),
    source: w.source,
    empty,
    seed: w.seed,
    bounds: { x0: -spanX / 2, x1: spanX / 2, z0: -spanZ / 2, z1: spanZ / 2 },
    grid: { ...w.grid },
    ground: { color: hexRgb(w.ground.color), wet: Number(w.ground.wet) || 0 },
    fog: {
      color: hexRgb(w.fog.color),
      density: Number(w.fog.density) || 0.003,
      glow: Number(w.fog.glow) || 0.5,
      // mist model shared with blender/vdm_city.py (start..depth, strength)
      start: Number(w.fog.start) || 30,
      depth: Number(w.fog.depth) || 700,
      strength: w.fog.strength == null ? 1 : Number(w.fog.strength),
    },
    sky: hexRgb(w.sky),
    window: { density: Number(w.window.density) || 0.5, glow: Number(w.window.glow) || 3, color: hexRgb(w.window.color) },
    neonGlow: Number(w.neon.glow) || 6,
    ambient: Number(w.ambient) || 0.3,
    corridor: { enabled: !!w.corridor.enabled, radius, cleared },
    buildings,
    neons,
    stats: { buildings: buildings.length, neons: neons.length },
  };
}

function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }

/** Camera path → points every ~2 m of travel, so sparse keyframes still cut a tube. */
function pathSamples(path, step = 2) {
  const pts = [];
  for (const p of path || []) {
    const v = Array.isArray(p) ? p : p && p.pos;
    if (Array.isArray(v) && v.length >= 3 && v.every((n) => Number.isFinite(Number(n)))) {
      pts.push([Number(v[0]), Number(v[1]), Number(v[2])]);
    }
  }
  if (pts.length < 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / step));
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
    }
  }
  return out;
}

/** Would the camera pass through (or too close to) this box's airspace? */
function corridorHit(x, z, w, d, h, samples, radius) {
  const x0 = x - w / 2, x1 = x + w / 2;
  const z0 = z - d / 2, z1 = z + d / 2;
  const rr = radius * radius;
  const top = h + CORRIDOR_CLEARANCE; // clear a roof and the tower stays
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s[1] > top) continue;
    const dx = Math.max(x0 - s[0], 0, s[0] - x1);
    const dz = Math.max(z0 - s[2], 0, s[2] - z1);
    if (dx * dx + dz * dz < rr) return true;
  }
  return false;
}

function pathSignature(path) {
  const out = [];
  for (const p of path || []) {
    const v = Array.isArray(p) ? p : p && p.pos;
    if (!Array.isArray(v) || v.length < 3) continue;
    out.push([v[0], v[1], v[2]].map(Number).join(','));
  }
  return out.join(';');
}

/** Stable hash of world params (+ camera path when the corridor is on) — cache key. */
export function cityHash(w, path, { paths = path ? [path] : [] } = {}) {
  const world = normalizeWorld(w);
  let s = JSON.stringify(world);
  if (world.corridor.enabled && paths.length) s += `|${paths.map(pathSignature).join('|')}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
