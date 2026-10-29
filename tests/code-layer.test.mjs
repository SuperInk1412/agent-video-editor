// Code layers (docs/DESIGN-BACKEND-V2.md §6.1–§6.3, WP3.2).
//
// Plain-Node group: the `code` element data, parameter evaluation (base +
// keyframes + property links), the per-frame render request, the source
// registry / materialisation, the static contract scan and the verdict logic.
// Nothing here needs Electron.
//
// Electron group (skipped with a reason when no Electron is installed): one
// template really renders in the sandbox and passes all five contract checks,
// and a deliberately broken source is really caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  CODE_CACHE_MODES, CODE_PARAM_PREFIX, CONTRACT_CHECKS, DEFAULT_CODE,
  codeCachePolicy, codeIssues, codeLayerPlan, codeParamName, codeParamPath, codeParamsAt,
  codeParamNames, codeSeed, codeSize, codeSourceId, coerceParamValue, evaluateContractCheck,
  isCodeParamPath, isSafeParamName, isSafeSourceFile, isSafeSourceId, manifestIssues,
  normalizeCode, paramProbes, perturbParamValue, scanSourceFiles, scanSourceText, sourceFiles,
  sourceIds, sourceManifest, sourceRecord, stripSourceNoise, writeCodeParam,
} from '../core/code-layer.js';
import { ELEMENT_TYPES, createProject, normalizeProject, validateProject } from '../core/schema.js';
import { applyOp, OP_KINDS } from '../core/ops.js';
import { findLinkTarget, resolveEffectiveValue } from '../core/links.js';
import { PUBLIC_OPS } from '../core/contracts.js';
import { resolveParams } from '../engine/render-workers/cache.js';
import { findElectron } from '../engine/render-workers/pool.js';

const REPO = path.resolve(import.meta.dirname, '..');
const near = (a, b, eps = 1e-6, msg = '') => {
  assert.ok(Number.isFinite(a), `${msg}: ${a} not finite`);
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

const MANIFEST = {
  runtime: 'canvas2d',
  entry: 'sketch.js',
  deterministic: true,
  params: [
    { id: 'density', type: 'number', default: 0.5, range: [0, 1], keyable: 'frame' },
    { id: 'count', type: 'int', default: 8, range: [2, 24], keyable: 'frame' },
    { id: 'tint', type: 'color', default: '#66ccff', keyable: 'frame' },
    { id: 'mirror', type: 'boolean', default: false, keyable: 'frame' },
  ],
};

const SOURCE = 'export function draw(ctx, vdm) { ctx.fillRect(0, 0, vdm.size[0], vdm.size[1]); }\n';

/** A project with one registered source and one code element using it. */
function scene({ code = {}, files = {} } = {}) {
  const p = normalizeProject(createProject({ title: 'code', duration: 6 }));
  applyOp(p, { op: 'sourceAdd', id: 'src_a', manifest: MANIFEST, files: { 'sketch.js': SOURCE, ...files } });
  const element = applyOp(p, {
    op: 'addElement',
    element: {
      type: 'code', start: 0, duration: 4, code: { source: 'src_a', params: { density: 0.25 }, seed: 7, ...code },
    },
  }).element;
  normalizeProject(p);
  return { project: p, el: p.elements.find((e) => e.id === element.id) };
}

// ---------------------------------------------------------------------------
// Data: the element type, defaults, validation, the op log
// ---------------------------------------------------------------------------

test('code-layer: `code` is an element type and keeps its own block', () => {
  assert.ok(ELEMENT_TYPES.includes('code'));
  const { project, el } = scene();
  assert.equal(el.type, 'code');
  // Every declared parameter gets its current value (manifest default or the
  // value the caller passed), so links / keyframes / the UI see a full block.
  assert.deepEqual(el.code, {
    source: 'src_a',
    params: { count: 8, density: 0.25, mirror: false, tint: '#66ccff' },
    seed: 7,
    size: null,
    cache: 'live',
  });
  assert.deepEqual(validateProject(project), []);
});

test('code-layer: normalizeCode fills defaults and drops garbage', () => {
  assert.deepEqual(normalizeCode(undefined), { source: '', params: {}, seed: 0, size: null, cache: 'live' });
  assert.deepEqual(DEFAULT_CODE.params, {});
  const cleaned = normalizeCode({
    source: 'src_a',
    params: { ok: 1, 'bad name': 2, nested: { nope: 1 }, arr: [1, 2, 3] },
    seed: 3.9,
    size: [640, 360],
    cache: 'bake',
  });
  assert.deepEqual(cleaned.params, { ok: 1, arr: [1, 2, 3] });
  assert.equal(cleaned.seed, 3);
  assert.deepEqual(cleaned.size, [640, 360]);
  assert.equal(cleaned.cache, 'bake');
  assert.equal(normalizeCode({ cache: 'nope' }).cache, 'live');
  assert.ok(CODE_CACHE_MODES.includes('live') && CODE_CACHE_MODES.includes('bake'));
});

test('code-layer: a broken code block is reported, not repaired', () => {
  assert.deepEqual(codeIssues(undefined), []);
  const issues = codeIssues({ source: '', params: { '1x': 1, deep: { a: 1 } }, seed: 1.5, size: [0, 10], cache: 'fast' });
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes('code.source'));
  assert.ok(paths.includes('code.params.1x'));
  assert.ok(paths.includes('code.params.deep'));
  assert.ok(paths.includes('code.seed'));
  assert.ok(paths.includes('code.size'));
  assert.ok(paths.includes('code.cache'));
  // A code element without a block cannot pass validation.
  const p = normalizeProject(createProject({ title: 'x' }));
  applyOp(p, { op: 'addElement', element: { type: 'code', duration: 2 } });
  assert.deepEqual(p.elements[0].code.source, '');
  assert.ok(validateProject(p).some((i) => i.path === 'elements[0].code.source'));
});

