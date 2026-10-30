// Source evaluation — the §7.8.2 overlay / takeover (WP4.2).
//
// What this file guards:
//   * the §7.8.1 snapshot contract: file header, node records, the closed
//     `SOURCE_PATHS` set, `props` as the t = 0 baseline, `tracks` in the exact
//     shape of `el.keyframes` — anything off ⇒ the whole snapshot is unusable;
//   * the three merge modes (`add` / `mul` / `override`), their degradations
//     (zero baseline, non-numeric `add`, opacity clamp) and the "a path the node
//     does not carry keeps the editor value" rule;
//   * the fixed six-step order inside `buildFrameIR`: links see the merged
//     values (§7.8.2 "加法 / 乘法可交换"), the parent chain is applied last;
//   * degradation: an element with `el.source` but no usable snapshot draws
//     exactly the no-source picture and says `fallback: 'editor-layer'`;
//   * the snapshot `hash` in the IRCache key.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SOURCE_SNAPSHOT_VERSION } from '../core/version.js';
import {
  SOURCE_PATHS, SOURCE_NUMERIC_PATHS, defaultSourceMode, isNumericSourcePath, isSourcePath,
  normalizeSnapshot, sameSourceValue, snapshotFor, snapshotProblems, sourceBaseAt,
  sourceMerge, sourceModeOf, sourceNodeAt, sourceSnapshotIds, sourceValueAt,
} from '../core/source-eval.js';
import { FRAME_IR_VERSION, IRCache, buildFrameIR } from '../core/frame-ir.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { compileProject } from '../core/tracks.js';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

const HEADER = () => ({
  version: SOURCE_SNAPSHOT_VERSION,
  source: 'html-lyrics',
  compiler: { name: 'source-service', version: 1, runtime: 'html', entry: 'index.html' },
  builtAt: '2026-10-30T09:41:12.345Z',
  hash: HASH_A,
});

/** A two-node snapshot: `n1` drives most paths, `n0` has a zero scale baseline. */
function snapshot(over = {}) {
  const nodes = over.nodes || [
    {
      id: 'n1',
      type: 'text',
      parent: null,
      props: {
        'style.text': '第一句',
        'style.font': 'SourceFont',
        'style.size': 100,
        'style.weight': 700,
        'style.color': '#112233',
        'style.align': 'left',
        'style.lineHeight': 1.5,
        'style.letterSpacing': 4,
        'src': 'media/src.png',
        'transform.x': 100,
        'transform.y': 50,
        'transform.scale': 2,
        'transform.rotation': 10,
        'transform.opacity': 0.5,
      },
      tracks: [
        { t: 0, path: 'style.text', value: '第一句' },
        { t: 1, path: 'style.text', value: '第二句' },
        { t: 0, path: 'transform.opacity', value: 0.5, ease: 'linear' },
        { t: 1, path: 'transform.opacity', value: 1, ease: 'linear' },
        { t: 0, path: 'transform.scale', value: 2, ease: 'linear' },
        { t: 1, path: 'transform.scale', value: 4, ease: 'linear' },
        { t: 0, path: 'transform.x', value: 100, ease: 'linear' },
        { t: 1, path: 'transform.x', value: 300, ease: 'linear' },
      ],
    },
    { id: 'n0', type: 'solid', parent: null, props: { 'transform.scale': 0 }, tracks: [] },
  ];
  return { ...HEADER(), ...over, nodes };
}

/** `evalElement`-shaped local values that mirror `n1`'s baselines. */
const stOf = (over = {}) => ({
  x: 40, y: 10, z: 0, scale: 1.5, rotation: 30, opacity: 0.8,
  text: '第一句', size: 100, color: '#112233', ...over,
});

