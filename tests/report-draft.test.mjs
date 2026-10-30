// Report drafts — docs/DESIGN-WP2.5-REVIEW.md §10.4, WP2.5c.
//
// The draft is the human's side of a report: heterogeneous attachments plus
// symptom tags plus one sentence, none of which touches the project. These
// tests pin the validation, the dedupe and the "what to measure" table.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATTACHMENT_KINDS, ATTACHMENT_MAX, NOTE_MAX, REPORT_VERSION, SYMPTOMS,
  addAttachment, createDraft, draftSummary, measurePlan, normalizeAttachment,
  normalizeDraft, planMatches, removeAttachment, setNote, setTags,
} from '../core/report-draft.js';

const element = (ref = 'el_1') => ({ kind: 'element', ref, label: '01 词2' });

test('a new draft is empty, versioned and shares no state between calls', () => {
  const a = createDraft();
  const b = createDraft();
  assert.deepEqual(a, { version: REPORT_VERSION, attachments: [], tags: [], note: '' });
  a.attachments.push(element());
  assert.deepEqual(b.attachments, [], 'two drafts never share an array');
});

test('attachment kinds cover exactly the ones this release can show', () => {
  assert.deepEqual([...ATTACHMENT_KINDS], ['element', 'object', 'camera', 'property', 'keyframe', 'range', 'region', 'changeset']);
  assert.equal(SYMPTOMS.length, 9);
  assert.ok(SYMPTOMS.includes('预览和成片不一样'));
});

test('normalizeAttachment validates each kind and keeps the addressable fields', () => {
  assert.deepEqual(normalizeAttachment({ kind: 'range', ref: 'r1', from: 153, to: 144 }),
    { kind: 'range', ref: 'r1', label: 'r1', from: 144, to: 153 }, 'a reversed range is sorted');
  assert.deepEqual(normalizeAttachment({ kind: 'region', ref: 'g1', frame: 12.4, rect: [1, 2, 30.456, 40] }),
    { kind: 'region', ref: 'g1', label: 'g1', frame: 12, rect: [1, 2, 30.46, 40] });
  assert.deepEqual(normalizeAttachment({ kind: 'property', ref: 'el_1:style.size', host: 'el_1', path: 'style.size' }),
    { kind: 'property', ref: 'el_1:style.size', label: 'el_1:style.size', host: 'el_1', path: 'style.size' });
  assert.deepEqual(normalizeAttachment({ kind: 'keyframe', ref: 'k1', host: 'el_1', path: 'style.size', t: 4.2004 }),
    { kind: 'keyframe', ref: 'k1', label: 'k1', host: 'el_1', path: 'style.size', t: 4.2 });

  assert.throws(() => normalizeAttachment({ kind: 'audio', ref: 'a' }), /unknown attachment kind/);
  assert.throws(() => normalizeAttachment({ kind: 'element', ref: '' }), /needs a ref/);
  assert.throws(() => normalizeAttachment({ kind: 'range', ref: 'r' }), /from\/to/);
  assert.throws(() => normalizeAttachment({ kind: 'region', ref: 'g', frame: 1, rect: [1, 2, 3] }), /rect/);
  assert.throws(() => normalizeAttachment({ kind: 'property', ref: 'p', host: 'el_1' }), /host and path/);
  assert.throws(() => normalizeAttachment({ kind: 'keyframe', ref: 'k', host: 'el_1', path: 'x' }), /needs t/);
});

test('normalizeDraft drops what it cannot show instead of throwing', () => {
  const draft = normalizeDraft({
    attachments: [element(), element(), { kind: 'audio', ref: 'a' }, { kind: 'camera', ref: 'cam_8' }],
    tags: ['闪烁', '闪烁', '不存在的症状', '被挡住'],
    note: `  ${'很长的描述'.repeat(300)}  `,
  });
  assert.equal(draft.attachments.length, 2, 'the duplicate and the unknown kind are gone');
  assert.deepEqual(draft.tags, ['闪烁', '被挡住']);
  assert.equal(draft.note.length, NOTE_MAX);
});

test('addAttachment appends, dedupes by kind+ref and moves a repeat to the end', () => {
  let draft = createDraft();
  draft = addAttachment(draft, element('el_1'));
  draft = addAttachment(draft, { kind: 'camera', ref: 'cam_8', label: '8 号机位' });
  draft = addAttachment(draft, { ...element('el_1'), label: '01 词2（改名）' });
  assert.deepEqual(draft.attachments.map((a) => a.ref), ['cam_8', 'el_1']);
  assert.equal(draft.attachments[1].label, '01 词2（改名）');
});

