// Layer-list insertion planner (core/timeline-order.js): where a new row goes
// in meta.ui.timelineOrder and which z values keep the 2D stack in agreement.
// Pure unit tests; the big miku-shaped fixture lives in the Electron checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_Z_GAP, sameOrder, poolAnchors, rowInsertIndex, insertRow, planRowInsert,
  planInsertionZ, planMoveZ, renumber2D,
} from '../core/timeline-order.js';
import {
  cameraRef, objectRef, elementRef, propertyRef, keyframeRef,
} from '../core/selection.js';

// Same mixed list shape as .tmp/fixtures/order: cameras, a 3D row, 2D rows and
// an audio row interleaved (only the 2D relative order is semantic).
const order = [
  cameraRef('cam_3'), cameraRef('cam_2'), objectRef('ob_1'), elementRef('el_4'),
  cameraRef('cam_1'), elementRef('el_3'), elementRef('el_2'), elementRef('el_1'),
];

const el = (id, z, start = 0, type = 'solid') => ({ id, type, z, start, duration: 5 });
const mapOf = (els) => new Map(els.map((e) => [elementRef(e.id), e]));

const els = [el('el_1', 0), el('el_2', 1), el('el_3', 2), el('el_4', 3)];
const stack = ['el:el_4', 'el:el_3', 'el:el_2', 'el:el_1'];

// ---------------------------------------------------------------- row placement

test('no selection: the new row goes to the top of the list', () => {
  const plan = planRowInsert(order, [], 'el:new');
  assert.equal(plan.index, 0);
  assert.equal(plan.order[0], 'el:new');
  assert.equal(plan.order.length, order.length + 1);
});

test('selected 2D row: the new row is inserted one row above it', () => {
  const plan = planRowInsert(order, ['el:el_2'], 'el:new');
  assert.equal(plan.index, order.indexOf('el:el_2'));
  assert.deepEqual(plan.order.slice(5, 9), ['el:el_3', 'el:new', 'el:el_2', 'el:el_1']);
  assert.equal(sameOrder(plan.order.filter((r) => r !== 'el:new'), order), true);
});

test('selected camera / 3D / audio rows: insert above that row', () => {
  let plan = planRowInsert(order, ['cam:cam_1'], 'el:new');
  assert.equal(plan.index, 4);
  assert.equal(plan.order[4], 'el:new');
  assert.equal(plan.order[5], 'cam:cam_1');

  plan = planRowInsert(order, ['ob:ob_1'], 'el:new');
  assert.equal(plan.index, 2);
  assert.equal(plan.order[2], 'el:new');
  assert.equal(plan.order[3], 'ob:ob_1');

  const withAudio = ['el:au', 'cam:cam_1', 'el:el_2'];
  plan = planRowInsert(withAudio, ['el:au'], 'el:new');
  assert.equal(plan.index, 0);
  assert.equal(plan.order[0], 'el:new');
});

test('multi-selection: the topmost selected row is the anchor', () => {
  const plan = planRowInsert(order, ['el:el_1', 'ob:ob_1'], 'el:new');
  assert.equal(plan.index, 2, 'ob_1 is above el_1');
  // Order of the anchors in the pool does not matter.
  const swapped = planRowInsert(order, ['ob:ob_1', 'el:el_1'], 'el:new');
  assert.deepEqual(swapped, plan);
});

test('property / keyframe refs anchor at their host row', () => {
  const anchors = poolAnchors({
    kind: 'keyframe',
    ids: [
      keyframeRef(elementRef('el_3'), 'transform.x', 1.5),
      propertyRef(cameraRef('cam_1'), 'fov'),
    ],
  });
  assert.deepEqual(anchors, ['el:el_3', 'cam:cam_1']);
  const plan = planRowInsert(order, anchors, 'el:new');
  assert.equal(plan.index, 4, 'cam_1 is above el_3');
  assert.equal(plan.order[4], 'el:new');
});

test('stale refs are ignored: no anchor means the top row', () => {
  assert.equal(rowInsertIndex(order, ['el:gone', 'cam:gone']), 0);
  assert.equal(rowInsertIndex(order, ['ob:gone', 'el:el_1']), 7, 'the real ref still wins');
  const plan = planRowInsert(order, ['el:gone'], 'el:new');
  assert.equal(plan.index, 0);
  assert.equal(plan.order[0], 'el:new');
  // Insert is idempotent even when a stale plan already contains the ref.
  assert.deepEqual(insertRow(plan.order, 'el:new', 3).filter((r) => r === 'el:new'), ['el:new']);
});

