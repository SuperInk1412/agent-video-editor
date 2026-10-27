// World defaults + normalisation (shared by core, engine and the viewport).
// Keeping this in core keeps the schema free of engine imports.
// `source`: 'procedural' (the generated city) or 'none' (an empty world: sky,
// fog and light only — every project starts like this, see
// docs/DESIGN-UNIFIED-SPACE.md). Other fields still normalise for 'none' so
// switching to a city later keeps the user's parameters.
export const WORLD_SOURCES = ['procedural', 'none'];
export const DEFAULT_WORLD = {
  source: 'procedural',
  seed: 2077,
  grid: { nx: 12, nz: 18, block: 70, street: 24 },
  density: 0.86,
  height: { min: 24, max: 260, power: 2.1 },
  palette: ['#141b26', '#1a2331', '#10161f', '#202b3a'],
  window: { density: 0.55, glow: 3.2, color: '#8fe8ff' },
  neon: { count: 260, glow: 7, colors: ['#ff2a6d', '#05d9e8', '#f9c80e', '#b967ff'] },
  fog: { color: '#071527', density: 0.0032, glow: 0.55, start: 30, depth: 700, strength: 1 },
  ground: { color: '#04070c', wet: 0.65 },
  sky: '#03060d',
  ambient: 0.3,
  // Flight corridor: clear buildings the camera would fly through. Geometry
  // only — the camera path is untouched, so a new seed can never drop a tower
  // into the drone's line of flight.
  corridor: { enabled: true, radius: 16 },
};

export function normalizeWorld(w) {
  const d = DEFAULT_WORLD;
  const src = w || {};
  return {
    ...d,
    ...src,
    source: WORLD_SOURCES.includes(src.source) ? src.source : d.source,
    grid: { ...d.grid, ...(src.grid || {}) },
    height: { ...d.height, ...(src.height || {}) },
    window: { ...d.window, ...(src.window || {}) },
    neon: { ...d.neon, ...(src.neon || {}) },
    fog: { ...d.fog, ...(src.fog || {}) },
    ground: { ...d.ground, ...(src.ground || {}) },
    corridor: { ...d.corridor, ...(src.corridor || {}) },
    palette: Array.isArray(src.palette) && src.palette.length ? src.palette : d.palette,
    neonColors: Array.isArray(src.neonColors) && src.neonColors.length ? src.neonColors : d.neon.colors,
  };
}

