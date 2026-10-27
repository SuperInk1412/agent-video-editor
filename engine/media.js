// Media helpers: probing, frame extraction, thumbnails, encoding.
// Everything shells out to ffmpeg/ffprobe — no native deps.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runProcess } from './process.js';

const execFileP = promisify(execFile);

const candidates = (name) => [
  process.env[`VDM_${name.toUpperCase()}`],
  `C:/Users/${process.env.USERNAME}/bin/${name}.exe`,
  `C:/ffmpeg/bin/${name}.exe`,
  name,
].filter(Boolean);

let cached = {};
export async function findBin(name) {
  if (cached[name]) return cached[name];
  for (const c of candidates(name)) {
    try {
      await execFileP(c, ['-version'], { windowsHide: true, timeout: 8000 });
      cached[name] = c;
      return c;
    } catch { /* next */ }
  }
  throw new Error(`${name} not found; set VDM_${name.toUpperCase()} or add it to PATH`);
}

export const hashOf = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 12);

export async function hashFile(file, { signal } = {}) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fss.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

export async function probeMedia(file) {
  const ffprobe = await findBin('ffprobe');
  const { stdout } = await execFileP(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  const fps = v && v.r_frame_rate ? (() => {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    return d ? n / d : n;
  })() : 0;
  return {
    file,
    duration: Number(info.format?.duration || v?.duration || 0),
    width: v?.width || 0,
    height: v?.height || 0,
    fps,
    videoCodec: v?.codec_name || null,
    audioCodec: a?.codec_name || null,
    hasAudio: !!a,
    rotation: Number(v?.tags?.rotate || 0),
  };
}

/** Extract a video element's source range to a PNG sequence at project fps/size (cover-cropped). */
export async function extractSequence({ src, outDir, srcIn = 0, duration, fps, width, height, fit = 'cover', loop = false, onLog, signal }) {
  const ffmpeg = await findBin('ffmpeg');
  await fs.mkdir(outDir, { recursive: true });
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
  ];
  if (loop) args.push('-stream_loop', '-1');
  args.push('-ss', String(Math.max(0, srcIn)), '-t', String(duration), '-i', src,
    '-vf', fit === 'stretch' ? `fps=${fps},scale=${width}:${height}`
      : `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
    '-start_number', '0', path.join(outDir, 'f_%05d.png'),
  );
  await runProcess(ffmpeg, args, { signal, onLog });
  const files = (await fs.readdir(outDir)).filter((f) => f.endsWith('.png')).sort();
  return { dir: outDir, count: files.length, first: files[0] ? path.join(outDir, files[0]) : null };
}

export async function thumbnail({ src, out, at = 0, width = 480 }) {
  const ffmpeg = await findBin('ffmpeg');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await execFileP(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', src,
    '-frames:v', '1', '-vf', `scale=${width}:-2`, out,
  ], { windowsHide: true });
  return out;
}

/** Encode a PNG sequence + optional audio into an mp4. */
export async function encodeSequence({ framesDir, pattern = 'f_%05d.png', startNumber = null, fps, out, audio = null, audioOffset = 0, gain = 0, crf = 18, onLog, signal }) {
  const ffmpeg = await findBin('ffmpeg');
  await fs.mkdir(path.dirname(out), { recursive: true });
  const args = ['-y', '-hide_banner', '-framerate', String(fps)];
  if (startNumber != null) args.push('-start_number', String(startNumber));
  args.push('-i', path.join(framesDir, pattern));
  if (audio) {
    if (audioOffset) args.push('-itsoffset', String(audioOffset));
    args.push('-i', audio);
  }
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p');
  if (audio) {
    if (gain) args.push('-af', `volume=${gain}dB`);
    args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  }
  args.push('-movflags', '+faststart', out);
  await runProcess(ffmpeg, args, { signal, onLog });
  return out;
}

export async function exportAudio({ src, out, start = 0, duration = 30, gain = 0 }) {
  const ffmpeg = await findBin('ffmpeg');
  await fs.mkdir(path.dirname(out), { recursive: true });
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(duration), '-i', src];
  if (gain) args.push('-af', `volume=${gain}dB`);
  args.push('-c:a', 'aac', '-b:a', '192k', out);
  await execFileP(ffmpeg, args, { windowsHide: true });
  return out;
}

export async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export function mimeOf(file) {
  const e = path.extname(file).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.json': 'application/json',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  })[e] || 'application/octet-stream';
}

export { fs, fss, path };
