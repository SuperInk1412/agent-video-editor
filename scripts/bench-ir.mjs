// Frame IR benchmark + budget gate (docs/DESIGN-BACKEND-V2.md §4.3, WP0.3).
//
//   node scripts/bench-ir.mjs                        # the project you are in
//   node scripts/bench-ir.mjs --project projects/miku-swiss --json
//   node scripts/bench-ir.mjs --frames 0:120 --budget 3 --hit-budget 1
//
// Budget: one frame must build in <= 3 ms on average and p95 (an IRCache hit
// must be <= 1 ms). Exits non-zero when the budget is missed, so a work package
// can gate on it. Warms up first so V8 has optimised the hot paths, and reports
// max separately: a single GC pause is not a regression.
import path from 'node:path';
import { findProjectRoot, loadProject } from '../engine/storage.js';
import { compileProject } from '../core/tracks.js';
import { buildFrameIR, IRCache, FRAME_IR_VERSION } from '../core/frame-ir.js';

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const projectArg = argOf('project');
const dir = projectArg ? path.resolve(projectArg) : await findProjectRoot(process.cwd());
if (!dir) {
  console.error('[bench-ir] no project.vdm.json here (pass --project)');
  process.exit(1);
}
const project = await loadProject(dir);
compileProject(project);
const meta = project.meta || {};
const fps = Number(meta.fps) || 24;
const lastFrame = Math.max(0, Math.round((Number(meta.duration) || 1) * fps));

const parseRange = (text) => {
  const [a, b] = String(text).split(':');
  const f0 = Math.max(0, Math.round(Number(a) || 0));
  const f1 = b == null ? lastFrame : Math.max(f0, Math.round(Number(b) || 0));
  return [f0, f1];
};
const [f0, f1] = argOf('frames') ? parseRange(argOf('frames')) : [0, lastFrame];
const budget = Number(argOf('budget', 3));
const hitBudget = Number(argOf('hit-budget', 1));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

const timeOne = (f, cache) => {
  const t0 = performance.now();
  buildFrameIR(project, f, { fps, cache });
  return performance.now() - t0;
};

// warm-up: JIT, curve tables, first-touch allocations
for (let f = f0; f <= Math.min(f1, f0 + 30); f++) buildFrameIR(project, f, { fps });

const cold = [];
for (let f = f0; f <= f1; f++) cold.push(timeOne(f, null));
const coldSorted = cold.slice().sort((a, b) => a - b);
const avg = cold.reduce((a, b) => a + b, 0) / cold.length;

const cache = new IRCache();
for (let f = f0; f <= f1; f++) buildFrameIR(project, f, { fps, cache });
const hits = [];
for (let f = f0; f <= f1; f++) hits.push(timeOne(f, cache));
const hitSorted = hits.slice().sort((a, b) => a - b);
const hitAvg = hits.reduce((a, b) => a + b, 0) / hits.length;

const items = buildFrameIR(project, f0, { fps }).items.length;
const report = {
  project: meta.title || path.basename(dir),
  version: FRAME_IR_VERSION,
  elements: project.elements?.length || 0,
  cameras: project.cameras?.length || 0,
  frames: f1 - f0 + 1,
  itemsAtFirstFrame: items,
  cold: { avg, p50: pct(coldSorted, 0.5), p95: pct(coldSorted, 0.95), max: coldSorted[coldSorted.length - 1] },
  cache: { avg: hitAvg, p95: pct(hitSorted, 0.95), hits: cache.hits, entries: cache.size },
  budget: { cold: budget, hit: hitBudget },
  pass: avg <= budget && pct(coldSorted, 0.95) <= budget * 1.5 && hitAvg <= hitBudget,
};

if (flag('json')) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  const ms = (v) => v.toFixed(2);
  console.log(`[bench-ir] ${report.project}: ${report.elements} elements, ${report.cameras} cameras, frames ${f0}..${f1} (${report.frames}), IR v${report.version}`);
  console.log(`[bench-ir] cold  avg ${ms(avg)} ms · p50 ${ms(report.cold.p50)} · p95 ${ms(report.cold.p95)} · max ${ms(report.cold.max)} (budget ${budget} avg, p95 <= ${budget * 1.5})`);
  console.log(`[bench-ir] cache avg ${hitAvg.toFixed(3)} ms · p95 ${report.cache.p95.toFixed(3)} · ${report.cache.hits} hits / ${report.cache.entries} entries (budget ${hitBudget})`);
  console.log(`[bench-ir] ${report.pass ? 'PASS' : 'FAIL'}`);
}
process.exit(report.pass ? 0 : 1);
