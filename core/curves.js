// Value curves between two keyframes.
//
// A curve lives on the *left* keyframe of a segment and describes how the
// value travels to the next key: `progress = sampleCurve(curve, u)` with
// `u = (t - t0) / (t1 - t0)`, then `value = a + (b - a) * progress`.
//
// Two families are stored in the project:
//   bezier  fixed endpoints (0,0) and (1,1) with two control points, solved by
//           a fixed 40-step bisection so the JS preview and the Blender bake
//           get identical numbers;
//   preset  parameterised easings (bounce / elastic / cyclic / step /
//           elasticStep) whose formulas mirror the reference implementation in
//           `参考程序/alight-curve-editor` (easing/*.java, editor-defaults.json).
//           `tests/fixtures/am-curve-samples.json` keeps its 257-point
//           samples; the Python sampler mirrors this file.
//
// Stored shapes:
//   { "type": "bezier", "preset": "easeInOut", "p1": [0.42, 0], "p2": [0.58, 1] }
//   { "type": "bounce", "params": { "firstStepLength": 0.3, "bounciness": 0.8 } }
//
// Pure ESM, no DOM/node imports.

export const BEZIER_SOLVE_STEPS = 40;
const CURVE_DECIMALS = 4;
// Preset parameters are more sensitive (a cyclic phase error compounds over
// the segment), so they keep two extra digits.
const PARAM_DECIMALS = 6;
// The reference app hard-codes this value instead of Math.PI; keep it so the
// sample fixtures stay comparable.
const AM_PI = 3.14159;

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, Number(v)));
const finite = (v) => Number.isFinite(Number(v));
const round = (v) => Math.round(Number(v) * 10 ** CURVE_DECIMALS) / 10 ** CURVE_DECIMALS;
const roundParam = (v) => Math.round(Number(v) * 10 ** PARAM_DECIMALS) / 10 ** PARAM_DECIMALS;
const mix = (a, b, t) => a * (1 - t) + b * t;

/** Parameter ranges + defaults per preset kind. */
export const CURVE_PARAMS = {
  bounce: {
    firstStepLength: { min: 0.01, max: 1, default: 0.3 },
    bounciness: { min: 0, max: 1, default: 0.8 },
  },
  elastic: {
    stepLength: { min: 0.01, max: 1, default: 0.25 },
    // `attack` is part of Alight Motion's stored format but its sample formula
    // only uses stepLength/decay/magnitude; it shifts the main handle instead.
    attack: { min: 0, max: 10, default: 1 },
    decay: { min: 0, max: 1, default: 0.5 },
    magnitude: { min: 0, max: 1, default: 1 },
  },
  cyclic: {
    stepLength: { min: 0.001, max: 1, default: 0.2857143 },
    sharpness: { min: 0, max: 1, default: 0 },
    skew: { min: 0, max: 1, default: 0.5 },
    decay: { min: 0, max: 1, default: 0 },
  },
  step: {
    stepLength: { min: 0.01, max: 1, default: 0.25 },
    smoothing: { min: 0, max: 1, default: 0 },
  },
  elasticStep: {
    stepLength: { min: 0.01, max: 1, default: 0.2 },
    magnitude: { min: 0, max: 1, default: 0.5 },
  },
};

export const CURVE_TYPE_LABELS = {
  bezier: '贝塞尔',
  bounce: '弹跳',
  elastic: '弹动',
  cyclic: '周期',
  step: '步数',
  elasticStep: '弹动步数',
};

const defaultParams = (type) => Object.fromEntries(
  Object.entries(CURVE_PARAMS[type] || {}).map(([key, spec]) => [key, spec.default]),
);

