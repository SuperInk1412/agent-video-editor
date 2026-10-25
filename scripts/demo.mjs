// Rebuild projects/demo/media from the local reference project, then refresh beats.
//
//   node scripts/demo.mjs            # materialise media + analyse beats
//   node scripts/demo.mjs --reset    # also re-run the auto storyboard
//
// media/ is gitignored on purpose: the timeline document is committed, the heavy
// assets are regenerated from whatever the machine already has.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PROJECT = path.join(REPO, 'projects', 'demo');
const REF = process.env.VDM_DEMO_REF || 'E:/MyProject/ARustyDream_MV_Mading_Project';
const reset = process.argv.includes('--reset');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
  p.on('error', reject);
  p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
});

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

async function main() {
  if (!(await exists(path.join(PROJECT, 'project.vdm.json')))) {
    throw new Error(`no demo project at ${PROJECT}`);
  }
  const media = path.join(PROJECT, 'media');
  await fs.mkdir(media, { recursive: true });

  const music = path.join(REF, 'Music', 'DOUDOU - A Rusty Dream (from Cyberpunk Edgerunners 2).flac');
  const frames = ['B', 'D', 'E', 'F'].map((k) => path.join(REF, 'work', 'style_frames', `frame_${k}.png`));

  if (await exists(music)) {
    const out = path.join(media, 'bgm.m4a');
    if (!(await exists(out))) {
      console.log('[demo] extracting 24s audio slice…');
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', '32', '-t', '24', '-i', music, '-vn', '-c:a', 'aac', '-b:a', '192k', out]);
    }
  } else {
    console.log(`[demo] reference music not found (${music}) — keep whatever is in media/`);
  }

  for (const src of frames) {
    if (!(await exists(src))) continue;
    const out = path.join(media, `frame_${path.basename(src, '.png').split('_')[1]}.jpg`);
    if (await exists(out)) continue;
    console.log(`[demo] importing ${path.basename(src)}…`);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', 'scale=1920:-2', '-q:v', '2', out]);
  }

  const cli = path.join(REPO, 'cli', 'vdm.js');
  console.log('[demo] analysing beats…');
  await run(process.execPath, [cli, 'beats', '--set-duration'], { cwd: PROJECT });

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