const elOf = (over = {}) => ({
  id: 'el_src',
  type: 'text',
  style: {
    text: '第一句', font: 'SourceFont', size: 100, weight: 700, color: '#112233',
    align: 'left', lineHeight: 1.5, letterSpacing: 4,
  },
  src: 'media/src.png',
  source: { id: 'html-lyrics', node: 'n1' },
  ...over,
});

const mergeOf = (el, snap, t, st) => sourceMerge(el, normalizeSnapshot(snap), t, st);

// ---------------------------------------------------------------- snapshots

test('source snapshot: the §7.8.1 example validates and keeps its baselines', () => {
  const snap = snapshot();
  assert.deepEqual(snapshotProblems(snap), []);
  const norm = normalizeSnapshot(snap);
  assert.ok(norm);
  assert.equal(norm.version, SOURCE_SNAPSHOT_VERSION);
  assert.equal(norm.source, 'html-lyrics');
  assert.deepEqual(norm.nodes.map((n) => n.id), ['n1', 'n0'], 'node order is preserved');
  assert.equal(norm.byId.get('n1').props['style.text'], '第一句');
  assert.deepEqual(norm.byId.get('n1').parent, null);
  // Tracks are compiled for `sampleTrack`: same input, no second sort.
  assert.equal(sourceBaseAt(norm, 'n1', 'transform.x'), 100);
  assert.equal(sourceBaseAt(norm, 'n0', 'transform.x'), undefined);
  assert.equal(sourceNodeAt(norm, 'nope'), null);
  // The node index is not payload: a normalised snapshot still validates (and
  // normalises again) exactly like the JSON it came from.
  assert.deepEqual(snapshotProblems(norm), []);
  assert.ok(normalizeSnapshot(norm));
});

test('source snapshot: a wrong version, missing nodes or a bad path is unusable', () => {
  assert.equal(normalizeSnapshot(snapshot({ version: 0 })), null);
  assert.equal(normalizeSnapshot(snapshot({ version: 2 })), null);
  assert.equal(normalizeSnapshot(snapshot({ version: '1' })), null);
  const noNodes = snapshot();
  delete noNodes.nodes;
  assert.equal(normalizeSnapshot(noNodes), null);
  assert.equal(normalizeSnapshot(snapshot({ nodes: 'nope' })), null);
  // A path outside the closed set is illegal in `props` and in a track.
  const badProp = snapshot();
  badProp.nodes[0].props['transform.z'] = 1;
  assert.equal(normalizeSnapshot(badProp), null);
  const badTrack = snapshot();
  badTrack.nodes[0].tracks.push({ t: 0, path: 'style.shadow', value: 1 });
  assert.equal(normalizeSnapshot(badTrack), null);
  // A track without a baseline is illegal (§7.8.1).
  const noBase = snapshot();
  noBase.nodes[0].tracks.push({ t: 0, path: 'transform.rotation', value: 0 });
  assert.equal(normalizeSnapshot(noBase), null);
  // Values are typed per path: a numeric path is a number, the rest a string.
  const badType = snapshot();
  badType.nodes[0].props['style.size'] = '100';
  assert.equal(normalizeSnapshot(badType), null);
  const badString = snapshot();
  badString.nodes[0].props['style.color'] = 0x112233;
  assert.equal(normalizeSnapshot(badString), null);
  // Node ids, duplicates and header keys.
  const badId = snapshot();
  badId.nodes[0].id = '1 line';
  assert.equal(normalizeSnapshot(badId), null);
  const dupId = snapshot();
  dupId.nodes[1].id = 'n1';
  assert.equal(normalizeSnapshot(dupId), null);
  assert.equal(normalizeSnapshot({ ...snapshot(), hash: 'sha256:xyz' }), null);
  assert.equal(normalizeSnapshot({ ...snapshot(), builtAt: '' }), null);
  assert.equal(normalizeSnapshot({ ...snapshot(), extra: true }), null);
  assert.equal(normalizeSnapshot({ ...snapshot(), nodes: [{ ...snapshot().nodes[0], type: 'video' }] }), null);
});

