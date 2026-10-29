// Inspect service — measurements over the frame IR
// (docs/DESIGN-BACKEND-V2.md §8.2, WP2.1).
//
// What this file guards:
//   * `stackAt` reports the far-to-near order of core/layers.js::orderLayers
//     (with the per-item depth numbers) and the item that owns a pixel, decided
//     by the camera ray rather than by the draw order;
//   * `coverage` counts per-frame presence / on-screen / unoccluded samples of
//     one item (the geometric half of the pixel probe from
//     docs/FIX-LAYER-ORDER-EMPTY-CLICK.md 问题四);
//   * `cutEdges` finds an element tail that lives a fraction of a frame past a
//     camera cut (问题五) and reports nothing when the edges are aligned;
//   * `pxAt` is honest: geometry only, `readPixels: false`, limitations spelled
//     out;
//   * `diff` produces the changed[{id,kind,path,before,after}] report §8.3 asks
//     for, including per-keyframe entries and the two ignored revision fields;
//   * none of the measurements mutate the project, and the MCP entry
//     (`callTool`) returns exactly the same numbers as the direct call;
//   * one optional case runs against the miku-swiss copy the FIX document's
//     probes used, and skips with a reason when that copy is absent or is not
//     the documented rev-304 shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  INSPECT_VERSION, SAMPLE_GRID, coverage, cutEdges, diff, estimateTextBox,
  frameAt, openProject, pxAt, stackAt,
} from '../application/inspect-service.js';
import { buildFrameIR, FRAME_IR_VERSION } from '../core/frame-ir.js';
import { orderLayers } from '../core/layers.js';
import { callTool } from '../mcp/tools.js';

const root = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);

const nodeOf = (pivot, rotation = [0, 0, 0]) => ({ pivot, position: [0, 0, 0], scale: [1, 1, 1], rotation });

const element = (id, type, start, duration, z, node, extra = {}) => ({
  id, type, start, duration, z, visible: true,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  ...(node ? { node: nodeOf(node) } : {}),
  ...extra,
});

/**
 * Three layers on three planes with one camera: a 96 x 54 m backdrop at z = -2,
 * an opaque lyric at z = 0 and a translucent hint 1 m in front of it. The lyric
 * is nearer to the camera than the backdrop's centre but farther from it than
 * the backdrop's origin? No — here both origins are dead ahead, so the draw
 * order and the depth buffer agree; the side camera below breaks that.
 */
function sceneProject() {
  return {
    schema: 'vdm.project/1', rev: 12,
    meta: { title: 'inspect', fps: 30, width: 1920, height: 1080, duration: 3, background: '#000000', fx: {} },
    segments: [],
    elements: [
      element('bg', 'solid', 0, 3, 1, [0, 5, -2], { style: { w: 9600, h: 5400, fill: '#111111' } }),
      element('lyric', 'text', 1, 1, 5, [0, 5, 0], { style: { text: 'ながら', size: 190, color: '#F2F0EB', align: 'center' } }),
      {
        ...element('hint', 'text', 0.5, 2, 9, [0, 5, 1], { style: { text: 'note', size: 96, color: '#ffffff' } }),
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.4 },
      },
    ],
    cameras: [{ id: 'cam_a', name: 'A', path: [{ t: 0, pos: [0, 5, 20], look: [0, 5, 0] }], fov: 50, start: 0, duration: 3, visible: true }],
    cameraOrder: ['cam_a'], activeCameraId: 'cam_a',
    world: { source: 'city', seed: 1 },
  };
}

/**
 * The 问题四 shape: the lyric's origin is farther from the camera than the
 * backdrop's, so `orderLayers` draws the lyric first and the backdrop last —
 * while the lyric's plane is 2 m in front of the backdrop and owns the pixel.
 */
function sideCameraProject() {
  const p = sceneProject();
  p.cameras[0].path = [{ t: 0, pos: [8, 5, 20], look: [-4, 5, 0] }];
  p.elements[1].node = nodeOf([-6.5, 4.4, 0]);
  return p;
}

