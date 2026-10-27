// Mix the project's audio elements (and legacy meta.audio fallback) to one
// temp WAV for the final encode. Volume keyframes are expanded to an ffmpeg
// `volume` filter expression; the same linear segments are used by the
// viewport's HTMLAudio mix (core/audio.js::audioVolume).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findBin, fileExists } from './media.js';
import { paths } from './storage.js';
import { audioElements, audioBaseVolume, AUDIO_VOLUME_PATH } from '../core/audio.js';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const t3 = (v) => Math.round(v * 1000) / 1000;
const fmt = (v) => (Math.abs(v) < 1e-9 ? '0' : Number(v).toFixed(6));

/** Linear gain automation as an ffmpeg expression; project time = from + t. */
export function audioGainExpression(el, from) {
  const base = audioBaseVolume(el);
  const keys = (el?.keyframes || [])
    .filter((k) => k?.path === AUDIO_VOLUME_PATH && Number.isFinite(Number(k.t)) && Number.isFinite(Number(k.value)))
    .sort((a, b) => Number(a.t) - Number(b.t));
  if (!keys.length) return fmt(base);
  if (keys.length === 1) return fmt(Math.max(0, Math.min(1, Number(keys[0].value))));
  const T = `(${fmt(from)}+t)`;
  let expr = fmt(Math.max(0, Math.min(1, Number(keys[keys.length - 1].value))));
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    if (!(Number(b.t) > Number(a.t))) continue;
    const va = Math.max(0, Math.min(1, Number(a.value)));
    const vb = Math.max(0, Math.min(1, Number(b.value)));
    const seg = `(${fmt(va)}+(${fmt(vb - va)})*((${T}-${fmt(a.t)})/(${fmt(b.t - a.t)})))`;
    expr = `if(lt(${T},${fmt(b.t)}),${seg},${expr})`;
  }
  expr = `if(lt(${T},${fmt(keys[0].t)}),${fmt(Math.max(0, Math.min(1, Number(keys[0].value))))},${expr})`;
  return expr;
}

function run(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`audio mix failed (${code}): ${err.slice(-1200)}`))));
  });
}

/**
 * Build a project-time mix for [from, to). Returns null when there is no
 * element audio (legacy meta.audio is handled by the caller) or no usable clip.
 */
export async function buildAudioMix({ dir, project, from = 0, to = null } = {}) {
  const clips = audioElements(project);
  if (!clips.length) return null;
  const root = path.resolve(dir || '.');
  const start = Math.max(0, num(from, 0));
  const end = Math.max(start, to == null ? num(project?.meta?.duration, start + 1) : num(to, start + 1));
  const duration = Math.max(0.001, end - start);
  const out = path.join(paths(root).cache, `audio-mix-${project?.rev || 0}-${t3(start)}-${t3(end)}.wav`);
  if (await fileExists(out)) {
    const st = await fs.stat(out).catch(() => null);
    if (st && st.size > 44) return out;
  }
  await fs.mkdir(path.dirname(out), { recursive: true });

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  const filters = [];
  const labels = [];
  for (const el of clips) {
    if (el.visible === false) continue;
    const src = String(el.src || '');
    if (!src) continue;
    const abs = path.isAbsolute(src) ? src : path.join(root, src);
    if (!(await fileExists(abs))) continue;
    const clipStart = num(el.start, 0);
    const clipEnd = clipStart + Math.max(0, num(el.duration, 0));
    const a = Math.max(start, clipStart);
    const b = Math.min(end, clipEnd);
    if (!(b > a + 1e-6)) continue;
    const srcIn = Math.max(0, num(el.srcIn, 0) + (a - clipStart));
    const len = b - a;
    if (el.loop) args.push('-stream_loop', '-1');
    args.push('-ss', String(t3(srcIn)), '-t', String(t3(len)), '-i', abs);
    const delay = Math.max(0, Math.round((a - start) * 1000));
    const label = `a${labels.length}`;
    const expr = audioGainExpression(el, start);
    filters.push(`[${labels.length}:a]atrim=0:${fmt(len)},asetpts=PTS-STARTPTS,adelay=${delay}:all=1,volume='${expr}':eval=frame[${label}]`);
    labels.push(label);
  }
  if (!labels.length) return null;

  const all = labels.map((l) => `[${l}]`).join('');
  const mix = labels.length > 1
    ? `${all}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0`
    : `${all}anull`;
  filters.push(`${mix},alimiter=limit=0.95,apad=whole_dur=${fmt(duration)},atrim=0:${fmt(duration)},asetpts=PTS-STARTPTS[out]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[out]', '-vn',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    out,
  );
  const ffmpeg = await findBin('ffmpeg');
  await run(ffmpeg, args);
  return out;
}