export const CURVE_PRESETS = {
  linear: { label: '线性', type: 'bezier', p1: [0.00, 0.00], p2: [1.00, 1.00] },
  easeIn: { label: '缓入', type: 'bezier', p1: [0.42, 0.00], p2: [1.00, 1.00] },
  easeOut: { label: '缓出', type: 'bezier', p1: [0.00, 0.00], p2: [0.58, 1.00] },
  easeInOut: { label: '缓入缓出', type: 'bezier', p1: [0.42, 0.00], p2: [0.58, 1.00] },
  bezier: { label: '三次贝塞尔', type: 'bezier', p1: [0.42, 0.00], p2: [0.58, 1.00] },
  bounce: { label: '弹跳', type: 'bounce', params: defaultParams('bounce') },
  elastic: { label: '弹动', type: 'elastic', params: defaultParams('elastic') },
  cyclic: { label: '周期', type: 'cyclic', params: defaultParams('cyclic') },
  step: { label: '步数', type: 'step', params: defaultParams('step') },
  elasticStep: { label: '弹动步数', type: 'elasticStep', params: defaultParams('elasticStep') },
};

/** Presets shown in the F2 rail, grouped like the reference editor's tabs. */
export const CURVE_GROUPS = [
  {
    title: '基础曲线',
    short: '基础',
    items: [
      { id: 'linear', label: '线性', ready: true },
      { id: 'easeIn', label: '缓入', ready: true },
      { id: 'easeOut', label: '缓出', ready: true },
      { id: 'easeInOut', label: '缓入缓出', ready: true },
    ],
  },
  {
    title: '动力学',
    short: '动力学',
    items: [
      { id: 'bounce', label: '弹跳', ready: true },
      { id: 'elastic', label: '弹动', ready: true },
      { id: 'cyclic', label: '周期', ready: true },
      { id: 'random', label: '随机', ready: false },
    ],
  },
  {
    title: '图案',
    short: '图案',
    items: [
      { id: 'step', label: '步数', ready: true },
      { id: 'elasticStep', label: '弹动步数', ready: true },
    ],
  },
];

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

const numberOr = (value, fallback) => {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Clamp/round a parameter bag to the schema of `type` (null for unknown types). */
function normalizeParams(type, raw) {
  const spec = CURVE_PARAMS[type];
  if (!spec) return null;
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [key, range] of Object.entries(spec)) {
    const v = numberOr(src[key], range.default);
    out[key] = roundParam(clamp(v, range.min, range.max));
  }
  return out;
}

/** Normalise/validate a stored curve; returns null when there is no curve. */
export function normalizeCurve(curve) {
  if (!curve || typeof curve !== 'object' || Array.isArray(curve)) return null;
  const presetDef = curve.preset ? CURVE_PRESETS[curve.preset] : null;
  let type = curve.type != null ? String(curve.type) : '';
  if (!type) {
    type = presetDef?.type || (Array.isArray(curve.p1) || Array.isArray(curve.p2) ? 'bezier' : '');
  }
  if (!type) return null;

  if (type === 'bezier') {
    const pDef = presetDef?.type === 'bezier' ? presetDef : null;
    const p1 = Array.isArray(curve.p1) ? curve.p1 : pDef?.p1;
    const p2 = Array.isArray(curve.p2) ? curve.p2 : pDef?.p2;
    if (!Array.isArray(p1) || !Array.isArray(p2)) return null;
    const x1 = Number(p1[0]), y1 = Number(p1[1]);
    const x2 = Number(p2[0]), y2 = Number(p2[1]);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    const out = {
      type: 'bezier',
      p1: [round(clamp(x1)), round(clamp(y1, -1, 2))],
      p2: [round(clamp(x2)), round(clamp(y2, -1, 2))],
    };
    if (presetDef?.type === 'bezier') out.preset = String(curve.preset);
    return out;
  }

  const params = normalizeParams(type, curve.params);
  if (!params) return null;
  const out = { type, params };
  if (presetDef?.type === type) out.preset = String(curve.preset);
  return out;
}

// ---------------------------------------------------------------- presets
// Formulas are line-by-line ports of the reference classes. Every one takes
// the normalised segment progress u (0..1) and returns the value progress.

