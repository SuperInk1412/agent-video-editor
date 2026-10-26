// Deterministic evaluation of an element at time t.
// This module is the contract between the WebGL preview and blender/vdm_build.py —
// any change here must be mirrored there (see docs/SPEC-PROJECT.md).
import { clamp, ease, sampleTrack, kick } from './time.js';

const MOTION_DEFAULTS = { type: 'none', amount: 0 };

/** normalised 0..1 progress through the element's life */
export function progress(el, t) {
  return clamp((t - el.start) / Math.max(1e-6, el.duration));
}

export function fadeMul(el, t) {
  const fin = Number(el.fadeIn || 0);
  const fout = Number(el.fadeOut || 0);
  const p = t - el.start;
  const q = el.start + el.duration - t;
  let m = 1;
  if (fin > 0) m *= clamp(p / fin);
  if (fout > 0) m *= clamp(q / fout);
  return m;
}

/**
 * 0..1 progress of the motion preset. `motion.span = [t0, t1]` pins it to an
 * absolute range, so both halves of a split element keep one continuous move.
 */
export function motionProgress(el, t) {
  const span = el.motion?.span;
  if (Array.isArray(span) && span.length === 2) {
    const a = Number(span[0]), b = Number(span[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return clamp((t - a) / (b - a));
  }
  return progress(el, t);
}

/** beat punch: every beat kicks the scale up by punch·5% and decays (independent of motion) */
export function punchMul(el, t, meta) {
  const punch = Number(el.punch || 0);
  if (!(punch > 0) || !meta?.beats?.length) return 1;
  return 1 + punch * 0.05 * kick(meta.beats, t, 0.12);
}

/** motion preset (+ beat punch) -> delta on top of the base transform */
export function motionDelta(el, t, meta) {
  const m = el.motion || MOTION_DEFAULTS;
  const amt = Number(m.amount || 0);
  const w = meta?.width || 1920;
  const h = meta?.height || 1080;
  const d = { x: 0, y: 0, scale: 1, rotation: 0 };
  d.scale *= punchMul(el, t, meta);
  if (!amt) return d;
  const p = motionProgress(el, t);
  const q = 0.35 * ease('easeInOut', p) + 0.65 * p; // soft start, mostly linear
  switch (m.type) {
    case 'in': d.scale *= 1 + amt * q; break;
    case 'out': d.scale *= 1 + amt * (1 - q); break;
    case 'left': d.x = -amt * w * (q - 0.5); d.scale *= 1.02; break;
    case 'right': d.x = amt * w * (q - 0.5); d.scale *= 1.02; break;
    case 'up': d.y = amt * h * (q - 0.5); d.scale *= 1.02; break;
    case 'down': d.y = -amt * h * (q - 0.5); d.scale *= 1.02; break;
    case 'drift': d.x = amt * w * (q - 0.5); d.y = -amt * h * 0.25 * (q - 0.5); break;
    case 'shake': {
      const s = amt * 0.5;
      d.x = s * 14 * (Math.sin(t * 37) + Math.sin(t * 23.3) * 0.6);
      d.y = s * 14 * Math.sin(t * 29.1);
      d.rotation = s * 0.7 * Math.sin(t * 17.7);
      break;
    }
    default: break;
  }
  return d;
}

/**
 * Effective element state at time t.
 * Resolution order: defaults -> keyframes -> motion delta -> fades.
 */
export function evalElement(el, t, meta = {}) {
  const base = el.transform || {};
  const get = (path, fallback) => sampleTrack(el.keyframes, path, t, fallback);
  const out = {
    x: Number(get('transform.x', base.x ?? 0)),
    y: Number(get('transform.y', base.y ?? 0)),
    scale: Number(get('transform.scale', base.scale ?? 1)),
    rotation: Number(get('transform.rotation', base.rotation ?? 0)),
    opacity: Number(get('transform.opacity', base.opacity ?? 1)),
    blur: Number(get('fx.blur', 0)),
    glow: Number(get('fx.glow', el.fx?.glow ?? 0)),
    text: get('style.text', el.style?.text ?? ''),
    size: Number(get('style.size', el.style?.size ?? 96)),
    color: get('style.color', el.style?.color ?? '#ffffff'),
  };
  const d = motionDelta(el, t, meta);
  out.x += d.x;
  out.y += d.y;
  out.scale *= d.scale;
  out.rotation += d.rotation;
  out.opacity = clamp(out.opacity * fadeMul(el, t));
  out.p = progress(el, t);
  return out;
}

/** rgb css color -> [r,g,b] 0..1, tolerant of #rgb/#rrggbb/rgba() */
export function parseColor(c) {
  if (Array.isArray(c)) return c;
  if (!c || typeof c !== 'string') return [1, 1, 1];
  const s = c.trim();
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3) return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255];
    if (h.length >= 6) return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0] / 255, p[1] / 255, p[2] / 255];
  }
  return [1, 1, 1];
}
