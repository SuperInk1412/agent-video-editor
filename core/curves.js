// Value curves between two keyframes.
//
// A curve lives on the *left* keyframe of a segment and describes how the
// value travels to the next key: `progress = sampleCurve(curve, u)` with
// `u = (t - t0) / (t1 - t0)`, then `value = a + (b - a) * progress`.
//
// The first implemented preset is a cubic bezier easing with fixed endpoints
// (0,0) and (1,1) and two draggable control points. The solver is a fixed
// 40-step bisection on x(s) = u, so the JS preview, the Blender bake and the
// tests all get bit-identical results (Blender/sample_track.py mirrors it).
//
// Data shape stored in the project:
//   "curve": { "type": "bezier", "preset": "easeInOut",
//              "p1": [0.42, 0], "p2": [0.58, 1] }
//
// Pure ESM, no DOM/node imports.

export const BEZIER_SOLVE_STEPS = 40;
const CURVE_DECIMALS = 4;

export const CURVE_PRESETS = {
  linear: { label: '线性', p1: [0.00, 0.00], p2: [1.00, 1.00] },
  easeIn: { label: '缓入', p1: [0.42, 0.00], p2: [1.00, 1.00] },
  easeOut: { label: '缓出', p1: [0.00, 0.00], p2: [0.58, 1.00] },
  easeInOut: { label: '缓入缓出', p1: [0.42, 0.00], p2: [0.58, 1.00] },
  bezier: { label: '三次贝塞尔', p1: [0.42, 0.00], p2: [0.58, 1.00] },
};

/** Presets that are designed but not implemented yet (shown disabled in the UI). */
export const CURVE_GROUPS = [
  {
    title: '基础曲线',
    items: [
      { id: 'linear', label: '线性', ready: true },
      { id: 'easeIn', label: '缓入', ready: true },
      { id: 'easeOut', label: '缓出', ready: true },
      { id: 'easeInOut', label: '缓入缓出', ready: true },
      { id: 'bezier', label: '三次贝塞尔', ready: true },
    ],
  },
  {
    title: '动力学（开发中）',
    items: [
      { id: 'bounce', label: '弹跳', ready: false },
      { id: 'elastic', label: '弹动', ready: false },
      { id: 'periodic', label: '周期', ready: false },
    ],
  },
  {
    title: '图案（开发中）',
    items: [
      { id: 'random', label: '随机', ready: false },
      { id: 'steps', label: '步数', ready: false },
      { id: 'elasticSteps', label: '弹动步数', ready: false },
    ],
  },
];

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, Number(v)));
const finite = (v) => Number.isFinite(Number(v));

/** Cubic-bezier component with fixed endpoints 0 and 1. */
const bez = (a, b, s) => {
  const is = 1 - s;
  return 3 * is * is * s * a + 3 * is * s * s * b + s * s * s;
};

/**
 * Progress for `u` on a cubic bezier whose x-solve is bisection-based.
 * p1/p2 are the two control points.
 */
export function sampleBezier(p1, p2, u) {
  const x1 = clamp(p1[0]), y1 = Number(p1[1]);
  const x2 = clamp(p2[0]), y2 = Number(p2[1]);
  if (!finite(y1) || !finite(y2)) return clamp(u);
  const target = clamp(u);
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let s = target;
  for (let i = 0; i < BEZIER_SOLVE_STEPS; i++) {
    s = (lo + hi) / 2;
    const x = bez(x1, x2, s);
    if (x < target) lo = s;
    else hi = s;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

/** Normalize/validate a stored curve; returns null when there is no curve. */
export function normalizeCurve(curve) {
  if (!curve || typeof curve !== 'object') return null;
  const p1 = Array.isArray(curve.p1) ? curve.p1 : (CURVE_PRESETS[curve.preset]?.p1 || null);
  const p2 = Array.isArray(curve.p2) ? curve.p2 : (CURVE_PRESETS[curve.preset]?.p2 || null);
  if (!p1 || !p2 || !finite(p1[0]) || !finite(p1[1]) || !finite(p2[0]) || !finite(p2[1])) return null;
  const round = (v) => Math.round(Number(v) * 10 ** CURVE_DECIMALS) / 10 ** CURVE_DECIMALS;
  const out = {
    type: 'bezier',
    p1: [round(clamp(p1[0])), round(clamp(p1[1], -1, 2))],
    p2: [round(clamp(p2[0])), round(clamp(p2[1], -1, 2))],
  };
  if (curve.preset && CURVE_PRESETS[curve.preset]) out.preset = String(curve.preset);
  return out;
}

/** Progress 0..1 for a curve (null curve = linear). */
export function sampleCurve(curve, u) {
  const c = normalizeCurve(curve);
  if (!c) return clamp(u);
  return sampleBezier(c.p1, c.p2, u);
}

/** Bezier control points for a named preset (null for unknown). */
export function presetCurve(id) {
  const p = CURVE_PRESETS[id];
  if (!p) return null;
  return normalizeCurve({ type: 'bezier', preset: id, p1: p.p1, p2: p.p2 });
}

/** Human label for a curve stored on a keyframe. */
export function curveLabel(curve) {
  const c = normalizeCurve(curve);
  if (!c) return '线性（默认）';
  if (c.preset && CURVE_PRESETS[c.preset]) return CURVE_PRESETS[c.preset].label;
  return '自定义贝塞尔';
}

/**
 * Consecutive key pairs of one track, as segments the curve editor can edit.
 * Keys may be element keyframes (`{t, value}`) or scene tracks (`{t, v}`).
 */
export function curveSegments(keys) {
  const list = (keys || [])
    .filter((k) => k && Number.isFinite(Number(k.t)))
    .slice()
    .sort((a, b) => Number(a.t) - Number(b.t));
  const out = [];
  for (let i = 0; i < list.length - 1; i++) {
    out.push({
      from: Math.round(Number(list[i].t) * 1000) / 1000,
      to: Math.round(Number(list[i + 1].t) * 1000) / 1000,
      a: list[i],
      b: list[i + 1],
    });
  }
  return out;
}
