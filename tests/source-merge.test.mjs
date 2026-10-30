// Three-way source merge — docs/DESIGN-BACKEND-V2.md §7.8.4 (WP4.4).
//
// Core (`core/source-merge.js`) is pure: the four conflict kinds, the
// whole-track rule and the invalid-shape fallback are tested against hand-made
// snapshots. The service half runs on a real throwaway project with the shared
// `html-title-card` fixture: mergeSource reads `base.json`, exports the editor
// layer, applies one transaction and records conflicts in a `needs-decision`
// change set (§8.1). One HTTP test covers `POST /api/sources/<id>/merge`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SOURCE_SNAPSHOT_VERSION } from '../core/version.js';
import { snapshotProblems } from '../core/source-eval.js';
import {
  MERGE_CONFLICT_KINDS, canonicalJson, editorSnapshotOf, hashPayload, merge, snapshotHash,
} from '../core/source-merge.js';
import { projectService } from '../engine/projects.js';
import { ChangeSetService } from '../application/changeset-service.js';
import {
  applyCompiled, basePath, clearFontCache, compileSource, mergeSource, readBase,
} from '../application/source-service.js';
import { normalizeProject } from '../core/schema.js';
import { setup as httpSetup, getter } from './helpers/http.mjs';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'sources', 'html-title-card');
const clone = (value) => JSON.parse(JSON.stringify(value));

// ----------------------------------------------------------------- core input
const node = (id, props, { type = 'text', tracks = [], parent = null } = {}) => ({ id, type, parent, props, tracks });
const snap = (nodes, source = 'demo') => ({ version: SOURCE_SNAPSHOT_VERSION, source, nodes });
const withNode = (snapshot, id, patch) => {
  const copy = clone(snapshot);
  const target = copy.nodes.find((entry) => entry.id === id);
  Object.assign(target, patch);
  return copy;
};

/** A node with one animated path: `transform.opacity` 0 → 1. */
const animated = (id, text, { opacity = [0, 1], type = 'text' } = {}) => node(id, {
  'style.text': text, 'transform.x': 0, 'transform.opacity': opacity[0],
}, {
  type,
  tracks: [
    { t: 0, path: 'transform.opacity', value: opacity[0], ease: 'easeInOut' },
    { t: 0.4, path: 'transform.opacity', value: opacity[1], ease: 'linear' },
  ],
});

test('merge: invalid shapes are rejected whole (§7.8.1 版本与降级)', () => {
  const legal = snap([node('n_a', { 'style.text': 'x' })]);
  const cases = [
    ['not an object', 'x'],
    ['nodes missing', { version: 1, source: 'demo' }],
    ['nodes not an array', { version: 1, source: 'demo', nodes: {} }],
    ['newer version', { ...legal, version: SOURCE_SNAPSHOT_VERSION + 1 }],
    ['unknown node key', snap([{ id: 'n_a', type: 'text', props: {}, tracks: [], extra: 1 }])],
    ['path outside SOURCE_PATHS', snap([node('n_a', { 'fx.blur': 2 })])],
    ['wrong value type', snap([node('n_a', { 'style.size': '96' })])],
    ['track without a baseline', snap([{ id: 'n_a', type: 'text', props: {}, tracks: [{ t: 0, path: 'transform.opacity', value: 1 }] }])],
    ['duplicate node ids', snap([node('n_a', {}), node('n_a', {})])],
    ['bad source id', { version: 1, source: 'not a source', nodes: [] }],
    ['two different sources', legal],
  ];
  for (const [label, input] of cases) {
    const ours = label === 'two different sources' ? snap([], 'other') : snap([]);
    const merged = merge(legal, ours, input);
    assert.deepEqual(merged, { result: null, conflicts: [] }, label);
  }
  // `{ nodes }` alone is a legal input shape too (headers are ignored, §7.8.4).
  const headerless = merge(legal, { nodes: [] }, { nodes: [] });
  assert.notEqual(headerless.result, null);
  assert.equal(headerless.result.source, 'demo');
});

