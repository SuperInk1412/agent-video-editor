// One GLSL implementation for the screen effects (docs/DESIGN-BACKEND-V2.md
// §5.4 / §10.2 WP3.5, decision D2).
//
// What this file guards — all of it plain JS, no GPU:
//   * `app/renderer/shaders/post.glsl` exists and carries the four programs;
//   * both consumers compile from that file and from nowhere else: the preview
//     fetches it (`POST_GLSL_PATH`), the render pool reads and parses it, and
//     `engine/render-workers/post.js` holds no shader body of its own;
//   * the effect parameters are parsed once (`core/screen-fx.js`) and the frame
//     IR packs the same numbers, so the preview and the Blender shot cannot
//     disagree about what a project asked for;
//   * `engine/render-workers/png16.js` really keeps 16 bits through a decode /
//     encode round trip (the export is 16-bit in and out).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  NEUTRAL_SCREEN_FX, POST_GLSL_PATH, POST_GLSL_SECTIONS, SCREEN_FX_KEYS,
  isNeutralScreenFx, normalizeScreenFx, parsePostGlsl,
} from '../core/screen-fx.js';
import { buildFrameIR } from '../core/frame-ir.js';
import { createProject, normalizeProject, DEFAULT_FX } from '../core/schema.js';
import { decodePng, encodePng16, pngBitDepth } from '../engine/render-workers/png16.js';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFile(path.join(REPO, rel), 'utf8');

