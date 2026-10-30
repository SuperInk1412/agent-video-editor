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
// Case I (docs/DESIGN-BACKEND-V2.md §6.1 / §10.2 WP3.4) is the code layer: a p5
// source tilted in 3D with an opaque block in front of it. Both backends draw
// the pixels of the one rasteriser (§5) — the preview through `GET /api/raster`,
// Blender through `engine/raster-bake.js` and an image-sequence plane — so the
// case fails when the block does not occlude the raster in both, when no pixel
// of the code layer is drawn, or when more than `CODE_ALLOWED` of the compared
// pixels differ by more than `TEXT_DIFF` levels (the same pixel budget as case
// H) or more than `ALLOWED` of the 16×9 cells differ (the A–G standard).
//
// Case J (docs/DESIGN-BACKEND-V2.md §5.4 / §10.2 WP3.5) is the screen-effect case:
// a video, colour blocks and a line of text under every effect (bloom, CA, grain,
// vignette, scanline, non-default grade/contrast/saturation). Blender writes a
// 16-bit PNG and engine/blender.js applies the one shared GLSL
// (app/renderer/shaders/post.glsl) through pool.post; the preview compiles the
// same file. The case fails when more than 2 % of the pixels differ by more than
// TEXT_DIFF levels, and prints the per-channel means and a 16x9 grid.
//
// Case L (docs/DESIGN-BACKEND-V2.md §7.1 / §10.2 WP4.1) is the source compile
// case: the shared `html-title-card` fixture is compiled into native elements,
// applied to a throwaway project, and the preview frame is compared with the
// same page rendered by Chromium at 1920×1080 (whole frame + text area, 2 %
// budget), while three animation times are checked against the browser's own
// `getBoundingClientRect` (0.5 px). Blender is not involved; the case is skipped
// with a reason when Electron is missing.
//
//   node scripts/check-render-parity.mjs [--keep] [--only=A,B,C,D,E,F,G,H,I,J,L]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { ensureSpace } from '../core/space.js';
import { saveProject, loadProject } from '../engine/storage.js';
import { findBlender, renderStill } from '../engine/blender.js';
import { findElectron } from '../engine/render-workers/pool.js';
import { rotationFromDirRoll } from '../core/rotation.js';
import { evalElement } from '../core/evaluate.js';
import { createAsNode } from '../core/rotation-ops.js';
import { applySourceToSt, normalizeSnapshot, sourceMerge, sourceStyleValues } from '../core/source-eval.js';
import { applyCompiled, compileSource, fontContext } from '../application/source-service.js';
import { layoutText } from '../core/glyphs.js';

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
// Case I: the code-layer project, its frame and the pixel budget (WP3.4).
const PROJECT_I = path.join(WORK, 'project-i');
const SOURCE_I = 'src_parity_i';
const FRAME_I = 12;              // IR frame under T = 0.5 s at 24 fps
const T_I = FRAME_I / 24;
const CODE_ALLOWED = 0.02;       // 2 % of the compared pixels (WP3.4 acceptance)

const only = (process.argv.find((a) => a.startsWith('--only=')) || '--only=A,B,C,D,E,F,G,H,I,J,L').slice(7).split(',');

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
  const dbg = captureDbg(line);
  if (!dbg) throw new Error(`could not parse case H: ${line.slice(0, 400)}`);
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

// --------------------------------------------------------------- case I: code

const MANIFEST_I = {
  format: 'vdm.source/1',
  id: SOURCE_I,
  label: 'parity code layer',
  runtime: 'p5',
  entry: 'sketch.js',
  libs: { p5: '1.9.4' },
  deterministic: true,
  params: [
    { id: 'density', type: 'number', default: 0.5, range: [0, 1], keyable: 'frame' },
    { id: 'tint', type: 'color', default: '#ff8800', keyable: 'frame' },
  ],
};

// Opaque magenta field + one orange band that moves with the frame number: "did
// the code layer draw" is a colour test, and a wrong frame number (or the held
// frame of a static layer) is obvious by the band's height.
const SKETCH_I = `export default (p) => {
  p.setup = () => {
    const vdm = p.vdm;
    const [w, h] = vdm ? vdm.size : [1920, 1080];
    p.createCanvas(w, h);
    p.pixelDensity(1);
    p.noStroke();
  };
  p.draw = () => {
    const vdm = p.vdm;
    if (!vdm) return;
    const density = Math.max(0.05, Math.min(1, Number(vdm.param('density')) || 0.5));
    p.background(255, 0, 255);
    p.fill(vdm.param('tint') || '#ff8800');
    const bandH = p.height * 0.12 * (1 + density);
    p.rect(0, (vdm.frame % 5) * bandH, p.width, bandH);
  };
};
`;

/**
 * Case I's project: one tilted code layer (§6.1 "照常是一块 2D 节点平面") and one
 * opaque block floating 4 m in front of it, plus the source on disk — the
 * rasteriser reads `sources/<id>/`, never the project's registry.
 */
async function buildCodeLayer() {
  const sourceDir = path.join(PROJECT_I, 'sources', SOURCE_I);
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(path.join(PROJECT_I, 'media'), { recursive: true });
  await fs.writeFile(path.join(sourceDir, 'manifest.json'), `${JSON.stringify(MANIFEST_I, null, 2)}\n`);
  await fs.writeFile(path.join(sourceDir, 'sketch.js'), SKETCH_I);
  const p = normalizeProject(createProject({ title: 'parity code layer', background: '#000000', duration: 2 }));
  ensureSpace(p);
  applyOps(p, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    { op: 'sourceAdd', id: SOURCE_I, manifest: MANIFEST_I, files: { 'sketch.js': SKETCH_I } },
    { op: 'addElement', element: {
      id: 'el_code', name: 'code', type: 'code', start: 0, duration: 2, z: 2,
      node: { pivot: [-0.3, 4.2, -2], position: [0, 0, 0], rotation: [12, 24, 0], scale: [0.9, 0.9, 1] },
      code: { source: SOURCE_I, params: { density: 0.6, tint: '#ff8800' }, seed: 7, size: [960, 540], cache: 'live' },
    } },
    // opaque, and a colour of its own so "the block drew" and "the raster does
    // not show through it" are two separate measurements
    { op: 'addElement', element: {
      id: 'el_block', name: 'block', type: 'solid', start: 0, duration: 2, z: 4,
      node: { pivot: [-1.6, 4.4, 2], position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      style: { w: 700, h: 520, fill: '#00cc60' },
    } },
  ]);
  await saveProject(PROJECT_I, p, { by: 'check-render-parity' });
}