test('merge: no conflict — both sides changed different paths', () => {
  const base = snap([animated('n_a', 'a', { opacity: [0, 1] })]);
  const ours = withNode(base, 'n_a', { props: { ...base.nodes[0].props, 'style.text': 'editor' } });
  const theirs = withNode(base, 'n_a', { props: { ...base.nodes[0].props, 'transform.x': 40 } });
  const { result, conflicts } = merge(base, ours, theirs);
  assert.deepEqual(conflicts, []);
  assert.equal(result.nodes.length, 1);
  const merged = result.nodes[0];
  assert.equal(merged.props['style.text'], 'editor', 'the editor change survives');
  assert.equal(merged.props['transform.x'], 40, 'the source change lands');
  assert.deepEqual(merged.tracks, base.nodes[0].tracks, 'the untouched source track survives');
  assert.deepEqual(Object.keys(result).sort(), ['hash', 'nodes', 'source', 'version']);
  assert.equal(result.version, SOURCE_SNAPSHOT_VERSION);
  assert.equal(result.source, 'demo');
  assert.match(result.hash, /^sha256:[0-9a-f]{64}$/);
});

test('merge: §7.8.4 row a/c/a — the editor change wins without a conflict', () => {
  const base = snap([node('n_a', { 'style.text': 'a', 'transform.x': 0 })]);
  const ours = snap([node('n_a', { 'style.text': 'c', 'transform.x': 0 })]);
  const theirs = snap([node('n_a', { 'style.text': 'a', 'transform.x': 0 })]);
  const { result, conflicts } = merge(base, ours, theirs);
  assert.deepEqual(conflicts, []);
  assert.equal(result.nodes[0].props['style.text'], 'c');
});

test('merge: conflict kind both-changed — six fields, theirs provisionally', () => {
  const base = snap([node('n_a', { 'style.text': 'a', 'transform.x': 0 })]);
  const ours = snap([node('n_a', { 'style.text': 'c', 'transform.x': 0 })]);
  const theirs = snap([node('n_a', { 'style.text': 'b', 'transform.x': 0 })]);
  const before = clone([base, ours, theirs]);
  const { result, conflicts } = merge(base, ours, theirs);
  assert.deepEqual([base, ours, theirs], before, 'merge 不改入参');
  assert.equal(conflicts.length, 1);
  assert.deepEqual(Object.keys(conflicts[0]).sort(), ['base', 'kind', 'nodeId', 'ours', 'path', 'theirs']);
  assert.deepEqual(conflicts[0], {
    nodeId: 'n_a', path: 'style.text', base: 'a', ours: 'c', theirs: 'b', kind: 'both-changed',
  });
  assert.equal(result.nodes[0].props['style.text'], 'b', '冲突暂取 theirs（由人决定）');
  assert.deepEqual([...MERGE_CONFLICT_KINDS], ['both-changed', 'node-deleted', 'node-collision', 'type-changed']);
});

test('merge: conflict kind node-deleted — the changed node disappears with a decision', () => {
  const base = snap([node('n_a', { 'style.text': 'a' }), node('n_keep', { 'style.text': 'k' })]);
  const ours = withNode(base, 'n_a', { props: { 'style.text': 'editor' } });
  const theirs = snap([node('n_keep', { 'style.text': 'k' })]);
  const { result, conflicts } = merge(base, ours, theirs);
  assert.deepEqual(result.nodes.map((entry) => entry.id), ['n_keep'], 'result 不含该节点');
  assert.equal(conflicts.length, 1);
  const [conflict] = conflicts;
  assert.deepEqual(Object.keys(conflict).sort(), ['base', 'kind', 'nodeId', 'ours', 'path', 'theirs']);
  assert.equal(conflict.nodeId, 'n_a');
  assert.equal(conflict.path, null, '节点级冲突 path = null');
  assert.equal(conflict.kind, 'node-deleted');
  assert.equal(conflict.theirs, null, '缺的那一侧写 null');
  assert.deepEqual(Object.keys(conflict.base).sort(), ['props', 'tracks', 'type']);
  assert.deepEqual(Object.keys(conflict.ours).sort(), ['props', 'tracks', 'type']);
  assert.equal(conflict.base.props['style.text'], 'a');
  assert.equal(conflict.ours.props['style.text'], 'editor');
  // The unchanged-editor row (a/a/节点没了) has no decision to make.
  const quiet = merge(base, base, theirs);
  assert.deepEqual(quiet.conflicts, []);
  assert.deepEqual(quiet.result.nodes.map((entry) => entry.id), ['n_keep']);
});