/** Three shots at 10 fps; every cut is an exact second. */
function cutProject() {
  return {
    schema: 'vdm.project/1', rev: 1,
    meta: { title: 'cuts', fps: 10, width: 320, height: 180, duration: 4.5, background: '#000000', fx: {} },
    segments: [],
    elements: [
      element('tail', 'solid', 0.5, 1.05, 0, null, { style: { w: 10, h: 10 } }), // ends f15.5, 0.5 f past the cut
      element('exact', 'solid', 0.5, 1, 0, null, { style: { w: 10, h: 10 } }), // ends exactly on the cut
      element('far', 'solid', 0.5, 0.6, 0, null, { style: { w: 10, h: 10 } }), // ends f11, 4 f before it
      element('span', 'solid', 0, 4.5, 0, null, { style: { w: 10, h: 10 } }), // crosses both cuts
    ],
    cameras: [
      { id: 'cam_a', name: 'a', path: [{ t: 0, pos: [0, 0, 10], look: [0, 0, 0] }], start: 0, duration: 1.5 },
      { id: 'cam_b', name: 'b', path: [{ t: 1.5, pos: [0, 0, 10], look: [0, 0, 0] }], start: 1.5, duration: 1.5 },
      { id: 'cam_c', name: 'c', path: [{ t: 3, pos: [0, 0, 10], look: [0, 0, 0] }], start: 3, duration: 1.5 },
    ],
    cameraOrder: ['cam_a', 'cam_b', 'cam_c'], activeCameraId: 'cam_a',
    world: { source: 'none' },
  };
}

// --------------------------------------------------------------- stackAt

test('inspect stackAt: far-to-near order is orderLayers, with per-item depth', () => {
  const project = sceneProject();
  const report = stackAt(project, 1.2);
  assert.equal(report.version, INSPECT_VERSION);
  assert.equal(report.ir, FRAME_IR_VERSION);
  assert.equal(report.rule, 'core/layers.js::orderLayers');
  assert.equal(report.frame, 36); // t = frame / fps, rounded (P5)
  assert.equal(report.t, 1.2);
  assert.equal(report.fps, 30);
  assert.equal(report.camera.id, 'cam_a');
  assert.equal(report.camera.mode, 'live');
  assert.deepEqual(report.point, [960, 540], 'the sampled pixel defaults to the frame centre');

  assert.deepEqual(report.order.map((row) => row.id), ['bg', 'lyric', 'hint']);
  // The order is literally the shared rule, not a second sort.
  const ir = buildFrameIR(project, 36, { fps: 30 });
  assert.deepEqual(report.order.map((row) => row.id), orderLayers(ir.items, ir.camera.pos).map((item) => item.id));

  for (const row of report.order) {
    for (const key of ['id', 'kind', 'z', 'depth', 'plane', 'distance']) assert.ok(key in row, `missing ${key}`);
    assert.ok(row.distance > 0);
    assert.ok(row.planeDistance > 0);
    assert.ok(row.rayDepth > 0);
    assert.ok(row.depth.bias >= 0);
    assert.equal(row.coversPoint, true, 'all three quads cover the centre');
  }
  // The backdrop is farther than the lyric, which is farther than the hint.
  assert.ok(report.order[0].distance > report.order[1].distance);
  assert.ok(report.order[1].distance > report.order[2].distance);
  // depth.bias is the 0.1 mm per el.z push of §4.4 (6 decimals, not rounded away).
  assert.equal(report.order[0].depth.bias, 0.0001);
  assert.equal(report.order[1].depth.bias, 0.0005);

  // The pixel is owned by the nearest plane; only depth writers occlude.
  assert.equal(report.hit, 'hint', 'preview.hitTest: nearest plane under the cursor');
  assert.equal(report.front, 'lyric', 'the translucent hint owns no depth');
  assert.equal(report.drawTop, 'hint');
  assert.equal(report.sortAgrees, true);
  assert.deepEqual(report.covering, ['bg', 'lyric', 'hint']);
  assert.deepEqual(report.depthOrder, ['hint', 'lyric', 'bg']);
});

test('inspect stackAt: a sort-only backend would show the wrong element (问题四 shape)', () => {
  const report = stackAt(sideCameraProject(), 1.2, { camera: 'cam_a', point: [960, 540] });
  const order = report.order.map((row) => row.id);
  assert.equal(order[0], 'lyric', 'the lyric origin is farther, so it is drawn first');
  assert.equal(order.indexOf('bg'), 1, 'the backdrop is drawn after it');
  assert.equal(report.hit, 'lyric', 'the depth buffer still shows the lyric');
  assert.equal(report.front, 'lyric');
  assert.equal(report.sortAgrees, false, 'last depth writer drawn is not the nearest one');
});