test('source snapshot: `snapshotFor` takes a map or a resolver and never throws', () => {
  const snap = snapshot();
  assert.ok(snapshotFor({ 'html-lyrics': snap }, 'html-lyrics'));
  assert.ok(snapshotFor((id) => (id === 'html-lyrics' ? snap : null), 'html-lyrics'));
  assert.equal(snapshotFor({ 'html-lyrics': snap }, 'other'), null);
  assert.equal(snapshotFor({ 'html-lyrics': snap }, ''), null);
  assert.equal(snapshotFor(null, 'html-lyrics'), null);
  assert.equal(snapshotFor(() => { throw new Error('disk gone'); }, 'html-lyrics'), null);
  assert.equal(snapshotFor({ 'html-lyrics': { ...snap, version: 9 } }, 'html-lyrics'), null);
  assert.equal(snapshotFor(() => 'not a snapshot', 'html-lyrics'), null);
});

test('source snapshot: the id list that keys the cache is sorted and unique', () => {
  assert.deepEqual(sourceSnapshotIds([
    { source: { id: 'b' } }, { source: { id: 'a' } }, { source: { id: 'a' } }, {}, { source: { id: '' } },
  ]), ['a', 'b']);
  assert.deepEqual(sourceSnapshotIds([]), []);
  assert.deepEqual(sourceSnapshotIds(null), []);
});

test('source paths: the closed set, its defaults and its numeric members', () => {
  assert.equal(SOURCE_PATHS.length, 14);
  assert.equal(isSourcePath('transform.opacity'), true);
  assert.equal(isSourcePath('transform.z'), false);
  assert.equal(isNumericSourcePath('style.text'), false);
  assert.equal(isNumericSourcePath('style.size'), true);
  assert.deepEqual(
    [...SOURCE_NUMERIC_PATHS].sort(),
    ['style.letterSpacing', 'style.lineHeight', 'style.size', 'style.weight',
      'transform.opacity', 'transform.rotation', 'transform.scale', 'transform.x', 'transform.y'],
  );
  // §7.8.2: ratio units default to `mul`, everything else to `add`.
  assert.equal(defaultSourceMode('transform.scale'), 'mul');
  assert.equal(defaultSourceMode('transform.opacity'), 'mul');
  assert.equal(defaultSourceMode('transform.x'), 'add');
  assert.equal(defaultSourceMode('style.text'), 'add');
});

test('source values: baseline at t = 0, lerp inside, clamping outside, stepping text', () => {
  const norm = normalizeSnapshot(snapshot());
  assert.equal(sourceValueAt(norm, 'n1', 'transform.x', 0), 100);
  assert.equal(sourceValueAt(norm, 'n1', 'transform.x', 0.5), 200);
  assert.equal(sourceValueAt(norm, 'n1', 'transform.x', 2), 300, 'after the last key the last value');
  assert.equal(sourceValueAt(norm, 'n1', 'transform.opacity', 0.25), 0.625);
  assert.equal(sourceValueAt(norm, 'n1', 'transform.y', 0.5), 50, 'no track = the baseline');
  // String paths step at the key.
  assert.equal(sourceValueAt(norm, 'n1', 'style.text', 0.5), '第一句');
  assert.equal(sourceValueAt(norm, 'n1', 'style.text', 1), '第二句');
  // Neither `props` nor a track: the source has nothing to say.
  assert.equal(sourceValueAt(norm, 'n0', 'transform.x', 0.5), undefined);
  assert.equal(sourceValueAt(norm, 'missing', 'transform.x', 0), undefined);
});

