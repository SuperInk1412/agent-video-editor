// Orientation regression check.
// Builds a throwaway project whose only element is a red-top / blue-bottom marker,
// renders it through the WebGL preview inside Electron, reads two pixels back and
// asserts that "top" is still at the top. Guards the double-flip class of bug.
//
//   node scripts/check-preview.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-orient');
const PROJECT = path.join(WORK, 'project');
const OUT = path.join(WORK, 'shot.png');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += String(d); });
  p.stderr.on('data', (d) => { err += String(d); });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, out, err }));
});

async function markerImage(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const r = await run('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080',
    '-vf', 'drawbox=x=0:y=0:w=1920:h=520:color=0xff2b2b@1:t=fill,drawbox=x=0:y=560:w=1920:h=520:color=0x2b6bff@1:t=fill',
    '-frames:v', '1', file,
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg marker failed: ${r.err.slice(-300)}`);
}

async function main() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(path.join(PROJECT, 'media'), { recursive: true });
  const img = path.join(PROJECT, 'media', 'marker.png');
  await markerImage(img);

  const project = {
    schema: 'vdm.project/1',
    rev: 1,
    meta: {
      title: 'orientation check', fps: 24, width: 1920, height: 1080, duration: 2,
      background: '#000000', audio: null, beats: [], tempo: 0,
      fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 },
    },
    segments: [],
    elements: [{
      id: 'el_1', name: 'marker', type: 'image', src: 'media/marker.png',
      start: 0, duration: 2, z: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      style: { fit: 'stretch' }, motion: { type: 'none', amount: 0 }, keyframes: [],
    }],
  };
  await fs.writeFile(path.join(PROJECT, 'project.vdm.json'), JSON.stringify(project, null, 2));

  const evalJs = [
    'const p=window.__vdm.preview; p.render(0.5);',
    'const gl=p.gl, W=p.canvas.width, H=p.canvas.height;',
    'const pxTop=new Uint8Array(4), pxBot=new Uint8Array(4);',
    'gl.readPixels(W>>1, H-8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pxTop);',
    'gl.readPixels(W>>1, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pxBot);',
    'window.__dbg={pxTop:[...pxTop], pxBot:[...pxBot]};',
  ].join(' ');

  const r = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${OUT}`, '--at=0.5', '--delay=2200', `--eval=${evalJs}`,
  ], { cwd: REPO });

  const line = (r.out || '').split('\n').find((l) => l.includes('[capture]'));
  if (!line) {
    console.error('[check] no capture output');
    console.error((r.err || r.out || '').slice(-2000));
    process.exit(1);
  }
  const start = line.indexOf('{');
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === String.fromCharCode(92)) esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) { console.error('[check] could not parse capture line'); process.exit(1); }
  const payload = JSON.parse(line.slice(start, end));
  const { pxTop: topPx, pxBot: botPx } = payload.dbg || {};
  if (!topPx || !botPx) {
    console.error('[check] no pixel readback:', line);
    process.exit(1);
  }
  const isRed = (p) => p[0] > 120 && p[1] < 120 && p[2] < 120;
  const isBlue = (p) => p[2] > 120 && p[0] < 120;
  const ok = isRed(topPx) && isBlue(botPx);
  console.log(`[check] top pixel rgba=${topPx.join(',')}  bottom pixel rgba=${botPx.join(',')}`);
  if (!ok) {
    console.error('[check] FAIL — preview is vertically flipped or washed out');
    process.exit(1);
  }
  console.log('[check] PASS — orientation matches the project (top is top)');
  await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => { console.error('[check]', e.message); process.exit(1); });
