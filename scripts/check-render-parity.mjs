// Preview ↔ Blender parity for parents and property links
// (docs/DESIGN-CAMFEED-PARENTS.md §4).
//
// One empty-world project carries every case at once:
//   A  a 2D image under a spatial parent (a 3D empty that moves and turns
//      after the bind) — Blender gets the baked plane matrix
//   B  a legacy 2D box whose pivot.x is linked to another element
//   C  a 3D box whose pivot.x is linked to the same element
//   D  the camera FOV linked to an element's roll
//   E  three-axis rotation: a tilted 2D node card, a keyed 3D box, a camera pan offset
//   F  2D plane order (docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §一): a card facing the
//      camera 2 m in front of a large backdrop. Its plane is farther from the
//      camera than the backdrop's plane, its origin nearer — ordering by plane
//      distance draws the backdrop over the card; Blender (EEVEE origin order) does not.
//   G  §四: a wide card on the left, 2 m in front of a wide backdrop whose
//      CENTRE is nearer the camera than the card's origin — ordering by origin
//      distance draws the backdrop over the card; Blender keeps the card in front.
// The preview frame and a Blender still are classified on a 16×9 grid of
// colour classes; the check fails when more than a few edge cells differ.
//
// Case H (docs/DESIGN-BACKEND-V2.md §4.4 v4 / WP1.3) is the text geometry case
// and runs on its own project: three lines of mixed Chinese / Japanese / Latin
// in two fonts, rendered by both backends at the project resolution, compared
// **pixel by pixel**. The preview draws the IR glyph mesh (core/glyphs.js) and
// Blender builds a mesh from the very same vertices, so the two pictures have to
// agree except for edge anti-aliasing; the case fails when more than 1 % of the
// pixels differ by more than `TEXT_DIFF` levels.
//
//   node scripts/check-render-parity.mjs [--keep] [--only=A,B,C,D,E,F,G]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { ensureSpace } from '../core/space.js';
import { saveProject, loadProject } from '../engine/storage.js';
import { renderStill } from '../engine/blender.js';
import { rotationFromDirRoll } from '../core/rotation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-parity');
const PROJECT = path.join(WORK, 'project');
const T = 0.5;
const GRID = [16, 9];
const ALLOWED = 4; // edge cells may land on either side of an anti-aliased border
// Case H: the project it builds, and the pixel-difference budget (WP1.3).
const PROJECT_H = path.join(WORK, 'project-h');
const TEXT_DIFF = 24;        // channel levels ignored as anti-aliasing
const TEXT_ALLOWED = 0.01;   // 1 % of the frame

