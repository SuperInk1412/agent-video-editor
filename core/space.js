// Unified space: every project is 3D (docs/DESIGN-UNIFIED-SPACE.md).
// Pure ESM (no node:*): the store, the engine, the viewport and tests share it.
//
// The "2D" frame is a screen plane at z = 0 whose bottom edge sits on the
// ground: 100 px = 1 m, screen x/y are pixels from the frame centre (y down),
// world is metres with y up. The default camera looks at the plane centre from
// SCREEN_DISTANCE metres away with a horizontal fov that exactly fills the
// frame, so a still camera and flat elements look like plain 2D.
import { PX_PER_M } from './scene.js';
import { applyOp } from './ops.js';

export const SCREEN_DISTANCE = 20; // m

const dims = (meta) => [Number(meta?.width) || 1920, Number(meta?.height) || 1080];

/** World y of the screen plane centre (the bottom edge is on the ground). */
export function screenCenterY(meta) {
  return dims(meta)[1] / 2 / PX_PER_M;
}

/** Horizontal fov (degrees) that makes the screen plane fill the frame. */
export function defaultFov(meta) {
  const halfW = dims(meta)[0] / 2 / PX_PER_M;
  return (2 * Math.atan(halfW / SCREEN_DISTANCE) * 180) / Math.PI;
}

/** Screen pixels (centre origin, y down) + depth in metres -> world metres. */
export function screenToWorld(meta, x, y, z = 0) {
  return [Number(x || 0) / PX_PER_M, screenCenterY(meta) - Number(y || 0) / PX_PER_M, Number(z || 0)];
}

/** An empty world whose backdrop is the project background. */
export function defaultWorld(meta) {
  return { source: 'none', sky: meta?.background || '#05070d' };
}

/** The `camera` argument of the addCamera op for the default framing (no id: the op assigns one). */
export function defaultCamera(meta) {
  const cy = screenCenterY(meta);
  return {
    name: '相机 1',
    fov: Math.round(defaultFov(meta) * 1e4) / 1e4,
    roll: 0,
    center: [0, 0, 0],
    path: [{ t: 0, pos: [0, cy, SCREEN_DISTANCE], look: [0, cy, 0] }],
    // Flat motion graphics: no motion blur, no handheld shake, no auto bank on
    // turns — once the user keys a move the frame must not drift on its own.
    // All three can be switched on in the camera settings.
    motionBlur: { enabled: false, shutter: 0.5 },
    shake: { amp: 0 },
    bankGain: 0,
  };
}

export const hasCamera = (p) => (Array.isArray(p?.cameras) && p.cameras.length > 0) || !!p?.camera;

/**
 * Idempotent upgrade to the unified space. A project without any camera is a
 * former 2D project (createProject still gives it a procedural world it never
 * used): switch the world to the empty one and add the default camera through
 * the same addCamera op the UI uses. Projects that already have a camera are
 * left alone. Returns true when it changed something.
 */
export function ensureSpace(p) {
  if (!p || hasCamera(p)) return false;
  applyOp(p, { op: 'worldSet', patch: defaultWorld(p.meta) });
  applyOp(p, { op: 'addCamera', camera: defaultCamera(p.meta) });
  return true;
}