test('code-layer: create / update / remove go through the op log', () => {
  for (const kind of ['sourceAdd', 'sourceWrite', 'sourceRemove', 'codeParamSet']) {
    assert.ok(OP_KINDS.includes(kind), `${kind} missing from OP_KINDS`);
    assert.ok(PUBLIC_OPS.includes(kind), `${kind} missing from the editing contract`);
  }
  const { project, el } = scene();
  applyOp(project, { op: 'updateElement', id: el.id, patch: { code: { seed: 42 } } });
  assert.equal(el.code.seed, 42);
  assert.equal(el.code.source, 'src_a', 'updateElement merges, it does not replace the block');
});

// ---------------------------------------------------------------------------
// Source registry + materialisation
// ---------------------------------------------------------------------------

test('code-layer: the registry materialises to manifest.json + files', () => {
  const { project } = scene({ files: { 'README.md': 'hello\n' } });
  assert.deepEqual(sourceIds(project), ['src_a']);
  const record = sourceRecord(project, 'src_a');
  assert.equal(record.manifest.runtime, 'canvas2d');
  assert.deepEqual(sourceFiles(project, 'src_a').map((f) => f.path), ['manifest.json', 'README.md', 'sketch.js']);
  const manifest = JSON.parse(sourceFiles(project, 'src_a')[0].content);
  assert.equal(manifest.id, 'src_a', 'manifest.json carries the directory id');
  assert.equal(manifest.params.length, 4);
  assert.deepEqual(sourceFiles(project, 'nope'), []);
  assert.equal(sourceManifest(project, 'nope'), null);
});

test('code-layer: unsafe source ids and file paths are rejected', () => {
  assert.ok(isSafeSourceId('src_rain'));
  for (const bad of ['', '../x', 'a/b', '.hidden', 'x'.repeat(70)]) assert.equal(isSafeSourceId(bad), false, String(bad));
  assert.ok(isSafeSourceFile('sketch.js'));
  assert.ok(isSafeSourceFile('lib/util.js'));
  for (const bad of ['../x.js', '/abs.js', 'a\\b.js', '', './a.js', 'a//b.js']) assert.equal(isSafeSourceFile(bad), false, String(bad));
  assert.ok(isSafeParamName('density'));
  assert.equal(isSafeParamName('2x'), false);
  assert.equal(codeParamPath('tint'), `${CODE_PARAM_PREFIX}tint`);
  assert.ok(isCodeParamPath('code.params.tint'));
  assert.equal(isCodeParamPath('code.params.'), false);
  assert.equal(codeParamName('code.params.tint'), 'tint');
  assert.equal(codeParamName('pivot.x'), null);
});