test('source values: §7.8.1 equality rounds like the hash payload', () => {
  assert.equal(sameSourceValue(1, 1.0000004), true);
  assert.equal(sameSourceValue(1, 1.000002), false);
  assert.equal(sameSourceValue(0, -0), true);
  assert.equal(sameSourceValue('#fff', '#FFF'), false, 'strings compare verbatim');
  assert.equal(sameSourceValue([0, 1], [0, 1]), true);
  assert.equal(sameSourceValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
});

// ---------------------------------------------------------------- merge modes

test('merge: `add` is local + (src(t) - base)', () => {
  const merge = mergeOf(elOf(), snapshot(), 0.5, stOf());
  assert.equal(merge.values['transform.x'].mode, 'add');
  assert.equal(merge.values['transform.x'].base, 100);
  assert.equal(merge.values['transform.x'].src, 200);
  assert.equal(merge.values['transform.x'].value, 140); // 40 + (200 - 100)
  // A path with no track contributes its baseline, i.e. no delta.
  assert.equal(merge.values['transform.y'].value, 10);
});

test('merge: `mul` is local × src(t) / base (the ratio default of §7.8.2)', () => {
  const merge = mergeOf(elOf(), snapshot(), 0.5, stOf());
  assert.equal(merge.values['transform.scale'].mode, 'mul');
  assert.equal(merge.values['transform.scale'].base, 2);
  assert.equal(merge.values['transform.scale'].src, 3);
  assert.equal(merge.values['transform.scale'].value, 2.25); // 1.5 × 3 / 2
  assert.equal(merge.values['transform.opacity'].value, 1); // 0.8 × 0.75 / 0.5 = 1.2 → clamped
});

test('merge: `mul` on a zero baseline degrades to override (the editor value)', () => {
  const merge = mergeOf({ ...elOf(), source: { id: 'html-lyrics', node: 'n0' } }, snapshot(), 0.5, stOf());
  assert.equal(merge.values['transform.scale'].mode, 'mul');
  assert.equal(merge.values['transform.scale'].base, 0);
  assert.equal(merge.values['transform.scale'].value, 1.5, 'no ratio to apply, local stays');
});

test('merge: `override` means the editor owns the path and the source is ignored', () => {
  const el = elOf({ sourceMode: { 'transform.x': 'override', 'style.text': 'override' } });
  assert.equal(sourceModeOf(el, 'transform.x'), 'override');
  assert.equal(sourceModeOf(el, 'transform.scale'), 'mul', 'unlisted paths keep the unit default');
  assert.equal(sourceModeOf({ sourceMode: { 'transform.x': 'bogus' } }, 'transform.x'), 'add');
  const merge = mergeOf(el, snapshot(), 1, stOf({ text: '第一句' }));
  assert.equal(merge.values['transform.x'].value, 40, 'local, not the animated source');
  assert.equal(merge.values['style.text'].value, '第一句', 'local, not 第二句');
});

test('merge: opacity is clamped to 0..1 after the merge', () => {
  const high = mergeOf(elOf(), snapshot(), 1, stOf({ opacity: 0.9 }));
  assert.equal(high.values['transform.opacity'].value, 1, '0.9 × 1 / 0.5 = 1.8 → 1');
  const negative = normalizeSnapshot(snapshot({
    nodes: [{
      id: 'n1',
      type: 'solid',
      props: { 'transform.opacity': 1 },
      tracks: [{ t: 0, path: 'transform.opacity', value: 1 }, { t: 1, path: 'transform.opacity', value: -0.5 }],
    }],
  }));
  const low = sourceMerge(elOf(), negative, 1, stOf({ opacity: 0.5 }));
  assert.equal(low.values['transform.opacity'].value, 0, '0.5 × -0.5 / 1 = -0.25 → 0');
});

test('merge: a non-numeric `add` keeps whoever changed the value', () => {
  // Editor mirrors the baseline: the source steps the text.
  const mirrored = mergeOf(elOf(), snapshot(), 1, stOf({ text: '第一句' }));
  assert.equal(mirrored.values['style.text'].value, '第二句');
  // The editor changed it: the editor wins, the source cannot overwrite it.
  const edited = mergeOf(elOf(), snapshot(), 1, stOf({ text: '管理员改过' }));
  assert.equal(edited.values['style.text'].value, '管理员改过');
  assert.equal(edited.values['style.text'].mode, 'add');
  // `mul` has no multiplication for a string, so it follows the `add` rule.
  const mulText = mergeOf(elOf({ sourceMode: { 'style.text': 'mul' } }), snapshot(), 1, stOf({ text: '管理员改过' }));
  assert.equal(mulText.values['style.text'].value, '管理员改过');
});

test('merge: a path the node does not carry is left to the editor layer', () => {
  const norm = normalizeSnapshot(snapshot({ nodes: [{ id: 'n1', type: 'solid', props: { 'transform.x': 100 }, tracks: [] }] }));
  const merge = sourceMerge(elOf(), norm, 0.5, stOf());
  assert.deepEqual(Object.keys(merge.values), ['transform.x'], 'no guessed defaults for the rest');
  assert.equal(merge.values['transform.x'].value, 40, 'src = base = 100, so no delta');
  assert.equal(merge.values['transform.opacity'], undefined);
});

test('merge: a missing snapshot or node returns null instead of guessing', () => {
  assert.equal(sourceMerge(elOf(), null, 0, stOf()), null);
  assert.equal(sourceMerge(elOf({ source: { id: 'html-lyrics', node: 'nope' } }), normalizeSnapshot(snapshot()), 0, stOf()), null);
  assert.equal(sourceMerge(elOf({ source: undefined }), normalizeSnapshot(snapshot()), 0, stOf()), null);
});

// ---------------------------------------------------------------- IR wiring

/** A tiny project: one text element bound to `n1`, one source-less solid. */
function sourceProject({ source = { id: 'html-lyrics', node: 'n1' } } = {}) {
  const p = {
    ...createProject({ title: 'sources', duration: 2, fps: 10 }),
    elements: [
      {
        id: 'el_src', type: 'text', start: 0, duration: 2, z: 1,
        transform: { x: 40, y: 10, scale: 1.5, rotation: 30, opacity: 0.8 },
        style: {
          text: '第一句', font: 'SourceFont', size: 100, weight: 700, color: '#112233',
          align: 'left', lineHeight: 1.5, letterSpacing: 4,
        },
        src: 'media/src.png',
        ...(source ? { source } : {}),
      },
      {
        id: 'el_plain', type: 'solid', start: 0, duration: 2, z: 0,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        style: { w: 100, h: 100 },
      },
    ],
  };
  return normalizeProject(p);
}

const build = (p, frame, opts = {}) => {
  compileProject(p);
  return buildFrameIR(p, frame, { fps: 10, ...opts });
};

const jsonSafe = (v) => {
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonSafe(x);
    return out;
  }
  return Object.is(v, -0) ? 0 : v;
};

