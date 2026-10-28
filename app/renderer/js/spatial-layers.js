// Draw / hit-test order and world placement for 2D element layers
// (PLAN-ui-round3 §2.5, docs/DESIGN-UNIFIED-SPACE.md §5).
//
// Pure math — no DOM, no WebGL — so the preview, hit testing and unit tests
// share exactly one ordering rule and one plane matrix.
//
// Feasibility note (spatial-render task 1): the legacy 2D path draws a layer
// through a 2x3 screen matrix plus a single depth (preview.js VERT `u_px2w` +
// `u_z`). That represents a camera-facing rectangle at one z only. A
// SpatialNode hands the layer a full 3D basis (`dir` + `roll`), so the same
// quad can be turned away from the camera; no 2x3 screen matrix can express
// that (a yaw becomes a horizontal squash instead of a foreshortened quad).
// The node branch therefore places the same textured rectangle with a 4x4
// world matrix and reuses the existing texture/shape fragment shaders, while
// layers without `el.node` keep the legacy screen path untouched.

export const PLANE_EPS = 1e-4; // "one plane" = |distanceA - distanceB| <= this (PLAN §2.5)
export const NORMAL_EPS = 1e-6; // unit-normal dot above 1 - NORMAL_EPS counts as parallel

const num = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(n) : d);
const vec3 = (v, d = [0, 0, 0]) => (Array.isArray(v) && v.length >= 3
  ? [num(v[0]), num(v[1], d[1]), num(v[2], d[2])]
  : [d[0], d[1], d[2]]);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Unit vector or null when the input is empty / non-finite. */
export function unit3(v) {
  const x = vec3(v);
  const l = Math.hypot(x[0], x[1], x[2]);
  return l > 1e-12 ? [x[0] / l, x[1] / l, x[2] / l] : null;
}

/** Plane `{ p: point, n: normal }` of a SpatialNode frame ({ pos, basis, scale }). */
export function planeOfFrame(frame) {
  const basis = Array.isArray(frame?.basis) ? frame.basis : [];
  const n = unit3(basis[2]) || [0, 0, 1];
  return { p: vec3(frame?.pos), n };
}

// ---------------------------------------------------------------- plane order

/** Camera -> plane distance in metres (absolute, like the legacy _planeDist). */
export function layerPlaneDistance(layer, camPos) {
  const p = layer?.plane?.p;
  const n = layer?.plane?.n;
  if (!p || !n) return 0;
  const c = vec3(camPos);
  return Math.abs((c[0] - p[0]) * n[0] + (c[1] - p[1]) * n[1] + (c[2] - p[2]) * n[2]);
}

/** True when both layers live on the same plane (same normal, same distance). */
export function sameLayerPlane(a, b, camPos) {
  if (!a?.plane || !b?.plane) return false;
  const da = layerPlaneDistance(a, camPos);
  const db = layerPlaneDistance(b, camPos);
  if (Math.abs(da - db) > PLANE_EPS) return false;
  const na = unit3(a.plane.n);
  const nb = unit3(b.plane.n);
  return !!na && !!nb && Math.abs(dot3(na, nb) - 1) <= NORMAL_EPS;
}

/**
 * Shared draw / hit ordering key (PLAN §2.5):
 *
 * 1. different planes  -> farther from the camera first (painter's order);
 * 2. one plane         -> `el.z` layer order, from any viewing angle;
 * 3. exact ties        -> source order, only so the sort is deterministic.
 *
 * Node creation order / array order never decides a same-plane order: `el.z`
 * is compared before the `ia` / `ib` tie-break.
 */
export function compareLayerPlanes(a, b, camPos, ia = 0, ib = 0) {
  const da = layerPlaneDistance(a, camPos);
  const db = layerPlaneDistance(b, camPos);
  if (Math.abs(da - db) > PLANE_EPS) return db - da;
  if (!sameLayerPlane(a, b, camPos)) {
    // Almost equal distance but different normals: still two planes, and the
    // distance cannot separate them any more — keep a deterministic layer order.
    return (num(a?.el?.z) - num(b?.el?.z)) || (ia - ib);
  }
  return (num(a?.el?.z) - num(b?.el?.z)) || (ia - ib);
}