/**
 * Runs inside the editor (loaded from the throwaway project's `/media/`, so the
 * `--eval` command line stays short). Measures the preview frame against the
 * Blender still and pins every number the case reports in `window.__dbg`.
 */
const PROBE_I = `export async function run() {
  const out = { errors: [] };
  const W = 1920, H = 1080, T = ${T_I}, FRAME = ${FRAME_I};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const app = window.__vdm;
    const p = app.preview;
    app.pause();
    p.playing = false;
    app.setTime(T);
    p.canvas.width = W;
    p.canvas.height = H;
    p._rebuildTargets();
    // The code layer's PNG is fetched asynchronously: wait until THIS frame is
    // on screen (a stale fallback would compare the wrong picture).
    let ready = false;
    for (let i = 0; i < 160 && !ready; i++) {
      p.render(T);
      ready = (p.layers || []).some((L) => L.raster && !L.raster.stale && L.raster.frame === FRAME);
      if (!ready) await sleep(50);
    }
    out.ready = ready;
    out.stats = p.rasterStats ? p.rasterStats() : null;
    if (!ready) throw new Error('the code layer never showed frame ' + FRAME);
    const shot = new Image();
    shot.src = p.canvas.toDataURL('image/png');
    await shot.decode();
    const ref = new Image();
    ref.src = '/media/zz-blender-i.png?t=' + Date.now();
    await ref.decode();
    const grab = (img) => {
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const a = grab(shot); // preview
    const b = grab(ref);  // Blender still
    // "the code layer drew here" = the p5 field's own colours (magenta field,
    // orange band). The block is green, the background black.
    const rasterAt = (d, i) => {
      const r = d[i], g = d[i + 1], bl = d[i + 2];
      return (r > 200 && bl > 200 && g < 90) || (r > 200 && g > 90 && g < 200 && bl < 90);
    };
    const polys = p.layerPolygons ? p.layerPolygons() : [];
    const wall = polys.find((poly) => poly.id === 'el_block');
    if (!wall) throw new Error('the block did not project (no polygon)');
    const centre = (poly) => poly.reduce((acc, pt) => [acc[0] + pt[0] / poly.length, acc[1] + pt[1] / poly.length], [0, 0]);
    const shrink = (poly, k) => {
      const c = centre(poly);
      return poly.map((pt) => [c[0] + (pt[0] - c[0]) * k, c[1] + (pt[1] - c[1]) * k]);
    };
    const quad = shrink(wall.points, 0.86);
    const inPoly = (poly, x, y) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    };
    let rasterA = 0, rasterB = 0, over = 0, area = 0, areaOver = 0;
    let quadPixels = 0, quadOver = 0, quadRaster = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      const ra = rasterAt(a, i), rb = rasterAt(b, i);
      if (ra) rasterA += 1;
      if (rb) rasterB += 1;
      if (d > ${TEXT_DIFF}) over += 1;
      if (ra || rb) { area += 1; if (d > ${TEXT_DIFF}) areaOver += 1; }
      const px = (i / 4) % W, py = Math.floor((i / 4) / W);
      if (inPoly(quad, px, py)) {
        quadPixels += 1;
        if (d > ${TEXT_DIFF}) quadOver += 1;
        if (ra || rb) quadRaster += 1;
      }
    }
    const total = W * H;
    out.size = [W, H];
    out.frame = FRAME;
    out.time = T;
    out.rasterPixels = rasterA;
    out.rasterPixelsBlender = rasterB;
    out.frameDiff = { pixels: over, ratio: over / total };
    out.rasterDiff = { pixels: areaOver, ratio: area ? areaOver / area : 0, area };
    out.block = { pixels: quadPixels, diff: quadOver, diffRatio: quadPixels ? quadOver / quadPixels : 0, raster: quadRaster, share: quadPixels / total };
    // The 16x9 colour-class grid of cases A-G, with this case's palette.
    const palette = { magenta: [255, 0, 255], orange: [255, 136, 0], green: [0, 204, 96], white: [255, 255, 255], black: [0, 0, 0] };
    const names = Object.keys(palette);
    const classify = (d, i) => {
      let best = 'black', bd = Infinity;
      for (const name of names) {
        const c = palette[name];
        const dd = (d[i] - c[0]) ** 2 + (d[i + 1] - c[1]) ** 2 + (d[i + 2] - c[2]) ** 2;
        if (dd < bd) { bd = dd; best = name; }
      }
      return best;
    };
    let gridDiff = 0;
    const cells = [];
    for (let j = 0; j < 9; j++) {
      for (let i = 0; i < 16; i++) {
        const x = Math.floor(((i + 0.5) / 16) * W);
        const y = Math.floor(((j + 0.5) / 9) * H);
        const k = (y * W + x) * 4;
        const ca = classify(a, k), cb = classify(b, k);
        if (ca !== cb) { gridDiff += 1; cells.push(i + ',' + j + ' preview ' + ca + ' blender ' + cb); }
      }
    }
    out.grid = { diff: gridDiff, cells };
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  window.__dbg = out;
}
`;

// The app may still be booting when `--delay` runs out (a previous Electron
// window can be shutting down): wait for `window.__vdm`, then load the probe
// module from the project's `/media/` so the command line stays short.
const EVAL_I = `(async () => {
  for (let i = 0; i < 150 && !(window.__vdm && window.__vdm.preview); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(window.__vdm && window.__vdm.preview)) throw new Error('the editor never booted');
  const mod = await import('/media/parity-i.js?t=' + Date.now());
  await mod.run();
})().catch((e) => { window.__dbg = { errors: [String((e && e.stack) || e)] }; })`;

/** The `dbg` object of a `[capture] <png> {...} content ...` line. */
function captureDbg(line) {
  const at = line.indexOf('"dbg":');
  if (at < 0) return null;
  const json = line.slice(at + 6);
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
  if (end < 0) return null;
  try { return JSON.parse(json.slice(0, end)); } catch { return null; }
}

const pct = (value) => `${(Number(value) * 100).toFixed(2)}%`;

/**
 * Case I: the same frame through both backends, at the project's resolution,
 * with the code layer rendered by the one rasteriser on both sides.
 */