test('inspect stackAt: point null skips the pixel test; camera and errors are checked', () => {
  const project = sceneProject();
  const noPoint = stackAt(project, 1.2, { point: null });
  assert.equal(noPoint.point, null);
  assert.equal(noPoint.hit, null);
  assert.equal(noPoint.covering, null);
  assert.equal(noPoint.pointInsideFrame, null);
  assert.equal(noPoint.order.length, 3);
  assert.equal(noPoint.order[0].coversPoint, null);

  const outside = stackAt(project, 1.2, { point: [5000, 5000] });
  assert.equal(outside.pointInsideFrame, false);
  assert.deepEqual(outside.covering, []);

  assert.equal(stackAt(project, 1.2, { camera: 'cam_a' }).camera.id, 'cam_a');
  assert.equal(stackAt(project, 1.2, { frame: 45 }).frame, 45);
  assert.throws(() => stackAt(project, 1.2, { camera: 'cam_missing' }),
    (error) => error.code === 'INVALID_ARGUMENT' && /cam_missing/.test(error.message));
  assert.throws(() => stackAt(project, -1), (error) => error.code === 'INVALID_ARGUMENT');
});

test('inspect stackAt: a supplied text measurement wins over the estimate', () => {
  const project = sceneProject();
  const measured = stackAt(project, 1.2, { measureText: () => [120, 60] });
  assert.equal(measured.order.find((row) => row.id === 'lyric').sizeSource, 'measured');
  const estimated = stackAt(project, 1.2);
  assert.equal(estimated.order.find((row) => row.id === 'lyric').sizeSource, 'text-estimate');
  // A 120 x 60 px box still covers the centre (it is centred on its origin).
  assert.equal(measured.hit, 'hint');
});

// --------------------------------------------------------------- coverage

test('inspect coverage: per-frame presence and unoccluded samples of one item', () => {
  const report = coverage(sceneProject(), { f0: 29, f1: 31, focus: 'lyric' });
  assert.equal(report.frameCount, 3);
  assert.equal(report.focus, 'lyric');
  assert.deepEqual(report.focusSummary.absentFrames, [29], 'the lyric starts at 1.0 s = f30');
  assert.equal(report.focusSummary.framesPresent, 2);
  assert.equal(report.focusSummary.framesOnScreen, 2);
  assert.equal(report.focusSummary.framesUnoccluded, 2);
  assert.deepEqual(report.focusSummary.hiddenFrames, []);
  assert.equal(report.focusSummary.samples, 2 * SAMPLE_GRID * SAMPLE_GRID);
  assert.deepEqual(report.numbers[0], { frame: 29, present: false, onScreen: 0, unoccluded: 0 });
  assert.equal(report.numbers[1].present, true);
  assert.equal(report.numbers[1].unoccluded, SAMPLE_GRID * SAMPLE_GRID);
  // The sampled pixel is still the frame centre, with the full stack behind it.
  assert.deepEqual(report.framesDetail[1].covering, ['bg', 'lyric', 'hint'], 'the hint is live from 0.5 s');
  assert.equal(report.framesDetail[1].front, 'lyric');
});

test('inspect coverage: an opaque plane in front hides the focus item', () => {
  const project = sceneProject();
  project.elements.push(element('blocker', 'solid', 0, 3, 20, [0, 5, 1.5], { style: { w: 9600, h: 5400, fill: '#000000' } }));
  const report = coverage(project, { f0: 30, f1: 30, focus: 'lyric' });
  const row = report.framesDetail[0];
  assert.equal(row.focus.present, true);
  assert.ok(row.focus.onScreen > 0);
  assert.equal(row.focus.unoccluded, 0, 'the blocker owns depth and is nearer');
  assert.deepEqual(row.focus.occluders, ['blocker']);
  assert.deepEqual(report.focusSummary.hiddenFrames, [30]);
});

test('inspect coverage: the pixel-only form lists who covers the centre', () => {
  const report = coverage(sceneProject(), { f0: 36, f1: 36 });
  assert.equal(report.focus, null);
  assert.deepEqual(report.framesDetail[0].covering, ['bg', 'lyric', 'hint']);
  assert.equal(report.framesDetail[0].hit, 'hint');
  assert.deepEqual(report.numbers, [{ frame: 36, covering: 3, hit: 'hint' }]);
  assert.throws(() => coverage(sceneProject(), { f0: 0, f1: 1, focus: 'nope' }),
    (error) => error.code === 'INVALID_ARGUMENT');
});

