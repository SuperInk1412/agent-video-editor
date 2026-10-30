// application/source-service.js — compile → base.json → apply (WP4.1, §7.8.1).
//
// Real files on a throwaway project: the compiler runs against the shared
// `html-title-card` fixture, the snapshot is read back from `.vdm/sources/`,
// and the elements go into the project through the one op path (one
// transaction).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectService } from '../engine/projects.js';
import { normalizeProject, validateProject, createProject } from '../core/schema.js';
import { applyOp, applyOps } from '../core/ops.js';
import { snapshotProblems } from '../core/source-eval.js';
import {
  applyCompiled, applyOpFor, basePath, canonicalJson, clearFontCache, compileSource,
  expandSourceOps, listSources, readBase, snapshotHash,
} from '../application/source-service.js';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'sources', 'html-title-card');

/** `{ manifest, files }` of the shared fixture, as the source registry stores it. */
async function fixture() {
  const names = await fs.readdir(FIXTURE);
  const files = {};
  let manifest = null;
  for (const name of names) {
    const text = await fs.readFile(path.join(FIXTURE, name), 'utf8');
    if (name === 'manifest.json') manifest = JSON.parse(text);
    else files[name] = text;
  }
  return { manifest, files };
}

/** Temp project with the fixture registered as a source. */
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-source-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); clearFontCache(); });
  const service = projectService(root);
  await service.transact({ command: { type: 'initialize', options: { title: 'source fixture', duration: 2 } } });
  const { manifest, files } = await fixture();
  await service.transact({ ops: [{ op: 'sourceAdd', id: 'html-title-card', manifest, files }] });
  let project = await service.read();
  return { root, service, manifest, files, getProject: () => project, setProject: (next) => { project = next; } };
}

test('compileSource writes a §7.8.1 snapshot and reports the compile', async (t) => {
  const { root, getProject } = await setup(t);
  const compiled = await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  assert.equal(compiled.source, 'html-title-card');
  assert.equal(compiled.runtime, 'html');
  assert.equal(compiled.entry, 'index.html');
  assert.match(compiled.hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(compiled.compiler, { name: 'source-service', version: 1, runtime: 'html', entry: 'index.html' });
  assert.match(compiled.builtAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  // The four marked nodes of the fixture, sorted by id, with §7.8.1 paths only.
  assert.deepEqual(compiled.nodes.map((node) => node.id), ['n_kicker', 'n_rule', 'n_subtitle', 'n_title']);
  for (const node of compiled.nodes) {
    assert.deepEqual(Object.keys(node).sort(), ['id', 'parent', 'props', 'tracks', 'type']);
    assert.ok(['text', 'solid', 'shape', 'image'].includes(node.type));
    assert.equal(snapshotProblems({ ...compiled.snapshot, nodes: [node] }).length, 0, `${node.id} is a legal snapshot node`);
  }
  const kicker = compiled.nodes.find((node) => node.id === 'n_kicker');
  assert.equal(kicker.type, 'text');
  assert.equal(kicker.props['style.size'], 18.36);
  assert.equal(kicker.props['style.align'], 'left');
  assert.match(kicker.props['style.text'], /WP4\.1/);
  // The animation is a source track in absolute seconds (WP4.1 fixture: 0 → 0.9 s).
  const opacity = kicker.tracks.filter((key) => key.path === 'transform.opacity');
  assert.ok(opacity.length >= 2);
  assert.ok(Math.abs(opacity[0].t - 0.05) < 1e-6, `first key at 0.05 s, got ${opacity[0].t}`);
  assert.equal(opacity[0].value, 0);
  // Every track path has a baseline (a track without one is not a legal snapshot).
  for (const node of compiled.nodes) {
    for (const key of node.tracks) assert.ok(Object.hasOwn(node.props, key.path), `${node.id} ${key.path} has a baseline`);
  }
  // The solid rule keeps its box + fill on the element (not a source path).
  const rule = compiled.elements.find((element) => element.source?.node === 'n_rule');
  assert.equal(rule.type, 'solid');
  assert.ok(rule.style.w > 0 && rule.style.h > 0);
  assert.match(rule.style.fill, /^#[0-9a-f]{6}$/);
  assert.equal(rule.source.id, 'html-title-card');
  // base.json exists, is exactly the snapshot, and validates.
  const file = basePath(root, 'html-title-card');
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(compiled.snapshot)));
  assert.equal(compiled.base, '.vdm/sources/html-title-card/base.json');
});

test('compileSource is deterministic: same source → same hash, new builtAt', async (t) => {
  const { root, getProject } = await setup(t);
  const first = await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  const second = await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  assert.equal(second.hash, first.hash);
  assert.equal(canonicalJson(first.nodes), canonicalJson(second.nodes));
  // §7.8.1: `builtAt` and `compiler` are not part of the hash.
  assert.equal(snapshotHash({ version: first.snapshot.version, source: first.source, nodes: first.nodes }), first.hash);
  assert.equal(snapshotHash({ ...first.snapshot, builtAt: '2000-01-01T00:00:00.000Z' }), first.hash);
  // A different source payload changes the hash.
  assert.notEqual(snapshotHash({ version: 1, source: 'x', nodes: [] }), snapshotHash({ version: 1, source: 'y', nodes: [] }));
});

test('compileSource refuses a non-compile runtime and a missing entry', async (t) => {
  const { root, service, getProject } = await setup(t);
  await service.transact({ ops: [{ op: 'sourceAdd', id: 'code_src', manifest: { runtime: 'p5', entry: 'sketch.js' }, files: { 'sketch.js': 'export default () => {};\n' } }] });
  const project = await service.read();
  await assert.rejects(compileSource({ project, sourceId: 'code_src', root }), /runtime/);
  await assert.rejects(compileSource({ project: getProject(), sourceId: 'missing', root }), { code: 'SOURCE_NOT_FOUND' });
  await assert.rejects(compileSource({ project, sourceId: 'bad id!', root }), { code: 'INVALID_ARGUMENT' });
});

test('readBase: valid snapshot, missing snapshot, broken snapshot', async (t) => {
  const { root, getProject } = await setup(t);
  const missing = await readBase({ root, sourceId: 'html-title-card' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.problems, ['not compiled']);
  await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  const valid = await readBase({ root, sourceId: 'html-title-card' });
  assert.equal(valid.ok, true);
  assert.equal(valid.snapshot.source, 'html-title-card');
  // A newer (or broken) snapshot is not partially parsed (§7.8.1 版本与降级).
  const file = basePath(root, 'html-title-card');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...raw, version: 99 }));
  const newer = await readBase({ root, sourceId: 'html-title-card' });
  assert.equal(newer.ok, false);
  assert.ok(newer.problems.some((problem) => problem.includes('version')));
  await fs.writeFile(file, '{ not json');
  const broken = await readBase({ root, sourceId: 'html-title-card' });
  assert.equal(broken.ok, false);
  assert.ok(broken.problems[0].startsWith('invalid json'));
});