test('code-layer: manifestIssues follows the PROPERTY format', () => {
  assert.deepEqual(manifestIssues(MANIFEST), []);
  const issues = manifestIssues({ runtime: 'flash', entry: '../x.js', params: [{ id: '2x', type: 'wat', keyable: 'never', range: [2, 1] }], deterministic: 'yes' });
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes('manifest.runtime'));
  assert.ok(paths.includes('manifest.entry'));
  assert.ok(paths.includes('manifest.params[0].id'));
  assert.ok(paths.includes('manifest.params[0].type'));
  assert.ok(paths.includes('manifest.params[0].keyable'));
  assert.ok(paths.includes('manifest.params[0].range'));
  assert.ok(paths.includes('manifest.deterministic'));
  assert.ok(manifestIssues({ runtime: 'p5', entry: 'sketch.js', params: [{ id: 'a' }, { id: 'a' }] })
    .some((i) => i.msg.includes('duplicate')));
});

// ---------------------------------------------------------------------------
// Parameter evaluation: manifest default → base → keyframes → property links
// ---------------------------------------------------------------------------

test('code-layer: parameters merge manifest defaults with element values', () => {
  const { project, el } = scene();
  const params = codeParamsAt(project, el, 0);
  assert.deepEqual(params, { density: 0.25, count: 8, tint: '#66ccff', mirror: false });
  assert.ok(Object.isFrozen(params));
  // Not a code element -> no parameters, no throw.
  assert.deepEqual(codeParamsAt(project, { id: 'el_x', type: 'solid' }, 0), {});
  // Unknown element (not in the project) still evaluates its own values.
  const loose = { id: 'el_x', type: 'code', code: { source: 'src_a', params: { density: 1 }, seed: 0 } };
  assert.deepEqual(codeParamsAt(project, loose, 0), { density: 1, count: 8, tint: '#66ccff', mirror: false });
});

test('code-layer: keyframes interpolate, other types step', () => {
  const { project, el } = scene();
  applyOp(project, { op: 'keySet', id: el.id, path: 'code.params.density', t: 0, value: 0.1 });
  applyOp(project, { op: 'keySet', id: el.id, path: 'code.params.count', t: 0, value: 2 });
  applyOp(project, { op: 'keySet', id: el.id, path: 'code.params.count', t: 2, value: 12 });
  applyOp(project, { op: 'keySet', id: el.id, path: 'code.params.mirror', t: 0, value: false });
  applyOp(project, { op: 'keySet', id: el.id, path: 'code.params.mirror', t: 1, value: true });
  near(codeParamsAt(project, el, 0).density, 0.1, 1e-9, 'density@0');
  near(codeParamsAt(project, el, 1).count, 7, 1e-9, 'count@1 is interpolated and rounded');
  assert.equal(codeParamsAt(project, el, 0.5).mirror, false, 'boolean holds the left key');
  assert.equal(codeParamsAt(project, el, 1).mirror, true, 'boolean steps at the key');
});

test('code-layer: a code parameter is a legal link SOURCE', () => {
  const { project, el } = scene();
  const other = applyOp(project, { op: 'addElement', element: { type: 'solid', duration: 4 } }).element;
  applyOp(project, { op: 'propLink', id: other.id, to: 'opacity', from: { host: 'el', id: el.id, path: 'code.params.density' }, t: 0, combine: 'add' });
  assert.equal(other.links[0].to, 'opacity');
  assert.deepEqual(validateProject(project), []);
  // The bind is the parameter value at t=0, so the contribution starts at 0.
  near(resolveEffectiveValue(project, other, 'opacity', 0), 1, 1e-9, 'bind offsets to zero');
  // Keyframe the parameter -> the linked opacity follows by the delta.
  applyOp(project, { op: 'keySet', id: el.id, path: 'code.params.density', t: 0, value: 0.25 });
  applyOp(project, { op: 'keySet', id: el.id, path: 'code.params.density', t: 2, value: 0.75 });
  near(resolveEffectiveValue(project, other, 'opacity', 2), 1.5, 1e-9, 'add: opacity = 1 + (0.75 - 0.25)');
});

