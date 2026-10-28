// Camera feed check (docs/DESIGN-CAMFEED-PARENTS.md).
//
// A feed-only camera (cam_2, output:false) films a red-top / blue-bottom marker.
// The output camera (cam_1) sits 100 m to the side and films a full-frame
// camfeed element of cam_2, so the picture must show the marker the right way
// up even though cam_1 never sees the marker itself.
//
//   node scripts/check-camfeed.mjs            preview (Electron, WebGL)
//   node scripts/check-camfeed.mjs --blender  also a Blender still
//
// The preview part also flips the feed to delay 1 and checks that the first
// frame shows nothing (no previous frame yet) and the next frame the marker.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { ensureSpace } from '../core/space.js';
import { saveProject } from '../engine/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-camfeed');
const PROJECT = path.join(WORK, 'project');
const OUT = path.join(WORK, 'shot.png');
const SIDE = 100; // metres between the marker rig and the output rig

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

export async function buildProject(dir, { delay = 0 } = {}) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'media'), { recursive: true });
  await markerImage(path.join(dir, 'media', 'marker.png'));
  const project = normalizeProject(createProject({ title: 'camfeed check', background: '#000000', duration: 2 }));
  ensureSpace(project);
  const out = project.cameras[0];
  const [key] = out.path;
  applyOps(project, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    { op: 'addCamera', camera: { id: 'cam_src', name: 'source' } },
  ]);
  const src = project.cameras.find((c) => c.id === 'cam_src');
  applyOps(project, [
    { op: 'cameraPatch', id: src.id, patch: { output: false, path: [{ ...key }] } },
    { op: 'cameraPatch', id: out.id, patch: { path: [{ ...key, pos: [key.pos[0] + SIDE, key.pos[1], key.pos[2]], look: [key.look[0] + SIDE, key.look[1], key.look[2]] }] } },
    { op: 'activateCamera', id: out.id },
    { op: 'addElement', element: {
      id: 'el_marker', name: 'marker', type: 'image', src: 'media/marker.png', start: 0, duration: 2, z: 0,
      style: { fit: 'stretch' },
    } },
    { op: 'addElement', element: {
      id: 'el_feed', name: 'feed', type: 'camfeed', start: 0, duration: 2, z: 1,
      transform: { x: SIDE * 100 }, feed: { camera: src.id, delay },
    } },
  ]);
  await saveProject(dir, project, { by: 'check' });
  return project;
}

function captureJson(stdout) {
  const line = (stdout || '').split('\n').find((l) => l.includes('[capture]'));
  if (!line) return null;
  // The first balanced JSON object on the line (same parse as check-preview.mjs).
  const start = line.indexOf('{');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(line.slice(start, i + 1));
  }
  return null;
}

const isRed = (p) => p[0] > 120 && p[1] < 120 && p[2] < 120;
const isBlue = (p) => p[2] > 120 && p[0] < 120;
const isDark = (p) => p[0] < 60 && p[1] < 60 && p[2] < 60;

async function preview() {
  await buildProject(PROJECT, { delay: 0 });
  const read = (name) => [
    `{const gl=p.gl,W=p.canvas.width,H=p.canvas.height,a=new Uint8Array(4),b=new Uint8Array(4);`,
    `gl.bindFramebuffer(gl.FRAMEBUFFER,null);`,
    `gl.readPixels(W>>1,Math.round(H*0.75),1,1,gl.RGBA,gl.UNSIGNED_BYTE,a);`,
    `gl.readPixels(W>>1,Math.round(H*0.25),1,1,gl.RGBA,gl.UNSIGNED_BYTE,b);`,
    `d.${name}={top:[...a],bottom:[...b]};}`,
  ].join('');
  const evalJs = [
    'const p=window.__vdm.preview; const d={};',
    'p.render(0.5);', read('live'),
    "p.project.elements.find(e=>e.id==='el_feed').feed.delay=1; p._clearFeedTargets();",
    'p.render(0.6);', read('delayFirst'),
    'p.render(0.7);', read('delayNext'),
    'window.__dbg=d;',
  ].join(' ');
  const r = await run(process.execPath, [
    path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${OUT}`, '--at=0.5', '--delay=2600', `--eval=${evalJs}`,
  ], { cwd: REPO });
  const payload = captureJson(r.out);
  const d = payload?.dbg;
  if (!d) {
    console.error('[camfeed] no capture output');
    console.error((r.err || r.out || '').slice(-2000));
    return false;
  }
  const show = (k) => `${k}: top=${d[k].top.join(',')} bottom=${d[k].bottom.join(',')}`;
  for (const k of ['live', 'delayFirst', 'delayNext']) console.log(`[camfeed] ${show(k)}`);
  const checks = [
    ['live feed shows the source picture upright', isRed(d.live.top) && isBlue(d.live.bottom)],
    ['delay feed is empty on its first frame', isDark(d.delayFirst.top) && isDark(d.delayFirst.bottom)],
    ['delay feed shows the previous frame next', isRed(d.delayNext.top) && isBlue(d.delayNext.bottom)],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`[camfeed] ${pass ? 'PASS' : 'FAIL'} ${name}`);
    ok &&= pass;
  }
  return ok;
}

async function main() {
  let ok = await preview();
  if (process.argv.includes('--blender')) {
    const { blenderStill } = await import('./check-camfeed-blender.mjs');
    ok = (await blenderStill(PROJECT, { buildProject, isRed, isBlue })) && ok;
  }
  if (!ok) process.exit(1);
  await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[camfeed]', e.stack || e.message); process.exit(1); });
}
