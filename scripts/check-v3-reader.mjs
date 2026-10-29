// Numeric cross-check of the shot-v3 reader (WP1.2).
//
// `blender/vdm_build.py` no longer evaluates anything: it reads the numbers out
// of the shot package. This check proves the numbers Python reads are exactly
// the numbers JS `frameFromShotV3` produces — core/frame-ir.js is the only
// evaluator (P2) — and that the matrix Blender places a plane with is `world`
// plus the depth bias and the draw-order hair.
//
//   node scripts/check-v3-reader.mjs [projectDir]
//   node scripts/check-v3-reader.mjs .scratch/miku-swiss      # a copy, not the user's project
//
// Needs Blender (found the same way the renderer finds it). Exits non-zero on
// any difference.
//
// For every render frame of the shot it compares, per drawn element:
//   world[16], size[2], opacity, depth.bias, drawOrder,
//   content.text / fontSize / color / glow
// and the Blender matrix the Python builder places the plane with
// (`SceneBuilder.item_matrix`) against `world` + `depth.bias` along the plane
// normal (+ the drawOrder tie-break). Tolerance: 1e-6, as the WP asks.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadProject } from '../engine/storage.js';
import { compileProject } from '../core/tracks.js';
import { buildShotV3, frameFromShotV3 } from '../engine/shot.js';
import { findBlender } from '../engine/blender.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BLENDER_DIR = path.join(REPO, 'blender');
const DIR = path.resolve(process.argv[2] || path.join(REPO, '.scratch', 'miku-swiss'));
if (!(await fs.stat(DIR).catch(() => null))) {
  console.error(`[check-v3-reader] no project at ${DIR}
  copy one first: mkdir -p .scratch/miku-swiss && cp projects/miku-swiss/project.vdm.json .scratch/miku-swiss/ && cp -r projects/miku-swiss/media .scratch/miku-swiss/`);
  process.exit(2);
}
const TOL = 1e-6;
const DEPTH_ORDER_M = 1e-5; // must match blender/vdm_build.py
const r0Translation = 3; // row-major 4x4: the translation sits in column 3

const project = await loadProject(DIR);
compileProject(project);
const fps = Number(project.meta?.fps) || 24;
const f0 = 1;
const f1 = Math.max(f0, Math.round((Number(project.meta?.duration) || 0) * fps));
const v3 = buildShotV3(project, { fps, from: (f0 - 1) / fps, to: (f1 - 1) / fps, city: { hash: null } });

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-v3-'));
const v3File = path.join(tmp, 'v3.json');
const outFile = path.join(tmp, 'python.json');
const script = path.join(tmp, 'read.py');
await fs.writeFile(v3File, JSON.stringify(v3));
const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(BLENDER_DIR)})
from vdm_build import ShotV3, v3_build_inputs, SceneBuilder

payload = json.load(open(${JSON.stringify(v3File)}, encoding="utf-8"))
reader = ShotV3(payload)
meta = {"fps": payload["fps"], "width": payload["size"][0],
        "height": payload["size"][1], "duration": 1}
builder = SceneBuilder({"meta": meta, "elements": [], "v3": payload},
                       {"project": "x.json", "root": "."})
builder.units_per_m = 1.0   # the embedded (metres) scene the 3D shot builds
builder.y_shift = 0.0
rows = []
for frame in range(int(payload["f0"]), int(payload["f1"]) + 1):
    for ident in sorted(reader.records):
        item = reader.item(ident, frame)
        if item is None:
            continue
        state, _style = v3_build_inputs({"style": {}}, item)
        matrix = builder.item_matrix(item)
        rows.append({
            "frame": frame, "id": ident,
            "world": item.get("world"), "size": item.get("size"),
            "opacity": item.get("opacity"),
            "bias": (item.get("depth") or {}).get("bias"),
            "drawOrder": item.get("drawOrder"),
            "text": state["text"], "fontSize": state["size"],
            "color": state["color"], "glow": state["glow"],
            "matrix": [value for row in matrix for value in row],
        })