async function codeLayerCase() {
  const blender = await findBlender().catch(() => null);
  const electron = findElectron();
  if (!blender || !electron) {
    const missing = [!blender ? 'Blender' : null, !electron ? 'Electron' : null].filter(Boolean).join(' and ');
    console.log(`[parity] I SKIP — ${missing} not found. The code layer needs Blender for the still and`
      + ' Electron for the one rasteriser (§5); without them there is no picture to compare.');
    return true;
  }
  await buildCodeLayer();
  const logs = [];
  const still = await renderStill({
    dir: PROJECT_I, project: await loadProject(PROJECT_I), time: T_I, scale: 1, samples: 16,
    out: path.join(WORK, 'blender-i.png'), onLog: (line) => logs.push(String(line)),
  });
  for (const line of logs.filter((entry) => entry.includes('raster'))) {
    console.log(`[parity] I ${line.trim()}`);
  }
  // The page can only load what the project serves: the still and the probe
  // module both ride in under `/media/`.
  await fs.copyFile(still, path.join(PROJECT_I, 'media', 'zz-blender-i.png'));
  await fs.writeFile(path.join(PROJECT_I, 'media', 'parity-i.js'), PROBE_I);
  const r = await run(process.execPath, [path.join(HERE, 'dev.mjs'), '--project', PROJECT_I,
    `--capture=${path.join(WORK, 'preview-i.png')}`, `--at=${T_I}`, '--delay=2600', '--hold=3000', `--eval=${EVAL_I}`], { cwd: REPO });
  const line = String(r.out).split('\n').find((entry) => entry.includes('[capture]'));
  if (!line) throw new Error(`no preview capture for case I: ${r.err.slice(-1200)}`);
  const dbg = captureDbg(line);
  if (!dbg) throw new Error(`could not parse case I: ${line.slice(0, 400)}`);
  if (dbg.errors && dbg.errors.length) {
    console.log(`[parity] I FAIL — the probe threw: ${dbg.errors[0].split('\n')[0]}`);
    return false;
  }
  console.log(`[parity] I code layer frame ${dbg.frame} (t=${dbg.time}s) ${dbg.size[0]}x${dbg.size[1]}:`
    + ` raster pixels preview ${dbg.rasterPixels}, Blender ${dbg.rasterPixelsBlender}`);
  console.log(`[parity] I block quad ${dbg.block.pixels} px (${pct(dbg.block.share)} of the frame):`
    + ` diff ${dbg.block.diff} px (${pct(dbg.block.diffRatio)} of the quad),`
    + ` raster pixels inside ${dbg.block.raster}`);
  console.log(`[parity] I raster area ${dbg.rasterDiff.area} px:`
    + ` diff ${dbg.rasterDiff.pixels} px (${pct(dbg.rasterDiff.ratio)})`);
  console.log(`[parity] I whole frame: diff ${dbg.frameDiff.pixels} px (${pct(dbg.frameDiff.ratio)})`);
  console.log(`[parity] I grid: ${dbg.grid.diff} of 144 cells differ (allowed ${ALLOWED})`
    + (dbg.grid.cells.length ? ` — ${dbg.grid.cells.join('; ')}` : ''));
  const failures = [];
  if (!(dbg.rasterPixels > 0)) failures.push('the preview drew no code-layer pixel');
  if (!(dbg.rasterPixelsBlender > 0)) failures.push('Blender drew no code-layer pixel');
  if (!(dbg.block.raster === 0)) failures.push(`${dbg.block.raster} code-layer pixels show through the block`);
  if (dbg.block.diffRatio > CODE_ALLOWED) failures.push(`the block differs by ${pct(dbg.block.diffRatio)}`);
  if (dbg.rasterDiff.ratio > CODE_ALLOWED) failures.push(`the code layer differs by ${pct(dbg.rasterDiff.ratio)}`);
  if (dbg.frameDiff.ratio > CODE_ALLOWED) failures.push(`the frame differs by ${pct(dbg.frameDiff.ratio)}`);
  if (dbg.grid.diff > ALLOWED) failures.push(`${dbg.grid.diff} grid cells differ (allowed ${ALLOWED})`);
  if (failures.length) {
    console.log(`[parity] I FAIL — ${failures.join('; ')}`);
    return false;
  }
  console.log(`[parity] I PASS — the code layer is drawn and occluded by both backends`
    + ` (${pct(CODE_ALLOWED)} of the compared pixels allowed, ${TEXT_DIFF} levels)`);
  return true;
}

// Case J (docs/DESIGN-BACKEND-V2.md §5.4 / §10.2 WP3.5) is the screen-effect case:
// text + colour blocks + a video with every effect turned up (bloom 0.8, CA 0.5,
// grain 0.3, vignette 0.6, scanline 0.2, non-default grade/contrast/saturation).
// The preview frame and the Blender film frame are compared pixel by pixel; the
// case fails when more than `FX_ALLOWED` of the pixels differ by more than
// `TEXT_DIFF` levels. Grain has no RNG on either side: it is a hash of the frame
// time and the pixel position, so the same `t` gives the same pattern in both
// pictures (§5.4 "颗粒用固定种子" — the seed is the clock).
const PROJECT_J = path.join(WORK, 'project-j');
const FX_J = {
  bloom: 0.8, ca: 0.5, grain: 0.3, vignette: 0.6, scanline: 0.2,
  grade: 0.35, contrast: 0.2, saturation: 0.75,
};
const FX_ALLOWED = 0.02;   // 2 % of the frame (WP3.5 acceptance)

/**
 * Case J's project: a full-frame-ish video, two colour blocks and a line of
 * text, all under every screen effect. The video is a flat colour on purpose —
 * the case is about the effects, not about decoding a moving picture, and a
 * solid frame cannot disagree about *which* frame was decoded.
 */
