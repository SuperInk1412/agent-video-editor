// Rebuild projects/demo/media from the local reference project, then refresh beats.
//
//   node scripts/demo.mjs            # materialise media + analyse beats
//   node scripts/demo.mjs --reset    # also re-run the auto storyboard
//
// media/ is gitignored on purpose: the timeline document is committed, the heavy
// assets are regenerated from whatever the machine already has. Without the
// reference project, placeholder frames and a drum loop on the committed beat grid
// are generated instead, so the demo opens (and renders) on any machine.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PROJECT = process.env.VDM_DEMO_PROJECT ? path.resolve(process.env.VDM_DEMO_PROJECT) : path.join(REPO, 'projects', 'demo');
const REF = process.env.VDM_DEMO_REF || 'E:/MyProject/ARustyDream_MV_Mading_Project';
const reset = process.argv.includes('--reset');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
  p.on('error', reject);
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
});

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

// neon gradients standing in for the reference style frames
const PLACEHOLDER = {
  B: { c: ['0x05070d', '0x00f0ff', '0xff2a4d'], seed: 3 },
  D: { c: ['0x0b0418', '0xff00aa', '0x3a0ca3'], seed: 11 },
  E: { c: ['0x020c14', '0x17d9ff', '0xf3e600'], seed: 23 },
  F: { c: ['0x100404', '0xff6b00', '0x6a00ff'], seed: 41 },
};

async function placeholderFrame(key, out) {
  const { c, seed } = PLACEHOLDER[key];
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', `gradients=s=1920x1080:c0=${c[0]}:c1=${c[1]}:c2=${c[2]}:n=3:seed=${seed}:speed=0`,
    '-frames:v', '1', '-vf', 'noise=alls=10:allf=t,vignette=PI/4', '-q:v', '3', out]);
}

/** kick/snare on the committed beat grid, hats in between, a low drone underneath */
async function placeholderMusic(beats, duration, out) {
  const SR = 44100;
  const pcm = new Float32Array(Math.ceil(duration * SR));
  let r = 9;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const hit = (t0, len, fn) => {
    const i0 = Math.floor(t0 * SR);
    for (let i = 0; i < len * SR && i0 + i < pcm.length; i++) if (i0 + i >= 0) pcm[i0 + i] += fn(i / SR);
  };
  beats.forEach((b, i) => {
    if (i % 2 === 0) hit(b, 0.35, (t) => 0.8 * Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-t * 28)) * t) * Math.exp(-t * 9));
    else hit(b, 0.25, (t) => 0.35 * rnd() * Math.exp(-t * 18) + 0.2 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 14));
    const next = beats[i + 1] ?? b + 0.5;
    hit((b + next) / 2, 0.06, () => 0.08 * rnd());
  });
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SR;
    pcm[i] += 0.05 * Math.sin(2 * Math.PI * 55 * t) + 0.03 * Math.sin(2 * Math.PI * 82.4 * t);
    pcm[i] = Math.max(-1, Math.min(1, pcm[i]));
  }
  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-',
      '-c:a', 'aac', '-b:a', '160k', out], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
    p.stdin.end(Buffer.from(pcm.buffer));
  });
}

async function main() {
  if (!(await exists(path.join(PROJECT, 'project.vdm.json')))) {
    throw new Error(`no demo project at ${PROJECT}`);
  }
  const media = path.join(PROJECT, 'media');
  await fs.mkdir(media, { recursive: true });

  const music = path.join(REF, 'Music', 'DOUDOU - A Rusty Dream (from Cyberpunk Edgerunners 2).flac');
  const frames = ['B', 'D', 'E', 'F'].map((k) => path.join(REF, 'work', 'style_frames', `frame_${k}.png`));

  const bgm = path.join(media, 'bgm.m4a');
  let synthesized = false;
  if (await exists(music)) {
    if (!(await exists(bgm))) {
      console.log('[demo] extracting 24s audio slice…');
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', '32', '-t', '24', '-i', music, '-vn', '-c:a', 'aac', '-b:a', '192k', bgm]);
    }
  } else if (!(await exists(bgm))) {
    const project = JSON.parse(await fs.readFile(path.join(PROJECT, 'project.vdm.json'), 'utf8'));
    const beats = project.meta?.beats || [];
    console.log(`[demo] reference music not found — generating a drum loop on the ${beats.length} committed beats`);
    await placeholderMusic(beats, Number(project.meta?.duration) || 24, bgm);
    synthesized = true;
  }

  for (const src of frames) {
    const key = path.basename(src, '.png').split('_')[1];
    const out = path.join(media, `frame_${key}.jpg`);
    if (await exists(out)) continue;
    if (await exists(src)) {
      console.log(`[demo] importing ${path.basename(src)}…`);
      await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', 'scale=1920:-2', '-q:v', '2', out]);
    } else {
      console.log(`[demo] reference frame ${key} not found — generating a placeholder`);
      await placeholderFrame(key, out);
    }
  }

  const cli = path.join(REPO, 'cli', 'vdm.js');
  if (synthesized && !reset) {
    console.log('[demo] placeholder music follows the committed beat grid — keeping meta.beats as is');
  } else {
    console.log('[demo] analysing beats…');
    await run(process.execPath, [cli, 'beats', '--set-duration'], { cwd: PROJECT });
  }

  if (reset) {
    console.log('[demo] storyboard…');
    await run(process.execPath, [cli, 'plan', '--style', 'neon', '--brief',
      '夜之城不睡\n把梦焊进骨头\n坠落也是一种方向\n谁的记忆在闪\n在噪音里认出自己\n那就别回头'], { cwd: PROJECT });
  }

  const list = (await fs.readdir(media)).filter((f) => !f.startsWith('.'));
  console.log(`[demo] media ready: ${list.join(', ')}`);
  console.log(`[demo] open with: npm start   (or: node engine/server.js --project projects/demo --open)`);
}

main().catch((e) => { console.error('[demo]', e.message); process.exit(1); });
