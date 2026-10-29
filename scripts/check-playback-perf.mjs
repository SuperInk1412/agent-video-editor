// Playback frame pacing (docs/FIX-LAYER-ORDER-EMPTY-CLICK.md §三).
//
// Opens a copy of a real project (miku-swiss: ~140 elements, 9 cameras) in
// the editor, plays 3 s in preview mode and measures the requestAnimationFrame
// intervals. Fails when the median interval is over 20 ms or the 95th
// percentile over 34 ms (i.e. noticeably below 60 / 30 fps). Also prints how
// much of each frame the main loop's JS takes, so a slow frame can be told
// apart from a slow layout / paint.
//
//   node scripts/check-playback-perf.mjs [--project=<dir>] [--from=<s>] [--keep] [--report]
//
// --report prints the numbers and always exits 0 (for recording a baseline).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.scratch', 'check-perf');
const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${fallback}`).slice(name.length + 3);
const SOURCE = path.resolve(arg('project', path.join(REPO, 'projects', 'miku-swiss')));
const FROM = Number(arg('from', 2));
const SECONDS = 3;
const MAX_P50 = 20;
const MAX_P95 = 34;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => { out += String(d); });
  p.stderr.on('data', (d) => { err += String(d); });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, out, err }));
});

/**
 * Project file + media only: a copied .vdm would point at the source's runtime.
 * `sources/` comes along when the project has code layers (§6.1): those sketch
 * files are the picture's source of truth, and the render pool reads the disk
 * copy under `sources/<id>/`.
 */
async function copyProject() {
  await fs.rm(WORK, { recursive: true, force: true });
  const dst = path.join(WORK, 'project');
  await fs.mkdir(dst, { recursive: true });
  await fs.copyFile(path.join(SOURCE, 'project.vdm.json'), path.join(dst, 'project.vdm.json'));
  await fs.cp(path.join(SOURCE, 'media'), path.join(dst, 'media'), { recursive: true }).catch(() => {});
  await fs.cp(path.join(SOURCE, 'sources'), path.join(dst, 'sources'), { recursive: true }).catch(() => {});
  return dst;
}

// Runs inside the editor. Wraps the per-frame pieces of the main loop to time
// their JS, then plays and records every rAF interval.
const probe = (from, seconds) => `(async () => {
  const v = window.__vdm;
  v.setEditMode(false);
  await new Promise((r) => setTimeout(r, 1500));
  const js = {};
  const wrap = (obj, name, label) => {
    const f = obj && obj[name];
    if (typeof f !== 'function') return;
    obj[name] = function (...a) {
      const t0 = performance.now();
      try { return f.apply(this, a); } finally { js[label] = (js[label] || 0) + performance.now() - t0; }
    };
  };
  wrap(v.timeline, 'setTime', 'timeline');
  wrap(v.preview, 'render', 'preview');
  wrap(v.gizmo, 'draw', 'gizmo');
  const gaps = [];
  let last = performance.now();
  let live = true;
  const mark = (now) => { gaps.push(now - last); last = now; if (live) requestAnimationFrame(mark); };
  v.setTime(${from});
  requestAnimationFrame(mark);
  v.play();
  await new Promise((r) => setTimeout(r, ${seconds * 1000}));
  v.pause();
  live = false;
  gaps.shift();
  const n = gaps.length;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(n - 1, Math.floor(n * p))];
  const perFrame = {};
  for (const k of Object.keys(js)) perFrame[k] = Math.round((js[k] / n) * 100) / 100;
  window.__dbg = {
    frames: n, fps: Math.round((n / ${seconds}) * 10) / 10,
    p50: Math.round(q(0.5) * 10) / 10, p95: Math.round(q(0.95) * 10) / 10, max: Math.round(sorted[n - 1] * 10) / 10,
    jsMs: perFrame,
    dom: document.getElementsByTagName('*').length,
    elements: v.S.project.elements.length, cameras: v.S.project.cameras.length,
    window: [innerWidth, innerHeight, devicePixelRatio],
  };
})()`;

async function main() {
  const dir = await copyProject();
  const js = probe(FROM, SECONDS).replace(/\n\s*/g, ' ');
  const r = await run(process.execPath, [path.join(HERE, 'dev.mjs'), '--project', dir,
    `--capture=${path.join(WORK, 'shot.png')}`, `--at=${FROM}`, '--delay=3000', `--eval=${js}`], { cwd: REPO });
  const m = r.out.match(/"dbg":(\{.*?"window":\[[^\]]*\]\})/);
  if (!m) throw new Error(`no measurement: ${(r.out + r.err).slice(-1200)}`);
  const d = JSON.parse(m[1]);
  console.log(`[perf] ${path.basename(SOURCE)}: ${d.elements} elements, ${d.cameras} cameras, ${d.dom} DOM nodes, window ${d.window.join('×')}`);
  console.log(`[perf] ${d.frames} frames in ${SECONDS} s = ${d.fps} fps · interval p50 ${d.p50} ms · p95 ${d.p95} ms · max ${d.max} ms`);
  console.log(`[perf] JS per frame (ms): ${JSON.stringify(d.jsMs)}`);
  if (!process.argv.includes('--keep')) await fs.rm(WORK, { recursive: true, force: true }).catch(() => {});
  if (process.argv.includes('--report')) return;
  if (d.p50 > MAX_P50 || d.p95 > MAX_P95) {
    console.log(`[perf] FAIL (limits: p50 ≤ ${MAX_P50} ms, p95 ≤ ${MAX_P95} ms)`);
    process.exit(1);
  }
  console.log('[perf] PASS');
}

main().catch((e) => { console.error('[perf]', e.stack || e.message); process.exit(1); });