/** Layers sorted for drawing: far plane first, `el.z` inside one plane. */
export function orderLayers(layers, camPos) {
  return (Array.isArray(layers) ? layers : [])
    .map((L, i) => ({ L, i }))
    .sort((A, B) => compareLayerPlanes(A.L, B.L, camPos, A.i, B.i))
    .map((e) => e.L);
}

// ---------------------------------------------------------------- matrices

/** Column-major 4x4 multiply: a * b (same layout as Float32Array attributes). */
export function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

/** Apply a column-major 4x4 to a point / vector (w = 1 / 0). */
export function transformPoint4(m, p) {
  const x = vec3(p);
  return [
    m[0] * x[0] + m[4] * x[1] + m[8] * x[2] + m[12],
    m[1] * x[0] + m[5] * x[1] + m[9] * x[2] + m[13],
    m[2] * x[0] + m[6] * x[1] + m[10] * x[2] + m[14],
  ];
}

export function transformVector4(m, v) {
  const x = vec3(v);
  return [
    m[0] * x[0] + m[4] * x[1] + m[8] * x[2],
    m[1] * x[0] + m[5] * x[1] + m[9] * x[2],
    m[2] * x[0] + m[6] * x[1] + m[10] * x[2],
  ];
}

/** Carry a plane through a world matrix (camera-parented layers). */
export function transformPlane(plane, m) {
  return { p: transformPoint4(m, plane.p), n: transformVector4(m, plane.n) };
}

/**
 * World matrix of one 2D layer's textured quad on its SpatialNode plane.
 *
 * `frame` is `core/spatial.js::frameOf(node)` ({ pos, basis: [right, up,
 * forward], scale }). `width` / `height` are the quad size in metres at frame
 * scale 1 (the renderer converts the layer's canvas-pixel w/h). The basis
 * convention is the same as `preview3d.js::_planeItem`: quad local +X is
 * -right, local +Y is up, and the fragment shader flips v, so the picture
 * reads unmirrored from the front (world y is up, textures keep v = 0 at top).
 *
 * `opts` is the layer's motion/punch decoration only:
 *   offset: [x, y, z] world metres added to the frame position (screen-space
 *           x/y of core/evaluate.js::motionDelta, already converted by caller);
 *   roll:   extra degrees around the plane normal (motion shake);
 *   scale:  multiplier for the quad size (motion in/out + beat punch).
 * The node placement itself (pivot / basis / scale) is not repeated here, so
 * `el.transform` values are never applied twice (task 5).
 */
export function nodePlaneMatrix(frame, width, height, opts = {}) {
  const pos = vec3(frame?.pos);
  const basis = Array.isArray(frame?.basis) ? frame.basis : [];
  const r0 = unit3(basis[0]) || [1, 0, 0];
  const u0 = unit3(basis[1]) || [0, 1, 0];
  const fw = unit3(basis[2]) || [0, 0, 1];
  const rad = (num(opts.roll) * Math.PI) / 180;
  let r = r0;
  let u = u0;
  if (rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    r = [r0[0] * c + u0[0] * s, r0[1] * c + u0[1] * s, r0[2] * c + u0[2] * s];
    u = [u0[0] * c - r0[0] * s, u0[1] * c - r0[1] * s, u0[2] * c - r0[2] * s];
  }
  // Mirroring (negative scale) is not part of this minimal branch: the quad is
  // kept upright and only its size follows |scale|. Zero collapses the quad to
  // a sliver like M3.S(0) did on the legacy path.
  const k = Math.max(1e-6, Math.abs(num(opts.scale, 1)));
  const w = Math.max(1e-6, Math.abs(num(width, 1)) * k);
  const h = Math.max(1e-6, Math.abs(num(height, 1)) * k);
  const off = vec3(opts.offset);
  return {
    w,
    h,
    model: new Float32Array([
      -r[0] * w, -r[1] * w, -r[2] * w, 0,
      u[0] * h, u[1] * h, u[2] * h, 0,
      fw[0], fw[1], fw[2], 0,
      pos[0] + off[0], pos[1] + off[1], pos[2] + off[2], 1,
    ]),
  };
}
