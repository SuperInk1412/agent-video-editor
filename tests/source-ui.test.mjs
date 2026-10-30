// Source marks and overlay/takeover switches (WP4.6a) — the pure half of
// app/renderer/js/source-badge.js and app/renderer/js/inspector-source-mode.js.
//
// What this file guards:
//   * the §7.2 R1 gate: a switch exists only for a property the source really
//     drives (a snapshot `props` / `tracks` path, or one `el.sourceMode` already
//     names), never for every property of a source element;
//   * the one-way door in the hover text (§7.4 R1: undo is the only way back);
//   * the write: one `set` op on the *whole* flat `sourceMode` table — the
//     dotted path `sourceMode.transform.x` would nest the table and core would
//     drop it, so this test applies the op through core/ops.js and then checks
//     the schema still accepts the project;
//   * 全部叠加 / 全部接管: one `batch` transaction over every driven path.
//
// The DOM (badge, 12×12 row mark, the switch itself) is exercised by the
// Electron probe scripts/check-source-ui.mjs, not by Node.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SOURCE_SNAPSHOT_VERSION } from '../core/version.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import {
  SOURCE_RECOVER_TIP, hasSource, setSourceSnapshots, sourceDrivenPaths, sourceDrives,
  sourceIdOf, sourceLabel, sourceMarkTip, sourceNodeIdOf, sourceNodeOf, sourceSnapshots,
  sourceSnapshotOf, sourceTip,
} from '../app/renderer/js/source-badge.js';
import {
  OVERLAY, TAKEOVER, overlayMode, overlayTip, rowSourceMode, sourceAllOp, sourceModeOp,
  sourceModeTable, takeoverMode, takeoverTip,
} from '../app/renderer/js/inspector-source-mode.js';

const HASH = `sha256:${'c'.repeat(64)}`;

/** A one-node snapshot: `h1` drives text / size / x / opacity, nothing else. */
const snapshot = () => ({
  version: SOURCE_SNAPSHOT_VERSION,
  source: 'title-card',
  compiler: { name: 'source-service', version: 1, runtime: 'html', entry: 'index.html' },
  builtAt: '2026-10-30T09:41:12.345Z',
  hash: HASH,
  nodes: [{
    id: 'h1',
    type: 'text',
    parent: null,
    props: {
      'style.text': '标题', 'style.size': 120, 'transform.x': 100, 'transform.opacity': 0.5,
    },
    tracks: [
      { t: 0, path: 'style.size', value: 120 },
      { t: 1, path: 'style.size', value: 180 },
    ],
  }],
});

const elOf = (over = {}) => ({
  id: 'el_src',
  type: 'text',
  start: 0,
  duration: 4,
  z: 1,
  source: { id: 'title-card', node: 'h1' },
  style: { text: '标题', size: 120, color: '#e3e8f0' },
  ...over,
});

/**
 * A real project with one source element. The binding is written into the
 * document (there is no `sourceBind` op yet — WP4.2/4.4's compile flow owns it),
 * so the project goes through `normalizeProject`, exactly like a load.
 */
function projectWithSource(over = {}) {
  const base = createProject({ title: 'source ui', duration: 4, width: 960, height: 540 });
  base.elements.push({
    id: 'el_src', name: '标题', type: 'text', start: 0, duration: 4, z: 1,
    source: { id: 'title-card', node: 'h1' },
    style: { text: '标题', size: 120, color: '#e3e8f0' },
    visible: true,
    ...over,
  });
  return normalizeProject(base);
}

test('source-badge: a binding is read without any snapshot, a mark needs none', () => {
  const el = elOf();
  assert.equal(hasSource(el), true);
  assert.equal(hasSource({ id: 'el_plain', type: 'solid' }), false);
  assert.equal(hasSource({ source: { node: 'h1' } }), false, 'an id is required');
  assert.equal(sourceIdOf(el), 'title-card');
  assert.equal(sourceNodeIdOf(el), 'h1');
  assert.equal(sourceIdOf({}), '');
  // Without a snapshot the element still knows its ids; the switch does not.
  setSourceSnapshots({});
  assert.equal(sourceNodeOf(el), null);
  assert.deepEqual(sourceDrivenPaths(el), []);
});