async function buildFxCase() {
  await fs.mkdir(path.join(PROJECT_J, 'media'), { recursive: true });
  const clip = path.join(PROJECT_J, 'media', 'fx-clip.mp4');
  const r = await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=0x2a4a8a:s=1920x1080:r=24', '-t', '2', '-pix_fmt', 'yuv420p', clip]);
  if (r.code !== 0) throw new Error(`ffmpeg clip failed: ${r.err.slice(-400)}`);
  const p = normalizeProject(createProject({ title: 'parity fx', background: '#05070d', duration: 2 }));
  ensureSpace(p);
  applyOps(p, [
    { op: 'setFx', fx: FX_J },
    { op: 'addElement', element: {
      id: 'el_fx_video', name: 'video', type: 'video', src: 'media/fx-clip.mp4',
      start: 0, duration: 2, z: 1,
      transform: { x: 0, y: 0, scale: 1 }, style: { fit: 'stretch', w: 1280, h: 720 },
    } },
    { op: 'addElement', element: {
      id: 'el_fx_warm', name: 'warm', type: 'solid', start: 0, duration: 2, z: 2,
      transform: { x: -560, y: 120 }, style: { w: 520, h: 320, fill: '#e04a2a' },
    } },
    { op: 'addElement', element: {
      id: 'el_fx_cool', name: 'cool', type: 'solid', start: 0, duration: 2, z: 3,
      transform: { x: 560, y: 180 }, style: { w: 380, h: 380, fill: '#20c060' },
    } },
    { op: 'addElement', element: {
      id: 'tx_fx', name: 'title', type: 'text', start: 0, duration: 2, z: 4,
      transform: { x: 0, y: -300 },
      style: { text: 'SCREEN FX 效果', font: 'Microsoft YaHei', size: 130, color: '#ffffff',
        align: 'center', lineHeight: 1.15, letterSpacing: 3 },
    } },
  ]);
  await saveProject(PROJECT_J, p, { by: 'check-render-parity' });
}

/**
 * Runs inside the editor: render one frame at `T`, diff it against the Blender
 * film frame (`/media/zz-blender-j.png`) and pin every number in `window.__dbg`.
 */
const PROBE_J = `export async function run() {
  const out = { errors: [] };
  const W = 1920, H = 1080, T = ${T};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const app = window.__vdm;
    const p = app.preview;
    app.pause();
    p.playing = false;
    app.setTime(T);
    p.canvas.width = W;
    p.canvas.height = H;
    p._rebuildTargets();
    await p.whenFontsReady();
    // media (the video element) and the text meshes arrive asynchronously
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      const assets = Array.from((p.assets || new Map()).values());
      ready = assets.length > 0 && assets.every((a) => a.ready);
      if (!ready) await sleep(40);
    }
    out.assets = Array.from((p.assets || new Map()).values()).map((a) => a.kind + ':' + a.ready);
    for (let i = 0; i < 3; i++) { p.render(T); await sleep(60); }
    const shot = new Image();
    shot.src = p.canvas.toDataURL('image/png');
    await shot.decode();
    const ref = new Image();
    ref.src = '/media/zz-blender-j.png?t=' + Date.now();
    await ref.decode();
    const grab = (img) => {
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const a = grab(shot);   // preview
    const b = grab(ref);    // Blender film frame (post applied by pool.post)
    const total = W * H;
    let over8 = 0, over24 = 0, over64 = 0, maxDiff = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    // 16x9 grid: mean absolute difference per cell, and how many of its pixels
    // are past the budget
    const GW = 16, GH = 9;
    const cellSum = new Float64Array(GW * GH);
    const cellCount = new Float64Array(GW * GH);
    const cellOver = new Float64Array(GW * GH);
    for (let i = 0; i < a.length; i += 4) {
      const dr = Math.abs(a[i] - b[i]);
      const dg = Math.abs(a[i + 1] - b[i + 1]);
      const db = Math.abs(a[i + 2] - b[i + 2]);
      const d = Math.max(dr, dg, db);
      sumR += dr; sumG += dg; sumB += db;
      if (d > maxDiff) maxDiff = d;
      if (d > 8) over8++;
      if (d > ${TEXT_DIFF}) over24++;
      if (d > 64) over64++;
      const px = (i / 4) % W, py = Math.floor((i / 4) / W);
      const cell = Math.min(GH - 1, Math.floor(py / H * GH)) * GW + Math.min(GW - 1, Math.floor(px / W * GW));
      cellSum[cell] += d;
      cellCount[cell] += 1;
      if (d > ${TEXT_DIFF}) cellOver[cell] += 1;
    }
    let cellMax = 0, cellMeanSum = 0, cellsOver = 0;
    const worst = [];
    for (let c = 0; c < cellSum.length; c++) {
      const mean = cellSum[c] / Math.max(1, cellCount[c]);
      cellMeanSum += mean;
      if (mean > cellMax) cellMax = mean;
      if (cellOver[c] > 0) cellsOver++;
      worst.push([c, Math.round(mean * 10) / 10, Math.round(cellOver[c] / Math.max(1, cellCount[c]) * 1000) / 10]);
    }
    worst.sort((x, y) => y[1] - x[1]);
    out.size = [W, H];
    out.time = T;
    out.assetsReady = out.assets.length > 0 && out.assets.every((s) => s.endsWith(':true'));
    out.frame = {
      pixels: total,
      over8, over24, over64,
      ratio: over24 / total,
      maxDiff,
      mean: { r: sumR / total, g: sumG / total, b: sumB / total },
    };
    out.grid = { cells: cellSum.length, maxMean: cellMax, meanMean: cellMeanSum / cellSum.length, cellsOver, worst: worst.slice(0, 6) };
    // where the difference lives: the video plane (a yuv -> rgb conversion on
    // each side), the flat background strip, and the rest of the frame
    const rects = {
      video: [320, 180, 1600, 900],
      background: [0, 0, 320, 1080],
    };
    const regions = {};
    for (const [name, [x0, y0, x1, y1]] of Object.entries(rects)) {
      let sum = 0, n = 0, over = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          sum += d; n += 1;
          if (d > ${TEXT_DIFF}) over += 1;
        }
      }
      regions[name] = { mean: sum / Math.max(1, n), over: over / Math.max(1, n) };
    }
    out.regions = regions;
    // a couple of probe pixels: the video plane and the flat background
    const pick = (x, y) => {
      const i = (y * W + x) * 4;
      return { preview: [a[i], a[i + 1], a[i + 2]], film: [b[i], b[i + 1], b[i + 2]] };
    };
    out.samples = { video: pick(960, 540), background: pick(120, 540) };
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  }
  window.__dbg = out;
}
`;

