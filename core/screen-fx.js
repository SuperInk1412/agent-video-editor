// Screen effects (bloom / CA / grain / vignette / scanline / grade / contrast /
// saturation): the parameter rules and the one GLSL source (WP3.5,
// docs/DESIGN-BACKEND-V2.md §5.4).
//
// Two consumers, one implementation:
//   app/renderer/js/preview.js        the realtime viewport (WebGL2, canvas)
//   engine/render-workers/pool.js     the Blender export (sandbox page, PNG)
//
// Both import this module — the preview over `/core/screen-fx.js`, the engine
// directly — and both read `app/renderer/shaders/post.glsl`. Neither side may
// carry its own copy of the shader bodies or of the parameter rules; that is
// what "one implementation" means here (D2).
//
// The parameter normalisation is the one the preview has always used in
// `_postAndComposite`: a missing number is 0, `saturation` falls back to 1,
// `bloom` is clamped to [0, 3]. The frame IR packs the same numbers
// (`core/frame-ir.js::screenFxOf` → `shot.screenFx`), and
// `tests/post-shaders.test.mjs` pins that the two agree, so the Blender shot
// and the WebGL preview cannot disagree about what a project asked for.
//
// Pure ESM, no DOM, no `node:*`: the browser and Node import the same file.

/** The eight screen-effect parameters, in the order the inspector draws them. */
export const SCREEN_FX_KEYS = Object.freeze([
  'bloom', 'ca', 'grain', 'scanline', 'vignette', 'grade', 'contrast', 'saturation',
]);

/** A project that asks for nothing: the export skips the post pass entirely. */
export const NEUTRAL_SCREEN_FX = Object.freeze({
  bloom: 0, ca: 0, grain: 0, scanline: 0, vignette: 0, grade: 0, contrast: 0, saturation: 1,
});

/** The file both paths compile from. Relative to the repository root. */
export const POST_GLSL_PATH = 'app/renderer/shaders/post.glsl';

/** The sections `post.glsl` must carry, and the key each one is exposed under. */
export const POST_GLSL_SECTIONS = Object.freeze({
  vert: 'quad.vert',
  bright: 'bright.frag',
  blur: 'blur.frag',
  composite: 'composite.frag',
});

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * The effect numbers one frame is drawn with. Exactly what the preview's
 * `_postAndComposite` reads, so extracting it changed no preview pixel.
 */
export function normalizeScreenFx(fx = {}) {
  const src = fx && typeof fx === 'object' ? fx : {};
  return {
    bloom: Math.min(3, Math.max(0, num(src.bloom))),
    ca: num(src.ca),
    grain: num(src.grain),
    scanline: num(src.scanline),
    vignette: num(src.vignette),
    grade: num(src.grade),
    contrast: num(src.contrast),
    saturation: Number.isFinite(Number(src.saturation)) ? Number(src.saturation) : 1,
  };
}

/** True when `fx` asks for no effect at all (the export then copies frames). */
export function isNeutralScreenFx(fx = {}) {
  const n = normalizeScreenFx(fx);
  return Math.abs(n.bloom) < 1e-6
    && Math.abs(n.ca) < 1e-6
    && Math.abs(n.grain) < 1e-6
    && Math.abs(n.scanline) < 1e-6
    && Math.abs(n.vignette) < 1e-6
    && Math.abs(n.grade) < 1e-6
    && Math.abs(n.contrast) < 1e-6
    && Math.abs(n.saturation - 1) < 1e-6;
}

const SECTION_RE = /^\s*\/\/\s*====\s*([A-Za-z0-9_.-]+)\s*====\s*$/;

/**
 * Split `post.glsl` into its four programs. Every section must start with
 * `#version 300 es` (a GLSL ES 3.00 program); a missing or malformed section is
 * a build error, not a silent fallback — the whole point is that there is only
 * one implementation to get wrong.
 *
 * Returns `{ vert, bright, blur, composite }`, each a complete shader source.
 */
export function parsePostGlsl(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('post.glsl：文件为空');
  const found = {};
  let name = null;
  let lines = [];
  const flush = () => {
    if (name && lines.length) found[name] = lines.join('\n').trim();
  };
  for (const line of text.split(/\r?\n/)) {
    const hit = SECTION_RE.exec(line);
    if (hit) {
      flush();
      name = hit[1];
      lines = [];
      continue;
    }
    if (name) lines.push(line);
  }
  flush();
  const out = {};
  for (const [key, section] of Object.entries(POST_GLSL_SECTIONS)) {
    const body = found[section];
    if (!body) throw new Error(`post.glsl：缺少段落 ${section}`);
    if (!/^#version\s+300\s+es/.test(body)) throw new Error(`post.glsl：段落 ${section} 没有以 #version 300 es 开头`);
    out[key] = `${body}\n`;
  }
  return out;
}