/** The IR minus what WP4.2 is allowed to move: `version` and `items[].source`. */
function picture(ir) {
  const copy = JSON.parse(JSON.stringify(jsonSafe(ir)));
  delete copy.version;
  for (const item of copy.items) delete item.source;
  return copy;
}

const itemOf = (ir, id) => ir.items.find((it) => it.id === id);

test('IR: the source values reach the item (§7.8.2 steps 2-3)', () => {
  const p = sourceProject();
  const ir = build(p, 5, { sourceSnapshots: { 'html-lyrics': snapshot() } });
  assert.equal(ir.version, FRAME_IR_VERSION);
  const item = itemOf(ir, 'el_src');
  // t = 0.5: the text steps at its key, size/scale/opacity/x interpolate.
  assert.equal(item.content.text, '第一句');
  assert.equal(item.content.font, 'SourceFont');
  assert.equal(item.content.weight, 700);
  assert.equal(item.content.align, 'left');
  assert.equal(item.content.lineHeight, 1.5);
  assert.equal(item.content.letterSpacing, 4);
  assert.equal(item.content.color, '#112233');
  assert.equal(item.opacity, 1, '0.8 × 0.75 / 0.5 = 1.2, clamped to 1');
  // x: local 40 + (src 200 - base 100) = 140 project px → 1.4 m from the centre
  assert.ok(Math.abs(item.world[12] - 1.4) < 1e-12, `world.x ${item.world[12]}`);
  assert.deepEqual(item.source, { id: 'html-lyrics', node: 'n1' });
});