test('source-badge: driven paths are the snapshot node paths, in SOURCE_PATHS order', () => {
  setSourceSnapshots({ 'title-card': snapshot() });
  const driven = sourceDrivenPaths(elOf());
  assert.deepEqual(driven, ['style.text', 'style.size', 'transform.x', 'transform.opacity']);
  assert.equal(sourceDrives(elOf(), 'style.size'), true);
  assert.equal(sourceDrives(elOf(), 'style.color'), false, 'the node carries no colour');
  assert.equal(sourceDrives(elOf(), 'transform.scale'), false);
});

test('source-badge: `el.sourceMode` keeps its own paths on the switch list (§7.2 R1)', () => {
  setSourceSnapshots({ 'title-card': snapshot() });
  const driven = sourceDrivenPaths(elOf({ sourceMode: { 'style.color': 'override', 'transform.z': 'add' } }));
  assert.deepEqual(driven, ['style.text', 'style.size', 'style.color', 'transform.x', 'transform.opacity']);
  assert.equal(driven.includes('transform.z'), false, 'a non-source path is not a switch');
  // No snapshot at all: only the paths the project already names.
  setSourceSnapshots({});
  assert.deepEqual(sourceDrivenPaths(elOf({ sourceMode: { 'style.color': 'override' } })), ['style.color']);
});

test('source-badge: label prefers the manifest label, then the id', () => {
  const project = { sources: [{ id: 'title-card', manifest: { label: '标题卡' } }] };
  assert.equal(sourceLabel(project, elOf()), '标题卡');
  assert.equal(sourceLabel({ sources: [{ id: 'title-card', manifest: {} }] }, elOf()), 'title-card');
  assert.equal(sourceLabel({}, elOf()), 'title-card');
});

test('source-badge: hover text carries the ids and the undo-only warning (§7.4 R1)', () => {
  const tip = sourceTip({}, elOf());
  assert.match(tip, /title-card/);
  assert.match(tip, /h1/);
  assert.match(tip, /只能用撤销恢复/);
  assert.match(sourceMarkTip({}, elOf()), /只能用撤销恢复/);
  assert.equal(SOURCE_RECOVER_TIP, '脱离后不再跟随源码更新，只能用撤销恢复');
});

test('source-badge: the snapshot registry validates and caches once', () => {
  setSourceSnapshots({ 'title-card': snapshot(), broken: { version: 99 } });
  assert.deepEqual(Object.keys(sourceSnapshots()), ['title-card', 'broken']);
  const first = sourceSnapshotOf('title-card');
  assert.ok(first && Array.isArray(first.nodes));
  assert.equal(sourceSnapshotOf('title-card'), first, 'the same object answers twice');
  assert.equal(sourceSnapshotOf('broken'), null, 'an invalid snapshot degrades to none');
  assert.equal(sourceSnapshotOf('nope'), null);
  setSourceSnapshots(null);
  assert.equal(sourceSnapshotOf('title-card'), null);
});

test('source-mode: overlay is the default, takeover needs every path to be override', () => {
  const el = elOf();
  assert.equal(rowSourceMode(el, ['transform.opacity']), OVERLAY);
  assert.equal(rowSourceMode(el, ['transform.opacity']), OVERLAY, 'mul is still overlay');
  assert.equal(rowSourceMode(elOf({ sourceMode: { 'transform.opacity': 'override' } }), ['transform.opacity']), TAKEOVER);
  assert.equal(
    rowSourceMode(elOf({ sourceMode: { 'transform.x': 'override' } }), ['transform.x', 'transform.y']),
    OVERLAY,
    'a half-taken-over vector row stays on 叠加',
  );
  assert.equal(rowSourceMode({ id: 'plain' }, ['transform.x']), OVERLAY);
});

