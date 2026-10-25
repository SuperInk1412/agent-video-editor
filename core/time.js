// Time / easing / keyframe math. Pure ESM, shared by engine, CLI and renderer.
export const EPS = 1e-6;
export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export const EASES = {
  linear: (p) => p,
  easeIn: (p) => p * p,
  easeOut: (p) => 1 - (1 - p) * (1 - p),
  easeInOut: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
  smooth: (p) => p * p * (3 - 2 * p),
  outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
  outBack: (p) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  },
  inOutCubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
};

export const EASE_NAMES = Object.keys(EASES);

export function ease(name, p) {
  const fn = EASES[name] || EASES.easeInOut;
  return fn(clamp(p));
}

/** index of last beat <= t, or -1 */
export function beatIndexAt(beats, t) {
  if (!beats || !beats.length) return -1;
  let lo = 0, hi = beats.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function nextBeat(beats, t) {
  if (!beats || !beats.length) return null;
  for (const b of beats) if (b > t + 1e-4) return b;
  return null;
}

/** exponential pulse that decays after each beat; `dur` controls sharpness */
export function kick(beats, t, dur = 0.14) {
  const i = beatIndexAt(beats, t);
  if (i < 0) return 0;
  const dt = t - beats[i];
  if (dt > dur * 5) return 0;
  return Math.exp(-dt / dur);
}

/**
 * Sample keyframe track for one property path.
 * keys: [{ t, path, value, ease }]
 * Numeric values are interpolated; strings / colors step.
 */
export function sampleTrack(keys, path, t, base = null) {
  if (!keys || !keys.length) return base;
  const list = keys.filter((k) => k.path === path).sort((a, b) => a.t - b.t);
  if (!list.length) return base;
  if (t <= list[0].t) return list[0].value;
  if (t >= list[list.length - 1].t) return list[list.length - 1].value;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (t >= a.t && t < b.t) {
      const p = (t - a.t) / Math.max(EPS, b.t - a.t);
      if (typeof a.value === 'number' && typeof b.value === 'number') {
        return lerp(a.value, b.value, ease(a.ease || 'easeInOut', p));
      }
      return a.value;
    }
  }
  return base;
}

/** true when a keyframe track exists for path */
export function hasTrack(keys, path) {
  return !!keys && keys.some((k) => k.path === path);
}

export const timecode = (t, fps = 24) => {
  const total = Math.max(0, t);
  const f = Math.round((total % 1) * fps) % fps;
  const s = Math.floor(total) % 60;
  const m = Math.floor(total / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};

export const fmtSec = (t) => (Math.round(t * 1000) / 1000).toFixed(3);