test('merge: conflict kind node-collision — ours is kept when theirs claims the id', () => {
  const base = snap([]);
  const ours = snap([node('n_a', { 'style.text': 'editor', 'style.size': 40 })]);
  const theirs = snap([node('n_a', { 'style.text': 'source', 'style.size': 96 })]);
  const { result, conflicts } = merge(base, ours, theirs);
  assert.equal(conflicts.length, 1);
  assert.deepEqual({
    nodeId: conflicts[0].nodeId, path: conflicts[0].path, base: conflicts[0].base, kind: conflicts[0].kind,
  }, {
    nodeId: 'n_a', path: null, base: null, kind: 'node-collision',
  });
  assert.equal(conflicts[0].ours.props['style.text'], 'editor');
  assert.equal(conflicts[0].theirs.props['style.text'], 'source');
  assert.equal(result.nodes[0].props['style.text'], 'editor', '保留 ours');
});

test('merge: conflict kind type-changed — the whole node comes from theirs', () => {
  const base = snap([node('n_a', { 'style.text': 'a', 'transform.x': 0 })]);
  const ours = snap([node('n_a', { 'style.text': 'editor', 'transform.x': 0 })]);
  const theirs = snap([node('n_a', { 'transform.x': 10, 'transform.opacity': 1 }, { type: 'solid' })]);
  const changed = merge(base, ours, theirs);
  assert.equal(changed.result.nodes[0].type, 'solid');
  assert.deepEqual(changed.result.nodes[0].props, { 'transform.x': 10, 'transform.opacity': 1 });
  assert.equal(changed.conflicts.length, 1);
  assert.equal(changed.conflicts[0].kind, 'type-changed');
  assert.equal(changed.conflicts[0].path, null);
  assert.equal(changed.conflicts[0].theirs.type, 'solid');
  // a/a/b with a type change: whole node from theirs, no conflict.
  const quiet = merge(base, base, theirs);
  assert.deepEqual(quiet.conflicts, []);
  assert.equal(quiet.result.nodes[0].type, 'solid');
});

test('merge: a track is one value — the whole key array conflicts once', () => {
  const base = snap([animated('n_a', 'a', { opacity: [0, 1] })]);
  const editorTrack = [
    { t: 0, path: 'transform.opacity', value: 0, ease: 'easeInOut' },
    { t: 0.4, path: 'transform.opacity', value: 0.5, ease: 'linear' },
  ];
  const sourceTrack = [
    { t: 0, path: 'transform.opacity', value: 0, ease: 'easeInOut' },
    { t: 0.4, path: 'transform.opacity', value: 1, ease: 'linear' },
    { t: 0.9, path: 'transform.opacity', value: 1, ease: 'linear' },
  ];
  const ours = withNode(base, 'n_a', { tracks: editorTrack });
  const theirs = withNode(base, 'n_a', { tracks: sourceTrack });
  const { result, conflicts } = merge(base, ours, theirs);
  assert.equal(conflicts.length, 1, '整条轨道一个值：不逐键拆冲突');
  const [conflict] = conflicts;
  assert.equal(conflict.path, 'transform.opacity');
  assert.equal(conflict.kind, 'both-changed');
  assert.ok(Array.isArray(conflict.base) && Array.isArray(conflict.ours) && Array.isArray(conflict.theirs));
  assert.equal(conflict.base.length, 2);
  assert.equal(conflict.ours.length, 2);
  assert.equal(conflict.theirs.length, 3);
  assert.deepEqual(conflict.theirs, sourceTrack, '轨道路径的冲突值是整条键数组');
  assert.deepEqual(result.nodes[0].tracks, sourceTrack, '暂取 theirs 的整条轨道');
  // The editor layer mirrors the baseline but never copies source tracks
  // (§7.8.1): a scalar equal to `props[path]` is "unchanged", not a deletion.
  const mirrored = withNode(base, 'n_a', { tracks: [], props: { ...base.nodes[0].props } });
  const quiet = merge(base, mirrored, theirs);
  assert.deepEqual(quiet.conflicts, []);
  assert.deepEqual(quiet.result.nodes[0].tracks, sourceTrack);
});