// ---------------------------------------------------------------- 2D z slots

test('inserting a 2D row between neighbours takes their z midpoint', () => {
  const plan = planInsertionZ({
    stack: ['el:el_4', 'el:new', 'el:el_3', 'el:el_2', 'el:el_1'],
    elements: els,
    element: { id: 'new', type: 'text', start: 0 },
  });
  assert.equal(plan.z, 2.5);
  assert.deepEqual(plan.ops, []);
});

test('inserting at the top / bottom extends the 2D stack by one', () => {
  const byRef = mapOf(els);
  const top = planInsertionZ({ stack: ['el:new', ...stack], elements: els, element: { id: 'new', type: 'text', start: 0 } });
  assert.equal(top.z, 4);
  assert.deepEqual(top.ops, []);

  const bottom = planInsertionZ({ stack: [...stack, 'el:new'], elements: els, element: { id: 'new', type: 'text', start: 0 } });
  assert.equal(bottom.z, -1);
  assert.deepEqual(bottom.ops, []);
  assert.equal(byRef.size, 4, 'planner does not mutate the project elements');
});

test('the only 2D element starts at z 0', () => {
  const plan = planInsertionZ({ stack: ['el:new'], elements: [], element: { id: 'new', type: 'shape', start: 2 } });
  assert.equal(plan.z, 0);
  assert.deepEqual(plan.ops, []);
});

test('tie in z: the whole 2D stack is renumbered bottom-to-top', () => {
  // Two neighbours share the same z, so there is no midpoint slot.
  const tied = [el('el_a', 2), el('el_b', 2), el('el_c', 0)];
  const plan = planInsertionZ({
    stack: ['el:el_a', 'el:new', 'el:el_b', 'el:el_c'],
    elements: tied,
    element: { id: 'new', type: 'text', start: 0 },
  });
  // Targets are 3,2,1,0 from the top; el_a only gains 1, el_b drops to 1, el_c already 0.
  assert.equal(plan.z, 2);
  assert.deepEqual(plan.ops, [
    { op: 'reorder', id: 'el_a', z: 3 },
    { op: 'reorder', id: 'el_b', z: 1 },
  ]);
});

test('gap too tight for a midpoint: renumber instead of floating point soup', () => {
  const tight = [el('el_a', 2.0001), el('el_b', 2), el('el_c', 0)];
  assert.ok(2.0001 - 2 < MIN_Z_GAP);
  const plan = planInsertionZ({
    stack: ['el:el_a', 'el:new', 'el:el_b', 'el:el_c'],
    elements: tight,
    element: { id: 'new', type: 'shape', start: 0 },
  });
  assert.equal(plan.z, 2);
  assert.deepEqual(plan.ops, [
    { op: 'reorder', id: 'el_a', z: 3 },
    { op: 'reorder', id: 'el_b', z: 1 },
  ]);
});

test('tie-break by start: a z midpoint that would reorder the stack renumbers', () => {
  // Same z and same start: the sort comparator cannot tell the rows apart, so
  // the planner must not guess — it renumbers.
  const tied = [el('el_a', 1, 0), el('el_b', 1, 0)];
  const plan = planInsertionZ({
    stack: ['el:el_b', 'el:new', 'el:el_a'],
    elements: tied,
    element: { id: 'new', type: 'text', start: 0 },
  });
  assert.equal(plan.z, 1);
  assert.deepEqual(plan.ops, [
    { op: 'reorder', id: 'el_b', z: 2 },
    { op: 'reorder', id: 'el_a', z: 0 },
  ]);
});

test('a stale ref in the stack is skipped by renumber, never crashes', () => {
  const plan = planInsertionZ({
    stack: ['el:gone', 'el:new'],
    elements: [],
    element: { id: 'new', type: 'text', start: 0 },
  });
  // The deleted row is not a real neighbour: the new row is the only 2D row.
  assert.equal(plan.z, 0);
  assert.deepEqual(plan.ops, []);
  // Not in the stack at all: no z invented, no ops.
  const outside = planInsertionZ({ stack: ['el:el_1'], elements: els, element: { id: 'new', type: 'text', start: 0 } });
  assert.equal(outside.z, 0);
  assert.deepEqual(outside.ops, []);
});