test('removeAttachment removes by ref and ignores an unknown one', () => {
  const draft = addAttachment(createDraft(), element('el_1'));
  assert.deepEqual(removeAttachment(draft, 'el_1').attachments, []);
  assert.equal(removeAttachment(draft, 'nope').attachments.length, 1);
});

test('setTags keeps only the user-visible symptoms and setNote trims', () => {
  const draft = setTags(createDraft(), ['闪烁', 'style.size', '其它']);
  assert.deepEqual(draft.tags, ['闪烁', '其它']);
  assert.equal(setNote(draft, '  第二行被挡住了  ').note, '第二行被挡住了');
});

test('a draft never grows past the attachment cap', () => {
  let draft = createDraft();
  for (let i = 0; i < ATTACHMENT_MAX + 5; i++) draft = addAttachment(draft, element(`el_${i}`));
  assert.equal(draft.attachments.length, ATTACHMENT_MAX);
  assert.equal(draft.attachments.at(-1).ref, `el_${ATTACHMENT_MAX + 4}`);
});

test('draftSummary names the place and the symptoms', () => {
  let draft = addAttachment(createDraft(), { kind: 'range', ref: 'r', from: 144, to: 153 });
  draft = addAttachment(draft, element());
  draft = setTags(draft, ['闪烁']);
  const summary = draftSummary(draft);
  assert.equal(summary.title, '报告 f144–f153');
  assert.equal(summary.subtitle, '闪烁 · 2 个附件');
  assert.match(summary.line, /f144–f153 · 闪烁 · 2 个附件/);
  assert.equal(draftSummary(createDraft()).subtitle, '未标症状 · 0 个附件');
});

test('measurePlan: any element is measured at the report frame', () => {
  const plan = measurePlan(addAttachment(createDraft(), element()), { frame: 150 });
  assert.deepEqual(plan.map((step) => step.kind), ['frame']);
  assert.equal(plan[0].opts.elementId, 'el_1');
  assert.equal(plan[0].opts.frame, 150);
});

test('measurePlan: 看不见 / 闪烁 adds per-frame coverage around the frame or the range', () => {
  let draft = addAttachment(createDraft(), element());
  draft = setTags(draft, ['闪烁']);
  const around = measurePlan(draft, { frame: 100 });
  assert.deepEqual(around.map((step) => step.kind), ['frame', 'coverage']);
  assert.deepEqual([around[1].opts.f0, around[1].opts.f1], [90, 110], 'no range = ±10 frames');

  draft = addAttachment(draft, { kind: 'range', ref: 'r', from: 144, to: 153 });
  const ranged = measurePlan(draft, { frame: 100 });
  assert.deepEqual([ranged[1].opts.f0, ranged[1].opts.f1], [144, 153]);
  assert.ok(ranged.some((step) => step.kind === 'cutEdges'), 'a range also asks for cut edges');
});

test('measurePlan: a blocked region samples the stack at its centre', () => {
  let draft = addAttachment(createDraft(), { kind: 'region', ref: 'g1', frame: 30, rect: [100, 50, 40, 20] });
  draft = setTags(draft, ['被挡住']);
  const plan = measurePlan(draft, {});
  const stack = plan.find((step) => step.kind === 'stackAt');
  assert.deepEqual(stack.opts.point, [120, 60]);
  assert.equal(stack.opts.frame, 30);
});

test('measurePlan: two elements ask who is in front, a keyframe asks the beat gap', () => {
  let draft = addAttachment(createDraft(), element('el_1'));
  draft = addAttachment(draft, element('el_2'));
  assert.ok(measurePlan(draft, {}).some((step) => step.kind === 'pairs'));

  draft = addAttachment(draft, { kind: 'keyframe', ref: 'k1', host: 'el_1', path: 'style.size', t: 4.2 });
  draft = setTags(draft, ['没卡上拍']);
  const plan = measurePlan(draft, { fps: 24 });
  const beat = plan.find((step) => step.kind === 'beatGap');
  assert.equal(beat.opts.t, 4.2);
  assert.equal(beat.opts.fps, 24);
});

test('measurePlan: preview-vs-render is a pending background job, not a fake number', () => {
  const draft = setTags(addAttachment(createDraft(), element()), ['预览和成片不一样']);
  const step = measurePlan(draft, {}).find((item) => item.kind === 'blenderDiff');
  assert.equal(step.pending, true);
});

test('planMatches: a measurement is stale once its attachment leaves the draft', () => {
  const draft = addAttachment(createDraft(), element('el_1'));
  const plan = measurePlan(draft, {});
  assert.equal(planMatches(plan, draft), true);
  assert.equal(planMatches(plan, removeAttachment(draft, 'el_1')), false);
});