test('code-layer: a code parameter is a legal link TARGET (add)', () => {
  const { project, el } = scene();
  const driver = applyOp(project, { op: 'addElement', element: { type: 'solid', duration: 4 } }).element;
  applyOp(project, { op: 'keySet', id: driver.id, path: 'transform.opacity', t: 0, value: 1 });
  applyOp(project, { op: 'propLink', id: el.id, to: 'code.params.density', from: { host: 'el', id: driver.id, path: 'opacity' }, t: 0 });
  assert.ok(el.links.some((l) => l.to === 'code.params.density'));
  assert.deepEqual(validateProject(project), []);
  near(codeParamsAt(project, el, 1).density, 0.25, 1e-9, 'density unchanged while the driver is flat');
  applyOp(project, { op: 'keySet', id: driver.id, path: 'transform.opacity', t: 2, value: 0.5 });
  near(codeParamsAt(project, el, 2).density, -0.25, 1e-9, 'add: density = 0.25 + (0.5 - 1)');
});

test('code-layer: a mul link onto a code parameter scales it', () => {
  const { project, el } = scene();
  const driver = applyOp(project, { op: 'addElement', element: { type: 'solid', duration: 4 } }).element;
  applyOp(project, { op: 'keySet', id: driver.id, path: 'transform.opacity', t: 0, value: 1 });
  applyOp(project, { op: 'propLink', id: el.id, to: 'code.params.density', from: { host: 'el', id: driver.id, path: 'opacity' }, t: 0, combine: 'mul' });
  applyOp(project, { op: 'keySet', id: driver.id, path: 'transform.opacity', t: 2, value: 0.5 });
  near(codeParamsAt(project, el, 0).density, 0.25, 1e-9, 'bind keeps the value at t=0');
  near(codeParamsAt(project, el, 2).density, 0.125, 1e-9, 'mul: 0.25 × (0.5 / 1)');
  near(resolveEffectiveValue(project, el, 'code.params.density', 2), 0.125, 1e-9, 'links.js agrees');
});

test('code-layer: code.params.* is linkable in both directions with any unit', () => {
  const { project, el } = scene();
  const target = findLinkTarget('el', el, 'code.params.density');
  assert.ok(target);
  assert.equal(target.unit, 'any');
  assert.equal(target.combine, 'add');
  // A parameter with no base value is still a valid target (the manifest owns the names).
  assert.ok(findLinkTarget('el', el, 'code.params.notYet'));
  // Other element properties keep their units: no blanket relaxation.
  assert.equal(findLinkTarget('el', el, 'opacity').unit, 'ratio');
  assert.equal(findLinkTarget('el', el, 'code.params.density').unit, 'any');
  // Linking an angle channel into a ratio channel still fails (units untouched).
  applyOp(project, { op: 'addCamera', camera: { id: 'cam_1' } });
  assert.throws(
    () => applyOp(project, { op: 'propLink', id: el.id, to: 'opacity', from: { host: 'cam', id: 'cam_1', path: 'fov' }, t: 0 }),
    /units differ/,
  );
  // ... but the same channel is fine into a code parameter (unit 'any').
  applyOp(project, { op: 'propLink', id: el.id, to: 'code.params.density', from: { host: 'cam', id: 'cam_1', path: 'fov' }, t: 0 });
  assert.deepEqual(validateProject(project), []);
});