function bounceSample(p, u) {
  const { firstStepLength: first, bounciness: bounce } = p;
  if (first <= 0) return 1;
  let start = 0;
  let length = first;
  let amplitude = 1;
  const probe = u + first / 2;
  for (let guard = 0; guard < 512; guard++) {
    const end = start + length;
    if (probe <= end) {
      if (start + length / 3 > first / 2 + 1 || (length < 0.1 && end > first / 2 + 1)) return 1;
      const x = Math.abs(((probe - start) / length - 0.5) * 2);
      return x * x * amplitude + (1 - amplitude);
    }
    length *= bounce;
    amplitude *= bounce;
    if (amplitude < 0.005) return 1;
    start = end;
  }
  return 1;
}

function elasticBasic(p, x) {
  const length = Math.max(p.stepLength, 0.01);
  const cos = Math.cos((AM_PI * x) / length);
  const falloff = 1 - Math.max(x, 0.005);
  return cos * Math.abs(falloff ** (p.decay * p.decay * 15 + 1));
}

function elasticSample(p, u) {
  const length = Math.max(p.stepLength, 0.01);
  const ease = (x) => 1 - elasticBasic(p, x) * p.magnitude;
  if (u >= length) return ease(u);
  const ramp = (1 - Math.cos((AM_PI * u) / length)) / 2;
  return mix(ramp * ease(length), ease(u), (u / length) ** 3);
}

function cyclicSample(p, u) {
  const length = Math.max(p.stepLength, 0.001);
  const pct = (x) => ((x % length) + length) % length / length;
  const cosInterp = (x) => 1 - ((Math.cos((x / length) * AM_PI * 2) + 1) / 2);
  const sawInterp = (x) => 1 - Math.abs(pct(x) - 0.5) * 2;
  const skewInterp = (x) => {
    const q = pct(x);
    let f = 0.5;
    if (q < p.skew) f = (0.5 * q) / p.skew;
    else if (q > p.skew) f = 0.5 + ((q - p.skew) / (1 - p.skew)) / 2;
    return (x - q * length) + length * f;
  };
  const warped = skewInterp(u);
  let value = mix(cosInterp(warped), sawInterp(warped), p.sharpness);
  const base = u - (u % length);
  if (length / 4 + base > 1) value = 0;
  else if (length / 2 + base < 1 && base + (length * 3) / 4 > 1 && pct(u) > p.skew) value = 1;
  return value * (1 - u * p.decay) + u * p.decay;
}

function stepSample(p, u) {
  const length = Math.max(p.stepLength, 0.001);
  const rampStart = length - p.smoothing * length;
  const rest = u % length;
  const raw = rampStart === length ? (rest >= length ? 1 : 0) : clamp((rest - rampStart) / (length - rampStart));
  const smooth = raw * raw * (3 - 2 * raw);
  return (u - rest) + smooth * length;
}

function elasticStepSample(p, u) {
  const length = Math.max(p.stepLength, 0.001);
  if (u < length) return 0;
  const inner = {
    stepLength: 0.5 - 0.45 * p.magnitude,
    decay: 1 - p.magnitude * 0.5,
    magnitude: (1 - p.magnitude) * 0.5 + 0.5,
  };
  const rest = u % length;
  const value = elasticSample(inner, rest / length);
  return (u - rest) + length * (value - 1);
}

/** Progress for a preset kind and its parameter bag; endpoints are pinned to 0/1. */
export function samplePreset(type, params, u) {
  const p = normalizeParams(type, params);
  const target = clamp(u);
  if (!p) return target;
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  switch (type) {
    case 'bounce': return bounceSample(p, target);
    case 'elastic': return elasticSample(p, target);
    case 'cyclic': return cyclicSample(p, target);
    case 'step': return stepSample(p, target);
    case 'elasticStep': return elasticStepSample(p, target);
    default: return target;
  }
}

