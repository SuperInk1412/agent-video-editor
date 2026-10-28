// Compare the actual Blender evaluator with JS on fixed editing boundary cases.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evalElement } from '../core/evaluate.js';
import { findBlender } from '../engine/blender.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-eval-'));
try {
  const meta = { width: 1920, height: 1080, beats: [0, 1, 2, 3] };
  const base = { id: 'probe', type: 'text', start: 0, duration: 4,
    transform: { x: 12, y: -8, scale: 1, rotation: 3, opacity: 1 },
    style: { text: 'probe', size: 96, color: '#ffffff' }, keyframes: [] };
  const cases = [];
  const add = (element, times = [0, 0.25, 0.5, 1, 2, 3.5, 4]) => {
    for (const time of times) cases.push({ element: { ...base, ...element }, time, meta });
  };
  add({ transform: { x: 0, y: 0, scale: 0, rotation: 0, opacity: 0 }, style: { text: '', size: 0, color: '#000000' } });
  add({ fadeIn: 0.5, fadeOut: 1 });
  for (const type of ['none', 'in', 'out', 'left', 'right', 'up', 'down', 'drift']) add({ motion: { type, amount: 0.125, span: [0, 4] } });
  add({ motion: { type: 'shake', amount: 1 } }, [0]);
  add({ punch: 1 }, [0, 1, 2, 3]);
  add({ keyframes: [
    { t: 0, path: 'transform.scale', value: 0, ease: 'linear' },
    { t: 4, path: 'transform.scale', value: 2 },
    { t: 0, path: 'style.size', value: 0, ease: 'linear' },
    { t: 4, path: 'style.size', value: 128 },
    { t: 0, path: 'style.text', value: 'first' },
    { t: 2, path: 'style.text', value: 'second' },
  ] });
  add({ keyframes: [
    { t: 0, path: 'transform.x', value: 0, ease: 'outExpo' },
    { t: 4, path: 'transform.x', value: 128 },
  ] }, [0, 2, 4]);
  for (const curve of [
    { type: 'bezier', p1: [0.42, 0], p2: [1, 1] },
    { type: 'bezier', p1: [0, 0], p2: [0.58, 1] },
    { type: 'bezier', p1: [0.42, 0], p2: [0.58, 1] },
    { type: 'bezier', p1: [0.2, 0], p2: [0.4, 1.6] },
  ]) add({ keyframes: [
    { t: 0, path: 'transform.x', value: 0, curve },
    { t: 4, path: 'transform.x', value: 128 },
  ] });
  // Property links: engine/blender.js attaches `_linkOverlay` to 2D elements
  // (core/link-eval.js::elementLinkOverlayTable), and vdm_build.py must apply
  // it BEFORE the motion preset / fades, exactly like evalElement's overlay.
  // Times are frame-aligned so JS and Python index the same table row.
  const linkValues = Array.from({ length: 4 * 24 + 1 }, (_, f) => (f >= 24 && f <= 72
    ? { x: f * 2, scale: 1 + f / 100, rotation: f / 10, opacity: 0.5 }
    : {}));
  add({ keyframes: [
    { t: 0, path: 'transform.x', value: 3, ease: 'linear' },
    { t: 4, path: 'transform.x', value: 11 },
  ], _linkOverlay: { fps: 24, values: linkValues } }, [0, 1, 2, 3, 4]);
  add({ fadeIn: 0.5, motion: { type: 'in', amount: 0.5, span: [0, 4] },
    _linkOverlay: { fps: 24, values: linkValues } }, [1, 2, 3]);
  const input = path.join(temporary, 'cases.json');
  const output = path.join(temporary, 'results.json');
  const script = path.join(temporary, 'check.py');
  await fs.writeFile(input, JSON.stringify(cases));
  await fs.writeFile(script, [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(path.join(repository, 'blender'))})`,
    'from vdm_build import eval_element',
    `with open(${JSON.stringify(input)}, encoding='utf-8') as source: cases = json.load(source)`,
    `with open(${JSON.stringify(output)}, 'w', encoding='utf-8') as out: json.dump([eval_element(c['element'], c['time'], c['meta']) for c in cases], out)`,
  ].join('\n'));
  await promisify(execFile)(await findBlender(), ['-b', '--factory-startup', '--python-exit-code', '1', '-P', script], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  const results = JSON.parse(await fs.readFile(output, 'utf8'));
  const fields = ['x', 'y', 'scale', 'rotation', 'opacity', 'glow', 'text', 'size', 'color'];
  const overlayAt = (element, time) => {
    const table = element._linkOverlay;
    if (!table) return null;
    const index = Math.max(0, Math.min(table.values.length - 1, Math.round(time * table.fps)));
    return table.values[index] || null;
  };
  cases.forEach((item, i) => {
    const expected = evalElement(item.element, item.time, item.meta, overlayAt(item.element, item.time));
    for (const field of fields) assert.equal(results[i][field], expected[field], `case ${i} ${field} at ${item.time}s`);
  });
  console.log(`[check] PASS — ${cases.length} JS / Blender samples match exactly (${fields.length} fields each)`);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