test('code-layer: coerceParamValue matches what the render pool does', () => {
  const evaluated = { density: '0.4', count: '7.6', mirror: 'true', tint: 12 };
  const coerced = {
    density: coerceParamValue('number', evaluated.density),
    count: coerceParamValue('int', evaluated.count),
    mirror: coerceParamValue('boolean', evaluated.mirror),
    tint: coerceParamValue('color', evaluated.tint),
  };
  assert.deepEqual(coerced, { density: 0.4, count: 8, mirror: true, tint: '12' });
  // The pool's own resolver agrees on every value it accepts.
  assert.deepEqual({ ...resolveParams(MANIFEST, {...coerced, density: 0.4, count: 8, mirror: true}) },
    { density: 0.4, count: 8, tint: '12', mirror: true });
});

test('code-layer: writeCodeParam writes a value or a key at t', () => {
  const { project, el } = scene();
  const base = writeCodeParam(el, 'density', 0.8, 0);
  assert.equal(base.key, false);
  assert.equal(el.code.params.density, 0.8);
  assert.equal(el.keyframes.length, 0, 'an unkeyed parameter stays a base value');
  applyOp(project, { op: 'keySet', id: el.id, path: 'code.params.density', t: 0, value: 0.2 });
  const keyed = writeCodeParam(el, 'density', 0.9, 2);
  assert.equal(keyed.key, true);
  assert.deepEqual(el.keyframes.map((k) => [k.path, k.t, k.value]), [['code.params.density', 0, 0.2], ['code.params.density', 2, 0.9]]);
  assert.throws(() => writeCodeParam(el, 'bad name', 1), /bad code parameter name/);
});

test('code-layer: codeParamSet clamps to the manifest range and records the write', () => {
  const { project, el } = scene();
  const result = applyOp(project, { op: 'codeParamSet', id: el.id, name: 'count', value: 999 });
  assert.equal(result.param, 'count');
  assert.equal(result.declared, true);
  assert.equal(el.code.params.count, 24, 'clamped to range [2, 24]');
  const undeclared = applyOp(project, { op: 'codeParamSet', id: el.id, name: 'extra', value: 3 });
  assert.equal(undeclared.declared, false);
  assert.equal(el.code.params.extra, 3);
  assert.throws(() => applyOp(project, { op: 'codeParamSet', id: el.id, name: '../x', value: 1 }), /参数名/);
  const solid = applyOp(project, { op: 'addElement', element: { type: 'solid', duration: 2 } }).element;
  assert.throws(() => applyOp(project, { op: 'codeParamSet', id: solid.id, name: 'count', value: 1 }), /不是 code 元素/);
});

// ---------------------------------------------------------------------------
// Render request + cache policy
// ---------------------------------------------------------------------------

test('code-layer: the per-frame render request is complete', () => {
  const { project, el } = scene({ code: { size: [800, 450], seed: -3, cache: 'bake' } });
  const plan = codeLayerPlan(project, el, 1.5, { fps: 30 });
  assert.equal(plan.sourceId, 'src_a');
  assert.equal(plan.runtime, 'canvas2d');
  assert.equal(plan.entry, 'sketch.js');
  assert.deepEqual(plan.size, [800, 450]);
  assert.equal(plan.frame, 45);
  assert.equal(plan.fps, 30);
  assert.equal(plan.seed, -3);
  assert.equal(plan.cache, 'bake');
  assert.equal(plan.allowLiveRender, false, 'bake never renders in the preview');
  assert.deepEqual(plan.params, codeParamsAt(project, el, 1.5));
  assert.equal(codeSize(el, { width: 1920, height: 1080 })[0], 800, 'explicit size wins');
  assert.deepEqual(codeSize({ code: {} }, { width: 1280, height: 720 }), [1280, 720], 'else the project size');
  assert.deepEqual(codeSize({ code: {} }, null), [1920, 1080], 'else 1920x1080');
  assert.equal(codeSeed(el), -3);
  assert.equal(codeSourceId(el), 'src_a');
  // fps falls back to the project rate.
  assert.equal(codeLayerPlan(project, el, 1).fps, project.meta.fps);
});