// ------------------------------------------------------------------- pxAt

test('inspect pxAt: geometry only, with the limitations spelled out', () => {
  const report = pxAt(sceneProject(), { frame: 36, x: 960, y: 540 });
  assert.equal(report.mode, 'geometry');
  assert.equal(report.readPixels, false, 'a pure-Node read cannot produce a colour');
  assert.equal(report.insideFrame, true);
  assert.deepEqual(report.pixel, { x: 960, y: 540 });
  assert.deepEqual(report.covering.map((entry) => entry.id), ['bg', 'lyric', 'hint']);
  assert.equal(report.covering.find((entry) => entry.id === 'hint').writesDepth, false);
  assert.equal(report.covering.find((entry) => entry.id === 'lyric').writesDepth, true);
  assert.equal(report.front, 'lyric');
  assert.equal(report.hit, 'hint');
  assert.ok(report.limitations.length >= 4);
  assert.ok(report.limitations.some((line) => /no colour/.test(line)));
  assert.ok(report.limitations.some((line) => /glyph/.test(line)));

  const outside = pxAt(sceneProject(), { frame: 36, x: 9000, y: 9000 });
  assert.equal(outside.insideFrame, false);
  assert.deepEqual(outside.covering, []);
  assert.equal(outside.hit, null);

  assert.throws(() => pxAt(sceneProject(), { frame: 36, x: 1 }), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => pxAt(sceneProject(), { x: 1, y: 1 }), (error) => error.code === 'INVALID_ARGUMENT');
});

// --------------------------------------------------------------- cutEdges

test('inspect cutEdges: a sub-frame tail is found, aligned edges are not', () => {
  const report = cutEdges(cutProject());
  assert.equal(report.fps, 10);
  assert.equal(report.maxGapFrames, 1);
  assert.deepEqual(report.cuts.map((cut) => `${cut.camera}@f${cut.frame}`), ['cam_b@f15', 'cam_c@f30'],
    't = 0 is the head of the timeline, not a cut');
  assert.equal(report.scanned.cuts, 2);
  assert.equal(report.total, 1);
  const edge = report.edges[0];
  assert.equal(edge.id, 'tail');
  assert.equal(edge.edge, 'end');
  assert.equal(edge.camera, 'cam_b');
  assert.equal(edge.frame, 15.5);
  assert.equal(edge.cutFrame, 15);
  assert.equal(edge.deltaFrames, 0.5);
  assert.equal(edge.gapFrames, 0.5);
  assert.equal(edge.overlapFrames, 0.5, 'it lives half a frame into the next shot');
  assert.equal(edge.side, 'after-cut');

  assert.equal(cutEdges(cutProject(), { maxGapFrames: 0.4 }).total, 0);
  assert.equal(cutEdges(cutProject(), { maxGapFrames: 1.5 }).total, 1);
  assert.equal(cutEdges(cutProject()).spans.total, null, 'spans are opt-in');
});

test('inspect cutEdges: includeSpans lists elements that cross a cut', () => {
  const report = cutEdges(cutProject(), { includeSpans: true });
  assert.equal(report.spans.total, 3); // tail crosses cut 1, span crosses both
  assert.deepEqual([...new Set(report.spans.items.map((item) => item.id))], ['tail', 'span']);
  assert.ok(report.spans.items.every((item) => Number.isFinite(item.cutFrame)));
});

test('inspect cutEdges: a head that misses a cut is reported with a negative delta', () => {
  const project = cutProject();
  project.elements.push(element('head', 'solid', 1.45, 0.4, 0, null, { style: { w: 10, h: 10 } }));
  const report = cutEdges(project);
  const head = report.edges.find((edge) => edge.id === 'head');
  assert.equal(head.edge, 'start');
  assert.equal(head.deltaFrames, -0.5);
  assert.equal(head.gapFrames, 0.5);
  assert.equal(head.overlapFrames, 0);
  assert.equal(head.side, 'before-cut');
});

// -------------------------------------------------------------------- diff