test('merge: the result hash matches the §7.8.1 recipe (node:crypto cross-check)', () => {
  const base = snap([animated('n_b', 'b'), node('n_a', { 'style.text': 'a', 'style.size': 96 })]);
  const ours = withNode(base, 'n_a', { props: { 'style.text': 'a', 'style.size': 120 } });
  const theirs = withNode(base, 'n_b', { tracks: [] });
  const { result } = merge(base, ours, theirs);
  const payload = { version: result.version, source: result.source, nodes: result.nodes };
  const expect = `sha256:${crypto.createHash('sha256')
    .update(canonicalJson(hashPayload(payload)), 'utf8').digest('hex')}`;
  assert.equal(result.hash, expect);
  assert.equal(result.hash, snapshotHash(payload));
  // Legal as a snapshot payload: the caller only adds compiler / builtAt.
  const problems = snapshotProblems({
    ...result, compiler: {}, builtAt: '1970-01-01T00:00:00.000Z',
  });
  assert.deepEqual(problems, []);
  // Deterministic: input order never decides the result.
  const flipped = merge(base, { ...ours, nodes: [...ours.nodes].reverse() }, { ...theirs, nodes: [...theirs.nodes].reverse() });
  assert.equal(flipped.result.hash, result.hash);
  assert.deepEqual(flipped.result.nodes.map((entry) => entry.id), ['n_a', 'n_b'], '§7.8.1: nodes sorted by id');
});

test('editorSnapshotOf: bound elements become a §7.8.1 node shape', () => {
  const elements = normalizeProject({
    rev: 1,
    meta: { width: 1920, height: 1080, duration: 2 },
    elements: [
      {
        id: 'el_a', type: 'text', start: 0, duration: 2,
        style: { text: '编辑器层', size: 88, color: '#ff5c7a' },
        transform: { x: 40, y: -12, scale: 1.2, rotation: 5, opacity: 1 },
        keyframes: [
          { t: 0, path: 'style.text', value: '第一句' },
          { t: 0.5, path: 'style.text', value: '第二句' },
          { t: 0, path: 'transform.x', value: 0 },
          { t: 0.5, path: 'transform.x', value: 40 },
          { t: 0, path: 'fx.blur', value: 2 },
        ],
        source: { id: 'demo', node: 'n_a' },
      },
      { id: 'el_b', type: 'text', start: 0, duration: 2, style: { text: 'x' } },
      { id: 'el_c', type: 'video', start: 0, duration: 2, source: { id: 'demo', node: 'n_c' } },
    ],
  }).elements;
  const snapshot = editorSnapshotOf(elements, 'demo');
  assert.equal(snapshot.source, 'demo');
  assert.deepEqual(snapshot.nodes.map((entry) => entry.id), ['n_a'], 'unbound and non-snapshot types are skipped');
  const exported = snapshot.nodes[0];
  assert.equal(exported.type, 'text');
  assert.equal(exported.props['style.text'], '编辑器层');
  assert.equal(exported.props['style.size'], 88);
  assert.equal(exported.props['transform.x'], 40);
  assert.equal(exported.props['transform.scale'], 1.2);
  assert.equal(exported.props['transform.rotation'], 5);
  assert.deepEqual(exported.tracks.map((key) => `${key.path}@${key.t}`), [
    'style.text@0', 'style.text@0.5', 'transform.x@0', 'transform.x@0.5',
  ], '每条 path 的整条键数组（非源路径被丢掉）');
  assert.deepEqual(snapshotProblems({
    ...snapshot, compiler: {}, builtAt: '1970-01-01T00:00:00.000Z', hash: `sha256:${'0'.repeat(64)}`,
  }), []);
  assert.deepEqual(editorSnapshotOf(elements, 'other').nodes, []);
});

// -------------------------------------------------------------------- service
/** `{ manifest, files }` of the shared fixture, as the registry stores it. */
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

/** Temp project with the fixture compiled and applied (§7.8.1 / §7.8.2). */
async function setupProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-source-merge-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); clearFontCache(); });
  const service = projectService(root);
  const changesets = new ChangeSetService(service);
  await service.transact({ command: { type: 'initialize', options: { title: 'source merge', duration: 2 } } });
  const { manifest, files } = await fixture();
  await service.transact({ ops: [{ op: 'sourceAdd', id: 'html-title-card', manifest, files }] });
  let project = await service.read();
  await compileSource({ project, sourceId: 'html-title-card', root });
  const applied = await applyCompiled({ project, sourceId: 'html-title-card', root });
  await service.transact({ ops: [applied.op] });
  project = await service.read();
  const byNode = (nodeId) => project.elements.find((el) => el.source?.id === 'html-title-card' && el.source.node === nodeId);
  return { root, service, changesets, project, byNode };
}

