// Pixel coverage: how many pixels does one element actually contribute?
// (docs/DESIGN-BACKEND-V2.md WP2.1 follow-up, B review item 1.)
//
//   node scripts/inspect-pixels.mjs --project <dir> --element s2_w4 \
//        --frames 142:158 --camera cam_8 [--json]
//
// Renders each frame twice through the real preview (offscreen Electron) — once
// with the element, once without — and reports the pixel difference. The
// in-page half lives in app/renderer/js/inspect-probe.js; this file only boots
// the app, parses the `[capture]` line and prints the numbers.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '../engine/storage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const elementId = argOf('element');
if (!elementId) {
  console.error('usage: node scripts/inspect-pixels.mjs --element <id> [--frames f0:f1] [--camera <id>] [--project dir] [--json]');
  process.exit(1);
}
const projectArg = argOf('project');
const dir = projectArg ? path.resolve(projectArg) : await findProjectRoot(process.cwd());
if (!dir) {
  console.error('[inspect-pixels] no project.vdm.json here (pass --project)');
  process.exit(1);
}
const [f0, f1] = (argOf('frames', '0:0') || '0:0').split(':').map((v) => Math.max(0, Math.round(Number(v) || 0)));
const frames = [];
for (let f = f0; f <= Math.max(f0, f1); f++) frames.push(f);
const camera = argOf('camera');

const evalJs = `(async () => {
  const m = await import('/app/renderer/js/inspect-probe.js');
  window.__dbg = await m.pixelCoverage(${JSON.stringify({ elementId, frames, camera })});
})()`;

const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { err += String(d); });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, out, err }));
});

const result = await run(process.execPath, [
  path.join(HERE, 'dev.mjs'), '--project', dir,
  `--capture=${path.join(dir, '.vdm', 'inspect-pixels.png')}`,
  `--eval=${evalJs}`, '--delay=4500',
]);

const line = (result.out || '').split('\n').find((l) => l.includes('[capture]'));
if (!line) {
  console.error('[inspect-pixels] no capture output');
  console.error((result.err || result.out || '').slice(-1500));
  process.exit(1);
}
const start = line.indexOf('{');
let depth = 0, inStr = false, esc = false, end = -1;
for (let i = start; i < line.length; i++) {
  const ch = line[i];
  if (inStr) {
    if (esc) esc = false;
    else if (ch === '\\') esc = true;
    else if (ch === '"') inStr = false;
    continue;
  }
  if (ch === '"') { inStr = true; continue; }
  if (ch === '{') depth++;
  else if (ch === '}' && --depth === 0) { end = i + 1; break; }
}
if (end < 0) {
  console.error('[inspect-pixels] could not parse the capture line');
  process.exit(1);
}
const payload = JSON.parse(line.slice(start, end));
const dbg = payload.dbg;
if (!dbg) {
  console.error('[inspect-pixels] the page returned nothing:', line.slice(0, 400));
  process.exit(1);
}
if (dbg.error) {
  console.error(`[inspect-pixels] ${dbg.error}${dbg.elementId ? ` (${dbg.elementId})` : ''}`);
  process.exit(1);
}

if (flag('json')) {
  process.stdout.write(`${JSON.stringify(dbg)}\n`);
} else {
  const cam = dbg.camera ? ` · ${dbg.camera}` : '';
  console.log(`pixel coverage  ${dbg.elementId} (${dbg.elementType})${cam} · ${dbg.size[0]}×${dbg.size[1]} · ${dbg.fps} fps`);
  console.log('  frame   pixels   ratio     maxΔ   bbox');
  for (const row of dbg.frames) {
    const ratio = `${(row.ratio * 100).toFixed(3)}%`;
    const bbox = row.bbox ? row.bbox.join(',') : '-';
    console.log(`  f${String(row.frame).padEnd(5)} ${String(row.pixels).padEnd(8)} ${ratio.padEnd(9)} ${String(row.maxChannel).padEnd(6)} ${bbox}`);
  }
  const counts = dbg.frames.map((r) => r.pixels);
  const zero = counts.filter((n) => n === 0).length;
  console.log(`  frames ${counts.length} · zero ${zero} · min ${Math.min(...counts)} · max ${Math.max(...counts)}`);
}