test('inspect diff: §8.3 changed[] with scalar, keyframe and project paths', () => {
  const before = sceneProject();
  const after = structuredClone(before);
  after.rev = 13;
  after.meta.savedAt = '2026-10-29T00:00:00.000Z';
  after.meta.title = 'inspect v2';
  after.elements[0].style.fill = '#222222';
  after.elements[1].style.size = 150;
  after.elements[1].keyframes = [
    { t: 1, path: 'style.size', value: 190 },
    { t: 2, path: 'style.size', value: 150 },
  ];
  after.elements.push(element('added', 'solid', 0, 1, 2, null, { style: { w: 4, h: 4 } }));
  after.elements = after.elements.filter((el) => el.id !== 'hint');
  after.cameras[0].fov = 40;
  after.world.seed = 2;

  const report = diff(before, after);
  assert.equal(report.version, INSPECT_VERSION);
  assert.equal(report.equal, false);
  assert.deepEqual(report.before, { rev: 12, title: 'inspect' });
  assert.deepEqual(report.after, { rev: 13, title: 'inspect v2' });

  const entry = (id, path) => report.changed.find((row) => row.id === id && row.path === path);
  assert.deepEqual(entry('bg', 'style.fill'), {
    id: 'bg', kind: 'element', change: 'modified', path: 'style.fill', before: '#111111', after: '#222222',
  });
  assert.equal(entry('lyric', 'style.size').before, 190);
  assert.equal(entry('lyric', 'style.size').after, 150);
  const key = (t) => entry('lyric', `keyframes[${t}].style.size`);
  assert.equal(key(1).change, 'added', 'the project had no keyframes before');
  assert.equal(key(1).before, null);
  assert.equal(key(1).after.value, 190);
  assert.equal(key(2).change, 'added');
  assert.equal(key(2).after.value, 150);
  assert.equal(entry('hint', undefined), undefined, 'a deleted element is reported by its own entry');
  assert.equal(entry('cam_a', 'fov').after, 40);
  assert.equal(entry(null, 'meta.title').after, 'inspect v2');
  assert.equal(entry(null, 'world.seed').after, 2);
  assert.equal(entry(null, 'rev'), undefined, 'rev is ignored by default');
  assert.equal(entry(null, 'meta.savedAt'), undefined, 'savedAt is ignored by default');

  assert.deepEqual(report.added, [{ id: 'added', kind: 'element' }]);
  assert.deepEqual(report.removed, [{ id: 'hint', kind: 'element' }]);
  assert.equal(report.counts.byKind.project, 2);
  for (const row of report.changed) {
    assert.equal(typeof row.kind, 'string');
    assert.ok('before' in row && 'after' in row && 'change' in row);
  }
});

test('inspect diff: the same project is equal, and ignore adds paths', () => {
  const project = sceneProject();
  const self = diff(project, project);
  assert.equal(self.equal, true);
  assert.deepEqual(self.changed, []);
  assert.deepEqual(self.counts, { changed: 0, added: 0, removed: 0, byKind: {} });

  const after = structuredClone(project);
  after.meta.ui = { selection: ['lyric'] };
  assert.equal(diff(project, after).total, 1);
  assert.equal(diff(project, after, { ignore: ['meta.ui'] }).total, 0);
  assert.throws(() => diff(null, project), (error) => error.code === 'INVALID_ARGUMENT');
});

// ------------------------------------------------------- read-only + entry

test('inspect: every measurement leaves the project untouched', () => {
  const project = sceneProject();
  const snapshot = JSON.stringify(project);
  stackAt(project, 1.2);
  stackAt(project, 1.2, { point: null });
  coverage(project, { f0: 29, f1: 31, focus: 'lyric' });
  pxAt(project, { frame: 36, x: 960, y: 540 });
  cutEdges(project);
  diff(project, sceneProject());
  assert.equal(JSON.stringify(project), snapshot);
});