test('applyCompiled builds one sourceApply op that upserts the elements in one transaction', async (t) => {
  const { root, service, getProject } = await setup(t);
  await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  const applied = await applyCompiled({ project: getProject(), sourceId: 'html-title-card', root });
  assert.equal(applied.op.op, 'sourceApply');
  assert.equal(applied.op.id, 'html-title-card');
  // 4 node-bound elements + the page background (solid fill + gradient bands).
  assert.equal(applied.op.elements.filter((element) => element.source).length, 4);
  assert.ok(applied.op.elements.length > 4, `background elements travel with the op (${applied.op.elements.length})`);
  assert.ok(applied.op.elements.filter((element) => !element.source).every((element) => element.type === 'solid'));
  const before = await service.read();
  const result = await service.transact({ ops: [applied.op] });
  assert.equal(result.rev, before.rev + 1, 'one transaction');
  assert.equal(result.didChange, true);
  const project = result.project;
  const bound = project.elements.filter((element) => element.source?.id === 'html-title-card');
  assert.equal(bound.length, 4);
  for (const element of bound) {
    assert.equal(typeof element.source.node, 'string');
    assert.equal(element.node, undefined, '§7.8.2: compiled elements use the legacy transform path');
    assert.equal(typeof element.transform.x, 'number');
    assert.equal(typeof element.transform.y, 'number');
  }
  const kicker = bound.find((element) => element.source.node === 'n_kicker');
  assert.equal(kicker.type, 'text');
  assert.match(kicker.style.text, /WP4\.1/);
  assert.equal(kicker.style.size, 18.36);
  // A zero-baseline ratio path is explicitly `add` so the animation is not lost.
  assert.deepEqual(kicker.sourceMode, { 'transform.opacity': 'add' });
  // The project on disk carries the binding and validates.
  const stored = JSON.parse(await fs.readFile(path.join(root, 'project.vdm.json'), 'utf8'));
  assert.equal(stored.elements.filter((element) => element.source?.id === 'html-title-card').length, 4);
  assert.deepEqual(validateProject(project), []);
  // One transaction = one rev, and a second identical apply does not duplicate.
  const again = await service.transact({ ops: [applied.op] });
  assert.equal(again.project.elements.filter((element) => element.source?.id === 'html-title-card').length, 4);
});