/** Progress 0..1 for a curve (null curve = linear). */
export function sampleCurve(curve, u) {
  const c = normalizeCurve(curve);
  if (!c) return clamp(u);
  const target = clamp(u);
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  if (c.type === 'bezier') return sampleBezier(c.p1, c.p2, target);
  return samplePreset(c.type, c.params, target);
}

/** Bezier control points / preset parameters for a named preset (null for unknown). */
export function presetCurve(id) {
  const p = CURVE_PRESETS[id];
  if (!p) return null;
  if (p.type === 'bezier') {
    return normalizeCurve({ type: 'bezier', preset: id, p1: p.p1, p2: p.p2 });
  }
  return normalizeCurve({ type: p.type, preset: id, params: p.params });
}

/** Human label for a curve stored on a keyframe. */
export function curveLabel(curve) {
  const c = normalizeCurve(curve);
  if (!c) return '线性（默认）';
  if (c.preset && CURVE_PRESETS[c.preset]) return CURVE_PRESETS[c.preset].label;
  if (c.type === 'bezier') return '自定义贝塞尔';
  return `自定义${CURVE_TYPE_LABELS[c.type] || '曲线'}`;
}

const PARAM_LABELS = {
  firstStepLength: '步长',
  bounciness: '回弹',
  stepLength: '步长',
  decay: '衰减',
  magnitude: '幅度',
  sharpness: '锐度',
  skew: '偏斜',
  smoothing: '平滑',
};

/** Compact parameter readout for the panel header ('' for bezier). */
export function curveParamsText(curve) {
  const c = normalizeCurve(curve);
  if (!c || c.type === 'bezier') return '';
  const keys = Object.keys(CURVE_PARAMS[c.type] || {}).filter((k) => k !== 'attack');
  return keys.map((k) => `${PARAM_LABELS[k] || k} ${Number(c.params[k]).toFixed(2)}`).join(' · ');
}

/**
 * Draggable control points in curve space (`u` = segment progress, `v` = value
 * progress). The ids and positions mirror the reference `getHandles()`; drag
 * mappings live in `moveCurveHandle` below.
 */
export function curveHandles(curve) {
  const c = normalizeCurve(curve);
  if (!c) return [];
  if (c.type === 'bezier') {
    return [
      { id: 'p1', u: c.p1[0], v: c.p1[1], label: '控制点 1', damping: 1, allowOvershoot: true },
      { id: 'p2', u: c.p2[0], v: c.p2[1], label: '控制点 2', damping: 1, allowOvershoot: true },
    ];
  }
  const p = c.params;
  if (c.type === 'bounce') {
    return [{
      id: 'main',
      u: (p.firstStepLength + p.firstStepLength * p.bounciness) / 2,
      v: 1 - p.bounciness,
      label: '步长 / 回弹',
      damping: 0.85,
    }];
  }
  if (c.type === 'elastic') {
    return [
      {
        id: 'main',
        u: p.stepLength * (p.attack + 1),
        v: p.decay,
        origin: [p.stepLength * (p.attack + 1), sampleCurve(c, p.stepLength * (p.attack + 1))],
        label: '步长 / 衰减',
        damping: 1,
      },
      {
        id: 'magnitude',
        u: 0,
        v: p.magnitude + 1,
        origin: [1, p.magnitude + 1],
        label: '幅度',
        damping: 1,
        allowOvershoot: true,
      },
    ];
  }
  if (c.type === 'cyclic') {
    return [
      { id: 'step', u: p.stepLength, v: 0, origin: [p.stepLength, 0], label: '步长', damping: 1 },
      { id: 'sharpness', u: p.sharpness * p.stepLength, v: 1.5, origin: [p.skew * p.stepLength, 1], label: '锐度', damping: 1 },
      { id: 'skew', u: p.skew * p.stepLength, v: 1, label: '偏斜', damping: 1 },
      { id: 'decay', u: 1, v: p.decay, origin: [0, 0], label: '衰减', damping: 1 },
    ];
  }
  if (c.type === 'step') {
    return [
      { id: 'main', u: p.stepLength, v: 0, origin: [p.stepLength, p.stepLength], label: '步长', damping: 1 },
      { id: 'smooth', u: p.stepLength + p.smoothing * p.stepLength, v: 1, origin: [p.stepLength, p.stepLength], label: '平滑', damping: 1 },
    ];
  }
  if (c.type === 'elasticStep') {
    return [
      { id: 'main', u: p.stepLength, v: 0, label: '步长', damping: 1 },
      { id: 'magnitude', u: 1, v: p.magnitude, origin: [2 * p.stepLength, p.stepLength], label: '幅度', damping: 1 },
    ];
  }
  return [];
}