test('inspect: the MCP entry returns the same numbers as the direct call', async () => {
  const project = sceneProject();
  const client = {
    calls: [],
    async call(method) {
      this.calls.push(method);
      assert.equal(method, 'project.read');
      return project;
    },
  };

  const directStack = stackAt(project, 1.2);
  const stacked = await callTool(client, 'vdm_inspect_stack', { time: 1.2 });
  assert.equal(stacked.isError, false);
  assert.equal(stacked.structuredContent.hit, directStack.hit);
  assert.equal(stacked.structuredContent.front, directStack.front);
  assert.deepEqual(stacked.structuredContent.order.map((row) => row.id), directStack.order.map((row) => row.id));
  assert.deepEqual(stacked.structuredContent.order.map((row) => row.rayDepth), directStack.order.map((row) => row.rayDepth));

  const directCoverage = coverage(project, { f0: 29, f1: 31, focus: 'lyric' });
  const covered = await callTool(client, 'vdm_inspect_coverage', { from: 29, to: 31, focus: 'lyric' });
  assert.equal(covered.isError, false);
  assert.deepEqual(covered.structuredContent.numbers, directCoverage.numbers);
  assert.deepEqual(covered.structuredContent.focusSummary, directCoverage.focusSummary);

  const directCuts = cutEdges(cutProject());
  const cutsClient = { call: async () => cutProject() };
  const cuts = await callTool(cutsClient, 'vdm_inspect_cut_edges', {});
  assert.equal(cuts.isError, false);
  assert.deepEqual(cuts.structuredContent.edges, directCuts.edges);

  const after = structuredClone(project);
  after.elements[1].style.size = 150;
  const directDiff = diff(project, after);
  const diffed = await callTool(client, 'vdm_inspect_diff', { before: project, after });
  assert.equal(diffed.isError, false);
  assert.deepEqual(diffed.structuredContent.changed, directDiff.changed);

  // The live project is the default side.
  const oneSided = await callTool(client, 'vdm_inspect_diff', { before: after });
  assert.equal(oneSided.isError, false);
  assert.equal(oneSided.structuredContent.changed[0].after, 190, 'before=after-edited, after=live');
  assert.equal(oneSided.structuredContent.changed[0].before, 150);

  const bothMissing = await callTool(client, 'vdm_inspect_diff', {});
  assert.equal(bothMissing.isError, true);
  assert.equal(bothMissing.structuredContent.error.code, 'INVALID_ARGUMENT');

  const badCamera = await callTool(client, 'vdm_inspect_stack', { time: 1.2, camera: 'nope' });
  assert.equal(badCamera.isError, true);
  assert.equal(badCamera.structuredContent.error.code, 'INVALID_ARGUMENT');

  const badSchema = await callTool(client, 'vdm_inspect_coverage', { from: 'x', to: 1 });
  assert.equal(badSchema.isError, true);
});