test('applyCompiled is idempotent: a second apply keeps the ids and the count', async (t) => {
  const { root, service, getProject } = await setup(t);
  await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  const first = await applyCompiled({ project: getProject(), sourceId: 'html-title-card', root });
  const afterFirst = (await service.transact({ ops: [first.op] })).project;
  const second = await applyCompiled({ project: afterFirst, sourceId: 'html-title-card', root });
  const afterSecond = (await service.transact({ ops: [second.op] })).project;
  const ids = (project) => project.elements.filter((element) => element.source?.id === 'html-title-card').map((element) => element.id).sort();
  assert.deepEqual(ids(afterSecond), ids(afterFirst));
  assert.equal(afterSecond.elements.length, afterFirst.elements.length);
  assert.equal(first.hash, second.hash);
});

test('applyCompiled compiles on demand and keeps the solid geometry from the compile', async (t) => {
  const { root, getProject } = await setup(t);
  // No base.json yet: apply compiles first (the same source always yields the
  // same hash, so the refresh is idempotent) instead of failing.
  const cold = await applyCompiled({ project: getProject(), sourceId: 'html-title-card', root });
  assert.ok(cold.elements.filter((element) => element.source).length === 4);
  assert.throws(
    () => applyOpFor({ project: { elements: [] }, snapshot: { version: 99, source: 'html-title-card', nodes: [] } }),
    { code: 'SOURCE_NOT_COMPILED' },
  );
  // Node-only payloads cannot rebuild element-layer geometry (§7.8.1 keeps only
  // the source paths), which is why apply takes the compile output.
  const compiled = await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  const { op } = applyOpFor({ project: { elements: [] }, snapshot: compiled.snapshot, elements: compiled.elements });
  const rule = op.elements.find((element) => element.source.node === 'n_rule');
  assert.ok(rule.style.w > 0 && rule.style.h > 0 && rule.style.fill);
  // Without a compile, the *current* elements supply the geometry: refreshing an
  // already-applied project from base.json alone must keep it intact.
  const project = createProject();
  applyOps(project, [op]);
  const refresh = applyOpFor({ project, snapshot: compiled.snapshot, elements: [] });
  assert.equal(refresh.op.elements.filter((element) => element.source).length, 4);
  assert.ok(refresh.op.elements.every((element) => element.type !== 'solid' || element.style.w > 0));
});

test('the sourceCompile / sourceApply ops are registered and validated by core', async (t) => {
  const { root, service, getProject } = await setup(t);
  const compiled = await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  // sourceCompile records the compile and changes nothing.
  const base = { elements: [], sources: (await service.read()).sources };
  const recorded = applyOp(base, { op: 'sourceCompile', id: 'html-title-card', compiled: { hash: compiled.hash, builtAt: compiled.builtAt, nodes: compiled.nodes.length } });
  assert.deepEqual(recorded.changed, []);
  assert.equal(recorded.compiled.hash, compiled.hash);
  assert.throws(() => applyOp(base, { op: 'sourceCompile', id: 'html-title-card', compiled: { hash: 'nope', nodes: 1 } }), /sha256/);
  assert.throws(() => applyOp(base, { op: 'sourceCompile', id: 'html-title-card' }), /base\.json/);
  // sourceApply without elements points at the application layer.
  assert.throws(() => applyOp(base, { op: 'sourceApply', id: 'html-title-card' }), /elements/);
  // A hand-built element payload is accepted, one op = one transaction step.
  const applied = await applyCompiled({ project: getProject(), sourceId: 'html-title-card', root });
  const project = createProject();
  const result = applyOps(project, [applied.op]);
  assert.equal(project.elements.filter((element) => element.source).length, 4);
  assert.equal(result.changed.length, applied.op.elements.length);
  // Re-applying with a changed payload updates in place instead of duplicating.
  const moved = JSON.parse(JSON.stringify(applied.op));
  const target = moved.elements.find((element) => element.source);
  target.transform.x = 123;
  const total = project.elements.length;
  applyOps(project, [moved]);
  assert.equal(project.elements.length, total);
  assert.equal(project.elements.find((element) => element.source?.node === target.source.node).transform.x, 123);
});