/**
 * Move one handle to curve-space (u, v) and return the new curve. The mappings
 * (which axis feeds which parameter, and their clamps) follow the reference
 * `copyWithUpdatedHandle` implementations. Edited curves lose `preset` so the
 * label becomes "自定义…".
 */
export function moveCurveHandle(curve, id, u, v) {
  const c = normalizeCurve(curve) || presetCurve('easeInOut');
  const uu = clamp(u);
  const vv = finite(v) ? Number(v) : 0;
  if (c.type === 'bezier') {
    const p1 = c.p1.slice();
    const p2 = c.p2.slice();
    if (id === 'p1') {
      p1[0] = uu;
      p1[1] = clamp(vv, -1, 2);
    } else if (id === 'p2') {
      p2[0] = uu;
      p2[1] = clamp(vv, -1, 2);
    } else {
      return c;
    }
    return normalizeCurve({ type: 'bezier', p1, p2 });
  }
  const p = { ...c.params };
  if (c.type === 'bounce' && id === 'main') {
    const nextBounce = clamp(1 - vv);
    // The reference maps x with the *current* bounciness, then replaces both.
    p.firstStepLength = clamp((uu * 2) / (p.bounciness + 1), 0.01, 1);
    p.bounciness = nextBounce;
  } else if (c.type === 'elastic' && id === 'main') {
    p.stepLength = clamp(uu / (p.attack + 1), 0.01, 1);
    p.decay = clamp(vv);
  } else if (c.type === 'elastic' && id === 'magnitude') {
    p.magnitude = clamp(vv - 1);
  } else if (c.type === 'cyclic' && id === 'step') {
    p.stepLength = clamp(uu, 0.001, 1);
  } else if (c.type === 'cyclic' && id === 'sharpness') {
    p.sharpness = clamp(uu / Math.max(p.stepLength, 0.001));
  } else if (c.type === 'cyclic' && id === 'skew') {
    p.skew = clamp(uu / Math.max(p.stepLength, 0.001));
  } else if (c.type === 'cyclic' && id === 'decay') {
    p.decay = clamp(vv);
  } else if (c.type === 'step' && id === 'main') {
    p.stepLength = clamp(uu, 0.01, 1);
  } else if (c.type === 'step' && id === 'smooth') {
    p.smoothing = clamp((uu - p.stepLength) / p.stepLength);
  } else if (c.type === 'elasticStep' && id === 'main') {
    p.stepLength = clamp(uu, 0.01, 1);
  } else if (c.type === 'elasticStep' && id === 'magnitude') {
    p.magnitude = clamp(vv);
  } else {
    return c;
  }
  return normalizeCurve({ type: c.type, params: p });
}

/** Value window the panel should show for a curve (handles must stay visible). */
export function curveRange(curve) {
  const c = normalizeCurve(curve);
  if (!c) return [-0.25, 1.25];
  if (c.type === 'elastic') return [-0.3, 2.05];
  if (c.type === 'cyclic') return [-0.5, 1.6];
  if (c.type === 'bezier') {
    const ys = [c.p1[1], c.p2[1]];
    const min = Math.min(0, ...ys);
    const max = Math.max(1, ...ys);
    if (min < -0.05 || max > 1.05) {
      return [Math.min(-0.25, min - 0.05), Math.max(1.25, max + 0.05)];
    }
  }
  return [-0.25, 1.25];
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