test('code-layer: live vs bake vs a non-deterministic source', () => {
  assert.deepEqual(codeCachePolicy({ code: { cache: 'live' } }), {
    mode: 'live', live: true, bake: false, allowLiveRender: true, cacheable: true, deterministic: true,
  });
  assert.deepEqual(codeCachePolicy({ code: { cache: 'bake' } }), {
    mode: 'bake', live: false, bake: true, allowLiveRender: false, cacheable: true, deterministic: true,
  });
  const nondet = codeCachePolicy({ code: {} }, { deterministic: false });
  assert.equal(nondet.cacheable, false, 'deterministic:false must never be reused from the cache');
  assert.equal(codeCachePolicy({}).mode, 'live');
});

// ---------------------------------------------------------------------------
// Contract check: static scan
// ---------------------------------------------------------------------------

test('code-layer: the static scan finds every banned API with a line number', () => {
  const sketch = [
    'export function draw(ctx, vdm) {',
    '  const now = Date.now();',
    '  const r = Math.random();',
    '  fetch("/x");',
    '  return [now, r];',
    '}',
  ].join('\n');
  const { errors } = scanSourceText(sketch, { path: 'sketch.js' });
  const ids = errors.map((e) => e.id).sort();
  assert.deepEqual(ids, ['date-now', 'fetch', 'math-random']);
  assert.equal(errors.find((e) => e.id === 'date-now').line, 2);
  assert.match(errors[0].message, /sketch\.js:\d+/);
  assert.match(errors.find((e) => e.id === 'math-random').message, /vdm\.random/);
});

test('code-layer: comments and strings do not trip the scan', () => {
  const sketch = [
    '// Date.now() and Math.random() are banned, but this is a comment',
    '/* fetch("/x") */',
    'export function draw(ctx, vdm) {',
    '  ctx.fillStyle = "#ff0000";',
    "  ctx.font = 'Date.now(fake)';",
    '  void vdm.t;',
    '}',
  ].join('\n');
  const scan = scanSourceText(sketch, { path: 'sketch.js' });
  assert.deepEqual(scan.errors, []);
  assert.equal(stripSourceNoise('a // b\nc').replace(/\s/g, ''), 'ac', 'comments are blanked, offsets kept');
});

test('code-layer: banned APIs per runtime', () => {
  const p5 = 'export default (p) => { p.loop(); p.frameRate(60); p.loadImage("a.png"); };';
  assert.deepEqual(scanSourceText(p5, { path: 'sketch.js', runtime: 'p5' }).errors.map((e) => e.id).sort(),
    ['p5-frame-rate', 'p5-load', 'p5-loop']);
  assert.deepEqual(scanSourceText(p5, { path: 'sketch.js', runtime: 'canvas2d' }).errors, []);
  const warns = scanSourceText('setTimeout(() => {}, 10);', { path: 'sketch.js' });
  assert.deepEqual(warns.errors, []);
  assert.equal(warns.warnings[0].id, 'set-timeout');
});

test('code-layer: scanSourceFiles only looks at code files', () => {
  const scan = scanSourceFiles([
    { path: 'sketch.js', content: 'Date.now();' },
    { path: 'manifest.json', content: '{"Date.now()": true}' },
    { path: 'README.md', content: 'Date.now()' },
    { path: 'shader.frag', content: 'void main() {}' },
  ], { runtime: 'canvas2d' });
  assert.equal(scan.files, 2);
  assert.deepEqual(scan.errors.map((e) => e.file), ['sketch.js']);
});

test('code-layer: the templates shipped with the repo are clean', async () => {
  for (const runtime of ['canvas2d', 'p5', 'glsl']) {
    const dir = path.join(REPO, 'templates', 'code', runtime);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifestIssues(manifest), [], `${runtime} manifest`);
    const files = [];
    for (const name of await fs.readdir(dir)) {
      if (name === 'manifest.json') continue;
      files.push({ path: name, content: await fs.readFile(path.join(dir, name), 'utf8') });
    }
    assert.ok(files.some((f) => f.path === manifest.entry), `${runtime} has its entry file`);
    const scan = scanSourceFiles(files, { runtime });
    assert.deepEqual(scan.errors, [], `${runtime} scan`);
    assert.deepEqual(scan.warnings, [], `${runtime} warnings`);
    assert.ok(manifest.params.length > 0, `${runtime} declares parameters`);
  }
});

// ---------------------------------------------------------------------------
// Contract check: probes + verdict
// ---------------------------------------------------------------------------