test('inspect: the CLI prints the same JSON the service returns', async () => {
  const dir = fs.mkdtempSync(path.join(root, '.scratch', 'inspect-cli-'));
  try {
    fs.writeFileSync(path.join(dir, 'project.vdm.json'), JSON.stringify(sceneProject(), null, 2));
    const { stdout } = await run(process.execPath, [
      path.join(root, 'cli', 'vdm.js'), 'inspect', 'stack', '--at', '1.2', '--json', '--project', dir,
    ], { cwd: root });
    const report = JSON.parse(stdout);
    assert.equal(report.frame, 36);
    assert.equal(report.hit, 'hint');
    assert.deepEqual(report.order.map((row) => row.id), ['bg', 'lyric', 'hint']);

    const { stdout: cutsOut } = await run(process.execPath, [
      path.join(root, 'cli', 'vdm.js'), 'inspect', 'cut-edges', '--json', '--project', dir,
    ], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
    const cuts = JSON.parse(cutsOut);
    assert.equal(cuts.total, 0, 'the scene project has one camera and no cuts');
    assert.deepEqual(cuts.cuts, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- small bits

test('inspect: frameAt follows P5, estimateTextBox is deterministic', () => {
  const project = sceneProject();
  assert.equal(frameAt(project, 1.2), 36);
  assert.equal(frameAt(project, 1.21), 36);
  assert.equal(frameAt(project, 1.23), 37);
  assert.equal(frameAt(project, 0), 0);
  assert.throws(() => frameAt(project, -0.1), (error) => error.code === 'INVALID_ARGUMENT');

  const cjk = estimateTextBox({ text: 'ながら', fontSize: 190, lineHeight: 1.1 });
  const latin = estimateTextBox({ text: 'iiiii', fontSize: 190, lineHeight: 1.1 });
  assert.deepEqual(cjk, estimateTextBox({ text: 'ながら', fontSize: 190, lineHeight: 1.1 }));
  assert.ok(cjk[0] > latin[0], 'CJK advances are wider than narrow Latin');
  const twoLines = estimateTextBox({ text: 'a\nb', fontSize: 100 });
  const oneLine = estimateTextBox({ text: 'a', fontSize: 100 });
  assert.ok(twoLines[1] > oneLine[1]);
});

// ------------------------------------------------ optional: the real copy

/**
 * docs/FIX-LAYER-ORDER-EMPTY-CLICK.md's probes ran on a copy of the user's
 * project. When that copy is on disk, replay the three numbers; otherwise skip
 * with the reason (a checkout without `.scratch/` still runs the rest).
 */
test('inspect: the documented miku-swiss probes reproduce (optional real data)', async (t) => {
  const candidates = [
    path.join(root, '.scratch', 'wp0.1', 'miku-swiss'),
    path.join(root, '.scratch', 'miku-swiss'),
  ];
  const dir = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'project.vdm.json')));
  if (!dir) {
    t.skip(`no miku-swiss copy (looked in ${candidates.map((c) => path.relative(root, c)).join(', ')})`);
    return;
  }
  const project = await openProject(dir);
  const el = (id) => (project.elements || []).find((e) => e.id === id);
  const cut = (project.cameras || []).find((camera) => Math.abs(Number(camera.start) - 1.667) < 1e-3);
  if (project.meta.fps !== 30 || !el('s1_w2') || !el('s2_w4') || !el('s2_w2') || !cut) {
    t.skip('the copy is not the 2026-10-29 rev-304 shape this probe documents');
    return;
  }

  // 问题一 / 问题四 stack: at t = 3 s the centre pixel belongs to the lyric,
  // not to the plate behind it.
  const stack = stackAt(project, 3, { camera: 'cam_8' });
  assert.equal(stack.hit, 's2_w2');
  assert.equal(stack.front, 's2_w2');
  assert.ok(stack.covering.includes('s2_bg'), 'the backdrop is under the same pixel');
  assert.ok(stack.order.findIndex((row) => row.id === 's2_bg')
    < stack.order.findIndex((row) => row.id === 's2_w2'), 'plate drawn before the lyric');

  // 问题四 coverage: the lyric is present and not hidden on every frame
  // f142–f158, and it is gone from f159 (it ends at 5.3 s).
  const covered = coverage(project, { f0: 142, f1: 158, camera: 'cam_8', focus: 's2_w4' });
  assert.equal(covered.focusSummary.framesPresent, 17);
  assert.equal(covered.focusSummary.framesUnoccluded, 17, 'no frame has zero visible samples');
  assert.deepEqual(covered.focusSummary.offScreenFrames, []);
  assert.deepEqual(covered.focusSummary.hiddenFrames, []);
  const gone = coverage(project, { f0: 159, f1: 159, camera: 'cam_8', focus: 's2_w4' });
  assert.deepEqual(gone.focusSummary.absentFrames, [159]);

  // 问题五 cutEdges: the shipped data is aligned; the rev-303 data (a 1.700 s
  // tail, reproduced in memory) leaves s1_w2 alive 0.99 frames into cam_7.
  assert.equal(cutEdges(project).total, 0);
  const rev303 = structuredClone(project);
  rev303.elements.find((entry) => entry.id === 's1_w2').duration = 1.7 - Number(el('s1_w2').start);
  const replay = cutEdges(rev303);
  assert.equal(replay.total, 1);
  assert.equal(replay.edges[0].id, 's1_w2');
  assert.equal(replay.edges[0].edge, 'end');
  assert.equal(replay.edges[0].overlapFrames, 0.99);
  assert.equal(replay.edges[0].camera, cut.id);
  // The FIX document's full scan used 1.5 frames and found the same one edge.
  assert.equal(cutEdges(rev303, { maxGapFrames: 1.5 }).total, 1);

  // The report is stable JSON (no element objects leak, no NaN).
  const text = JSON.stringify({ stack, covered, replay });
  assert.ok(!text.includes('NaN'));
  assert.deepEqual(JSON.parse(text).stack.hit, 's2_w2');
});

test('inspect pixelCoverage: needs an element and a real preview', async () => {
  const { pixelCoverage } = await import('../application/inspect-service.js');
  // no element -> refused before anything boots
  await assert.rejects(() => pixelCoverage('.', {}), (e) => e.code === 'INVALID_ARGUMENT');
  // a missing project directory fails with a coded error, not a raw spawn crash
  await assert.rejects(
    () => pixelCoverage('/definitely/not/a/project', { elementId: 'x', f0: 0, f1: 0 }),
    (e) => e.code === 'PIXEL_PROBE_FAILED' || e.code === 'INVALID_ARGUMENT',
  );
});