json.dump(rows, open(${JSON.stringify(outFile)}, "w", encoding="utf-8"))
`;
await fs.writeFile(script, py);
const blender = await findBlender();
await promisify(execFile)(blender, ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '-P', script],
  { timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
const pyRows = JSON.parse(await fs.readFile(outFile, 'utf8'));

// ---------------------------------------------------------------- compare
let pairs = 0;
let fields = 0;
let diffs = 0;
let presenceDiffs = 0;
let worst = { what: '', diff: 0 };
const byField = {};
const note = (what, diff) => { if (!(diff <= worst.diff)) worst = { what, diff }; };
const diffOf = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null) ? 0 : Infinity;
  }
  return Math.abs(Number(a) - Number(b));
};
const jsByFrame = new Map();
for (let f = v3.f0; f <= v3.f1; f++) {
  const map = new Map();
  for (const item of frameFromShotV3(v3, f).items) map.set(item.id, item);
  jsByFrame.set(f, map);
}
const seen = new Set();
for (const row of pyRows) {
  const js = jsByFrame.get(row.frame)?.get(row.id);
  if (!js) { presenceDiffs += 1; note(`python-only ${row.id}@${row.frame}`, Infinity); continue; }
  seen.add(`${row.frame}|${row.id}`);
  pairs += 1;
  const scalars = [
    ['opacity', row.opacity, js.opacity],
    ['bias', row.bias, js.depth?.bias],
    ['drawOrder', row.drawOrder, js.drawOrder],
    ['glow', row.glow, js.content?.glow],
  ];
  // text numbers only exist on a text item (`content.text` / `fontSize` / `color`)
  if (js.kind === 'text') {
    scalars.push(['fontSize', row.fontSize, js.content?.fontSize]);
    scalars.push(['text', row.text, js.content?.text]);
    scalars.push(['color', row.color, js.content?.color]);
  }
  for (const [name, a, b] of scalars) {
    fields += 1;
    if (typeof b === 'string' || typeof a === 'string') {
      if (String(a) !== String(b)) { diffs += 1; byField[name] = (byField[name] || 0) + 1; note(`${name} ${row.id}@${row.frame}`, Infinity); }
      continue;
    }
    const d = diffOf(a, b);
    if (!(d <= TOL)) { diffs += 1; byField[name] = (byField[name] || 0) + 1; note(`${name} ${row.id}@${row.frame}`, d); }
  }
  for (let i = 0; i < 16; i++) {
    fields += 1;
    const d = diffOf(row.world?.[i], js.world?.[i]);
    if (!(d <= TOL)) { diffs += 1; byField.world = (byField.world || 0) + 1; note(`world[${i}] ${row.id}@${row.frame}`, d); }
  }
  const size = Array.isArray(js.size) ? js.size : [];
  for (let i = 0; i < size.length; i++) {
    fields += 1;
    const d = diffOf(row.size?.[i], size[i]);
    if (!(d <= TOL)) { diffs += 1; byField.size = (byField.size || 0) + 1; note(`size[${i}] ${row.id}@${row.frame}`, d); }
  }
  // The placement matrix must be `world` plus (bias + the drawOrder hair)
  // along the plane normal — the rule itemModelMatrix() gives the preview.
  const n = [js.world[8], js.world[9], js.world[10]];
  const len = Math.hypot(n[0], n[1], n[2]);
  const unit = len > 1e-12 ? n.map((v) => v / len) : [0, 0, 1];
  const off = Number(js.depth?.bias || 0) + DEPTH_ORDER_M * Number(js.drawOrder || 0);
  const expected = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) expected.push(js.world[c * 4 + r]);
  for (let i = 0; i < 3; i++) expected[r0Translation + i * 4] += unit[i] * off; // row-major: col 3
  for (let i = 0; i < 16; i++) {
    fields += 1;
    const d = diffOf(row.matrix?.[i], expected[i]);
    if (!(d <= TOL)) { diffs += 1; byField.matrix = (byField.matrix || 0) + 1; note(`matrix[${i}] ${row.id}@${row.frame}`, d); }
  }
}
for (const [f, map] of jsByFrame) {
  for (const id of map.keys()) if (!seen.has(`${f}|${id}`)) { presenceDiffs += 1; note(`js-only ${id}@${f}`, Infinity); }
}
await fs.rm(tmp, { recursive: true, force: true });
console.log(JSON.stringify({
  project: DIR, frames: [v3.f0, v3.f1], elements: v3.items.length,
  pairs, fields, diffs, presenceDiffs,
  tolerance: TOL, byField, worst: { what: worst.what, diff: worst.diff === Infinity ? 'not-a-number' : worst.diff },
}, null, 2));
if (diffs || presenceDiffs) process.exit(1);