test('code-layer: parameter probes change the value in a visible way', () => {
  const probes = paramProbes(MANIFEST, { params: { density: 0.25, count: 8, tint: '#66ccff', mirror: false } });
  assert.deepEqual(probes.map((p) => p.id), ['density', 'count', 'tint', 'mirror']);
  const byId = Object.fromEntries(probes.map((p) => [p.id, p.to]));
  assert.notEqual(byId.density, 0.25);
  assert.ok(byId.count >= 2 && byId.count <= 24, 'stays inside the range');
  assert.notEqual(byId.tint, '#66ccff');
  assert.equal(byId.mirror, true);
  assert.equal(perturbParamValue({ type: 'enum', options: ['a', 'b'] }, 'a'), 'b');
  assert.equal(perturbParamValue({ type: 'wat' }, 1), undefined);
  assert.deepEqual(paramProbes({ params: [] }), []);
});

test('code-layer: the verdict marks all five checks', () => {
  const clean = evaluateContractCheck({
    sourceId: 'src_a', runtime: 'canvas2d', manifest: MANIFEST,
    scan: { errors: [], warnings: [], files: 1 },
    determinism: { frame: 0, hash: 'aa', hashAgain: 'aa', same: true },
    alpha: { min: 0, max: 229, transparentFraction: 0.7, width: 640, height: 360 },
    timing: { ms: 12.5, budgetMs: 200, frames: 2 },
    params: MANIFEST.params.map((p) => ({ id: p.id, changed: true, to: 1, frame: 0 })),
    frame: 0,
  });
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.checks.map((c) => c.id), CONTRACT_CHECKS.map((c) => c.id));
  assert.deepEqual(clean.counts, { pass: 5, warn: 0, fail: 0 });
  assert.match(clean.checks[3].detail, /12\.5 ms/);
  assert.match(clean.checks[1].detail, /哈希一致/);
});

test('code-layer: each failure has a reason a person can act on', () => {
  const base = {
    sourceId: 'src_a', runtime: 'canvas2d', manifest: MANIFEST, frame: 0,
    scan: { errors: [], warnings: [] },
    determinism: { frame: 0, hash: 'aa', hashAgain: 'aa', same: true },
    alpha: { min: 0, max: 229, transparentFraction: 0.7 },
    timing: { ms: 10, budgetMs: 200 },
    params: [{ id: 'density', changed: true, to: 1, frame: 0 }],
  };
  const banned = evaluateContractCheck({
    ...base,
    scan: { errors: [{ file: 'sketch.js', line: 2, id: 'date-now', message: 'sketch.js:2 用了 Date.now() —— 读时钟' }], warnings: [] },
  });
  assert.equal(banned.ok, false);
  assert.match(banned.checks[0].detail, /Date\.now/);

  const flaky = evaluateContractCheck({ ...base, determinism: { frame: 0, hash: 'aa', hashAgain: 'bb', same: false } });
  assert.equal(flaky.ok, false);
  assert.match(flaky.checks[1].detail, /哈希不同/);

  const blank = evaluateContractCheck({ ...base, alpha: { min: 0, max: 0, transparentFraction: 1 } });
  assert.equal(blank.checks[2].status, 'fail');
  assert.match(blank.checks[2].detail, /全透明/);

  const solid = evaluateContractCheck({ ...base, alpha: { min: 255, max: 255, transparentFraction: 0 } });
  assert.equal(solid.checks[2].status, 'warn');
  assert.match(solid.checks[2].detail, /透明像素/);
  assert.equal(solid.ok, true, 'a hint is not a failure');

  const slow = evaluateContractCheck({ ...base, timing: { ms: 260, budgetMs: 200 } });
  assert.equal(slow.ok, false);
  assert.match(slow.checks[3].detail, /超过预算 200 ms/);

  const hardcoded = evaluateContractCheck({ ...base, params: [{ id: 'density', changed: false, to: 0.83, frame: 12, error: null }] });
  assert.equal(hardcoded.ok, false);
  assert.match(hardcoded.checks[4].detail, /写死/);
  assert.match(hardcoded.checks[4].detail, /第 12 帧/);

  const noParams = evaluateContractCheck({ ...base, manifest: { params: [] }, params: [] });
  assert.equal(noParams.checks[4].status, 'pass');
  assert.match(noParams.checks[4].detail, /没有声明参数/);
});

