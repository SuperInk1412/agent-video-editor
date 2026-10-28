// Three-axis rotation for every element (docs/DESIGN-TRANSFORM-UNIFY.md §2).
//
//   rotation = [x, y, z] in degrees, keyed per axis as 'rotation.x' / '.y' / '.z'
//
// Each axis turns clockwise when seen from the positive end of that axis, and
// they apply Z first, then X, then Y:  R = Ry(-y) · Rx(-x) · Rz(-z)  (right-hand
// rotations by the negated angles). So:
//   z  turns the element in its own plane — exactly the old 2D `rotation` /
//      node `roll` (same sign);
//   x  tilts it (positive: the top goes away from a viewer in front of it);
//   y  turns it around the world's vertical.
//
// Rotation 0 faces +Z (toward the default camera): forward = R·[0,0,1],
// up = R·[0,1,0], right = forward × up — the same basis convention as
// core/scene.js::basisFromDir, so rotation 0 equals dir [0,0,1], roll 0.
//
// Cameras use the same angles as an offset in the camera's own frame:
// +x looks down, +y pans right, +z turns clockwise seen from the camera's
// front — the old manual roll, the picture turns clockwise. (For every host,
// z is clockwise seen from the front: an element's front faces +Z.)
//
// Pure ESM, no imports from scene.js (scene.js imports this module).

const D = Math.PI / 180;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 0) => (isNum(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? a.map((v) => v / l) : [0, 0, 1]; };
const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
const col = (M, j) => [M[0][j], M[1][j], M[2][j]];

export const ROTATION_AXES = ['x', 'y', 'z'];
export const ROTATION_PATHS = ROTATION_AXES.map((a) => `rotation.${a}`);

const Rx = (b) => { const c = Math.cos(b), s = Math.sin(b); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const Ry = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
const Rz = (g) => { const c = Math.cos(g), s = Math.sin(g); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };

/** `[x, y, z]` degrees from any loose value (missing axes are 0). */
export function normalizeRotation(rot) {
  const r = Array.isArray(rot) ? rot : [];
  return [0, 1, 2].map((i) => num(r[i], 0));
}

/** 3×3 rotation (rows) of `[x, y, z]` degrees. */
export function rotationMatrix(rot) {
  const [x, y, z] = normalizeRotation(rot);
  return mul(Ry(-y * D), mul(Rx(-x * D), Rz(-z * D)));
}

/** `{right, up, forward}` (basisFromDir convention) of `[x, y, z]` degrees. */
export function basisFromRotation(rot) {
  const R = rotationMatrix(rot);
  const forward = col(R, 2);
  const up = col(R, 1);
  return { right: cross(forward, up), up, forward };
}

/** Degrees `[x, y, z]` of a basis (basisFromDir convention). Gimbal lock keeps z = 0. */
export function rotationFromBasis(basis) {
  const f = norm(basis.forward);
  const u0 = basis.up;
  // re-orthonormalise up against forward
  const u = norm(u0.map((v, i) => v - dot(u0, f) * f[i]));
  const xc = cross(u, f); // R · [1,0,0]
  const R = [[xc[0], u[0], f[0]], [xc[1], u[1], f[1]], [xc[2], u[2], f[2]]];
  // R = Ry(a) · Rx(b) · Rz(c) with a = -y, b = -x, c = -z
  const sb = Math.max(-1, Math.min(1, -R[1][2]));
  const b = Math.asin(sb);
  let a, c;
  if (Math.abs(Math.cos(b)) > 1e-6) {
    a = Math.atan2(R[0][2], R[2][2]);
    c = Math.atan2(R[1][0], R[1][1]);
  } else {
    c = 0;
    a = Math.atan2(-R[2][0], R[0][0]);
  }
  // degrees in (-180, 180], no negative zero
  const clean = (v) => {
    let r = Math.round((-v / D) * 1e6) / 1e6;
    if (r <= -180) r += 360;
    return Object.is(r, -0) ? 0 : r;
  };
  return [clean(b), clean(a), clean(c)];
}

/** Reference basis of a direction with roll 0 (core/scene.js::basisFromDir, inlined). */
function dirBasis(dir) {
  const forward = norm(dir);
  const upRef = Math.abs(forward[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = norm(cross(forward, upRef));
  return { right, up: cross(right, forward), forward };
}

/** `{dir, roll}` (the SpatialNode / object orientation fields) of `[x, y, z]`. */
export function dirRollFromRotation(rot) {
  const b = basisFromRotation(rot);
  const b0 = dirBasis(b.forward);
  const roll = Math.atan2(dot(b.right, b0.up), dot(b.right, b0.right)) / D;
  return { dir: b.forward.map((v) => Math.round(v * 1e12) / 1e12), roll: Math.round(roll * 1e9) / 1e9 };
}

/** `[x, y, z]` of a `{dir, roll}` orientation (migration and the rotation ball). */
export function rotationFromDirRoll(dir, roll = 0) {
  const b0 = dirBasis(dir);
  const r = num(roll, 0) * D;
  const c = Math.cos(r), s = Math.sin(r);
  const right = b0.right.map((v, i) => v * c + b0.up[i] * s);
  const up = b0.up.map((v, i) => v * c - b0.right[i] * s);
  return rotationFromBasis({ right, up, forward: b0.forward });
}

/** Does a host carry three-axis rotation (base value or any axis key)? */
export function hasRotation(host, keyed = null) {
  if (Array.isArray(host?.rotation)) return true;
  return ROTATION_PATHS.some((p) => (keyed ? keyed(p) : false));
}

/**
 * Sampled `[x, y, z]` at t. `sampleAxis(path, fallback)` reads one axis track
 * (each host stores keys its own way: object/camera tracks, element keyframes).
 */
export function sampleRotation(base, sampleAxis, t) {
  const b = normalizeRotation(base);
  return ROTATION_PATHS.map((path, i) => num(sampleAxis(path, b[i], t), b[i]));
}

/**
 * Camera state with a rotation offset applied in the camera's own frame:
 * returns a new `{...state, look, roll}` (pos, fov … unchanged).
 */
export function applyCameraRotation(state, rot) {
  const [x, y, z] = normalizeRotation(rot);
  if (!x && !y && !z) return state;
  const dist = Math.max(1e-3, Math.hypot(...state.look.map((v, i) => v - state.pos[i])));
  const f = norm(state.look.map((v, i) => v - state.pos[i]));
  const b0 = dirBasis(f);
  const r = num(state.roll, 0) * D;
  const c = Math.cos(r), s = Math.sin(r);
  const right = b0.right.map((v, i) => v * c + b0.up[i] * s);
  const up = b0.up.map((v, i) => v * c - b0.right[i] * s);
  const back = f.map((v) => -v);
  // camera local axes as world columns: L = [right, up, back]
  const L = [[right[0], up[0], back[0]], [right[1], up[1], back[1]], [right[2], up[2], back[2]]];
  // z is clockwise seen from the camera's front, i.e. the old roll (the
  // picture turns clockwise); the local +Z axis here points back, hence -z
  const W = mul(L, rotationMatrix([x, y, -z])); // local offset, expressed in world
  const nf = col(W, 2).map((v) => -v);
  const nu = col(W, 1);
  const nb0 = dirBasis(nf);
  const nr = cross(nf, nu);
  const roll = Math.atan2(dot(nr, nb0.up), dot(nr, nb0.right)) / D;
  return { ...state, look: state.pos.map((v, i) => v + nf[i] * dist), roll };
}