test('post-shaders: the shared GLSL carries the four programs', async () => {
  const text = await read(POST_GLSL_PATH);
  const shaders = parsePostGlsl(text);
  assert.deepEqual(Object.keys(shaders).sort(), ['blur', 'bright', 'composite', 'vert']);
  for (const [name, source] of Object.entries(shaders)) {
    assert.match(source, /^#version 300 es/, `${name} must be GLSL ES 3.00`);
  }
  // the section names are the file's own contract
  for (const section of Object.values(POST_GLSL_SECTIONS)) {
    assert.ok(text.includes(`// ==== ${section} ====`), `missing section marker ${section}`);
  }
  // every effect the project can ask for is in the composite, and the two
  // switches that let one shader serve both paths are there too
  const composite = shaders.composite;
  for (const uniform of ['u_bloomAmount', 'u_ca', 'u_grain', 'u_scan', 'u_vignette',
    'u_grade', 'u_contrast', 'u_saturation', 'u_time', 'u_flip', 'u_keepAlpha']) {
    assert.ok(composite.includes(uniform), `composite.frag is missing ${uniform}`);
  }
});

test('post-shaders: the preview compiles the shared file, not its own copy', async () => {
  const preview = await read('app/renderer/js/preview.js');
  assert.ok(preview.includes("from '/core/screen-fx.js'"), 'preview imports the shared parameter rules');
  assert.ok(preview.includes('parsePostGlsl'), 'preview parses post.glsl');
  assert.ok(preview.includes('POST_GLSL_PATH'), 'preview names the one file');
  assert.match(preview, /fetch\(`\/\$\{POST_GLSL_PATH\}`/, 'preview fetches /app/renderer/shaders/post.glsl');
  for (const gone of ['const FRAG_BRIGHT', 'const FRAG_BLUR', 'const FRAG_COMPOSITE']) {
    assert.ok(!preview.includes(gone), `${gone} must not exist in preview.js any more`);
  }
  // and it is the same GLSL the pool hands to the sandbox page
  assert.ok(preview.includes('POST_SHADERS.bright') && preview.includes('POST_SHADERS.blur')
    && preview.includes('POST_SHADERS.composite'));
});

test('post-shaders: the render pool reads the same file and ships no shader body', async () => {
  const pool = await read('engine/render-workers/pool.js');
  assert.ok(pool.includes('POST_GLSL_PATH'), 'the pool resolves the shared file');
  assert.ok(pool.includes('parsePostGlsl'), 'the pool parses it with the shared parser');
  assert.match(pool, /readFile\(file, 'utf8'\)/, 'the pool reads the file from disk');

  const page = await read('engine/render-workers/post.js');
  assert.ok(!page.includes('#version 300 es'), 'post.js must not carry a shader body');
  assert.ok(!/const FRAG_/.test(page), 'post.js must not carry a named shader');
  assert.ok(page.includes("from './png16.js'"), 'the page decodes/encodes 16-bit PNGs itself');

  // the page refuses to build a program without the shared sources
  const { createPostProcessor } = await import('../engine/render-workers/post.js');
  assert.throws(() => createPostProcessor(), /共享着色器/);
  assert.throws(() => createPostProcessor({ shaders: { vert: 'x' } }), /共享着色器缺少/);
});

test('post-shaders: one parameter rule for the preview, the IR and the export', () => {
  const cases = [
    {},
    { bloom: 0.8, ca: 0.5, grain: 0.3, vignette: 0.6, scanline: 0.2, grade: 0.35, contrast: 0.2, saturation: 0.75 },
    { bloom: 9, saturation: 0 },       // bloom is clamped, saturation is not
    { bloom: -2, ca: 'x', grain: null }, // junk becomes 0
    { saturation: undefined },
    { saturation: '0.5' },             // numeric strings are numbers
  ];
  const project = normalizeProject(createProject({ title: 'fx', duration: 1, width: 320, height: 180 }));
  for (const fx of cases) {
    const wanted = normalizeScreenFx(fx);
    project.meta.fx = { ...fx };
    const ir = buildFrameIR(project, 0);
    // the IR packs exactly the numbers the shader reads (core/frame-ir.js::screenFxOf)
    assert.deepEqual(ir.screenFx, wanted, `IR and core/screen-fx.js disagree for ${JSON.stringify(fx)}`);
    // and the preview's own rule: bloom in [0, 3], saturation defaults to 1
    assert.ok(wanted.bloom >= 0 && wanted.bloom <= 3);
    if (!Number.isFinite(Number(fx.saturation))) assert.equal(wanted.saturation, 1);
  }
  // the key set is the inspector's, and neutral means "nothing to do"
  assert.deepEqual([...SCREEN_FX_KEYS].sort(), Object.keys(normalizeScreenFx({})).sort());
  assert.equal(isNeutralScreenFx(NEUTRAL_SCREEN_FX), true);
  assert.equal(isNeutralScreenFx({}), true);
  assert.equal(isNeutralScreenFx({ grain: 0.001 }), false);
  assert.equal(isNeutralScreenFx({ saturation: 0.5 }), false);
  // the project default is *not* neutral: an export goes through the post pass
  assert.equal(isNeutralScreenFx(DEFAULT_FX), false);
});

test('post-shaders: a broken post.glsl is an error, not a silent fallback', () => {
  assert.throws(() => parsePostGlsl(''), /文件为空/);
  assert.throws(() => parsePostGlsl('// nothing here\n'), /缺少段落/);
  assert.throws(
    () => parsePostGlsl('// ==== quad.vert ====\nvoid main() {}\n'),
    /#version 300 es/,
  );
});

test('post-shaders: 16-bit PNG survives the export codec', async () => {
  const width = 3;
  const height = 2;
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 4099) & 0xffff;
  const png = await encodePng16({ width, height, data });
  assert.equal(pngBitDepth(png), 16, 'the film is written at 16 bits');
  const back = await decodePng(png);
  assert.equal(back.width, width);
  assert.equal(back.height, height);
  assert.equal(back.depth, 16);
  assert.deepEqual([...back.data], [...data], 'every sample survives the round trip');
  // a file that is not a PNG is refused instead of guessed at
  await assert.rejects(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])), /不是 PNG/);
  assert.equal(pngBitDepth(Uint8Array.from([1, 2, 3])), null);
});
