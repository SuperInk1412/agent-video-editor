// Preview ↔ Blender parity for parents and property links
// (docs/DESIGN-CAMFEED-PARENTS.md §4).
//
// One empty-world project carries every case at once:
//   A  a 2D image under a spatial parent (a 3D empty that moves and turns
//      after the bind) — Blender gets the baked plane matrix
//   B  a legacy 2D box whose pivot.x is linked to another element
//   C  a 3D box whose pivot.x is linked to the same element
//   D  the camera FOV linked to an element's roll
// The preview frame and a Blender still are classified on a 16×9 grid of
// colour classes; the check fails when more than a few edge cells differ.
//
//   node scripts/check-render-parity.mjs [--keep] [--only=A,B,C,D]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { ensureSpace } from '../core/space.js';
import { saveProject, loadProject } from '../engine/storage.js';
import { renderStill } from '../engine/blender.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-parity');
const PROJECT = path.join(WORK, 'project');
const T = 0.5;
const GRID = [16, 9];
const ALLOWED = 4; // edge cells may land on either side of an anti-aliased border

const only = (process.argv.find((a) => a.startsWith('--only=')) || '--only=A,B,C,D').slice(7).split(',');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  const out = [];
  let err = '';
  p.stdout.on('data', (d) => out.push(d));
  p.stderr.on('data', (d) => { err += String(d); });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, out: Buffer.concat(out), err }));
});

async function build() {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(path.join(PROJECT, 'media'), { recursive: true });
  const marker = path.join(PROJECT, 'media', 'marker.png');
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080',
    '-vf', 'drawbox=x=0:y=0:w=1920:h=540:color=0xff2020@1:t=fill,drawbox=x=0:y=540:w=1920:h=540:color=0x2040ff@1:t=fill',
    '-frames:v', '1', marker]);
  if (r.code !== 0) throw new Error(r.err);
  const p = normalizeProject(createProject({ title: 'parity', background: '#000000', duration: 2 }));
  ensureSpace(p);
  const cam = p.cameras[0].id;
  const ops = [{ op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } }];
  // E1: the link source (green), always present.
  ops.push({ op: 'addElement', element: { id: 'el_src', type: 'solid', start: 0, duration: 2, z: 1,
    transform: { x: -600, y: 250 }, style: { w: 160, h: 160, fill: '#20e020' } } });
  if (only.includes('A')) {
    ops.push(
      { op: 'objectAdd', object: { id: 'ob_rig', type: 'empty', pivot: [3, 5.4, 0] } },
      { op: 'addElement', element: { id: 'el_card', type: 'image', src: 'media/marker.png', start: 0, duration: 2, z: 2,
        transform: { x: 300, y: -100, scale: 0.25 }, style: { fit: 'stretch' } } },
      { op: 'spatialParent', id: 'el_card', parent: 'ob_rig', t: 0 },
      // after the bind: move and turn the parent, the card must follow
      { op: 'objectPatch', id: 'ob_rig', patch: { pivot: [1.5, 6.2, 1], rot: { dir: [0.42262, 0, -0.90631], roll: 10 } } },
    );
  }
  if (only.includes('B')) {
    ops.push(
      { op: 'addElement', element: { id: 'el_box', type: 'solid', start: 0, duration: 2, z: 3,
        transform: { x: -200, y: 300 }, style: { w: 200, h: 120, fill: '#ffe020' } } },
      { op: 'propLink', host: 'el', id: 'el_box', to: 'pivot.x', from: { host: 'el', id: 'el_src', path: 'pivot.x' }, combine: 'add', t: 0 },
    );
  }
  if (only.includes('C')) {
    ops.push(
      { op: 'objectAdd', object: { id: 'ob_box', type: 'solid', pivot: [-4, 2, 0], geom: { w: 1.5, h: 1.5, d: 0.2 },
        style: { color: '#ffffff', emissive: 1 } } },
      { op: 'propLink', host: 'ob', id: 'ob_box', to: 'pivot.x', from: { host: 'el', id: 'el_src', path: 'pivot.x' }, combine: 'add', t: 0 },
    );
  }
  if (only.includes('D')) {
    ops.push({ op: 'propLink', host: 'cam', id: cam, to: 'fov', from: { host: 'el', id: 'el_src', path: 'roll' }, combine: 'add', t: 0 });
  }
  // Move / turn the source after every bind: linked children must follow.
  ops.push({ op: 'updateElement', id: 'el_src', patch: { transform: { x: -350, rotation: only.includes('D') ? 12 : 0 } } });
  applyOps(p, ops);
  await saveProject(PROJECT, p, { by: 'check' });
}

