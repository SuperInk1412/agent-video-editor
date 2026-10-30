// Report service — stores what a human reports and re-measures it
// (docs/DESIGN-WP2.5-REVIEW.md §10.4-7/8, WP2.5c).
//
// A report is a file under `.vdm/reports/<id>.json`: a draft (attachments,
// symptoms, note) plus the measurements the symptom asked for, the revision it
// was taken at and a lifecycle status. It is not project state: nothing here
// calls `core/ops.js`, takes a revision or enters the undo history.
//
// Measurements come from `application/inspect-service.js` (the WP2.1 geometry
// engine). Every measure says what it measured and whether it can judge the
// symptom; "verified" is only set when every judged measure passes, so a
// re-measure that still sees the problem leaves the report open.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildFrameIR } from '../core/frame-ir.js';
import { REPORT_VERSION, measurePlan, normalizeDraft } from '../core/report-draft.js';
import { coverage, cutEdges, stackAt } from './inspect-service.js';
import { atomicJson } from '../engine/storage.js';

const ID = /^rp_[0-9a-f]{16}$/;
const KEEP = 500;

export const reportId = () => `rp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const reportsDir = (root) => path.join(root, '.vdm', 'reports');
export const isReportId = (value) => typeof value === 'string' && ID.test(value);

const fault = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const nowIso = () => new Date().toISOString();
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const round3 = (v) => Math.round(Number(v) * 1e3) / 1e3 + 0;

/** The frame IR of one frame, with the live camera — the preview's own view. */
function irOf(project, frame) {
  const fps = num(project?.meta?.fps, 24) || 24;
  return buildFrameIR(project, Math.round(frame), { fps, camera: 'live' });
}

// ------------------------------------------------------------------ measures

function frameMeasure(project, { frame, elementId }) {
  const ir = irOf(project, frame);
  const item = ir.items.find((entry) => entry.id === elementId);
  if (!item) return { kind: 'frame', elementId, frame: Math.round(frame), visible: false, camera: ir.camera.id };
  return {
    kind: 'frame',
    elementId,
    frame: Math.round(frame),
    visible: true,
    camera: ir.camera.id,
    mode: ir.mode,
    item: {
      world: item.world,
      size: item.size,
      opacity: round3(item.opacity),
      depth: item.depth,
      content: item.content?.type || item.kind,
    },
  };
}

function pairsMeasure(project, { frame, ids }) {
  const base = stackAt(project, frame, { point: null });
  const rowOf = (id) => base.order.find((entry) => entry.id === id);
  const centreOf = (id) => rowOf(id)?.projectedCenter || null;
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const point = centreOf(a) || centreOf(b);
      if (!point) {
        pairs.push({ a, b, frame: Math.round(frame), answerable: false, reason: 'not-on-screen' });
        continue;
      }
      const stack = stackAt(project, frame, { point });
      const rowA = stack.order.find((entry) => entry.id === a);
      const rowB = stack.order.find((entry) => entry.id === b);
      const coversA = !!rowA?.coversPoint;
      const coversB = !!rowB?.coversPoint;
      let front = null;
      if (coversA && coversB && rowA.rayDepth != null && rowB.rayDepth != null) {
        front = rowA.rayDepth < rowB.rayDepth ? a : (rowB.rayDepth < rowA.rayDepth ? b : 'same-plane');
      }
      pairs.push({ a, b, frame: Math.round(frame), point, coversA, coversB, front });
    }
  }
  return { kind: 'pairs', frame: Math.round(frame), pairs };
}

function beatGapMeasure(project, { t, fps }) {
  const beats = Array.isArray(project?.meta?.beats) ? project.meta.beats.map(Number).filter(Number.isFinite) : [];
  if (!beats.length) return { kind: 'beatGap', t, status: 'info', note: '工程没有拍点（meta.beats 为空）' };
  let nearest = beats[0];
  for (const beat of beats) if (Math.abs(beat - t) < Math.abs(nearest - t)) nearest = beat;
  const rate = num(fps, num(project?.meta?.fps, 24)) || 24;
  return {
    kind: 'beatGap',
    t: round3(t),
    nearest: round3(nearest),
    deltaSeconds: round3(t - nearest),
    deltaFrames: round3((t - nearest) * rate),
  };
}

/** Run one plan step; never throws for a missing attachment — it says so. */
function runStep(project, step, context) {
  try {
    switch (step.kind) {
      case 'frame': return frameMeasure(project, step.opts);
      case 'coverage': return { kind: 'coverage', ...coverage(project, step.opts) };
      case 'stackAt': return { kind: 'stackAt', ...stackAt(project, step.opts.frame, step.opts) };
      case 'pairs': return pairsMeasure(project, step.opts);
      case 'beatGap': return beatGapMeasure(project, step.opts);
      case 'cutEdges': {
        const result = cutEdges(project);
        const range = context.range;
        const edges = range ? result.edges.filter((edge) => edge.frame >= range.from - 1 && edge.frame <= range.to + 1) : result.edges;
        return { kind: 'cutEdges', ...result, edges, total: edges.length };
      }
      case 'blenderDiff': return { kind: 'blenderDiff', status: 'pending', note: '需要一次 Blender 渲染任务；报告先保存，出图后回填' };
      default: return { kind: step.kind, status: 'skipped', note: `unknown measure ${step.kind}` };
    }
  } catch (error) {
    return { kind: step.kind, status: 'error', code: error.code || 'MEASURE_FAILED', message: error.message };
  }
}

/**
 * Measurements for a draft at one frame. `frame` is the report's frame (the
 * playhead when it was written); a range attachment widens coverage/cut edges.
 */
export function measureDraft({ project, draft, frame = 0, fps = null, range = null }) {
  const d = normalizeDraft(draft);
  const rate = num(fps, num(project?.meta?.fps, 24)) || 24;
  const plan = measurePlan(d, { frame, fps: rate, range });
  const span = d.attachments.find((a) => a.kind === 'range') || range;
  const measures = plan.map((step) => ({ id: step.id, ...runStep(project, step, { range: span }) }));
  return { plan, measures };
}

// ------------------------------------------------------------------ verdicts

/**
 * Which symptoms a measurement can judge. `pass` means the problem is gone;
 * `fail` keeps the report open; `info` is context that never blocks.
 */
export function judge(measure, tags = []) {
  const has = (tag) => tags.includes(tag);
  if (measure.status === 'error') return 'fail';
  if (measure.status === 'pending') return 'pending';
  switch (measure.kind) {
    case 'coverage': {
      const summary = measure.focusSummary;
      if (!summary) return 'info';
      if (has('看不见')) return summary.framesUnoccluded > 0 ? 'pass' : 'fail';
      if (has('闪烁')) {
        const steady = summary.framesUnoccluded === summary.framesPresent && summary.framesPresent === measure.frameCount;
        return steady ? 'pass' : 'fail';
      }
      return 'info';
    }
    case 'stackAt': {
      // "被挡住" needs to know which element should be in front; the stack
      // alone cannot say. Report the numbers, never judge them.
      return 'info';
    }
    case 'beatGap': {
      if (!has('没卡上拍') || measure.status === 'info') return 'info';
      return Math.abs(measure.deltaFrames || 0) < 0.5 ? 'pass' : 'fail';
    }
    case 'cutEdges':
      return (measure.total || 0) === 0 ? 'pass' : 'fail';
    default:
      return 'info';
  }
}

export function verdictOf({ tags = [], measures = [] } = {}) {
  const passed = [];
  const failed = [];
  const pending = [];
  for (const measure of measures) {
    const result = judge(measure, tags);
    if (result === 'pass') passed.push(measure.id);
    else if (result === 'fail') failed.push(measure.id);
    else if (result === 'pending') pending.push(measure.id);
  }
  return {
    status: failed.length || pending.length ? 'open' : (passed.length ? 'verified' : 'open'),
    passed, failed, pending,
  };
}

// ------------------------------------------------------------------- reports

/** Build a report object (not saved yet). */
export function createReport({ project, draft, frame = 0, fps = null, camera = null, mode = 'preview', now = nowIso() }) {
  const d = normalizeDraft(draft);
  const rate = num(fps, num(project?.meta?.fps, 24)) || 24;
  const { plan, measures } = measureDraft({ project, draft: d, frame, fps: rate });
  const verification = verdictOf({ tags: d.tags, measures });
  return {
    version: REPORT_VERSION,
    id: reportId(),
    created: now,
    updatedAt: now,
    rev: num(project?.rev, 0),
    frame: Math.round(frame),
    fps: rate,
    camera: camera || project?.activeCameraId || project?.camera?.id || null,
    mode: mode === 'edit' ? 'edit' : 'preview',
    tags: d.tags,
    note: d.note,
    attachments: d.attachments,
    plan,
    measures,
    status: 'open',
    verification: { ...verification, at: now },
  };
}

async function ensureDir(root) {
  await fs.mkdir(reportsDir(root), { recursive: true });
}

export async function saveReport(root, report) {
  if (!report || !isReportId(report.id)) throw fault('INVALID_ARGUMENT', 'report needs an rp_ id');
  await ensureDir(root);
  await atomicJson(path.join(reportsDir(root), `${report.id}.json`), report);
  await prune(root);
  return report;
}

async function prune(root) {
  const dir = reportsDir(root);
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => /^rp_[0-9a-f]{16}\.json$/.test(name));
  if (names.length <= KEEP) return;
  const rows = await Promise.all(names.map(async (name) => {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    return { file, at: stat?.mtimeMs || 0 };
  }));
  rows.sort((a, b) => a.at - b.at);
  for (const row of rows.slice(0, rows.length - KEEP)) await fs.rm(row.file, { force: true }).catch(() => {});
}

export async function listReports(root, { limit = 50 } = {}) {
  const dir = reportsDir(root);
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => /^rp_[0-9a-f]{16}\.json$/.test(name));
  const rows = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (!text) continue;
    try { rows.push(JSON.parse(text)); } catch { /* a corrupt file is skipped, not fatal */ }
  }
  rows.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  const size = Math.max(1, Math.min(200, Math.round(num(limit, 50))));
  return { version: REPORT_VERSION, reports: rows.slice(0, size), total: rows.length };
}

export async function readReport(root, id) {
  if (!isReportId(id)) throw fault('REPORT_NOT_FOUND', `no report ${id}`, 404);
  const text = await fs.readFile(path.join(reportsDir(root), `${id}.json`), 'utf8').catch(() => null);
  if (!text) throw fault('REPORT_NOT_FOUND', `no report ${id}`, 404);
  try { return JSON.parse(text); } catch { throw fault('REPORT_NOT_FOUND', `report ${id} is unreadable`, 404); }
}

/** Re-run the same plan on the current project; only a full pass verifies. */
export async function remeasureReport({ root, project, id, now = nowIso() }) {
  const report = await readReport(root, id);
  const { plan, measures } = measureDraft({ project, draft: report, frame: report.frame, fps: report.fps });
  const verification = verdictOf({ tags: report.tags, measures });
  const next = {
    ...report,
    plan,
    measures,
    updatedAt: now,
    rev: num(project?.rev, report.rev),
    verification: { ...verification, at: now },
    // A re-measure that still sees the problem puts the report back to open,
    // even if a human had marked it fixed: the numbers, not the label, decide.
    status: verification.status === 'verified' ? 'verified' : 'open',
  };
  await saveReport(root, next);
  return next;
}
