// Image / video / text objects in the 3D scene (planes instead of boxes).
// Pure ESM (no node:*): the viewport, the bake (engine/shot.js) and tests share it.
// blender/vdm_objects.py mirrors fitPlane() and videoFrame(); keep them in step.
//
//   image / video:  { src: 'media/x.png', srcIn: 0, rate: 1,
//                     geom: { w, h },                          // the frame the picture is fitted into, metres
//                     style: { fit: 'contain'|'cover'|'stretch', uv: [u0, v0, u1, v1], emissive: 1, opacity: 1 } }
//   text:           { style: { text, size, color, font, align, tracking, lineHeight, extrude, emissive, opacity } }
//
// Facing: a plane's front looks along the object's `dir` (like "面向镜头"), and
// reads unmirrored from the front: picture +u / reading direction = −right.

export const PLANE_TYPES = new Set(['image', 'video']);
export const MEDIA_TYPES = new Set(['image', 'video', 'text']);
export const FITS = ['contain', 'cover', 'stretch'];
export const ALIGNS = ['left', 'center', 'right'];
export const DEFAULT_FONT = 'SimHei';

const isNum = (n) => Number.isFinite(Number(n));
const num = (n, d = 0) => (isNum(n) ? Number(n) : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const isPlane = (obj) => PLANE_TYPES.has(obj?.type);
export const isText = (obj) => obj?.type === 'text';

/** Normalised crop rect in source UV space (0..1, v up). */
export function normalizeUV(uv) {
  if (!Array.isArray(uv) || uv.length < 4 || !uv.slice(0, 4).every(isNum)) return [0, 0, 1, 1];
  let [u0, v0, u1, v1] = uv.slice(0, 4).map((n) => clamp(Number(n), 0, 1));
  if (u1 < u0) [u0, u1] = [u1, u0];
  if (v1 < v0) [v0, v1] = [v1, v0];
  if (u1 - u0 < 1e-4 || v1 - v0 < 1e-4) return [0, 0, 1, 1];
  return [u0, v0, u1, v1];
}

/** Picture / video settings with defaults. */
export function mediaSpec(obj) {
  const st = obj?.style || {};
  const g = obj?.geom || {};
  return {
    src: obj?.src ? String(obj.src) : '',
    srcIn: Math.max(0, num(obj?.srcIn, 0)),
    rate: Math.max(0.01, num(obj?.rate, 1)),
    fit: FITS.includes(st.fit) ? st.fit : 'contain',
    uv: normalizeUV(st.uv),
    w: Math.max(0.001, num(g.w, 2)),
    h: Math.max(0.001, num(g.h, 2)),
    emissive: Math.max(0, num(st.emissive, 1)),
  };
}

/** Text settings with defaults (size = em height in metres). */
export function textSpec(obj) {
  const st = obj?.style || {};
  return {
    text: st.text == null ? 'Text' : String(st.text),
    size: Math.max(0.001, num(st.size, 1)),
    color: typeof st.color === 'string' && st.color ? st.color : '#ffffff',
    font: st.font ? String(st.font) : DEFAULT_FONT,
    align: ALIGNS.includes(st.align) ? st.align : 'center',
    tracking: num(st.tracking, 0),          // extra space between letters, in em
    lineHeight: Math.max(0.1, num(st.lineHeight, 1.2)),
    extrude: Math.max(0, num(st.extrude, 0)), // depth in metres (Blender only; the viewport draws the face)
    emissive: Math.max(0, num(st.emissive, 1)),
  };
}

/** A font given as a file (has an extension / a slash) rather than a family name. */
export const isFontFile = (font) => /[\\/]/.test(font) || /\.(ttf|otf|ttc|woff2?)$/i.test(font);

/** Project-relative media path -> URL served by the engine (/media/* = <project>/media). */
export function mediaUrl(src) {
  const s = String(src || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return `/media/${s.replace(/^media\//, '')}`;
}

/**
 * Fit a picture (imgW×imgH pixels, cropped to `uv`) into a w×h frame.
 * Returns the drawn quad size (metres) and the UV rect to sample.
 *   stretch: quad = frame, uv as given
 *   contain: quad shrinks to the picture's aspect inside the frame
 *   cover:   quad = frame, uv cropped (centred) to the frame's aspect
 */
export function fitPlane(fit, imgW, imgH, w, h, uv = [0, 0, 1, 1]) {
  const [u0, v0, u1, v1] = normalizeUV(uv);
  const cw = Math.max(1e-6, num(imgW, 1) * (u1 - u0));
  const ch = Math.max(1e-6, num(imgH, 1) * (v1 - v0));
  const pic = cw / ch;
  const frame = w / h;
  if (fit === 'stretch' || !isNum(imgW) || !isNum(imgH) || imgW <= 0 || imgH <= 0) {
    return { w, h, uv: [u0, v0, u1, v1] };
  }
  if (fit === 'cover') {
    if (pic > frame) {
      const keep = (u1 - u0) * (frame / pic);
      const mid = (u0 + u1) / 2;
      return { w, h, uv: [mid - keep / 2, v0, mid + keep / 2, v1] };
    }
    const keep = (v1 - v0) * (pic / frame);
    const mid = (v0 + v1) / 2;
    return { w, h, uv: [u0, mid - keep / 2, u1, mid + keep / 2] };
  }
  // contain
  return pic > frame ? { w, h: w / pic, uv: [u0, v0, u1, v1] } : { w: h * pic, h, uv: [u0, v0, u1, v1] };
}

/** Source time (seconds) of a video object at project time t. */
export function videoTime(obj, t) {
  const m = mediaSpec(obj);
  const local = clamp(num(t, 0) - num(obj?.start, 0), 0, Math.max(0, num(obj?.duration, 0)));
  return m.srcIn + local * m.rate;
}

/**
 * 1-based frame of the extracted sequence (which starts at srcIn and is sampled
 * at `fps` in source time) for project time t; clamped to [1, count].
 */
export function videoFrame(obj, t, fps, count = Infinity) {
  const m = mediaSpec(obj);
  const local = clamp(num(t, 0) - num(obj?.start, 0), 0, Math.max(0, num(obj?.duration, 0)));
  const idx = Math.floor(local * m.rate * fps + 1e-6) + 1;
  return clamp(idx, 1, Math.max(1, count));
}

/** Seconds of source footage a video object needs (for extraction). */
export const videoSpan = (obj) => Math.max(0, num(obj?.duration, 0)) * mediaSpec(obj).rate;