const only = (process.argv.find((a) => a.startsWith('--only=')) || '--only=A,B,C,D,E,F,G,H').slice(7).split(',');

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
  if (only.includes('E')) {
    ops.push(
      { op: 'addElement', element: { id: 'el_tilt', type: 'image', src: 'media/marker.png', start: 0, duration: 2, z: 4,
        node: { pivot: [-3.5, 8, -2], position: [0, 0, 0], rotation: [25, 40, 10], scale: [0.22, 0.22, 1] }, style: { fit: 'stretch' } } },
      { op: 'objectAdd', object: { id: 'ob_turn', type: 'solid', pivot: [5, 2.2, -1], geom: { w: 2.4, h: 0.6, d: 0.6 },
        rotation: [0, 0, 0], style: { color: '#ffe020', emissive: 1 } } },
      { op: 'objectKey', id: 'ob_turn', path: 'rotation.z', t: 0, v: 0 },
      { op: 'objectKey', id: 'ob_turn', path: 'rotation.z', t: 1, v: 90 },
      { op: 'cameraPatch', id: cam, patch: { rotation: [0, 3, 0] } },
    );
  }
  if (only.includes('F')) {
    // top-right corner is empty in A–E; the default camera sits at [0, 5.4, 20]
    const card = [10.6, 12, -2];
    const toCam = [0 - card[0], 5.4 - card[1], 20 - card[2]];
    ops.push(
      { op: 'addElement', element: { id: 'el_backdrop', type: 'solid', start: 0, duration: 2, z: 5,
        node: { pivot: [10.6, 12, -4], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        style: { w: 2000, h: 1100, fill: '#ffffff' } } },
      { op: 'addElement', element: { id: 'el_facing', type: 'solid', start: 0, duration: 2, z: 6,
        node: { pivot: card, position: [0, 0, 0], rotation: rotationFromDirRoll(toCam, 0), scale: [1, 1, 1] },
        style: { w: 1000, h: 650, fill: '#20e020' } } },
    );
  }
  if (only.includes('G')) {
    // bottom band (row 7) is empty in A–F; card origin 23.7 m, backdrop centre 23.0 m
    ops.push(
      { op: 'addElement', element: { id: 'el_wide_bd', type: 'solid', start: 0, duration: 2, z: 7,
        node: { pivot: [2, -1, -2], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        style: { w: 4400, h: 700, fill: '#ffffff' } } },
      { op: 'addElement', element: { id: 'el_side', type: 'solid', start: 0, duration: 2, z: 8,
        node: { pivot: [-11, -1, 0], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        style: { w: 1000, h: 500, fill: '#20e020' } } },
    );
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

async function previewGrid(projectDir = PROJECT) {
  const pts = JSON.stringify(points());
  const evalJs = [
    `const p=window.__vdm.preview; p.render(${T}); const gl=p.gl,W=p.canvas.width,H=p.canvas.height;`,
    'gl.bindFramebuffer(gl.FRAMEBUFFER,null); const px=new Uint8Array(4);',
    `window.__dbg={grid:${pts}.map(([fx,fy])=>{gl.readPixels(Math.floor(W*fx),Math.floor(H*(1-fy)),1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);return [px[0],px[1],px[2]];})};`,
  ].join(' ');
  const r = await run(process.execPath, [path.join(HERE, 'dev.mjs'), '--project', projectDir,
    `--capture=${path.join(WORK, path.basename(projectDir) + '-preview.png')}`, `--at=${T}`, '--delay=2600', `--eval=${evalJs}`], { cwd: REPO });
  const line = String(r.out).split('\n').find((l) => l.includes('[capture]'));
  if (!line) throw new Error(`no preview capture: ${r.err.slice(-800)}`);
  const m = line.match(/"grid":(\[\[.*?\]\])/);
  return JSON.parse(m[1]);
}

async function blenderGrid(projectDir = PROJECT) {
  const out = await renderStill({ dir: projectDir, project: await loadProject(projectDir), time: T, scale: 0.5, samples: 8,
    out: path.join(WORK, path.basename(projectDir) + '-blender.png') });
  const grid = [];
  for (const [fx, fy] of points()) {
    const r = await run('ffmpeg', ['-v', 'error', '-i', out, '-vf', `crop=1:1:trunc(iw*${fx}):trunc(ih*${fy})`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    grid.push([...r.out.subarray(0, 3)]);
  }
  return grid;
}

/**
 * Case H's project: three lines, two fonts, Chinese + Japanese + Latin. Text is
 * the one content kind both backends used to typeset themselves (canvas vs
 * FONT curve), so it is the case that proves the shared mesh.
 */
async function buildText() {
  await fs.mkdir(path.join(PROJECT_H, 'media'), { recursive: true });
  const p = normalizeProject(createProject({ title: 'parity text', background: '#000000', duration: 2 }));
  ensureSpace(p);
  applyOps(p, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    { op: 'addElement', element: { id: 'tx_cjk', type: 'text', start: 0, duration: 2, z: 1,
      transform: { x: 0, y: 240 },
      style: { text: '未来幻想\n消えてゆく', font: 'Microsoft YaHei', size: 150, color: '#ffffff',
        align: 'center', lineHeight: 1.15, letterSpacing: 4 } } },
    { op: 'addElement', element: { id: 'tx_lat', type: 'text', start: 0, duration: 2, z: 2,
      transform: { x: 0, y: -220 },
      style: { text: 'TOKYO 2099 / 光', font: 'Arial', size: 120, color: '#ffffff',
        align: 'center', lineHeight: 1.2, letterSpacing: 2 } } },
  ]);
  await saveProject(PROJECT_H, p, { by: 'check' });
}

/**
 * Case H (WP1.3): the same frame through both backends at the project's own
 * resolution, diffed pixel by pixel in the renderer (the preview canvas is
 * resized to 1920x1080 for the comparison). Both sides draw the IR glyph mesh,
 * so what is left is anti-aliasing along the edges.
 */
async function textCase() {
  await buildText();
  // The Blender still is served from the project's /media so the page can load
  // it (an --eval string cannot carry a 1920x1080 PNG on a Windows command line).
  const still = await renderStill({ dir: PROJECT_H, project: await loadProject(PROJECT_H), time: T, scale: 1, samples: 16,
    out: path.join(WORK, 'blender-h.png') });
  await fs.copyFile(still, path.join(PROJECT_H, 'media', 'zz-blender.png'));
  const evalJs = `(async () => {
    const p = window.__vdm.preview;
    const W = 1920, H = 1080;
    p.canvas.width = W; p.canvas.height = H; p._rebuildTargets();
    await p.whenFontsReady();
    p.render(${T});
    const shot = new Image();
    shot.src = p.canvas.toDataURL('image/png');
    await shot.decode();
    const ref = new Image();
    ref.src = '/media/zz-blender.png?t=' + Date.now();
    await ref.decode();
    const grab = (img) => {
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const a = grab(shot);
    const b = grab(ref);
    let over8 = 0, over24 = 0, over64 = 0;
    let left = W, top = H, right = 0, bottom = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > 8) over8++;
      if (d > 24) {
        over24++;
        const px = (i / 4) % W;
        const py = Math.floor((i / 4) / W);
        if (px < left) left = px;
        if (px > right) right = px;
        if (py < top) top = py;
        if (py > bottom) bottom = py;
      }
      if (d > 64) over64++;
    }
    const total = W * H;
    window.__dbg = { W, H, total, over8, over24, over64, ratio: over24 / total,
      bbox: over24 ? [left, top, right, bottom] : null, fonts: p.fontBytes.size,
      meshDraws: p.meshStats.draws, meshBuilds: p.meshStats.builds };
  })();`;
  const r = await run(process.execPath, [path.join(HERE, 'dev.mjs'), '--project', PROJECT_H,
    `--capture=${path.join(WORK, 'preview-h.png')}`, `--at=${T}`, '--delay=2600', '--hold=2500', `--eval=${evalJs}`], { cwd: REPO });
  const line = String(r.out).split('\n').find((l) => l.includes('[capture]'));
  if (!line) throw new Error(`no preview capture for case H: ${r.err.slice(-1200)}`);
  const at = line.indexOf('"dbg":');
  const json = at < 0 ? '' : line.slice(at + 6);
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(`could not parse case H: ${line.slice(0, 400)}`);
  const dbg = JSON.parse(json.slice(0, end));
  console.log(`[parity] H text: ${dbg.W}x${dbg.H}  fonts=${dbg.fonts}  mesh draws=${dbg.meshDraws} builds=${dbg.meshBuilds}`);
  console.log(`[parity] H diff >8: ${dbg.over8} (${(dbg.over8 / dbg.total * 100).toFixed(2)}%)`
    + `  >24: ${dbg.over24} (${(dbg.ratio * 100).toFixed(2)}%)  >64: ${dbg.over64}`
    + `  bbox ${JSON.stringify(dbg.bbox)}`);
  if (!(dbg.fonts > 0)) {
    console.log('[parity] H FAIL — the preview never fetched a font, so this case compared the old text path');
    return false;
  }
  if (dbg.ratio > TEXT_ALLOWED) {
    console.log(`[parity] H FAIL — ${(dbg.ratio * 100).toFixed(2)}% of the pixels differ by more than ${TEXT_DIFF} (allowed ${TEXT_ALLOWED * 100}%)`);
    return false;
  }
  console.log(`[parity] H PASS — ${(dbg.ratio * 100).toFixed(2)}% of the pixels differ by more than ${TEXT_DIFF} (allowed ${TEXT_ALLOWED * 100}%)`);
  return true;
}

async function main() {
  const gridCases = only.filter((k) => k !== 'H');
  let failed = false;
  if (!gridCases.length) {
    await fs.rm(WORK, { recursive: true, force: true });
  } else {
    await build();
  }
  const a = gridCases.length ? await previewGrid() : [];
  const b = gridCases.length ? await blenderGrid() : [];
  const rows = [];
  let diff = 0;
  const misses = [];
  const counts = {};
  if (gridCases.length) {
    for (let j = 0; j < GRID[1]; j++) {
      let line = '';
      for (let i = 0; i < GRID[0]; i++) {
        const k = j * GRID[0] + i;
        const ca = classify(a[k]);
        const cb = classify(b[k]);
        counts[ca] = (counts[ca] || 0) + 1;
        if (ca !== cb) { diff++; line += '#'; misses.push(`(${i},${j}) preview ${a[k]} blender ${b[k]}`); } else line += SYMBOL[ca];
      }
      rows.push(line);
    }
    console.log(`[parity] cases ${gridCases.join(',')}  preview classes ${JSON.stringify(counts)}`);
    for (const r of rows) console.log(`[parity] ${r}`);
    if (diff > 0) {
      for (let j = 0; j < GRID[1]; j++) {
        const at = (g, i) => SYMBOL[classify(g[j * GRID[0] + i])];
        console.log(`[parity] preview ${Array.from({ length: GRID[0] }, (_, i) => at(a, i)).join('')}  blender ${Array.from({ length: GRID[0] }, (_, i) => at(b, i)).join('')}`);
      }
    }
    for (const m of misses) console.log(`[parity] differs ${m}`);
    console.log(`[parity] ${diff} of ${a.length} cells differ (allowed ${ALLOWED})`);
    if (diff > ALLOWED) {
      console.log('[parity] FAIL');
      failed = true;
    }
  }
  // Case H: text geometry, pixel diff at full resolution (§4.4 v4 / WP1.3).
  if (only.includes('H')) {
    if (!(await textCase())) failed = true;
  }
  if (failed) {
    if (!process.argv.includes('--keep')) console.log('[parity] work dir kept for inspection:', WORK);
    process.exit(1);
  }
  console.log('[parity] PASS');
  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => { console.error('[parity]', e.stack || e.message); process.exit(1); });
