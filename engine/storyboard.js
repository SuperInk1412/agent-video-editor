// Auto-storyboard: beats + media pool -> visible, editable ops.
// Deterministic (seeded) so re-running the same brief gives the same board.
import { applyOps } from '../core/ops.js';

export const STYLE_PRESETS = {
  neon: {
    background: '#05070d',
    fx: { bloom: 0.55, ca: 0.35, grain: 0.12, vignette: 0.5, scanline: 0.22, grade: 0.15, contrast: 0.08, saturation: 1.12 },
    title: { font: 'SimHei', size: 168, color: '#f3e600' },
    caption: { font: 'SimHei', size: 54, color: '#00f0ff' },
    accent: '#ff2a4d',
  },
  clean: {
    background: '#0a0a0c',
    fx: { bloom: 0.18, ca: 0.0, grain: 0.03, vignette: 0.28, scanline: 0.0, grade: 0, contrast: 0.02, saturation: 1.02 },
    title: { font: 'SimHei', size: 150, color: '#ffffff' },
    caption: { font: 'SimHei', size: 48, color: '#c8d0da' },
    accent: '#ffffff',
  },
  film: {
    background: '#0b0908',
    fx: { bloom: 0.32, ca: 0.18, grain: 0.26, vignette: 0.62, scanline: 0.0, grade: 0.28, contrast: 0.12, saturation: 0.94 },
    title: { font: 'SimHei', size: 160, color: '#f2e7d5' },
    caption: { font: 'SimHei', size: 50, color: '#d8c7a8' },
    accent: '#b3442f',
  },
};

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** seeded Fisher–Yates: every asset is used once before any repeats */
function shuffled(rng, arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build a storyboard.
 * @param {object} o
 * @param {object} o.project  current project (for meta.duration/beats/media root)
 * @param {string[]} o.media  relative media paths (from project media dir)
 * @param {string} o.style    neon|clean|film
 * @param {string} o.brief    free text; lines become captions
 * @param {number} o.seed
 * @param {number} o.maxSegments
 * @returns {{ops: object[], segments: object[]}}
 */
export function autoStoryboard({ project, media = [], style = 'neon', brief = '', seed = 7, maxSegments = 12 }) {
  const preset = STYLE_PRESETS[style] || STYLE_PRESETS.neon;
  const rng = mulberry32(seed);
  const fps = project.meta.fps || 24;
  const duration = Math.max(2, project.meta.duration || 12);
  const beats = (project.meta.beats || []).filter((b) => b < duration);
  const tempo = project.meta.tempo || (beats.length > 1 ? 60 / (beats[1] - beats[0]) : 120);
  const beatDur = 60 / Math.max(40, tempo);

  const lines = String(brief || '')
    .split(/\r?\n|[；;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const ops = [];
  const segments = [];

  // ---- segmentation: 8 beats per shot (4 when very slow), clamped ----
  const perSeg = beatDur * 8;
  let count = Math.max(1, Math.min(maxSegments, Math.round(duration / Math.max(1.2, perSeg))));
  // one shot per brief line, as long as every shot stays at least 1.2s long
  if (lines.length > count) count = Math.max(count, Math.min(lines.length, maxSegments, Math.floor(duration / 1.2)));
  const boundaries = [];
  for (let i = 0; i < count; i++) {
    const start = (duration * i) / count;
    const end = i === count - 1 ? duration : (duration * (i + 1)) / count;
    boundaries.push([Math.round(start * 1000) / 1000, Math.round((end - start) * 1000) / 1000]);
  }

  // snap segment starts to the closest beat (keeps cuts musical)
  const snapped = boundaries.map(([s, d], i) => {
    if (!beats.length || i === 0) return [s, d];
    let best = beats[0], bd = Infinity;
    for (const b of beats) {
      const dd = Math.abs(b - s);
      if (dd < bd) { bd = dd; best = b; }
    }
    return bd < beatDur * 0.6 ? [best, d] : [s, d];
  });
  for (let i = 0; i < snapped.length; i++) {
    const [start] = snapped[i];
    const end = i + 1 < snapped.length ? snapped[i + 1][0] : duration;
    const dur = Math.max(0.4, end - start);
    segments.push({
      id: `seg_${i + 1}`,
      name: `镜 ${String(i + 1).padStart(2, '0')}`,
      start: Math.round(start * 1000) / 1000,
      duration: Math.round(dur * 1000) / 1000,
      intent: lines[i] || '',
      status: 'draft',
    });
  }

  // ---- media assignment ----
  const pool = media.filter((m) => /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(m));
  const order = shuffled(rng, pool);

  const motions = ['in', 'out', 'left', 'right', 'drift'];
  let z = 0;

  segments.forEach((seg, i) => {
    const caption = (lines[i] || '').trim();
    if (pool.length) {
      const src = order[i % order.length];
      const isVid = /\.(mp4|webm|mov)$/i.test(src);
      ops.push({
        op: 'addElement',
        element: {
          id: `el_bg_${i + 1}`,
          name: `背景 ${i + 1}`,
          type: isVid ? 'video' : 'image',
          src,
          segment: seg.id,
          start: seg.start,
          duration: seg.duration,
          z: z++,
          fadeIn: 0.25,
          fadeOut: 0.25,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          style: { fit: 'cover' },
          motion: { type: motions[i % motions.length], amount: 0.1 + 0.05 * (i % 3) },
        },
      });
    }

    // title / caption
    const isTitle = i === 0 || i % 4 === 3;
    if (i === 0) {
      ops.push({
        op: 'addElement',
        element: {
          id: 'el_title',
          name: '主标题',
          type: 'text',
          segment: seg.id,
          start: seg.start + 0.2,
          duration: Math.min(seg.duration - 0.2, 3.2),
          z: z++,
          fadeIn: 0.45,
          fadeOut: 0.4,
          transform: { x: 0, y: -20, scale: 1, rotation: 0, opacity: 1 },
          style: { text: project.meta.title || '未命名', font: preset.title.font, size: preset.title.size, color: preset.title.color, align: 'center', letterSpacing: 6 },
          motion: { type: 'in', amount: 0.06 },
          keyframes: [
            { t: seg.start + 0.2, path: 'transform.scale', value: 0.9, ease: 'outExpo' },
            { t: seg.start + 1.0, path: 'transform.scale', value: 1, ease: 'outExpo' },
          ],
        },
      });
      ops.push({
        op: 'addElement',
        element: {
          id: 'el_rule',
          name: '标题下划线',
          type: 'shape',
          segment: seg.id,
          start: seg.start + 0.8,
          duration: Math.min(seg.duration - 0.8, 2.4),
          z: z++,
          fadeIn: 0.3,
          transform: { x: 0, y: 92, scale: 1, rotation: 0, opacity: 0.95 },
          style: { shape: 'rect', fill: preset.accent, w: 760, h: 5 },
          keyframes: [
            { t: seg.start + 0.8, path: 'transform.scale', value: 0.1, ease: 'outExpo' },
            { t: seg.start + 1.2, path: 'transform.scale', value: 1, ease: 'outExpo' },
          ],
        },
      });
    } else if (isTitle && caption) {
      ops.push({
        op: 'addElement',
        element: {
          id: `el_txt_${i + 1}`,
          name: `大字 ${i + 1}`,
          type: 'text',
          segment: seg.id,
          start: seg.start + 0.1,
          duration: Math.max(0.4, seg.duration - 0.2),
          z: z++,
          fadeIn: 0.2,
          fadeOut: 0.2,
          punch: 0.8,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          style: { text: caption, font: preset.title.font, size: Math.round(preset.title.size * 0.8), color: preset.title.color, align: 'center', letterSpacing: 2 },
          motion: { type: 'none', amount: 0 },
        },
      });
    } else if (caption) {
      ops.push({
        op: 'addElement',
        element: {
          id: `el_cap_${i + 1}`,
          name: `字幕 ${i + 1}`,
          type: 'text',
          segment: seg.id,
          start: seg.start + 0.15,
          duration: Math.max(0.4, seg.duration - 0.3),
          z: z++,
          fadeIn: 0.25,
          fadeOut: 0.25,
          transform: { x: 0, y: 300, scale: 1, rotation: 0, opacity: 1 },
          style: { text: caption, font: preset.caption.font, size: preset.caption.size, color: preset.caption.color, align: 'center', letterSpacing: 1 },
          motion: { type: 'none', amount: 0 },
        },
      });
    }
  });

  // ---- segment ops first, then meta (all unshifted in reverse order) ----
  const segOps = segments.map((seg) => ({ op: 'addSegment', segment: { ...seg } }));
  ops.unshift(...segOps);
  ops.unshift({ op: 'setMeta', path: 'style', value: style });
  ops.unshift({ op: 'setFx', fx: preset.fx });
  ops.unshift({ op: 'setMeta', path: 'background', value: preset.background });

  // clear previous content is the caller's job (it passes an emptied project)
  return { ops, segments };
}

/**
 * Replace the 2D timeline of `project` (in place) with an auto storyboard.
 * Everything else — title, size, audio, beats, cameras, world, 3D objects — stays.
 */
export function planProject(project, { media = [], style = 'neon', brief = '', seed = 7, maxSegments = 12, duration = null } = {}) {
  const planned = { ...project, meta: { ...project.meta, ...(Number(duration) > 0 ? { duration: Number(duration) } : {}) } };
  const { ops, segments } = autoStoryboard({ project: planned, media, style, brief, seed, maxSegments });
  applyOps(project, [{ op: 'replaceTimeline', elements: [], segments: [] },
    ...(Number(duration) > 0 ? [{ op: 'setMeta', path: 'duration', value: Number(duration) }] : []), ...ops]);
  return { segments: segments.length, elements: project.elements.length };
}

/** Turn a project into a compact text summary the agent can read. */
export function summarizeProject(project, { segmentId = null, time = 0 } = {}) {
  const segs = project.segments.filter((s) => !segmentId || s.id === segmentId);
  const segIds = new Set(segs.map((s) => s.id));
  const els = project.elements.filter((e) => !segmentId || !e.segment || segIds.has(e.segment));
  return {
    title: project.meta.title,
    fps: project.meta.fps,
    size: [project.meta.width, project.meta.height],
    duration: project.meta.duration,
    tempo: project.meta.tempo,
    beats: project.meta.beats.slice(0, 400),
    fx: project.meta.fx,
    playhead: time,
    segments: segs.map((s) => ({ id: s.id, name: s.name, start: s.start, duration: s.duration, intent: s.intent, status: s.status })),
    elements: els.map((e) => ({
      id: e.id, name: e.name, type: e.type, segment: e.segment, src: e.src,
      start: e.start, duration: e.duration, z: e.z,
      transform: e.transform, motion: e.motion, fx: e.fx,
      text: e.type === 'text' ? e.style.text : undefined,
      style: e.type === 'text' ? { font: e.style.font, size: e.style.size, color: e.style.color } : undefined,
      keyframes: e.keyframes,
    })),
  };
}
