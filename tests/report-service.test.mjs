// Report service — docs/DESIGN-WP2.5-REVIEW.md §10.4-7/8, WP2.5c.
//
// A report is stored under `.vdm/reports/`, never in the project, and it is
// re-measured against the current revision. These tests pin the measurement
// plan, the honest verdicts and the file round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyOp } from '../core/ops.js';
import { addAttachment, createDraft, setTags } from '../core/report-draft.js';
import { projectService } from '../engine/projects.js';
import {
  createReport, judge, listReports, measureDraft, readReport, remeasureReport,
  reportsDir, saveReport, verdictOf,
} from '../application/report-service.js';

const FPS = 24;

/**
 * A real project through the one write path: `initialize` gives it the default
 * camera, then one screen-space solid is added at `x` project pixels.
 */
async function fixture(t, { x = 0, beats = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = projectService(root);
  await service.transact({ command: { type: 'initialize', options: { title: 'report', duration: 4, fps: FPS } } }, { actorId: 'cli' });
  await service.transact({
    ops: [{
      op: 'addElement',
      element: {
        id: 'el_1', type: 'solid', start: 0, duration: 4, z: 1,
        style: { w: 80, h: 80, fill: '#ff0000' },
        transform: { x, y: 0 },
      },
    }],
  }, { actorId: 'ui' });
  const project = await service.read();
  if (beats) {
    project.meta.beats = beats;
    await service.transact({ command: { type: 'replace', project } }, { actorId: 'ui' });
  }
  return { root, project: await service.read() };
}

const elementDraft = () => addAttachment(createDraft(), { kind: 'element', ref: 'el_1', label: '色块' });

test('createReport measures the report frame and stores it under .vdm/reports', async (t) => {
  const { root, project } = await fixture(t);
  const report = createReport({ project, draft: elementDraft(), frame: 12 });

  assert.match(report.id, /^rp_[0-9a-f]{16}$/);
  assert.equal(report.rev, project.rev);
  assert.equal(report.frame, 12);
  assert.equal(report.fps, FPS);
  assert.equal(report.status, 'open');
  const frame = report.measures.find((m) => m.kind === 'frame');
  assert.equal(frame.visible, true);
  assert.equal(frame.elementId, 'el_1');
  assert.ok(frame.item.world.length === 16);

  await saveReport(root, report);
  const file = path.join(reportsDir(root), `${report.id}.json`);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).id, report.id);

  const listed = await listReports(root);
  assert.equal(listed.total, 1);
  assert.equal(listed.reports[0].id, report.id);
  assert.equal((await readReport(root, report.id)).id, report.id);
  await assert.rejects(() => readReport(root, 'rp_0000000000000000'), (error) => error.code === 'REPORT_NOT_FOUND');
  await assert.rejects(() => readReport(root, '../../etc/passwd'), (error) => error.code === 'REPORT_NOT_FOUND');
});

test('看不见 fails while the element is off screen and verifies after it is fixed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-report-fix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = projectService(root);
  await service.transact({ command: { type: 'initialize', options: { title: 'report', duration: 4, fps: FPS } } }, { actorId: 'cli' });
  await service.transact({
    ops: [{
      op: 'addElement',
      element: {
        id: 'el_1', type: 'solid', start: 0, duration: 4, z: 1,
        style: { w: 80, h: 80, fill: '#ff0000' },
        transform: { x: 5000, y: 0 },
      },
    }],
  }, { actorId: 'ui' });

  const draft = setTags(elementDraft(), ['看不见']);
  const off = createReport({ project: await service.read(), draft, frame: 12 });
  const coverage = off.measures.find((m) => m.kind === 'coverage');
  assert.equal(coverage.focusSummary.framesUnoccluded, 0);
  assert.equal(off.verification.status, 'open');
  assert.deepEqual(off.verification.failed, ['coverage:el_1']);
  await saveReport(root, off);

  // The human moves it back on screen; the same plan now passes.
  await service.transact({ ops: [{ op: 'set', id: 'el_1', path: 'transform.x', value: 0 }] }, { actorId: 'ui' });
  const fixed = await remeasureReport({ root, project: await service.read(), id: off.id });
  assert.equal(fixed.verification.status, 'verified');
  assert.equal(fixed.status, 'verified');
  assert.deepEqual(fixed.verification.failed, []);
  assert.equal((await readReport(root, off.id)).status, 'verified');
});

test('没卡上拍 judges the beat gap in frames, and says when there are no beats', async (t) => {
  const { project } = await fixture(t, { beats: [1, 2, 3] });
  let draft = addAttachment(createDraft(), { kind: 'keyframe', ref: 'k1', host: 'el_1', path: 'style.w', t: 1 });
  draft = setTags(draft, ['没卡上拍']);
  const onBeat = measureDraft({ project, draft, frame: 24 }).measures.find((m) => m.kind === 'beatGap');
  assert.equal(onBeat.deltaFrames, 0);
  assert.equal(judge(onBeat, draft.tags), 'pass');

  const offBeat = measureDraft({
    project, draft: { ...draft, attachments: [{ ...draft.attachments[0], t: 1.04 }] }, frame: 24,
  }).measures.find((m) => m.kind === 'beatGap');
  assert.equal(offBeat.deltaFrames, 0.96);
  assert.equal(judge(offBeat, draft.tags), 'fail');

  const { project: plain } = await fixture(t);
  const none = measureDraft({ project: plain, draft, frame: 24 }).measures.find((m) => m.kind === 'beatGap');
  assert.equal(none.status, 'info');
  assert.match(none.note, /没有拍点/);
  assert.equal(judge(none, draft.tags), 'info');
});

test('cutEdges passes only when the range has no cut edge', async (t) => {
  const { project } = await fixture(t);
  const draft = setTags(addAttachment(createDraft(), { kind: 'range', ref: 'r', from: 0, to: 48 }), ['位置不对']);
  const measure = measureDraft({ project, draft, frame: 12 }).measures.find((m) => m.kind === 'cutEdges');
  assert.equal(measure.total, 0);
  assert.equal(judge(measure, draft.tags), 'pass');
  assert.equal(verdictOf({ tags: draft.tags, measures: [measure] }).status, 'verified');
});

test('a pending background job never counts as verified', async (t) => {
  const { project } = await fixture(t);
  const draft = setTags(elementDraft(), ['预览和成片不一样']);
  const report = createReport({ project, draft, frame: 12 });
  const blender = report.measures.find((m) => m.kind === 'blenderDiff');
  assert.equal(blender.status, 'pending');
  assert.equal(report.verification.status, 'open');
  assert.deepEqual(report.verification.pending, ['blender']);
});

test('a measurement that throws is reported, not swallowed', async (t) => {
  const { project } = await fixture(t);
  const draft = setTags(addAttachment(createDraft(), { kind: 'element', ref: 'el_missing' }), ['看不见']);
  const measure = measureDraft({ project, draft, frame: 12 }).measures.find((m) => m.kind === 'coverage');
  assert.equal(measure.status, 'error');
  assert.equal(measure.code, 'INVALID_ARGUMENT');
  assert.equal(judge(measure, draft.tags), 'fail');
});