// ---------------------------------------------------------------- moving rows

test('moving a 2D row reuses the midpoint rules without renumbering', () => {
  const byRef = mapOf(els);
  const ops = planMoveZ({ stack: ['el:el_4', 'el:el_1', 'el:el_3', 'el:el_2'], byRef, ref: 'el:el_1' });
  assert.deepEqual(ops, [{ op: 'reorder', id: 'el_1', z: 2.5 }]);
});

test('moving to the top / already in place', () => {
  const byRef = mapOf(els);
  assert.deepEqual(planMoveZ({ stack: ['el:el_1', 'el:el_4', 'el:el_3', 'el:el_2'], byRef, ref: 'el:el_1' }), [
    { op: 'reorder', id: 'el_1', z: 4 },
  ]);
  // Same display order as the current z values: nothing to do.
  assert.deepEqual(planMoveZ({ stack, byRef, ref: 'el:el_1' }), []);
  // A single-row stack has no slot to compute.
  assert.deepEqual(planMoveZ({ stack: ['el:el_1'], byRef, ref: 'el:el_1' }), []);
  // Unknown refs are harmless.
  assert.deepEqual(planMoveZ({ stack, byRef, ref: 'el:gone' }), []);
});

test('moving with no room falls back to a whole-stack renumber', () => {
  const tight = [el('el_a', 2.0001), el('el_b', 2), el('el_c', 0)];
  const byRef = mapOf(tight);
  // Put el_c between the two close neighbours.
  const ops = planMoveZ({ stack: ['el:el_a', 'el:el_c', 'el:el_b'], byRef, ref: 'el:el_c' });
  assert.deepEqual(ops, [
    { op: 'reorder', id: 'el_a', z: 2 },
    { op: 'reorder', id: 'el_c', z: 1 },
    { op: 'reorder', id: 'el_b', z: 0 },
  ]);
});

test('explicit renumber gives the top row the highest z and skips unchanged rows', () => {
  const byRef = mapOf([el('el_1', 0), el('el_2', 1), el('el_3', 2)]);
  assert.deepEqual(renumber2D(['el:el_3', 'el:el_1', 'el:el_2'], byRef), [
    { op: 'reorder', id: 'el_1', z: 1 },
    { op: 'reorder', id: 'el_2', z: 0 },
  ]);
  assert.deepEqual(renumber2D(['el:el_3'], byRef), [{ op: 'reorder', id: 'el_3', z: 0 }]);
  assert.deepEqual(renumber2D([], byRef), []);
});

test('miku-shaped mixed list: 2D rank ignores cameras, 3D rows and audio', () => {
  // Shape elements plus text/camera rows, like projects/miku-swiss (read-only
  // sample): the new 2D row's z rank counts only 2D refs above it.
  const miku = [
    cameraRef('cam_1'), elementRef('s7_tc'), elementRef('s7_tr'), objectRef('ob_2'),
    cameraRef('cam_2'), elementRef('s7_dot'), elementRef('s7_bg'), elementRef('au_1'),
  ];
  const elements = [
    el('s7_tc', 6, 1), el('s7_tr', 5, 1), el('s7_dot', 2, 2), el('s7_bg', 0, 0),
    el('au_1', 9, 0, 'audio'),
  ];
  // New shape above s7_dot (which sits below the 3D/camera rows); its z rank
  // counts only the two 2D rows above it, and it lands between their z values.
  const plan = planRowInsert(miku, ['el:s7_dot'], 'el:new');
  assert.equal(plan.index, 5);
  assert.equal(plan.order[4], 'cam:cam_2');
  assert.equal(plan.order[5], 'el:new');
  assert.equal(plan.order[6], 'el:s7_dot');
  const anchored = planInsertionZ({
    stack: ['el:s7_tc', 'el:s7_tr', 'el:new', 'el:s7_dot', 'el:s7_bg'],
    elements,
    element: { id: 'new', type: 'shape', start: 1 },
  });
  assert.deepEqual(anchored.ops, []);
  assert.equal(anchored.z, 3.5, 'between s7_tr z=5 and s7_dot z=2');
});
