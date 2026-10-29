// Dump the frame IR (docs/DESIGN-BACKEND-V2.md §4, WP0.3).
//
//   node scripts/dump-ir.mjs 150                     # the project you are in
//   node scripts/dump-ir.mjs 150 --project projects/miku-swiss --out /tmp/ir.json
//   node scripts/dump-ir.mjs 0:90 --project ... --compact   # a range, one per line
//
// `--camera live|<id>`, `--editor` (the free editor view) and `--solo c1,c2`
// pick the eye; `--no-cache` builds every frame from scratch. Prints JSON on
// stdout, so a person, a script or an agent can read the same numbers the
// renderer draws.
import fs from 'node:fs/promises';
import path from 'node:path';
import { findProjectRoot, loadProject } from '../engine/storage.js';
import { compileProject } from '../core/tracks.js';
import { buildFrameIR, FRAME_IR_VERSION } from '../core/frame-ir.js';

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const spec = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.startsWith('--'));
if (!spec && !flag('help')) {
  console.error('usage: node scripts/dump-ir.mjs <frame | f0:f1> [--project dir] [--camera live|id] [--editor] [--solo ids] [--out file] [--compact]');
  process.exit(1);
}

const projectArg = argOf('project');
const dir = projectArg
  ? path.resolve(projectArg)
  : await findProjectRoot(process.cwd());
if (!dir) {
  console.error('[dump-ir] no project.vdm.json here (pass --project)');
  process.exit(1);
}
const project = await loadProject(dir);
compileProject(project);

const fps = Number(project.meta?.fps) || 24;
const parse = (text) => {
  const [a, b] = String(text).split(':');
  const f0 = Math.max(0, Math.round(Number(a) || 0));
  const f1 = b == null ? f0 : Math.max(f0, Math.round(Number(b) || 0));
  return [f0, f1];
};
const [f0, f1] = parse(spec ?? 0);

const camera = flag('editor') ? undefined : (argOf('camera') || 'live');
const soloList = (argOf('solo') || '').split(',').map((s) => s.trim()).filter(Boolean);
const opts = {
  fps,
  camera,
  edit: flag('editor') ? { cam: argOf('camera') || null, mode: true } : null,
  soloCameras: soloList.length ? new Set(soloList) : null,
};

const frames = [];
for (let f = f0; f <= f1; f++) frames.push(buildFrameIR(project, f, opts));
const payload = frames.length === 1
  ? frames[0]
  : { version: FRAME_IR_VERSION, frames };

const text = flag('compact') || frames.length > 1
  ? (frames.length === 1 ? JSON.stringify(payload) : frames.map((ir) => JSON.stringify(ir)).join('\n'))
  : `${JSON.stringify(payload, null, 2)}`;

const out = argOf('out');
if (out) {
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(path.resolve(out), `${text}\n`);
  const ir = frames[0];
  console.error(`[dump-ir] ${path.resolve(out)}  (${frames.length} frame(s), ${ir.items.length} item(s), ${ir.cameraLayers.length} camera layer(s), version ${FRAME_IR_VERSION})`);
} else {
  process.stdout.write(`${text}\n`);
}