// ---------------------------------------------------------------------------
// End to end (real sandbox; skipped without Electron)
// ---------------------------------------------------------------------------

const ELECTRON = findElectron();
const electronSkip = !ELECTRON && 'no Electron on this machine';

async function tempProject(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-code-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const project = normalizeProject(createProject({ title: 'code-check', duration: 4, fps: 24 }));
  await fs.writeFile(path.join(dir, 'project.vdm.json'), `${JSON.stringify(project, null, 2)}\n`);
  return dir;
}

async function installSource(dir, runtime, patch = {}) {
  const id = 'src_tpl';
  const srcDir = path.join(dir, 'sources', id);
  await fs.mkdir(srcDir, { recursive: true });
  const templateDir = path.join(REPO, 'templates', 'code', runtime);
  for (const name of await fs.readdir(templateDir)) {
    if (name === 'manifest.json') continue;
    await fs.copyFile(path.join(templateDir, name), path.join(srcDir, name));
  }
  const manifest = { ...JSON.parse(await fs.readFile(path.join(templateDir, 'manifest.json'), 'utf8')), id };
  await fs.writeFile(path.join(srcDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, content] of Object.entries(patch)) await fs.writeFile(path.join(srcDir, name), content);
  return id;
}

function runCli(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'cli', 'vdm.js'), ...args], { cwd: REPO, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      reject(new Error(`vdm ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('code-layer: a shipped template passes all five contract checks', { skip: electronSkip }, async (t) => {
  const dir = await tempProject(t);
  const id = await installSource(dir, 'canvas2d');
  const run = await runCli(['source', 'check', id, '--project', dir, '--json']);
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const verdict = JSON.parse(run.stdout);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.checks.map((c) => [c.id, c.status, c.detail])) );
  assert.deepEqual(verdict.counts.fail, 0);
  assert.ok(verdict.ms > 0, 'a real per-frame number');
});

test('code-layer: a hard-coded parameter is caught by the real check', { skip: electronSkip }, async (t) => {
  const dir = await tempProject(t);
  const id = await installSource(dir, 'canvas2d', {
    'sketch.js': [
      'export function draw(ctx, vdm) {',
      '  // ignores vdm.param("density") on purpose',
      '  ctx.fillStyle = "rgba(255, 0, 0, 0.5)";',
      '  ctx.fillRect(0, 0, vdm.size[0] * 0.25, vdm.size[1] * 0.25);',
      '}',
    ].join('\n'),
  });
  const run = await runCli(['source', 'check', id, '--project', dir, '--json']);
  assert.equal(run.code, 1, 'the check must exit non-zero');
  const verdict = JSON.parse(run.stdout);
  const params = verdict.checks.find((c) => c.id === 'params');
  assert.equal(params.status, 'fail');
  assert.match(params.detail, /写死/);
});

test('code-layer: a source that reads the clock is caught by the real check', { skip: electronSkip }, async (t) => {
  const dir = await tempProject(t);
  const id = await installSource(dir, 'canvas2d', {
    'sketch.js': [
      'export function draw(ctx, vdm) {',
      '  const frames = Math.round((Date.now() - 1735689600000) / 1000 * vdm.fps);',
      '  ctx.fillStyle = `rgba(255, 255, 255, ${(frames % 2) * 0.5 + 0.3})`;',
      '  ctx.fillRect(0, 0, vdm.size[0] * 0.5, vdm.size[1] * 0.5);',
      '}',
    ].join('\n'),
  });
  const run = await runCli(['source', 'check', id, '--project', dir, '--json']);
  assert.equal(run.code, 1);
  const verdict = JSON.parse(run.stdout);
  const scan = verdict.checks.find((c) => c.id === 'static');
  assert.equal(scan.status, 'fail');
  assert.match(scan.detail, /Date\.now\(\)/);
});
