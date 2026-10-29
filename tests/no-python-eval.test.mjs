// The Blender backend reads numbers, it does not evaluate (WP1.2,
// docs/DESIGN-BACKEND-V2.md §3 P2/P3, §10.2, §11.7).
//
// `blender/vdm_build.py` used to carry a second evaluator — keyframes, easing,
// value curves, motion presets, beat punches and property-link overlays — that
// had to be kept in sync with `core/evaluate.js` by hand. Since WP1.2 it draws
// the frozen frame IR (`shot v3`) instead, and the evaluator is gone. This test
// fails if any of those functions (or a `*_sample` preset sampler) comes back:
// a second evaluation path is exactly the drift the IR removed.
//
// A comment may still mention a deleted name (the module explains what it no
// longer does), so `#` lines are skipped; code lines, docstrings and any other
// Python file in `blender/` are checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLENDER = path.join(ROOT, 'blender');

/** Functions the Python side may not have any more (WP1.2 delete list). */
const FORBIDDEN = [
  'sample_track',
  'ease',
  '_bezier_axis',
  '_curve_mix',
  'sample_curve',
  'sample_preset',
  '_preset_params',
  '_round_param',
  '_bounce_sample',
  '_elastic_basic',
  '_elastic_sample',
  '_cyclic_sample',
  '_step_sample',
  '_elastic_step_sample',
  'motion_progress',
  'punch_mul',
  'kick',
  'motion_delta',
  'element_link_overlay',
  'baked_world',
  'eval_element',
];

/** `def name(` or a plain call `name(` — a mention inside prose is not a call. */
const usage = (source, name) => new RegExp(`(^|[^\\w.])${name}\\s*\\(`, 'm').test(source);

/** Any preset sampler of the deleted family (`_bounce_sample`, ...). */
const SAMPLER = /(^|[^\w.])(_\w*_sample)\s*\(/;

async function pythonFiles() {
  const names = (await fs.readdir(BLENDER)).filter((name) => name.endsWith('.py')).sort();
  return Promise.all(names.map(async (name) => ({
    name, source: await fs.readFile(path.join(BLENDER, name), 'utf8'),
  })));
}

const codeLines = (source) => source.split(/\r?\n/)
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => !line.trimStart().startsWith('#'));

test('blender/*.py has no second evaluator (WP1.2)', async () => {
  const files = await pythonFiles();
  assert.ok(files.some((file) => file.name === 'vdm_build.py'), 'blender/vdm_build.py is missing');
  const hits = new Set();
  for (const file of files) {
    for (const { line, number } of codeLines(file.source)) {
      for (const name of FORBIDDEN) {
        if (usage(line, name)) hits.add(`${file.name}:${number}: ${name} — ${line.trim()}`);
      }
      const sampler = line.match(SAMPLER);
      if (sampler) hits.add(`${file.name}:${number}: ${sampler[2]} — ${line.trim()}`);
    }
  }
  const found = [...hits].sort();
  assert.deepEqual(found, [], `the Python evaluator came back:\n${found.join('\n')}`);
});

test('the v3 reader is what places the 2D layer', async () => {
  const source = await fs.readFile(path.join(BLENDER, 'vdm_build.py'), 'utf8');
  for (const name of ['class ShotV3', 'def v3_unpack', 'def load_shot_v3', 'def item_matrix', 'def _v3_update']) {
    assert.ok(source.includes(name), `blender/vdm_build.py lost \`${name}\``);
  }
});