test('mergeSource: auto merge keeps both sides and writes the new base.json', async (t) => {
  const { root, service, changesets, byNode } = await setupProject(t);
  const kicker = byNode('n_kicker');
  const title = byNode('n_title');
  // Editor layer: move one element (a source path, but the source does not move it).
  await service.transact({ ops: [{ op: 'set', id: title.id, path: 'transform.x', value: 77.5 }] });
  // ...and a takeover decision the merge must not reset (§7.8.4).
  await service.transact({
    ops: [{ op: 'set', id: title.id, path: 'sourceMode', value: { 'transform.opacity': 'override' } }],
  });
  // Source side: change a text node.
  const base = await readBase({ root, sourceId: 'html-title-card' });
  const theirs = clone(base.snapshot);
  theirs.nodes.find((entry) => entry.id === 'n_kicker').props['style.text'] = 'WP4.4 · 合并后的源事实';
  const project = await service.read();
  const beforeRev = project.rev;

  const merged = await mergeSource({
    project, sourceId: 'html-title-card', root, theirs, changesets, actorId: 'test',
  });
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(Object.keys(merged.result).sort(), ['hash', 'nodes', 'source', 'version']);
  assert.equal(typeof merged.changesetId, 'string');

  const after = await service.read();
  assert.equal(after.rev, beforeRev + 1, 'merge = one transaction');
  assert.equal(after.elements.find((el) => el.id === kicker.id).style.text, 'WP4.4 · 合并后的源事实');
  assert.equal(after.elements.find((el) => el.id === title.id).transform.x, 77.5, '非冲突的编辑器修改一项不丢');
  assert.deepEqual(
    after.elements.find((el) => el.id === title.id).sourceMode,
    { 'transform.opacity': 'override' },
    '§7.8.4: 合并不改 el.sourceMode（用户的接管决定保留）',
  );

  const record = await changesets.get(merged.changesetId);
  assert.equal(record.status, 'applied');
  assert.equal(record.transactions.length, 1);
  assert.equal(record.ops.length, 1, 'one sourceApply op = one transaction');

  // base.json is the merged payload plus the caller's stamp (§7.8.4).
  const onDisk = JSON.parse(await fs.readFile(basePath(root, 'html-title-card'), 'utf8'));
  assert.equal(onDisk.hash, merged.result.hash);
  assert.deepEqual(onDisk.nodes, merged.result.nodes);
  assert.deepEqual(onDisk.compiler, base.snapshot.compiler);
  assert.match(onDisk.builtAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.deepEqual(snapshotProblems(onDisk), []);
});

test('mergeSource: conflicts become a needs-decision change set, revert is one step', async (t) => {
  const { root, service, changesets, byNode } = await setupProject(t);
  const kicker = byNode('n_kicker');
  await service.transact({ ops: [{ op: 'set', id: kicker.id, path: 'style.text', value: 'editor text' }] });
  const base = await readBase({ root, sourceId: 'html-title-card' });
  const theirs = clone(base.snapshot);
  theirs.nodes.find((entry) => entry.id === 'n_kicker').props['style.text'] = 'source text';
  const project = await service.read();

  const merged = await mergeSource({
    project, sourceId: 'html-title-card', root, theirs, changesets, actorId: 'test',
  });
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(merged.conflicts[0], {
    nodeId: 'n_kicker', path: 'style.text', base: base.snapshot.nodes.find((n) => n.id === 'n_kicker').props['style.text'],
    ours: 'editor text', theirs: 'source text', kind: 'both-changed',
  });
  const provisional = await service.read();
  assert.equal(provisional.elements.find((el) => el.id === kicker.id).style.text, 'source text', '冲突暂取 theirs');

  const record = await changesets.get(merged.changesetId);
  assert.equal(record.status, 'needs-decision');
  assert.equal(record.transactions.length, 1, '冲突也是一次事务');
  assert.equal(record.merge.sourceId, 'html-title-card');
  assert.deepEqual(record.merge.conflicts, merged.conflicts, '六字段原样进变更集');
  assert.equal(record.report.decisions.length, 1);
  assert.equal(record.report.decisions[0].reason, 'both-changed');
  assert.equal(record.report.decisions[0].id, 'n_kicker');
  assert.equal(record.report.decisions[0].path, 'style.text');
  assert.equal((await changesets.list({ status: 'needs-decision' })).total, 1);

  // 撤销一步：项目回到合并前的编辑器值（base.json 不在事务里，见报告）。
  const reverted = await changesets.revert({ id: merged.changesetId, actorId: 'test' });
  assert.equal(reverted.status, 'reverted');
  const back = await service.read();
  assert.equal(back.elements.find((el) => el.id === kicker.id).style.text, 'editor text');
});

test('mergeSource: without `theirs` it recompiles the registry in memory first', async (t) => {
  const { root, service, changesets, byNode } = await setupProject(t);
  const kicker = byNode('n_kicker');
  const oldBase = await readBase({ root, sourceId: 'html-title-card' });
  const html = await fs.readFile(path.join(FIXTURE, 'index.html'), 'utf8');
  const edited = html.replace('WP4.1 · 网页编译对拍（用例 L）', 'WP4.4 · 源侧改过的事实');
  assert.notEqual(edited, html);
  await service.transact({ ops: [{ op: 'sourceWrite', id: 'html-title-card', path: 'index.html', content: edited }] });
  const project = await service.read();

  const merged = await mergeSource({ project, sourceId: 'html-title-card', root, changesets, actorId: 'test' });
  assert.deepEqual(merged.conflicts, []);
  assert.notEqual(merged.result.hash, oldBase.snapshot.hash, 'the in-memory compile saw the new source');
  const after = await service.read();
  assert.equal(after.elements.find((el) => el.id === kicker.id).style.text, 'WP4.4 · 源侧改过的事实');
  assert.equal((await changesets.get(merged.changesetId)).status, 'applied');
});

test('mergeSource: a missing base.json or source is refused', async (t) => {
  const { root, service, changesets } = await setupProject(t);
  const project = await service.read();
  await assert.rejects(
    mergeSource({ project, sourceId: 'nope', root, changesets }),
    { code: 'SOURCE_NOT_FOUND' },
  );
  await assert.rejects(
    mergeSource({ project, sourceId: 'html-title-card', root }),
    { code: 'INVALID_ARGUMENT' },
  );
});

// ----------------------------------------------------------------------- HTTP
test('HTTP POST /api/sources/<id>/merge: conflicts are reviewable, one transaction', async (t) => {
  const { service, post } = await httpSetup(t);
  const get = getter(service);
  const { manifest, files } = await fixture();
  assert.equal((await post('api/ops', { ops: [{ op: 'sourceAdd', id: 'html-title-card', manifest, files }] })).status, 200);
  assert.equal((await post('api/sources/html-title-card/compile', {})).status, 200);
  assert.equal((await post('api/sources/html-title-card/apply', {})).status, 200);

  const projectResponse = await get('api/project');
  const kicker = projectResponse.body.project.elements
    .find((el) => el.source?.id === 'html-title-card' && el.source.node === 'n_kicker');
  assert.ok(kicker, 'the kicker element is bound to the source');
  const set = await post('api/ops', { ops: [{ op: 'set', id: kicker.id, path: 'style.text', value: 'editor text' }] });
  assert.equal(set.status, 200);

  const baseResponse = await get('api/sources/html-title-card/base');
  assert.equal(baseResponse.status, 200);
  const theirs = clone(baseResponse.body.snapshot);
  theirs.nodes.find((entry) => entry.id === 'n_kicker').props['style.text'] = 'source text';
  const mergeResponse = await post('api/sources/html-title-card/merge', { theirs, actorId: 'test' });
  assert.equal(mergeResponse.status, 200);
  const body = await mergeResponse.json();
  assert.equal(body.ok, true);
  assert.equal(body.source, 'html-title-card');
  assert.equal(body.conflicts.length, 1);
  assert.equal(body.conflicts[0].kind, 'both-changed');
  assert.match(body.result.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof body.changesetId, 'string');
  const bound = body.project.elements.find((el) => el.id === kicker.id);
  assert.equal(bound.style.text, 'source text', 'theirs is provisional until a human decides');

  const changeset = await get(`api/changesets/${body.changesetId}`);
  assert.equal(changeset.status, 200);
  assert.equal(changeset.body.changeset.status, 'needs-decision');
  assert.deepEqual(changeset.body.changeset.merge.conflicts, body.conflicts);
  assert.equal(changeset.body.changeset.merge.sourceId, 'html-title-card');
});