test('IR: an image element takes `src` from the source', () => {
  const p = sourceProject();
  p.elements[0].type = 'image';
  p.elements[0].src = 'media/src.png';
  delete p.elements[0].style.text;
  const ir = build(p, 0, { sourceSnapshots: { 'html-lyrics': snapshot() } });
  assert.equal(itemOf(ir, 'el_src').content.src, 'media/src.png');
  // The editor moved the picture: its own src wins (`add`, whoever changed it).
  p.elements[0].src = 'media/other.png';
  const edited = build(p, 0, { sourceSnapshots: { 'html-lyrics': snapshot() } });
  assert.equal(itemOf(edited, 'el_src').content.src, 'media/other.png');
});

test('IR: no snapshot degrades the element to editor-layer, nothing else moves', () => {
  const bound = sourceProject();
  const plain = sourceProject({ source: null });
  const withoutSnapshot = build(bound, 5);
  const noSource = build(plain, 5);
  assert.deepEqual(picture(withoutSnapshot), picture(noSource), 'the no-source picture, field for field');
  assert.deepEqual(itemOf(withoutSnapshot, 'el_src').source, {
    id: 'html-lyrics', node: 'n1', fallback: 'editor-layer',
  });
  assert.equal(itemOf(withoutSnapshot, 'el_src').content.text, '第一句', 'the editor-layer text stays');
  assert.equal(itemOf(noSource, 'el_src').source, null);
  // ... and it never throws, however broken the snapshot is.
  const broken = build(bound, 5, { sourceSnapshots: { 'html-lyrics': { ...snapshot(), version: 9 } } });
  assert.deepEqual(picture(broken), picture(noSource));
  assert.equal(itemOf(broken, 'el_src').source.fallback, 'editor-layer');
});

test('IR: a snapshot without the node degrades the whole element', () => {
  const bound = sourceProject({ source: { id: 'html-lyrics', node: 'n_other' } });
  const plain = sourceProject({ source: null });
  const ir = build(bound, 5, { sourceSnapshots: { 'html-lyrics': snapshot() } });
  assert.deepEqual(picture(ir), picture(build(plain, 5)));
  assert.deepEqual(itemOf(ir, 'el_src').source, {
    id: 'html-lyrics', node: 'n_other', fallback: 'editor-layer',
  });
});

