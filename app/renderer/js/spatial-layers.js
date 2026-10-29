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
// Metres a coplanar layer is pushed toward the viewer per unit of `el.z`
// (docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §四 2). Mirrors Blender exactly:
// vdm_build.py::make_updater moves each plane `layer_px * z` along its normal,
// and in the unified space one local unit is 1/100 m with layer_px = 0.01 —
// 0.1 mm per layer number, enough to keep a depth-tested stack free of
// z-fighting without moving the picture.
export const LAYER_DEPTH_M = 1e-4;

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

/**
 * Camera -> plane distance in metres (absolute, like the legacy _planeDist).
 *
 * Only classifies "one plane": a tilted plane's infinite extension can pass
 * much closer to the camera than the visible quad, so it must never order two
 * different planes (see `layerOriginDistance`).
 */
export function layerPlaneDistance(layer, camPos) {
  const p = layer?.plane?.p;
  const n = layer?.plane?.n;
  if (!p || !n) return 0;
  const c = vec3(camPos);
  return Math.abs((c[0] - p[0]) * n[0] + (c[1] - p[1]) * n[1] + (c[2] - p[2]) * n[2]);
}

/**
 * Camera -> element origin distance in metres: the rule Blender already uses
 * for the picture. `vdm_build.py` builds one real object per 2D plane and EEVEE
 * sorts blended objects by object-origin distance, so the preview must sort the
 * same way to stay parity-clean. The origin is the element's world frame
 * position (`L.plane.p`, i.e. `frameOf(elementWorldNode(...)).pos`).
 */
export function layerOriginDistance(layer, camPos) {
  const p = layer?.plane?.p;
  if (!p) return 0;
  const c = vec3(camPos);
  return Math.hypot(c[0] - num(p[0]), c[1] - num(p[1]), c[2] - num(p[2]));
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
 * Identity of one plane, independent of the camera: the unit normal and the
 * plane's offset along it, both quantised to `PLANE_EPS`. Coplanar layers (a
 * backdrop and the words written on it, a shadow and its text) share a key, so
 * `el.z` can own their stack; everything else is a different group.
 *
 * Quantising a pure per-layer value is what makes the grouping order-free: a
 * shuffled layer list groups exactly like the sorted one, no pairwise
 * "same plane" chaining that could depend on the input order.
 */
export function layerPlaneKey(layer) {
  const p = layer?.plane?.p;
  const n = unit3(layer?.plane?.n);
  if (!p || !n) return '';
  const q = (v) => Math.round(v / PLANE_EPS) * PLANE_EPS;
  const d = dot3(n, vec3(p));
  return `${q(n[0])},${q(n[1])},${q(n[2])},${q(d)}`;
}

/** Draw order inside one plane: `el.z`, then source order (a strict total order). */
export function compareLayerStack(a, b, ia = 0, ib = 0) {
  return (num(a?.el?.z) - num(b?.el?.z)) || (ia - ib);
}

/**
 * Layers sorted for drawing (PLAN §2.5, docs/FIX-LAYER-ORDER-EMPTY-CLICK.md):
 *
 * 1. group by plane — coplanar layers share one group (`layerPlaneKey`);
 * 2. groups far to near by camera -> ORIGIN distance, the rule Blender's EEVEE
 *    bake already follows, so a full-screen backdrop that is really behind the
 *    type also sorts behind it;
 * 3. inside a group, `el.z` owns the stack (a full-screen backdrop stays behind
 *    the type from any viewing angle), then source order.
 *
 * The order is a strict total order — no comparator mixes "el.z" with a
 * distance, so `Array.sort` can never bounce a pair back and forth as the
 * camera moves (that was 问题四: the lyric flickered in 镜头 02 once the
 * backdrop's ORIGIN came nearer than the lyric's).
 *
 * Since 问题四 the picture no longer depends on this order: opaque 2D planes
 * write depth (preview.js::_drawLayers), so a wrong guess costs a blending edge
 * at most, never a whole layer. Sorting only decides translucent stacking.
 */
export function orderLayers(layers, camPos) {
  const groups = new Map();
  (Array.isArray(layers) ? layers : []).forEach((L, i) => {
    const key = layerPlaneKey(L);
    let g = groups.get(key);
    if (!g) {
      g = { key, members: [], dist: Infinity, first: i };
      groups.set(key, g);
    }
    g.members.push({ L, i });
    // The group's distance is its nearest member: a big backdrop has one far
    // origin, a card lying on it a near one, and the group is only as far as
    // what sits on it.
    g.dist = Math.min(g.dist, layerOriginDistance(L, camPos));
  });
  const ordered = [...groups.values()].sort((a, b) => (b.dist - a.dist) || (a.first - b.first));
  const out = [];
  for (const g of ordered) {
    g.members.sort((A, B) => compareLayerStack(A.L, B.L, A.i, B.i));
    for (const m of g.members) out.push(m.L);
  }
  return out;
}

/**
 * Distance from a ray origin to where it meets the layer's plane, in metres
 * (null when the ray runs parallel or the plane is behind it). The picking
 * twin of the depth buffer: `hitTest` takes the smallest one so the element
 * under the cursor is the one the picture shows there, whatever the draw order.
 */
export function layerRayDepth(layer, ray) {
  const p = layer?.plane?.p;
  const n = layer?.plane?.n;
  const o = ray?.origin;
  const d = ray?.dir;
  if (!p || !n || !o || !d) return null;
  const denom = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2]) / denom;
  return Number.isFinite(t) && t > 0 ? t : null;
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
 * `opts` is the layer's motion/punch decoration plus the same-plane stacking
 * offset:
 *   offset: [x, y, z] world metres added to the frame position (screen-space
 *           x/y of core/evaluate.js::motionDelta, already converted by caller);
 *   roll:   extra degrees around the plane normal (motion shake);
 *   scale:  multiplier for the quad size (motion in/out + beat punch);
 *   depth:  metres along the plane normal toward the viewer (positive = the
 *           front face). The preview passes `LAYER_DEPTH_M * el.z` here so a
 *           coplanar stack is separated for the depth buffer exactly like
 *           Blender separates its objects (§四 2); the bake leaves it 0 because
 *           vdm_build.py adds its own `layer_px * z` on top.
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
  // local +Z is the plane's forward (the front face), so a positive depth moves
  // the quad toward the viewer without changing its size or orientation.
  const push = num(opts.depth);
  return {
    w,
    h,
    model: new Float32Array([
      -r[0] * w, -r[1] * w, -r[2] * w, 0,
      u[0] * h, u[1] * h, u[2] * h, 0,
      fw[0], fw[1], fw[2], 0,
      pos[0] + off[0] + fw[0] * push, pos[1] + off[1] + fw[1] * push, pos[2] + off[2] + fw[2] * push, 1,
    ]),
  };
}