test('expandSourceOps: an op with only { id } resolves through the service', async (t) => {
  const { root, service, getProject } = await setup(t);
  const expanded = await expandSourceOps([{ op: 'sourceCompile', id: 'html-title-card' }], { project: getProject(), root });
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].op, 'sourceCompile');
  assert.match(expanded[0].compiled.hash, /^sha256:[0-9a-f]{64}$/);
  const apply = await expandSourceOps([{ op: 'sourceApply', id: 'html-title-card' }], { project: getProject(), root });
  assert.equal(apply[0].op, 'sourceApply');
  assert.equal(apply[0].elements.filter((element) => element.source).length, 4);
  // A batch is expanded recursively; unrelated ops pass through.
  const nested = await expandSourceOps([{ op: 'batch', ops: [{ op: 'setMeta', patch: { title: 'x' } }, { op: 'sourceApply', id: 'html-title-card' }] }], { project: getProject(), root });
  assert.equal(nested[0].ops.length, 2);
  assert.equal(nested[0].ops[1].op, 'sourceApply');
  // Through the write path an agent may send the short form and still get one transaction.
  const before = await service.read();
  const result = await service.transact({ ops: [{ op: 'sourceCompile', id: 'html-title-card' }] });
  assert.equal(result.didChange, false, 'a compile changes no project state');
  assert.equal(result.rev, before.rev);
  const applied = await service.transact({ ops: [{ op: 'sourceApply', id: 'html-title-card' }] });
  assert.equal(applied.rev, before.rev + 1);
  assert.equal(applied.project.elements.filter((element) => element.source?.id === 'html-title-card').length, 4);
  // A dry run compiles in memory and writes nothing.
  const stamp = (await fs.stat(basePath(root, 'html-title-card'))).mtimeMs;
  await service.transact({ dryRun: true, ops: [{ op: 'sourceApply', id: 'html-title-card' }] });
  assert.equal((await fs.stat(basePath(root, 'html-title-card'))).mtimeMs, stamp);
});

test('listSources reports the registry and the compile status', async (t) => {
  const { root, service, getProject } = await setup(t);
  const before = await listSources({ project: getProject(), root });
  assert.equal(before.sources.length, 1);
  const entry = before.sources[0];
  assert.equal(entry.id, 'html-title-card');
  assert.equal(entry.runtime, 'html');
  assert.equal(entry.entry, 'index.html');
  assert.equal(entry.compilable, true);
  assert.equal(entry.compiled, null);
  assert.ok(entry.files.includes('manifest.json') && entry.files.includes('style.css'));
  await compileSource({ project: getProject(), sourceId: 'html-title-card', root });
  const after = await listSources({ project: await service.read(), root });
  assert.equal(after.sources[0].compiled.valid, true);
  assert.equal(after.sources[0].compiled.nodes, 4);
  assert.equal(after.sources[0].compiled.hash, (await readBase({ root, sourceId: 'html-title-card' })).snapshot.hash);
  assert.equal(entry.manifest.format, 'vdm.source/1');
});

test('a code element cannot be bound to a compile source (it has no per-frame plan)', async (t) => {
  const { service } = await setup(t);
  // The registry accepts html; a `code` layer over it would ask the pool to
  // rasterise a page (§7.8.6 #8), so validation reports it.
  const project = await service.read();
  const broken = normalizeProject({
    ...JSON.parse(JSON.stringify(project)),
    elements: [{ id: 'el_code', type: 'code', start: 0, duration: 2, code: { source: 'html-title-card' } }],
  });
  const issues = validateProject(broken);
  assert.ok(issues.some((issue) => issue.path === 'elements[0].code.source'), JSON.stringify(issues));
  // ...and a normal element with a source binding survives normalisation (§7.8.2).
  const bound = normalizeProject({
    ...JSON.parse(JSON.stringify(project)),
    elements: [{
      id: 'el_t', type: 'text', start: 0, duration: 2, style: { text: 'hi' },
      source: { id: 'html-title-card', node: 'n_title' }, sourceMode: { 'transform.opacity': 'add', bogus: 'mul' },
    }],
  });
  assert.deepEqual(bound.elements[0].source, { id: 'html-title-card', node: 'n_title' });
  assert.deepEqual(bound.elements[0].sourceMode, { 'transform.opacity': 'add' });
  // A keyframe on a bound element is the editor layer, untouched by apply.
  const withKeys = applyOps(normalizeProject(createProject()), [
    { op: 'addElement', element: { id: 'el_k', type: 'text', duration: 2, style: { text: 'x' } } },
  ]).changed;
  assert.deepEqual(withKeys, ['el_k']);
});