test('IR: the six steps — links see the merged value, the parent chain is last', () => {
  // Steps 1-4: the child's local opacity is 1, a `mul` link to a parent element
  // at 0.5 makes it 0.5, and the source `mul` (ratio 1.5 at t = 0.5) scales that
  // to 0.75. Add / mul commute, so this is the frozen order either way.
  const linked = sourceProject();
  linked.elements.push({
    id: 'el_link_src', type: 'solid', start: 0, duration: 2, z: 2,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    style: { w: 100, h: 100 },
    source: { id: 'html-lyrics', node: 'n1' },
    links: [{
      id: 'l_op', to: 'opacity', from: { host: 'el', id: 'el_plain', path: 'opacity' },
      combine: 'mul', bindParentValue: 1, enabled: true,
    }],
  });
  linked.elements[1].transform.opacity = 0.5;
  const ir = build(linked, 5, { sourceSnapshots: { 'html-lyrics': snapshot() } });
  assert.equal(itemOf(ir, 'el_link_src').opacity, 0.75, '0.5 (link) × 1.5 (source ratio)');

  // Steps 5-6: the parent's motion since the bind is added after everything.
  const p = normalizeProject({
    ...createProject({ title: 'parent', duration: 2, fps: 10 }),
    elements: [
      {
        id: 'papa', type: 'solid', start: 0, duration: 2, z: 0,
        transform: { x: 100, y: 0, scale: 1, rotation: 0, opacity: 1 },
        style: { w: 100, h: 100 },
        keyframes: [
          { t: 0, path: 'transform.x', value: 100, ease: 'linear' },
          { t: 1, path: 'transform.x', value: 300, ease: 'linear' },
        ],
      },
      {
        id: 'kid', type: 'solid', start: 0, duration: 2, z: 1,
        transform: { x: 30, y: 0, scale: 1, rotation: 0, opacity: 1 },
        style: { w: 100, h: 100 },
        source: { id: 'html-lyrics', node: 'n1' },
      },
    ],
  });
  applyOp(p, { op: 'spatialParent', id: 'kid', parent: 'papa', t: 0 });
  const frames = [0, 5, 10].map((f) => build(p, f, { sourceSnapshots: { 'html-lyrics': snapshot() } }));
  const xs = frames.map((f) => Math.round(itemOf(f, 'kid').world[12] * 1e9) / 1e9);
  assert.deepEqual(xs, [0.3, 2.3, 4.3], 'kid local 0.3 + source Δ + the parent motion since the bind');
  const papa = frames.map((f) => Math.round(itemOf(f, 'papa').world[12] * 1e9) / 1e9);
  assert.deepEqual(papa, [1, 2, 3], 'the parent itself only moves by its own keyframes');
});

test('IR: the cache key follows the snapshot hash (§7.8.2)', () => {
  const p = sourceProject();
  const cache = new IRCache();
  const one = snapshot();
  const first = build(p, 5, { cache, sourceSnapshots: { 'html-lyrics': one } });
  const again = build(p, 5, { cache, sourceSnapshots: { 'html-lyrics': one } });
  assert.equal(again, first, 'same rev + same hash = the cached frame');
  assert.equal(cache.hits, 1);
  assert.equal(cache.misses, 1);
  // A recompiled snapshot (new hash, re-keyed source animation, same rev) must
  // not be served from the old entry: the same local 40 px now sits on top of a
  // bigger source delta (300 - 100 = 200 px instead of 100 px).
  const recompiled = snapshot({
    hash: HASH_B,
    nodes: [{
      id: 'n1',
      type: 'text',
      props: { 'transform.x': 100 },
      tracks: [
        { t: 0, path: 'transform.x', value: 100, ease: 'linear' },
        { t: 1, path: 'transform.x', value: 500, ease: 'linear' },
      ],
    }],
  });
  const after = build(p, 5, { cache, sourceSnapshots: { 'html-lyrics': recompiled } });
  assert.notEqual(after, first);
  assert.ok(Math.abs(itemOf(after, 'el_src').world[12] - 2.4) < 1e-12, 'local 40 + 200 = 240 px');
  assert.ok(Math.abs(itemOf(first, 'el_src').world[12] - 1.4) < 1e-12, 'local 40 + 100 = 140 px');
  assert.equal(cache.hits, 1, 'the new hash was a miss');
  // The resolver shape keys the same way.
  const viaFunction = build(p, 5, { cache, sourceSnapshots: (id) => (id === 'html-lyrics' ? recompiled : null) });
  assert.equal(itemOf(viaFunction, 'el_src').world[12], itemOf(after, 'el_src').world[12]);
});

test('IR: a source-less project never enters the source logic', () => {
  const p = sourceProject({ source: null });
  for (const item of build(p, 0).items) assert.equal(item.source, null);
  // Passing snapshots changes nothing when nothing references them.
  const withSnaps = build(p, 0, { sourceSnapshots: { 'html-lyrics': snapshot() } });
  assert.deepEqual(picture(withSnaps), picture(build(p, 0)));
});
