// Audio elements: sound is a normal timeline element with start/duration,
// source in-point, a base volume and optional `audio.volume` keyframes.
// Pure ESM: the viewport mix, the ffmpeg mix and the CLI all share this.
import { DEFAULT_TRANSFORM, DEFAULT_STYLE, DEFAULT_FX, DEFAULT_MOTION, newId } from './schema.js';

export const AUDIO_VOLUME_PATH = 'audio.volume';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.max(0, Math.min(1, num(v, 0)));

/** Audio elements in timeline order (the element array order is not audio order). */
export function audioElements(project) {
  return (project?.elements || []).filter((e) => e?.type === 'audio' && e.src);
}

export function audioBaseVolume(el) {
  return el?.volume == null ? 1 : clamp01(el.volume);
}

/**
 * Linear volume automation at project time t. Audio uses linear segments (the
 * ffmpeg mixer mirrors this) regardless of the rendered keyframe ease; that is
 * predictable for gain and avoids a dozen ease expressions in the filter graph.
 */
export function audioVolume(el, t) {
  const base = audioBaseVolume(el);
  const keys = (el?.keyframes || [])
    .filter((k) => k?.path === AUDIO_VOLUME_PATH && Number.isFinite(Number(k.t)) && Number.isFinite(Number(k.value)))
    .sort((a, b) => Number(a.t) - Number(b.t));
  if (!keys.length) return base;
  const at = Number(t);
  if (!Number.isFinite(at) || at <= keys[0].t) return clamp01(keys[0].value);
  const last = keys[keys.length - 1];
  if (at >= last.t) return clamp01(last.value);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (at < a.t || at > b.t) continue;
    const span = Math.max(1e-9, Number(b.t) - Number(a.t));
    const u = (at - Number(a.t)) / span;
    return clamp01(Number(a.value) + (Number(b.value) - Number(a.value)) * u);
  }
  return base;
}

/**
 * Projects created before audio elements stored their song only in
 * `meta.audio`. On load, surface that track as a real element so it can be
 * selected, split, trimmed and keyframed. The legacy field stays in place as a
 * fallback for old render paths and beat analysis; preview/render use elements
 * whenever at least one exists.
 */
export function ensureAudioElements(project) {
  const meta = project?.meta;
  const src = String(meta?.audio?.src || '');
  if (!src || meta.audioMigrated) return false;
  if (audioElements(project).length) {
    meta.audioMigrated = true;
    return false;
  }
  if (!Array.isArray(project.elements)) project.elements = [];
  const id = newId('el', new Set(project.elements.map((e) => e.id)));
  const duration = Math.max(0.05, num(meta.duration, 12));
  const offset = Math.max(0, num(meta.audio.offset, 0));
  const gainDb = num(meta.audio.gain, 0);
  const volume = Math.max(0, Math.min(1, 10 ** (gainDb / 20)));
  const z = project.elements.reduce((m, e) => Math.max(m, num(e.z, 0)), -1) + 1;
  project.elements.push({
    id,
    name: src.split('/').pop() || '声音',
    type: 'audio',
    src,
    segment: null,
    start: 0,
    duration,
    z,
    srcIn: offset,
    volume,
    transform: { ...DEFAULT_TRANSFORM },
    style: { ...DEFAULT_STYLE },
    fx: { ...DEFAULT_FX },
    motion: { ...DEFAULT_MOTION },
    keyframes: [],
    visible: true,
    meta: { fromSoundtrack: true },
  });
  meta.audioMigrated = true;
  return true;
}