const EVAL_J = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 150 && !(window.__vdm && window.__vdm.preview); i++) await sleep(100);
  if (!(window.__vdm && window.__vdm.preview)) throw new Error('the editor never booted');
  const mod = await import('/media/parity-j.js?t=' + Date.now());
  await mod.run();
})().catch((e) => { window.__dbg = { errors: [String((e && e.stack) || e)] }; })`;

/**
 * Case J: the same frame through both backends with every screen effect on.
 * Blender writes a 16-bit PNG, `engine/blender.js` applies the one shared
 * implementation through `pool.post`, and the preview draws the same shaders in
 * its canvas — so the two pictures should only differ where the two renderers
 * disagree about the underlying frame (text anti-aliasing), not about an effect.
 */
async function fxCase() {
  const blender = await findBlender().catch(() => null);
  const electron = findElectron();
  if (!blender || !electron) {
    const missing = [!blender ? 'Blender' : null, !electron ? 'Electron' : null].filter(Boolean).join(' and ');
    console.log(`[parity] J SKIP — ${missing} not found. The export applies the shared GLSL through`
      + ' the render pool (§5.4), so the case needs both Blender and Electron.');
    return true;
  }
  await buildFxCase();
  const logs = [];
  const still = await renderStill({
    dir: PROJECT_J, project: await loadProject(PROJECT_J), time: T, scale: 1, samples: 16,
    out: path.join(WORK, 'blender-j.png'), onLog: (line) => logs.push(String(line)),
  });
  const postLine = logs.find((line) => /(^|\s)post\b/.test(line));
  if (postLine) console.log(`[parity] J ${postLine.trim()}`);
  await fs.copyFile(still, path.join(PROJECT_J, 'media', 'zz-blender-j.png'));
  await fs.writeFile(path.join(PROJECT_J, 'media', 'parity-j.js'), PROBE_J);
  // The preview runs on the same software rasteriser the render pool forces
  // (§13: pixels must not depend on the installed GPU). Grain is a chaotic
  // hash of the pixel position and the frame time: two different GL
  // implementations disagree on its last bit and the whole pattern diverges,
  // which would measure the driver, not the shared implementation.
  const r = await run(process.execPath, [path.join(HERE, 'dev.mjs'), '--project', PROJECT_J, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu',
    `--capture=${path.join(WORK, 'preview-j.png')}`, `--at=${T}`, '--delay=2600', '--hold=3500', `--eval=${EVAL_J}`], { cwd: REPO });
  const line = String(r.out).split('\n').find((entry) => entry.includes('[capture]'));
  if (!line) throw new Error(`no preview capture for case J: ${r.err.slice(-1200)}`);
  const dbg = captureDbg(line);
  if (!dbg) throw new Error(`could not parse case J: ${line.slice(0, 400)}`);
  if (dbg.errors && dbg.errors.length) {
    console.log(`[parity] J FAIL — the probe threw: ${dbg.errors[0].split('\n')[0]}`);
    return false;
  }
  console.log(`[parity] J screen effects ${dbg.size[0]}x${dbg.size[1]} at t=${dbg.time}s:`
    + ` bloom ${FX_J.bloom} ca ${FX_J.ca} grain ${FX_J.grain} vignette ${FX_J.vignette}`
    + ` scanline ${FX_J.scanline} grade ${FX_J.grade} contrast ${FX_J.contrast} saturation ${FX_J.saturation}`);
  console.log(`[parity] J mean |diff| per channel: R ${dbg.frame.mean.r.toFixed(2)}`
    + ` G ${dbg.frame.mean.g.toFixed(2)} B ${dbg.frame.mean.b.toFixed(2)}`
    + `  max ${dbg.frame.maxDiff}`);
  console.log(`[parity] J whole frame: >8 ${dbg.frame.over8} (${pct(dbg.frame.over8 / dbg.frame.pixels)})`
    + `  >${TEXT_DIFF} ${dbg.frame.over24} (${pct(dbg.frame.ratio)})  >64 ${dbg.frame.over64}`);
  console.log(`[parity] J grid ${dbg.grid.cells} cells: mean ${dbg.grid.meanMean.toFixed(2)},`
    + ` worst ${dbg.grid.maxMean.toFixed(2)}, ${dbg.grid.cellsOver} cells with a pixel over ${TEXT_DIFF}`
    + ` — worst cells (cell, mean, %over): ${dbg.grid.worst.map((w) => `${w[0]}/${w[1]}/${w[2]}%`).join(' ')}`);
  if (dbg.regions) {
    const parts = Object.entries(dbg.regions).map(([name, r]) =>
      `${name} mean ${r.mean.toFixed(2)} (${pct(r.over)} over ${TEXT_DIFF})`);
    console.log(`[parity] J regions: ${parts.join(', ')}`);
    const sample = dbg.samples;
    console.log(`[parity] J samples: video preview ${sample.video.preview} film ${sample.video.film}`
      + `; background preview ${sample.background.preview} film ${sample.background.film}`);
  }
  const failures = [];
  if (!dbg.assetsReady) failures.push(`the preview never loaded its media (${JSON.stringify(dbg.assets)})`);
  if (!(dbg.frame.ratio <= FX_ALLOWED)) failures.push(`the frame differs by ${pct(dbg.frame.ratio)} (allowed ${pct(FX_ALLOWED)})`);
  if (!postLine) failures.push('the export log has no post line — the effects never ran on the film');
  if (failures.length) {
    console.log(`[parity] J FAIL — ${failures.join('; ')}`);
    return false;
  }
  console.log(`[parity] J PASS — ${pct(dbg.frame.ratio)} of the pixels differ by more than ${TEXT_DIFF}`
    + ` (allowed ${pct(FX_ALLOWED)}), one GLSL implementation on both sides`);
  return true;
}

// ---------------------------------------------------------------- case L: HTML
//
// Case L (docs/DESIGN-BACKEND-V2.md §7.1 / §10.2 WP4.1) is the source compile
// case: the shared `html-title-card` fixture is compiled by
// application/source-service.js into native elements, applied to a throwaway
// project, and the preview frame is compared with the same page rendered
// natively by Chromium at 1920×1080.
//
//   * the whole frame and the text area are compared pixel by pixel: channel
//     levels above PAGE_DIFF count as different, PAGE_ALLOWED of them is the
//     budget WP4.1 states;
//   * the CSS animations are checked at three times: the compiled element's
//     position must follow the browser's own `getBoundingClientRect` within
//     POSITION_EPS_PX.
//
// The preview does not read `.vdm/sources/` yet (that wiring is WP4.3/4.6), so
// the compared frame bakes the snapshot's value at T into the elements with
// core/source-eval.js::sourceMerge — the function the IR evaluates with
// (§7.8.2). The animation check merges into the *unbaked* baseline copy, so the
// tracks are measured rather than the bake.
//
// Electron is required (both pictures are Chromium); Blender is not involved,
// and the case is skipped with a reason when Electron is missing.

const PROJECT_L = path.join(WORK, 'project-l');
const SOURCE_L = 'html-title-card';
const FIXTURE_L = path.join(REPO, 'tests', 'fixtures', 'sources', SOURCE_L);
const T_L = 2;                       // all four animations are done by 1.55 s
const FRAME_L = Math.round(T_L * 24);
const AT_L = [0.35, 0.9, 2];         // animation samples for the position check
const PAGE_DIFF = 24;                // channel levels ignored as anti-aliasing
const PAGE_ALLOWED = 0.02;           // 2 % of the frame (WP4.1 acceptance)
const POSITION_EPS_PX = 0.5;         // §7.1 / WP4.1 acceptance

/** The fixture as a source registry record: `{ manifest, files }`. */
async function fixtureSourceL() {
  const files = {};
  let manifest = null;
  for (const name of await fs.readdir(FIXTURE_L)) {
    const text = await fs.readFile(path.join(FIXTURE_L, name), 'utf8');
    if (name === 'manifest.json') manifest = JSON.parse(text);
    else files[name] = text;
  }
  return { manifest, files };
}

/** The Electron main script for case L (written into the work dir, not the repo). */
const NATIVE_CAPTURE_CJS = `const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [page, outPng, outJson] = process.argv.slice(-3);
const probePath = path.join(__dirname, 'probe-l.js');
app.commandLine.appendSwitch('disable-lcd-text');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1920, height: 1080, useContentSize: true, show: false, frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false, nodeIntegration: false },
  });
  try {
    await win.loadFile(page);
    for (let i = 0; i < 8; i++) {
      const size = await win.webContents.executeJavaScript('[window.innerWidth, window.innerHeight]');
      if (size[0] === 1920 && size[1] === 1080) break;
      win.setContentSize(1920, 1080);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await win.webContents.executeJavaScript('window.__VDM_CASE = ' + (process.env.VDM_CASE || '{}'));
    const result = await win.webContents.executeJavaScript(fs.readFileSync(probePath, 'utf8'));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(outPng, image.toPNG());
    fs.writeFileSync(outJson, JSON.stringify(result));
    console.log('[native] ok ' + JSON.stringify({ viewport: result.viewport, animations: result.animationCount }));
  } catch (e) {
    console.error('[native] failed', e && e.stack);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
`;

/**
 * The probe executed in the page: pin the compiler's font per node (the file's
 * font chain would resolve to something else in the browser), pause every CSS
 * animation at each sample time, then read the geometry with
 * `getBoundingClientRect` (a Range for the inline text box).
 */
const PROBE_L = `(async () => {
  const CASE = window.__VDM_CASE || {};
  const PIN = CASE.pin || {};
  const TIMES = CASE.times || [];
  const CAPTURE = CASE.time;
  const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  for (const [id, spec] of Object.entries(PIN)) {
    const el = document.querySelector('[data-vdm-id="' + id + '"]');
    if (!el) continue;
    if (spec.family) el.style.fontFamily = '"' + spec.family + '"';
    if (spec.weight !== undefined) el.style.fontWeight = String(spec.weight);
    el.style.fontSynthesis = 'none';
  }
  await frames();
  const read = () => Object.keys(PIN).map((id) => {
    const el = document.querySelector('[data-vdm-id="' + id + '"]');
    if (!el) return { id, missing: true };
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      id,
      range: [rect.left, rect.top, rect.width, rect.height],
      box: [box.left, box.top, box.width, box.height],
      fontSize: parseFloat(style.fontSize),
      lineHeight: style.lineHeight === 'normal' ? null : parseFloat(style.lineHeight),
      letterSpacing: style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing),
      opacity: parseFloat(style.opacity),
      transform: style.transform,
      color: style.color,
      font: style.fontFamily,
      text: el.textContent,
    };
  });
  const animations = document.getAnimations();
  const out = { viewport: [window.innerWidth, window.innerHeight], samples: [], animationCount: animations.length };
  for (const t of TIMES) {
    for (const animation of animations) { animation.pause(); animation.currentTime = t * 1000; }
    await frames();
    out.samples.push({ t, nodes: read() });
  }
  for (const animation of animations) { animation.pause(); animation.currentTime = CAPTURE * 1000; }
  await frames();
  out.capture = { t: CAPTURE, nodes: read() };
  return out;
})()`;

/**
 * Compile + apply the fixture into a throwaway project, then bake the snapshot's
 * `t = T_L` value into the elements (sourceMerge, §7.8.2). The unbaked baseline
 * is kept for the animation check.
 */
async function buildHtmlProject() {
  await fs.rm(PROJECT_L, { recursive: true, force: true });
  await fs.mkdir(path.join(PROJECT_L, 'media'), { recursive: true });
  const { manifest, files } = await fixtureSourceL();
  const fonts = await fontContext(PROJECT_L);
  const p = normalizeProject(createProject({
    title: 'parity html', width: 1920, height: 1080, duration: T_L + 1, background: '#06070c',
  }));
  ensureSpace(p);
  applyOps(p, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    { op: 'sourceAdd', id: SOURCE_L, manifest, files },
  ]);
  const compiled = await compileSource({ project: p, sourceId: SOURCE_L, root: PROJECT_L });
  const applied = await applyCompiled({ project: p, sourceId: SOURCE_L, root: PROJECT_L });
  applyOps(p, [applied.op]);
  const snapshot = normalizeSnapshot(compiled.snapshot);
  // The browser must use the family the compiler picked (§7.1: one concrete
  // family, not the page's chain resolved by a different font config).
  const pin = {};
  for (const element of p.elements) {
    if (element.type !== 'text' || !element.source) continue;
    pin[element.source.node] = { family: element.style.font, weight: element.style.weight };
  }
  const baseline = JSON.parse(JSON.stringify(p.elements));
  // Bake the source value at T_L (see the header comment).
  for (const element of p.elements) {
    if (!element.source || element.source.id !== SOURCE_L) continue;
    const st = evalElement(element, T_L, p.meta);
    const merge = sourceMerge(element, snapshot, T_L, st);
    if (!merge) continue;
    applySourceToSt(st, merge.values);
    element.transform = { x: st.x, y: st.y, scale: st.scale, rotation: st.rotation, opacity: st.opacity };
    element.style = {
      ...element.style,
      ...sourceStyleValues(merge.values),
      text: st.text, size: st.size, color: st.color,
    };
    // The load-time rotation migration would rebuild this anyway; doing it here
    // keeps the baked picture the one the preview draws.
    if (element.node !== undefined) delete element.node;
    createAsNode(p.meta, element);
  }
  await saveProject(PROJECT_L, p, { by: 'check-render-parity' });
  // The text quad the IR typesets (§4.4 v4): the position check needs it to turn
  // a centre into the browser's inline-box left edge.
  const quadOf = (element) => {
    if (!element) return [0, 0];
    const font = fonts.fonts[String(element.style.font || '').toLowerCase()] || Object.values(fonts.fonts)[0];
    if (!font) return [0, 0];
    const layout = layoutText([font], String(element.style.text ?? ''), {
      fontSize: element.style.size,
      lineHeight: element.style.lineHeight,
      letterSpacing: element.style.letterSpacing,
      align: element.style.align,
    });
    return [layout.width, layout.height];
  };
  const boundTo = (list, nodeId) => list.find((element) => element.source?.id === SOURCE_L && element.source.node === nodeId) || null;
  return {
    project: p, snapshot, pin, quadOf,
    elementOf: (nodeId) => boundTo(p.elements, nodeId),
    baselineOf: (nodeId) => boundTo(baseline, nodeId),
  };
}

/** Render the fixture page in Chromium: the reference picture + its geometry. */
async function captureNativeL({ pinJson, times, outPng, outJson }) {
  const electron = findElectron();
  if (!electron) throw Object.assign(new Error('Electron not found'), { code: 'DEPENDENCY_MISSING' });
  const scriptPath = path.join(WORK, 'native-capture.cjs');
  await fs.writeFile(scriptPath, NATIVE_CAPTURE_CJS);
  await fs.writeFile(path.join(WORK, 'probe-l.js'), PROBE_L);
  const env = { ...process.env, VDM_CASE: JSON.stringify({ pin: pinJson, times, time: T_L }) };
  const r = await run(electron, [scriptPath, path.join(FIXTURE_L, 'index.html'), outPng, outJson], { cwd: REPO, env });
  if (r.code !== 0) throw new Error(`native capture failed: ${String(r.err).slice(-800)}`);
  const line = String(r.out).split('\n').find((entry) => entry.includes('[native] ok'));
  if (!line) throw new Error(`native capture printed no marker: ${String(r.out).slice(-400)} ${String(r.err).slice(-400)}`);
  return JSON.parse(await fs.readFile(outJson, 'utf8'));
}

/** The compiled value of one bound element at `t` (the §7.8.2 merge). */
function bakedStateAt(element, snapshot, meta, t) {
  const st = evalElement(element, t, meta);
  const merge = sourceMerge(element, snapshot, t, st);
  if (merge) applySourceToSt(st, merge.values);
  return st;
}

/**
 * Case L: compiled HTML vs the browser's own frame. Skipped, with a reason, when
 * Electron is missing.
 */
async function htmlCase() {
  const electron = findElectron();
  if (!electron) {
    console.log('[parity] L SKIP — Electron not found. Case L renders the same page natively in'
      + ' Chromium and compares it with the preview (WP4.1 acceptance); Blender is not involved.');
    return true;
  }
  const built = await buildHtmlProject();
  const pagePng = path.join(WORK, 'page-l.png');
  const nativeJson = path.join(WORK, 'page-l.json');
  const native = await captureNativeL({
    pinJson: built.pin, times: AT_L, outPng: pagePng, outJson: nativeJson,
  });
  if (native.viewport[0] !== 1920 || native.viewport[1] !== 1080) {
    console.log(`[parity] L FAIL — the browser viewport is ${native.viewport.join('×')}, the project is 1920×1080`);
    return false;
  }
  // The reference picture rides in under the project's /media/ (an --eval string
  // cannot carry a 1920×1080 PNG on a Windows command line).
  await fs.copyFile(pagePng, path.join(PROJECT_L, 'media', 'zz-page-l.png'));

  // Text regions for the per-area number: the browser's own inline boxes.
  const regions = native.capture.nodes
    .filter((node) => !node.missing)
    .map((node) => node.range)
    .filter((rect) => rect[2] > 0 && rect[3] > 0)
    .map(([x, y, w, h]) => [x - 2, y - 2, w + 4, h + 4]);
  const probe = `export async function run() {
  const app = window.__vdm;
  const p = app.preview;
  const W = 1920, H = 1080;
  const REGIONS = ${JSON.stringify(regions)};
  app.pause();
  p.playing = false;
  app.setTime(${T_L});
  p.canvas.width = W;
  p.canvas.height = H;
  p._rebuildTargets();
  await p.whenFontsReady();
  // The text mesh path needs the font bytes; a canvas fallback would compare a
  // different rasteriser (case H makes the same check).
  for (let i = 0; i < 100 && p.fontBytes.size === 0 && p.fontPending.size > 0; i++) await new Promise((r) => setTimeout(r, 50));
  p.render(${T_L});
  // Read the frame back the way cases A–G sample the preview: the WebGL
  // framebuffer, row 0 = bottom.
  const gl = p.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const a = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, a);
  const ref = new Image();
  ref.src = '/media/zz-page-l.png?t=' + Date.now();
  await ref.decode();
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(ref, 0, 0, W, H);
  const b = ctx.getImageData(0, 0, W, H).data;
  const at = (x, y) => ((H - 1 - y) * W + x) * 4; // framebuffer rows are bottom-up
  const inRegions = (x, y) => REGIONS.some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
  let over = 0, over8 = 0, textPixels = 0, textOver = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ia = at(x, y);
      const ib = (y * W + x) * 4;
      const d = Math.max(Math.abs(a[ia] - b[ib]), Math.abs(a[ia + 1] - b[ib + 1]), Math.abs(a[ia + 2] - b[ib + 2]));
      if (d > 8) over8 += 1;
      const inside = inRegions(x, y);
      if (inside) textPixels += 1;
      if (d > ${PAGE_DIFF}) {
        over += 1;
        if (inside) textOver += 1;
      }
    }
  }
  const sample = (x, y) => {
    const ia = at(x, y);
    const ib = (y * W + x) * 4;
    return [[a[ia], a[ia + 1], a[ia + 2]], [b[ib], b[ib + 1], b[ib + 2]]];
  };
  window.__dbg = {
    W, H, total: W * H, over, over8, ratio: over / (W * H),
    text: { pixels: textPixels, over: textOver, ratio: textPixels ? textOver / textPixels : 0 },
    fonts: p.fontBytes.size, fontFailed: [...p.fontFailed],
    meshDraws: p.meshStats.draws, meshBuilds: p.meshStats.builds,
    layers: (p.layers || []).length,
    samples: [sample(0, 0), sample(W >> 1, H >> 1), sample(W - 1, H - 1)],
  };
}`;
  await fs.writeFile(path.join(PROJECT_L, 'media', 'parity-l.js'), probe);
  const evalJs = `(async () => {
  for (let i = 0; i < 150 && !(window.__vdm && window.__vdm.preview); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(window.__vdm && window.__vdm.preview)) throw new Error('the editor never booted');
  const mod = await import('/media/parity-l.js?t=' + Date.now());
  await mod.run();
})().catch((e) => { window.__dbg = { errors: [String((e && e.stack) || e)] }; })`;
  const r = await run(process.execPath, [path.join(HERE, 'dev.mjs'), '--project', PROJECT_L,
    `--capture=${path.join(WORK, 'preview-l.png')}`, `--at=${T_L}`, '--delay=2600', '--hold=2500', `--eval=${evalJs}`], { cwd: REPO });
  const line = String(r.out).split('\n').find((entry) => entry.includes('[capture]'));
  if (!line) throw new Error(`no preview capture for case L: ${String(r.err).slice(-1200)}`);
  const dbg = captureDbg(line);
  if (!dbg) throw new Error(`could not parse case L: ${line.slice(0, 400)}`);
  if (dbg.errors && dbg.errors.length) {
    console.log(`[parity] L FAIL — the probe threw: ${dbg.errors[0].split('\n')[0]}`);
    return false;
  }

  // ---- CSS animation: compiled position vs getBoundingClientRect ----
  const failures = [];
  const rows = [];
  let worst = 0;
  for (const nodeId of Object.keys(built.pin)) {
    const element = built.elementOf(nodeId);
    const baseline = built.baselineOf(nodeId);
    if (!element || !baseline) continue;
    const [width] = built.quadOf(element);
    for (const sample of native.samples) {
      const browser = sample.nodes.find((entry) => entry.id === nodeId);
      if (!browser || browser.missing) continue;
      const st = bakedStateAt(baseline, built.snapshot, built.project.meta, sample.t);
      // §7.8.1: `transform.x` is the element centre in project pixels (y down);
      // the compiled text quad's left edge is the browser's inline-box start.
      const left = st.x + 1920 / 2 - width / 2;
      const centreY = st.y + 1080 / 2;
      const boxCentreY = browser.box[1] + browser.box[3] / 2;
      const dx = left - browser.range[0];
      const dy = centreY - boxCentreY;
      const error = Math.max(Math.abs(dx), Math.abs(dy));
      worst = Math.max(worst, error);
      rows.push([nodeId, sample.t, dx, dy]);
      if (error > POSITION_EPS_PX) failures.push(`${nodeId}@${sample.t}s 位置差 ${error.toFixed(3)} px`);
    }
  }

  console.log(`[parity] L html-title-card ${native.viewport.join('×')}, frame ${FRAME_L} (t=${T_L}s):`
    + ` frame diff ${dbg.over} px (${pct(dbg.ratio)})  [>8: ${dbg.over8}, >${PAGE_DIFF}: ${dbg.over}]`);
  console.log(`[parity] L text area ${dbg.text.pixels} px: diff ${dbg.text.over} px (${pct(dbg.text.ratio)})`);
  console.log(`[parity] L fonts: ${dbg.fonts} loaded${dbg.fontFailed.length ? `, failed ${JSON.stringify(dbg.fontFailed)}` : ''}`
    + `  mesh draws ${dbg.meshDraws} builds ${dbg.meshBuilds}  layers ${dbg.layers}`);
  console.log(`[parity] L animation: ${rows.length} samples, worst |Δ| ${worst.toFixed(3)} px (allowed ${POSITION_EPS_PX})`);
  for (const [id, t, dx, dy] of rows) console.log(`[parity] L   ${id} @${t}s  Δx ${dx.toFixed(3)} px  Δy ${dy.toFixed(3)} px`);
  if (!(dbg.fonts > 0)) failures.push('the preview never fetched a font, so the text mesh path was not used');
  if (dbg.ratio > PAGE_ALLOWED) failures.push(`full frame differs by ${pct(dbg.ratio)} > ${pct(PAGE_ALLOWED)}`);
  if (failures.length) {
    console.log(`[parity] L pixel samples (preview | browser): ${JSON.stringify(dbg.samples)}`);
    console.log(`[parity] L FAIL — ${failures.join('; ')}`);
    return false;
  }
  console.log(`[parity] L PASS — frame diff ${pct(dbg.ratio)} (allowed ${pct(PAGE_ALLOWED)}),`
    + ` text area ${pct(dbg.text.ratio)}, position error ≤ ${POSITION_EPS_PX} px`);
  return true;
}

async function main() {
  const gridCases = only.filter((k) => !['H', 'I', 'J', 'L'].includes(k));
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
  // Case I: a code layer, drawn from the one rasteriser by both backends
  // (§6.1 / §10.2 WP3.4). Skipped, with a reason, when Blender or Electron is
  // missing — the case needs both.
  if (only.includes('I')) {
    if (!(await codeLayerCase())) failed = true;
  }
  // Case J: every screen effect on, preview vs the exported film (§5.4 / WP3.5).
  if (only.includes('J')) {
    if (!(await fxCase())) failed = true;
  }
  // Case L: compiled HTML vs the browser's own frame (§7.1 / WP4.1).
  if (only.includes('L')) {
    if (!(await htmlCase())) failed = true;
  }
  if (failed) {
    if (!process.argv.includes('--keep')) console.log('[parity] work dir kept for inspection:', WORK);
    process.exit(1);
  }
  console.log('[parity] PASS');
  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
}

main().catch((e) => { console.error('[parity]', e.stack || e.message); process.exit(1); });