const SYMBOL = { red: 'r', blue: 'u', green: 'g', yellow: 'y', white: 'w', black: '.' };
const PALETTE = { red: [255, 32, 32], blue: [32, 64, 255], green: [32, 224, 32], yellow: [255, 224, 32], white: [255, 255, 255], black: [0, 0, 0] };
function classify([r, g, b]) {
  let best = null, bd = Infinity;
  for (const [name, c] of Object.entries(PALETTE)) {
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}
const points = () => {
  const out = [];
  for (let j = 0; j < GRID[1]; j++) for (let i = 0; i < GRID[0]; i++) out.push([(i + 0.5) / GRID[0], (j + 0.5) / GRID[1]]);
  return out;
};

async function previewGrid() {
  const pts = JSON.stringify(points());
  const evalJs = [
    `const p=window.__vdm.preview; p.render(${T}); const gl=p.gl,W=p.canvas.width,H=p.canvas.height;`,
    'gl.bindFramebuffer(gl.FRAMEBUFFER,null); const px=new Uint8Array(4);',
    `window.__dbg={grid:${pts}.map(([fx,fy])=>{gl.readPixels(Math.floor(W*fx),Math.floor(H*(1-fy)),1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);return [px[0],px[1],px[2]];})};`,
  ].join(' ');
  const r = await run(process.execPath, [path.join(HERE, 'dev.mjs'), '--project', PROJECT,
    `--capture=${path.join(WORK, 'preview.png')}`, `--at=${T}`, '--delay=2600', `--eval=${evalJs}`], { cwd: REPO });
  const line = String(r.out).split('\n').find((l) => l.includes('[capture]'));
  if (!line) throw new Error(`no preview capture: ${r.err.slice(-800)}`);
  const m = line.match(/"grid":(\[\[.*?\]\])/);
  return JSON.parse(m[1]);
}

async function blenderGrid() {
  const out = await renderStill({ dir: PROJECT, project: await loadProject(PROJECT), time: T, scale: 0.5, samples: 8,
    out: path.join(WORK, 'blender.png') });
  const grid = [];
  for (const [fx, fy] of points()) {
    const r = await run('ffmpeg', ['-v', 'error', '-i', out, '-vf', `crop=1:1:trunc(iw*${fx}):trunc(ih*${fy})`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    grid.push([...r.out.subarray(0, 3)]);
  }
  return grid;
}

async function main() {
  await build();
  const a = await previewGrid();
  const b = await blenderGrid();
  const rows = [];
  let diff = 0;
  const counts = {};
  for (let j = 0; j < GRID[1]; j++) {
    let line = '';
    for (let i = 0; i < GRID[0]; i++) {
      const k = j * GRID[0] + i;
      const ca = classify(a[k]);
      const cb = classify(b[k]);
      counts[ca] = (counts[ca] || 0) + 1;
      if (ca !== cb) { diff++; line += '#'; } else line += SYMBOL[ca];
    }
    rows.push(line);
  }
  console.log(`[parity] cases ${only.join(',')}  preview classes ${JSON.stringify(counts)}`);
  for (const r of rows) console.log(`[parity] ${r}`);
  if (diff > ALLOWED) {
    for (let j = 0; j < GRID[1]; j++) {
      const at = (g, i) => SYMBOL[classify(g[j * GRID[0] + i])];
      console.log(`[parity] preview ${Array.from({ length: GRID[0] }, (_, i) => at(a, i)).join('')}  blender ${Array.from({ length: GRID[0] }, (_, i) => at(b, i)).join('')}`);
    }
  }
  console.log(`[parity] ${diff} of ${a.length} cells differ (allowed ${ALLOWED})`);
  if (diff > ALLOWED) {
    console.log('[parity] FAIL');
    process.exit(1);
  }
  console.log('[parity] PASS');
  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => { console.error('[parity]', e.stack || e.message); process.exit(1); });