test('source-mode: the table keeps the unit default per path', () => {
  assert.equal(overlayMode('transform.opacity'), 'mul', 'ratio paths overlay by multiplying');
  assert.equal(overlayMode('transform.scale'), 'mul');
  assert.equal(overlayMode('style.size'), 'add');
  assert.equal(overlayMode('style.text'), 'add');
  assert.equal(takeoverMode(), 'override');
  assert.deepEqual(sourceModeTable(elOf(), ['transform.opacity', 'style.text'], TAKEOVER),
    { 'transform.opacity': 'override', 'style.text': 'override' });
  assert.deepEqual(sourceModeTable(elOf(), ['transform.opacity', 'style.text'], OVERLAY),
    { 'transform.opacity': 'mul', 'style.text': 'add' });
  // Existing entries survive a switch on another path.
  const kept = sourceModeTable(elOf({ sourceMode: { 'style.color': 'override' } }), ['style.text'], OVERLAY);
  assert.equal(kept['style.color'], 'override');
  assert.equal(kept['style.text'], 'add');
});

test('source-mode: one switch click is one flat-table `set` op', () => {
  assert.equal(sourceModeOp(elOf(), [], TAKEOVER), null);
  assert.equal(sourceModeOp({ id: 'plain' }, ['transform.x'], TAKEOVER), null, 'no binding, no write');
  assert.equal(sourceModeOp(elOf(), ['transform.x'], 'bogus'), null);
  const op = sourceModeOp(elOf(), ['transform.x', 'transform.opacity'], TAKEOVER);
  assert.equal(op.op, 'set');
  assert.equal(op.id, 'el_src');
  assert.equal(op.path, 'sourceMode');
  assert.deepEqual(op.value, { 'transform.x': 'override', 'transform.opacity': 'override' });
});

test('source-mode: the op survives core/ops.js and the schema', () => {
  const p = projectWithSource();
  const el = p.elements[0];
  applyOp(p, sourceModeOp(el, ['transform.opacity'], TAKEOVER));
  // Flat keys: a dotted `set` path would have produced `sourceMode.transform`,
  // which core/schema.js drops on load — this is the assertion that catches it.
  assert.deepEqual(p.elements[0].sourceMode, { 'transform.opacity': 'override' });
  assert.deepEqual(validateProject(p).filter((issue) => /source/i.test(issue.path)), []);
  applyOp(p, sourceModeOp(p.elements[0], ['transform.opacity'], OVERLAY));
  assert.deepEqual(p.elements[0].sourceMode, { 'transform.opacity': 'mul' });
  assert.deepEqual(validateProject(p).filter((issue) => /source/i.test(issue.path)), []);
});

test('source-mode: 全部叠加 / 全部接管 is one batch transaction', () => {
  setSourceSnapshots({ 'title-card': snapshot() });
  const el = elOf();
  const all = sourceAllOp(el, TAKEOVER);
  assert.equal(all.op, 'batch');
  assert.equal(all.ops.length, 1, 'one element = one `set` inside the batch');
  assert.deepEqual(all.ops[0].value, {
    'style.text': 'override', 'style.size': 'override', 'transform.x': 'override', 'transform.opacity': 'override',
  });
  const p = projectWithSource();
  applyOp(p, all);
  assert.equal(Object.keys(p.elements[0].sourceMode).length, 4);
  applyOp(p, sourceAllOp(p.elements[0], OVERLAY));
  assert.deepEqual(p.elements[0].sourceMode, {
    'style.text': 'add', 'style.size': 'add', 'transform.x': 'add', 'transform.opacity': 'mul',
  });
  // Nothing driven (no snapshot, no table) ⇒ no empty transaction.
  setSourceSnapshots({});
  assert.equal(sourceAllOp(elOf(), TAKEOVER), null);
});

test('source-mode: hover text spells out the ratio rule (§7.2 R1)', () => {
  assert.match(overlayTip(['transform.opacity']), /相乘/);
  assert.match(overlayTip(['transform.scale', 'transform.x']), /相加/);
  assert.match(overlayTip(['style.size']), /相加/);
  assert.match(overlayTip(['style.text']), /本地值/);
  assert.match(overlayTip(['transform.opacity']), /一次撤销/);
  assert.match(takeoverTip(), /覆盖/);
  assert.match(takeoverTip(), /一次撤销/);
});
