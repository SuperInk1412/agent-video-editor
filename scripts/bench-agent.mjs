#!/usr/bin/env node
// Comparison benchmark for the edit agent (docs/DESIGN-BACKEND-V2.md §8.4, WP5.3).
//
// The same fixed task set runs twice:
//
//   * `changeset` — over the MCP tool surface (`mcp/tools.js::callTool` → the
//     project runtime's `POST /api/rpc`): read, apply one change set, read it
//     back, measure, and replay the write against the stale revision to prove
//     the precondition refuses it;
//   * `direct` — the simulated pre-change-set workflow: `JSON.parse` the
//     project file, apply the ops in memory, `saveProject` over it. No change
//     set, no journal entry, no revision precondition, no property-level undo.
//
// Every run records wall time (total and the write itself), tool calls, change
// sets, properties changed, final revision, whether the task's acceptance check
// passed, failures/refusals, and what reverting costs. The output is JSON plus
// a markdown table.
//
//   node scripts/bench-agent.mjs --agent=scripted
//   node scripts/bench-agent.mjs --agent=scripted --project .scratch/wp0.1/miku-swiss --runs 3
//   node scripts/bench-agent.mjs --agent=dsh          # skipped with a reason when findDsh() is null
//   node scripts/bench-agent.mjs --help
//
// Zero dependencies, and the source project is never written: every run gets a
// fresh copy in the temp directory (`.vdm/` is not copied, so a run starts with
// a clean journal and registry). `--project` may point at a working copy such
// as `.scratch/wp0.1/miku-swiss`; the checked-in sample is not touched.
//
// Numbers are this run only: the "direct" side is simulated on this machine,
// not a history of the old one-shot workflow (see `report.notes`).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { callTool } from '../mcp/tools.js';
import { startServer } from '../engine/server.js';
import { runtimeClient } from '../engine/runtime.js';
import { saveProject } from '../engine/storage.js';
import { projectService } from '../engine/projects.js';
import { applyOps } from '../core/ops.js';
import { content } from '../application/project-service.js';
import { coverage as inspectCoverage } from '../application/inspect-service.js';
import { AgentLoop, ScriptedAgent, findDsh, nearestBeat } from '../engine/agent.js';
import { DshAgent } from '../engine/dsh-agent.js';

const NL = String.fromCharCode(10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

export const BENCH_VERSION = 1;
export const ACTOR = 'agent:bench';
export const BASELINE_KIND = 'simulated-direct-write';
/** Tool error codes that mean "the engine refused", not "the run broke". */
export const REFUSAL_CODES = Object.freeze([
  'LOCKED', 'REV_CONFLICT', 'PATH_OUTSIDE_SCOPE', 'OP_INVALID', 'INVALID_ARGUMENT',
  'TOO_MANY_OPS', 'CHANGESET_NOT_FOUND', 'DEPENDENCY_MISSING',
]);
const REFUSALS = new Set(REFUSAL_CODES);

const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const contentHash = (project) => sha256(content(project));
const median = (values) => {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : round((list[mid - 1] + list[mid]) / 2);
};

// ------------------------------------------------------------------ fixture
// A 3 s / 30 fps project with two lyric lines (the sample's first shot), so
// `node scripts/bench-agent.mjs` produces a table on a clean checkout. Names
// match the miku-swiss copy, so the same task definitions run on either.
export function fixtureProject() {
  const node = (pivot) => ({ pivot, position: [0, 0, 0], scale: [1, 1, 1], rotation: [0, 0, 0] });
  const lyric = (id, name, text, start) => ({
    id, name, type: 'text', start, duration: 1.167, z: 5, visible: true,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    node: node([0, 0, 0]),
    style: { text, size: 230, color: '#F2F0EB', align: 'center' },
  });
  return {
    schema: 'vdm.project/1', rev: 1,
    meta: {
      title: 'bench fixture', fps: 30, width: 1920, height: 1080, duration: 3,
      background: '#05070d', beats: [0.1, 0.85, 1.6, 2.35], tempo: 80, fx: {}, style: 'default', curvePresets: [],
    },
    segments: [],
    elements: [
      {
        id: 'bg', name: '底色', type: 'solid', start: 0, duration: 3, z: 1, visible: true,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        node: node([0, 0, -2]), style: { w: 9600, h: 5400, fill: '#111111' },
      },
      lyric('s1_w1', '01 词1 未来', '未来', 0),
      lyric('s1_w2', '01 词2 幻想', '幻想', 0.5),
    ],
    cameras: [{ id: 'cam_a', name: 'A', path: [{ t: 0, pos: [0, 0, 20], look: [0, 0, 0] }], fov: 50, start: 0, duration: 3, visible: true }],
    cameraOrder: ['cam_a'], activeCameraId: 'cam_a', world: { source: 'none' },
  };
}

const ADDED_TEXT = '基准 新增';

/** Same grid as engine/agent.js::beatGrid (kept local; that one is private). */
function tempoGrid(tempo, duration, fps) {
  const period = 60 / Number(tempo);
  if (!(period > 0.02) || !(period < 10)) return [];
  const beats = [];
  for (let index = 0; index * period < Number(duration) - 1e-9; index++) {
    beats.push(round(Math.round((index * period) * fps) / fps, 3));
  }
  return beats;
}

const sameNumber = (a, b, tolerance) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
const check = (name, expected, actual, ok = JSON.stringify(expected) === JSON.stringify(actual)) => ({ name, ok, expected, actual: actual ?? null });
const nearCheck = (name, expected, actual, tolerance) => ({
  name, ok: sameNumber(Number(expected), Number(actual), tolerance), expected, actual: Number.isFinite(Number(actual)) ? Number(actual) : null,
});
/** "It is really on screen" — the measured samples, not the agent's claim. */
const coverageCheck = (state, field) => {
  const value = state.coverage?.focusSummary?.[field];
  return {
    name: `覆盖测量（${field}）`,
    ok: Number(value) > 0,
    expected: '> 0',
    actual: Number.isFinite(Number(value)) ? Number(value) : null,
  };
};

// -------------------------------------------------------------------- tasks
// One entry = one fixed task. `ops` builds the write, `verify` is the
// acceptance check run on the project file afterwards (never the agent's own
// prose), and `elementOf` finds the host the measurement focuses on.
export const TASKS = [
  {
    id: 'font-size-and-beat',
    title: '改字号并卡到最近拍点',
    prompt: '把 01 词2 改成 150 号字并卡到最近拍点',
    select: /01 词2/,
    create: false,
    scope: (target) => ({ elements: [target.id], paths: ['style.size', 'start', '@host'] }),
    ops: ({ target, beat }) => [
      { op: 'set', id: target.id, path: 'style.size', value: 150 },
      { op: 'moveElement', id: target.id, start: beat.frameAligned },
    ],
    elementOf: (items, state) => items.find((el) => el.id === state.target.id),
    verify: ({ project, state }) => {
      const el = (project.elements || []).find((entry) => entry.id === state.target.id);
      return [
        check('元素仍在工程里', state.target.id, el?.id),
        check('字号写成 150', 150, el?.style?.size),
        nearCheck('起点卡到最近拍点', state.beat.frameAligned, el?.start, 1e-3),
        check('起点落在帧上', true, sameNumber(el?.start * state.fps, Math.round(el?.start * state.fps), 0.05)),
        coverageCheck(state, 'framesUnoccluded'),
      ];
    },
    coverageTarget: (items, state) => items.find((el) => el.id === state.target.id),
  },
  {
    id: 'add-element',
    title: '加一个元素',
    prompt: '加一个 1 秒的标题「基准 新增」，卡到最近拍点',
    select: null,
    create: true,
    scope: () => ({ elements: ['@new'], paths: ['*'], create: true }),
    ops: ({ beat }) => [{
      op: 'addElement',
      element: { type: 'text', start: beat.frameAligned, duration: 1, style: { text: ADDED_TEXT, size: 120, color: '#ffd400' } },
    }],
    elementOf: (items) => items.find((el) => el.style?.text === ADDED_TEXT),
    verify: ({ project, state }) => {
      const added = (project.elements || []).find((el) => el.style?.text === ADDED_TEXT);
      const onBeat = (state.beats || []).some((beat) => sameNumber(added?.start, round(Math.round(beat * state.fps) / state.fps, 3), 1e-3));
      return [
        check('新增元素存在', ADDED_TEXT, added?.style?.text ?? null),
        check('类型是 text', 'text', added?.type ?? null),
        check('时长 1 s', 1, added?.duration ?? null),
        check('起点落在某个拍点帧上', true, onBeat),
        check('新元素在最上层', true, Number(added?.z) > Math.max(...(project.elements || []).filter((el) => el.id !== added?.id).map((el) => Number(el.z) || 0))),
        coverageCheck(state, 'framesPresent'),
      ];
    },
    coverageTarget: (items) => items.find((el) => el.style?.text === ADDED_TEXT),
  },
  {
    id: 'fix-position',
    title: '修一个位置',
    prompt: '把 01 词1 往右移到 x = 120，并确认它在画面里',
    select: /01 词1/,
    create: false,
    scope: (target) => ({ elements: [target.id], paths: ['transform.x'] }),
    ops: ({ target }) => [{ op: 'updateElement', id: target.id, patch: { transform: { x: 120 } } }],
    elementOf: (items, state) => items.find((el) => el.id === state.target.id),
    verify: ({ project, state }) => {
      const el = (project.elements || []).find((entry) => entry.id === state.target.id);
      return [
        check('元素仍在工程里', state.target.id, el?.id),
        check('x 写成 120', 120, el?.transform?.x),
        check('没有顺带改到别的属性', true, el?.style?.size === state.target.style?.size && el?.start === state.target.start),
        coverageCheck(state, 'framesOnScreen'),
      ];
    },
    coverageTarget: (items, state) => items.find((el) => el.id === state.target.id),
  },
];

// ------------------------------------------------------------- project files

async function readProjectFile(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'project.vdm.json'), 'utf8'));
}

async function journalEntries(root) {
  try {
    const stored = JSON.parse(await fs.readFile(path.join(root, '.vdm', 'transactions.json'), 'utf8'));
    return Array.isArray(stored.entries) ? stored.entries.length : 0;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

/** Beat metadata a run will use: stored markers, a tempo grid, or a seeded grid. */
function planBeats(project, bpm) {
  const meta = project.meta || {};
  const fps = Number(meta.fps) || 24;
  const duration = Number(meta.duration) || 0;
  const stored = Array.isArray(meta.beats) ? meta.beats.filter((beat) => Number.isFinite(Number(beat))) : [];
  if (stored.length) return { info: { source: 'meta.beats', count: stored.length, tempo: Number(meta.tempo) || 0 }, beats: stored };
  const tempo = Number(meta.tempo) || 0;
  if (tempo > 0) {
    const beats = tempoGrid(tempo, duration, fps);
    return { info: { source: 'meta.tempo', count: beats.length, tempo }, beats };
  }
  const beats = tempoGrid(bpm, duration, fps);
  return { info: { source: 'bench-seeded', count: beats.length, tempo: bpm, bpm }, beats, seed: true };
}

/**
 * Copy the source project into a fresh temp directory (never `.vdm/`) and make
 * sure the copy has a beat grid to snap to. A project without `meta.beats` /
 * `meta.tempo` gets a frame-aligned grid at `bpm`, written into the copy only,
 * so "卡到最近拍点" is measurable and the same on every machine.
 */
async function prepareRun({ project = null, bpm = 128 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-bench-agent-'));
  if (project) {
    await fs.cp(path.resolve(project), root, {
      recursive: true,
      filter: (entry) => path.basename(entry) !== '.vdm',
    });
  } else {
    await saveProject(root, fixtureProject(), { by: 'bench' });
  }
  const project0 = await readProjectFile(root);
  const planned = planBeats(project0, bpm);
  if (planned.seed) {
    project0.meta = { ...project0.meta, beats: planned.beats, tempo: bpm };
    await saveProject(root, project0, { by: 'bench' });
  }
  const seeded = await readProjectFile(root);
  return {
    root,
    project: seeded,
    meta: seeded.meta || {},
    fps: Number(seeded.meta?.fps) || 24,
    duration: Number(seeded.meta?.duration) || 0,
    beats: { ...planned.info, beats: planned.beats },
    rev: seeded.rev,
  };
}

function sourceMeta(prepared, { project = null } = {}) {
  return {
    source: project ? path.resolve(project) : 'fixture',
    kind: project ? 'project-copy' : 'fixture',
    title: prepared.meta.title ?? null,
    fps: prepared.fps,
    duration: prepared.duration,
    elements: (prepared.project.elements || []).length,
    rev: prepared.rev,
    beats: { source: prepared.beats.source, count: prepared.beats.count, tempo: prepared.beats.tempo },
  };
}

function resolveTarget(project, task) {
  if (!task.select) return null;
  const target = (project.elements || []).find((el) => el.type === 'text' && task.select.test(String(el.name || '')));
  if (!target) throw new Error(`${task.id}: no element matching ${task.select} in this project`);
  return target;
}

/** The fields one run needs before it can build its ops. */
function taskState(prepared, task) {
  const target = resolveTarget(prepared.project, task);
  const startTime = target ? Number(target.start) : prepared.duration / 3;
  const beat = nearestBeat(prepared.beats.beats, startTime, prepared.fps);
  if (!beat) throw new Error(`${task.id}: the project has no beat to snap to`);
  return {
    rev: prepared.rev,
    meta: prepared.meta,
    fps: prepared.fps,
    duration: prepared.duration,
    beats: prepared.beats.beats,
    beat,
    target,
    startTime,
  };
}

// ------------------------------------------------------------- scripted run

function makeCtx(calls) {
  const toolCalls = (name) => calls.filter((call) => call.tool === name);
  const last = (name) => {
    const all = toolCalls(name);
    return all.length ? all[all.length - 1] : null;
  };
  return {
    lastOk: (name) => {
      const message = last(name);
      return message?.ok ? message.result : null;
    },
    lastError: (name) => {
      const message = last(name);
      return message && !message.ok ? message.error : null;
    },
    last,
    toolResults: toolCalls,
  };
}

/**
 * The fixed script: read → find the host → read the beat grid → apply one
 * change set → read it back → measure → replay the write against the stale
 * revision. Every step reads what the previous tool returned, so a scripted run
 * is a real loop over the MCP surface, not a hard-coded op list.
 */
function scriptedSteps(task, state) {
  return [
    () => ({ tool: 'vdm_project_read', args: { section: 'summary' } }),
    (ctx) => {
      const summary = ctx.lastOk('vdm_project_read');
      if (!summary) throw new Error(`${task.id}: vdm_project_read(summary) failed`);
      state.rev = summary.rev;
      state.meta = summary.meta || {};
      state.fps = Number(state.meta.fps) || 24;
      state.duration = Number(state.meta.duration) || 0;
      return { tool: 'vdm_project_read', args: { section: 'elements', offset: 0, limit: 500 } };
    },
    (ctx) => {
      const page = ctx.lastOk('vdm_project_read');
      if (!page?.items) throw new Error(`${task.id}: vdm_project_read(elements) failed`);
      state.target = task.select
        ? page.items.find((el) => el.type === 'text' && task.select.test(String(el.name || '')))
        : null;
      if (task.select && !state.target) throw new Error(`${task.id}: no element matching ${task.select} in this project`);
      state.startTime = state.target ? Number(state.target.start) : state.duration / 3;
      return { tool: 'vdm_context_read', args: { time: state.startTime } };
    },
    (ctx) => {
      if (!ctx.lastOk('vdm_context_read')) throw new Error(`${task.id}: vdm_context_read failed`);
      state.beats = Array.isArray(state.meta.beats) && state.meta.beats.length
        ? state.meta.beats
        : tempoGrid(state.meta.tempo, state.duration, state.fps);
      state.beat = nearestBeat(state.beats, state.startTime, state.fps);
      if (!state.beat) throw new Error(`${task.id}: the project has no beat grid (meta.beats / meta.tempo)`);
      return {
        tool: 'vdm_changeset_apply',
        args: { ops: task.ops(state), actorId: ACTOR, intent: task.prompt, expectedRev: state.rev },
      };
    },
    (ctx) => {
      const applied = ctx.lastOk('vdm_changeset_apply');
      if (!applied) {
        const error = ctx.lastError('vdm_changeset_apply');
        throw new Error(`${task.id}: vdm_changeset_apply was refused (${error?.code ?? 'ERROR'}: ${error?.message ?? ''})`);
      }
      state.changeset = {
        id: applied.id,
        status: applied.status,
        rev: applied.rev,
        baseRev: applied.baseRev,
        transactions: Array.isArray(applied.transactions) ? applied.transactions.length : 0,
        changed: Array.isArray(applied.changed) ? applied.changed.length : 0,
        added: Array.isArray(applied.added) ? applied.added.length : 0,
        removed: Array.isArray(applied.removed) ? applied.removed.length : 0,
      };
      return { tool: 'vdm_changeset_show', args: { id: applied.id } };
    },
    (ctx) => {
      const record = ctx.lastOk('vdm_changeset_show');
      state.show = record ? {
        status: record.status,
        changed: Number(record.changedTotal ?? record.changed?.length ?? 0),
        added: Array.isArray(record.added) ? record.added.length : 0,
        removed: Array.isArray(record.removed) ? record.removed.length : 0,
        verification: record.report?.verification ?? null,
      } : null;
      return { tool: 'vdm_project_read', args: { section: 'elements', offset: 0, limit: 500 } };
    },
    (ctx) => {
      const page = ctx.lastOk('vdm_project_read');
      if (!page?.items) throw new Error(`${task.id}: reading the elements back failed`);
      state.element = task.coverageTarget(page.items, state);
      if (!state.element) throw new Error(`${task.id}: the edited element is missing after the change set`);
      return {
        tool: 'vdm_inspect_coverage',
        args: {
          from: Math.round(Number(state.element.start) * state.fps),
          to: Math.round((Number(state.element.start) + Number(state.element.duration)) * state.fps),
          focus: state.element.id,
        },
      };
    },
    (ctx) => {
      state.coverage = ctx.lastOk('vdm_inspect_coverage');
      // WP2.2's revision precondition: the same write, replayed against the
      // revision the run started from. It must be refused and must not write.
      return {
        tool: 'vdm_changeset_apply',
        args: { ops: task.ops(state), actorId: ACTOR, intent: `${task.prompt}（旧 rev 重放）`, expectedRev: state.rev },
      };
    },
    (ctx) => {
      state.guard = ctx.lastError('vdm_changeset_apply');
      if (!state.guard) state.guardApplied = ctx.lastOk('vdm_changeset_apply');
      return { type: 'final', text: `${task.title} 完成` };
    },
  ];
}

async function drive(client, agent, { maxSteps = 40 } = {}) {
  const calls = [];
  const started = performance.now();
  for (let step = 0; step < maxSteps; step++) {
    const action = await agent.next(makeCtx(calls));
    if (!action || action.type === 'final') break;
    if (action.type !== 'tool' || typeof action.name !== 'string') throw new Error(`unexpected agent action ${JSON.stringify(action)}`);
    const before = performance.now();
    const result = await callTool(client, action.name, action.args || {});
    const ms = performance.now() - before;
    calls.push({
      n: calls.length + 1,
      tool: action.name,
      args: action.args || {},
      ms: round(ms),
      ok: !result.isError,
      ...(result.isError
        ? {
          code: result.structuredContent?.error?.code ?? 'ERROR',
          message: result.structuredContent?.error?.message ?? null,
          error: result.structuredContent?.error ?? { code: 'ERROR' },
        }
        : { result: result.structuredContent }),
    });
  }
  return { calls, ms: round(performance.now() - started) };
}

const publicCalls = (calls) => calls.map(({ result, ...call }) => call);

/** Turn the loop's own bookkeeping into the row the table prints. */
function summarizeCalls(calls, guardRefused) {
  const errors = calls.filter((call) => !call.ok);
  const refusals = errors.filter((call) => REFUSALS.has(call.code));
  const expected = guardRefused ? 1 : 0;
  return {
    toolErrors: errors.length,
    refusals: refusals.length,
    // Errors the run did not ask for: a happy path keeps this at 0.
    failures: Math.max(0, errors.length - expected),
  };
}

function guardRecord(state, { revAfter, journalAfterTask }) {
  const refused = state.guard?.code === 'REV_CONFLICT';
  return {
    attempted: true,
    expectedRev: state.rev,
    code: state.guard?.code ?? null,
    message: state.guard?.message ?? null,
    refused,
    wrote: !!state.guardApplied,
    revUnchanged: state.changeset ? revAfter === state.changeset.rev : null,
    journalUnchanged: journalAfterTask === 1,
    passed: refused && !state.guardApplied && revAfter === state.changeset?.rev && journalAfterTask === 1,
  };
}

async function revertChangeSet(client, id) {
  if (!id) return { attempted: false, granularity: 'property', selective: true, ms: 0, restored: null };
  const started = performance.now();
  const result = await callTool(client, 'vdm_changeset_revert', { id, actorId: ACTOR });
  const ms = performance.now() - started;
  const record = result.isError ? null : result.structuredContent;
  return {
    attempted: true,
    ok: !result.isError,
    granularity: 'property',
    selective: true,
    ms: round(ms),
    status: record?.status ?? null,
    rev: record?.rev ?? null,
    counts: record?.revert
      ? { reverted: record.revert.reverted, already: record.revert.already, conflicts: record.revert.conflicts }
      : null,
    decisions: record?.report?.decisions?.length ?? (record?.revert?.decisions?.length ?? 0),
    error: result.isError ? result.structuredContent?.error?.code ?? 'ERROR' : null,
  };
}

async function runScriptedTask(task, { source, bpm, keep, maxSteps = 40, onProject }) {
  const prepared = await prepareRun({ project: source, bpm });
  onProject?.(prepared);
  let service = null;
  let state = null;
  const revert = { attempted: false };
  try {
    state = taskState(prepared, task);
    service = await startServer({ root: prepared.root, port: 0 });
    // The runtime normalizes a project when it loads it (defaults, migrations).
    // Compare the revert against that view, or every revert would look lossy
    // just because the first transaction wrote the defaults to disk.
    const hashBefore = contentHash(await service.projects.read());
    const client = runtimeClient(service.info);
    const agent = new ScriptedAgent({ script: scriptedSteps(task, state) });
    const run = await drive(client, agent, { maxSteps });
    const after = await readProjectFile(prepared.root);
    const journalAfterTask = await journalEntries(prepared.root);
    const coverageReport = state.coverage
      ? { f0: state.coverage.f0, f1: state.coverage.f1, focus: state.coverage.focus, ...pickCoverage(state.coverage.focusSummary) }
      : null;
    const checks = [...task.verify({ project: after, state }), check('rev 前进 1', state.rev + 1, after.rev)];
    const guard = guardRecord(state, { revAfter: after.rev, journalAfterTask });
    const write = run.calls.find((call) => call.tool === 'vdm_changeset_apply' && call.ok);
    const counters = summarizeCalls(run.calls, guard.refused);

    // Revert after the task so the revert cost is measured on the same run.
    Object.assign(revert, await revertChangeSet(client, state.changeset?.id));
    const reverted = await readProjectFile(prepared.root);
    revert.revAfter = reverted.rev;
    revert.restored = contentHash(reverted) === hashBefore;
    const journalAfterRevert = await journalEntries(prepared.root);

    return {
      status: 'ok',
      task: task.id,
      ms: run.ms,
      writeMs: write ? write.ms : null,
      toolCalls: run.calls.length,
      changesets: state.changeset ? 1 : 0,
      propertiesChanged: state.show ? state.show.changed + state.show.added + state.show.removed : null,
      changeSet: state.changeset ? {
        id: state.changeset.id,
        status: state.changeset.status,
        baseRev: state.changeset.baseRev,
        rev: state.changeset.rev,
        transactions: state.changeset.transactions,
      } : null,
      revBefore: state.rev,
      revAfter: after.rev,
      revAfterRevert: reverted.rev,
      verified: checks.every((entry) => entry.ok),
      checks,
      evidence: {
        beat: state.beat,
        target: state.target ? { id: state.target.id, start: state.target.start, duration: state.target.duration } : null,
        element: state.element ? { id: state.element.id, start: state.element.start, duration: state.element.duration } : null,
        coverage: coverageReport,
        changeSet: state.show,
        guard,
      },
      ...counters,
      refusalsExpected: guard.refused ? 1 : 0,
      guard,
      bypass: { detected: false },
      calls: publicCalls(run.calls),
      journalAfterTask,
      journalAfterRevert,
      revert,
    };
  } catch (error) {
    return {
      status: 'error',
      task: task.id,
      ms: null,
      toolCalls: 0,
      changesets: 0,
      revBefore: state?.rev ?? prepared.rev,
      revAfter: null,
      verified: false,
      error: { code: error.code ?? 'ERROR', message: error.message },
      calls: [],
      revert,
    };
  } finally {
    if (service) await service.close();
    if (!keep) await fs.rm(prepared.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function pickCoverage(summary) {
  if (!summary) return {};
  return {
    framesPresent: summary.framesPresent ?? null,
    framesOnScreen: summary.framesOnScreen ?? null,
    framesUnoccluded: summary.framesUnoccluded ?? null,
    samplesUnoccluded: summary.samplesUnoccluded ?? null,
  };
}

// --------------------------------------------------------------- direct run

/**
 * The simulated pre-change-set workflow: read the project file, apply the ops
 * in memory, write the file back, measure with the pure inspect service. No
 * runtime, no change set, no journal entry, no revision precondition. Reverting
 * means putting the whole file back from a copy.
 */
async function runDirectTask(task, { source, bpm, keep, onProject }) {
  const prepared = await prepareRun({ project: source, bpm });
  onProject?.(prepared);
  const file = path.join(prepared.root, 'project.vdm.json');
  const rawBefore = await fs.readFile(file);
  const projectBefore = JSON.parse(rawBefore);
  const hashBefore = contentHash(projectBefore);
  const state = taskState(prepared, task);
  try {
    const started = performance.now();
    const readStarted = performance.now();
    const project = JSON.parse(await fs.readFile(file, 'utf8'));
    const readMs = performance.now() - readStarted;
    const writeStarted = performance.now();
    const checksumBefore = state.rev;
    applyOps(project, task.ops(state));
    await saveProject(prepared.root, project, { by: 'bench-direct' });
    const writeMs = performance.now() - writeStarted;
    const after = await readProjectFile(prepared.root);
    const focus = task.coverageTarget(after.elements || [], state)
      ?? (after.elements || []).find((el) => el.id === state.target?.id)
      ?? (after.elements || []).find((el) => el.style?.text === ADDED_TEXT);
    const measureStarted = performance.now();
    state.coverage = focus
      ? inspectCoverage(after, {
        f0: Math.round(Number(focus.start) * state.fps),
        f1: Math.round((Number(focus.start) + Number(focus.duration)) * state.fps),
        focus: focus.id,
      })
      : null;
    const measureMs = performance.now() - measureStarted;
    const checks = [...task.verify({ project: after, state }), check('rev 前进 1', checksumBefore + 1, after.rev)];
    const ms = performance.now() - started;
    const journalAfterTask = await journalEntries(prepared.root);

    // Whole-file restore: the only undo the direct path has.
    const revertStarted = performance.now();
    await fs.writeFile(file, rawBefore);
    const restoreMs = performance.now() - revertStarted;
    const reverted = await readProjectFile(prepared.root);

    return {
      status: 'ok',
      task: task.id,
      ms: round(ms),
      readMs: round(readMs),
      writeMs: round(writeMs),
      measureMs: round(measureMs),
      toolCalls: 0,
      changesets: 0,
      propertiesChanged: null,
      revBefore: checksumBefore,
      revAfter: after.rev,
      verified: checks.every((entry) => entry.ok),
      checks,
      evidence: {
        beat: state.beat,
        target: state.target ? { id: state.target.id, start: state.target.start, duration: state.target.duration } : null,
        coverage: state.coverage ? { f0: state.coverage.f0, f1: state.coverage.f1, focus: state.coverage.focus, ...pickCoverage(state.coverage.focusSummary) } : null,
      },
      failures: 0,
      refusals: 0,
      toolErrors: 0,
      guard: { attempted: false, supported: false, note: '直接写盘没有 rev 前置条件' },
      bypass: { detected: false },
      surface: 'fs (JSON.parse → applyOps → saveProject)',
      calls: [],
      journalAfterTask,
      journalAfterRevert: journalAfterTask,
      revert: {
        attempted: true,
        granularity: 'file',
        selective: false,
        ms: round(restoreMs),
        ok: true,
        revAfter: reverted.rev,
        restored: contentHash(reverted) === hashBefore,
        note: '覆盖整份工程文件；没有逐属性回退',
      },
    };
  } catch (error) {
    return {
      status: 'error',
      task: task.id,
      ms: null,
      toolCalls: 0,
      changesets: 0,
      revBefore: state.rev,
      revAfter: null,
      verified: false,
      error: { code: error.code ?? 'ERROR', message: error.message },
      calls: [],
      revert: { attempted: false, granularity: 'file', selective: false },
    };
  } finally {
    if (!keep) await fs.rm(prepared.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// -------------------------------------------------------------------- dsh run
// A real dsh is driven through `AgentLoop` (§8.4 / WP2.5e): each step is one
// headless dsh invocation, the loop executes the tool, and the same acceptance
// checks run on the file afterwards. Stills are a local PNG stand-in so the
// table compares the agent/tool path, not Electron boot time.

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buffer) => {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};
function pngBuffer(width = 1920, height = 1080) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const benchStill = ({ dir, frame, label }) => (async () => {
  const target = path.join(dir, '.vdm', 'agent', 'stills', `${label}-f${frame}.png`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const png = pngBuffer();
  await fs.writeFile(target, png);
  return { path: target, width: 1920, height: 1080, bytes: png.length, ms: 1, backend: 'bench-synthetic' };
})();

async function runDshTask(task, { source, bpm, keep, timeoutMs, maxSteps, resolveDsh, onProject }) {
  const prepared = await prepareRun({ project: source, bpm });
  onProject?.(prepared);
  let state;
  try {
    state = taskState(prepared, task);
    // Compare against the engine's (normalized) view: a runtime that loads the
    // project adds defaults, and a raw-file hash would call every revert lossy.
    const hashBefore = contentHash(await projectService(prepared.root).read());
    const agent = new DshAgent({ root: prepared.root, resolveRuntime: resolveDsh, timeoutMs });
    const loop = new AgentLoop({
      root: prepared.root,
      scope: task.scope(state.target),
      agent,
      renderStill: benchStill,
      actorId: ACTOR,
      maxSteps: maxSteps || 60,
    });
    try {
      const started = performance.now();
      let result = await loop.run({ task: task.prompt });
      for (let round = 0; round < 3 && result.status === 'awaiting-approval'; round++) {
        result = await loop.approve({});
      }
      const ms = performance.now() - started;
      const after = await readProjectFile(prepared.root);
      const journalAfterTask = await journalEntries(prepared.root);
      const applied = (result.changesets || []).filter((entry) => entry.status === 'applied');
      const focus = task.coverageTarget(after.elements || [], state)
        ?? (after.elements || []).find((el) => el.id === state.target?.id)
        ?? (after.elements || []).find((el) => el.style?.text === ADDED_TEXT);
      state.coverage = focus
        ? inspectCoverage(after, {
          f0: Math.round(Number(focus.start) * state.fps),
          f1: Math.round((Number(focus.start) + Number(focus.duration)) * state.fps),
          focus: focus.id,
        })
        : null;
      const checks = [...task.verify({ project: after, state }), check('rev 前进', true, after.rev > state.rev)];
      const coverageReport = state.coverage ? { f0: state.coverage.f0, f1: state.coverage.f1, focus: state.coverage.focus, ...pickCoverage(state.coverage.focusSummary) } : null;
      // §8.4's write path is the change-set service. dsh runs with the project
      // as its cwd and has its own file tools, so a run whose revision moved
      // without a change set or a journal entry wrote the file behind the
      // engine's back. Record it instead of trusting the agent's prose.
      const bypassed = after.rev !== state.rev && applied.length === 0 && journalAfterTask === 0;
      const bypass = {
        detected: bypassed,
        revMoved: after.rev !== state.rev,
        changesets: applied.length,
        journalEntries: journalAfterTask,
        note: bypassed
          ? 'rev 前进了但没有变更集 / journal 记录：写入绕过了变更集路径（dsh 在工程目录里直接改了文件）'
          : null,
      };
      // `vdm_changeset_revert` only needs the project root; the dsh run has no
      // runtime session, and the change-set service reads the same project.
      const revert = applied[0]?.id
        ? await revertChangeSet({ info: { root: prepared.root } }, applied[0].id)
        : { attempted: false, granularity: 'property', selective: true, ms: 0, restored: false, reason: '本次运行没有可回退的变更集' };
      const reverted = await readProjectFile(prepared.root);
      revert.revAfter = reverted.rev;
      revert.restored = contentHash(await projectService(prepared.root).read()) === hashBefore;
      const calls = agent.history.map((row) => ({
        n: row.n,
        tool: row.tool,
        args: row.args,
        ok: row.ok,
        ms: row.ms ?? null,
        ...(row.ok ? {} : { code: row.error?.code ?? 'ERROR', message: row.error?.message ?? null }),
      }));
      return {
        status: result.status === 'completed' ? 'ok' : result.status,
        task: task.id,
        ms: round(ms),
        agentSteps: agent.steps,
        toolCalls: calls.length,
        changesets: applied.length,
        propertiesChanged: applied.reduce((sum, entry) => sum + (entry.counts
          ? (entry.counts.changed || 0) + (entry.counts.added || 0) + (entry.counts.removed || 0)
          : (entry.changed?.length || 0)), 0),
        changeSet: applied[0] ? {
          id: applied[0].id,
          status: applied[0].status,
          baseRev: applied[0].baseRev ?? null,
          rev: applied[0].rev ?? null,
          transactions: (applied[0].transactions || []).length,
          count: applied.length,
        } : null,
        revBefore: result.revision?.before ?? state.rev,
        revAfter: after.rev,
        verified: checks.every((entry) => entry.ok),
        checks,
        evidence: {
          beat: state.beat,
          coverage: coverageReport,
          report: { verified: result.report?.verificationSummary?.verified ?? 0, unverified: result.report?.verificationSummary?.unverified ?? 0 },
        },
        failures: result.contract?.failures ?? 0,
        refusals: (result.rejections || []).length,
        rejections: (result.rejections || []).map((entry) => ({ tool: entry.tool, code: entry.error?.code ?? null })),
        agentText: result.agentText ?? null,
        reportPath: result.reportPath ?? null,
        bypass,
        loopSteps: (result.steps || []).map((step) => step.step),
        calls,
        journalAfterTask,
        revert,
      };
    } finally {
      await agent.close();
    }
  } catch (error) {
    return {
      status: 'error',
      task: task.id,
      ms: null,
      toolCalls: 0,
      changesets: 0,
      revBefore: state?.rev ?? null,
      revAfter: null,
      verified: false,
      error: { code: error.code ?? 'ERROR', message: error.message },
      calls: [],
      revert: { attempted: false, granularity: 'property', selective: true },
    };
  } finally {
    if (!keep) await fs.rm(prepared.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ---------------------------------------------------------------- benchmark

function summaryOf(runs) {
  const ok = runs.filter((run) => run.status === 'ok');
  const first = ok[0] ?? runs[0];
  return {
    runCount: runs.length,
    ok: ok.length,
    ms: median(ok.map((run) => run.ms)),
    writeMs: median(ok.map((run) => run.writeMs).filter((value) => value != null)),
    toolCalls: median(ok.map((run) => run.toolCalls)),
    changesets: median(ok.map((run) => run.changesets)),
    propertiesChanged: median(ok.map((run) => run.propertiesChanged).filter((value) => value != null)),
    revAfter: first?.revAfter ?? null,
    verified: ok.length === runs.length && runs.every((run) => run.verified),
    failures: runs.reduce((sum, run) => sum + (run.failures ?? 0), 0),
    refusals: runs.reduce((sum, run) => sum + (run.refusals ?? 0), 0),
    revertMs: median(ok.filter((run) => run.revert?.attempted !== false).map((run) => run.revert?.ms).filter((value) => value != null)),
    revertGranularity: first?.revert?.granularity ?? null,
    revertSelective: first?.revert?.selective ?? null,
    revertRestored: ok.length > 0 && ok.every((run) => run.revert?.restored === true),
    revertDecisions: first?.revert?.decisions ?? null,
    revertAttempted: ok.some((run) => run.revert?.attempted !== false),
    bypassed: runs.some((run) => run.bypass?.detected === true),
    journalAfterTask: median(ok.map((run) => run.journalAfterTask).filter((value) => value != null)),
  };
}

const FAILED_RUN = (task, error) => ({
  status: 'error', task, ms: null, toolCalls: 0, changesets: 0, verified: false,
  error: { code: error.code ?? 'ERROR', message: error.message }, calls: [],
});

/**
 * Run the benchmark. Returns the report object (the CLI prints/writes it);
 * `out`/`md` are the CLI's business so tests and callers stay side-effect free.
 */
export async function runBench({
  agent = 'scripted', project = null, tasks = null, runs = null, bpm = 128,
  keep = false, timeoutMs = 600000, maxSteps = 40, resolveDsh = findDsh, log = () => {},
} = {}) {
  if (agent !== 'scripted' && agent !== 'dsh') throw new Error(`unknown agent mode ${agent} (scripted | dsh)`);
  const count = Math.max(1, Math.floor(Number(runs) || (agent === 'dsh' ? 1 : 3)));
  const wanted = tasks ? (Array.isArray(tasks) ? tasks : String(tasks).split(',').map((entry) => entry.trim()).filter(Boolean)) : null;
  const selected = wanted ? TASKS.filter((task) => wanted.includes(task.id)) : [...TASKS];
  const unknown = wanted ? wanted.filter((id) => !TASKS.some((task) => task.id === id)) : [];
  if (unknown.length) throw new Error(`unknown task(s) ${unknown.join(', ')}; known: ${TASKS.map((task) => task.id).join(', ')}`);

  let dsh = { available: false, bin: null };
  try {
    const found = await resolveDsh();
    if (found?.bin) dsh = { available: true, bin: found.bin };
  } catch { /* a probe failure is "not available" for reporting */ }

  const report = {
    version: BENCH_VERSION,
    kind: 'agent-benchmark',
    generatedAt: new Date().toISOString(),
    agent,
    status: 'ok',
    skipReason: null,
    surface: agent === 'dsh'
      ? 'engine/agent.js AgentLoop（dsh headless 逐步驱动；写入走变更集服务）'
      : 'MCP（mcp/tools.js::callTool → POST /api/rpc，进程内 runtime）',
    runs: count,
    project: null,
    env: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      dsh,
      still: agent === 'dsh' ? 'bench-synthetic（不计 Electron 出图时间）' : null,
    },
    tasks: [],
    baseline: { kind: BASELINE_KIND, note: '同机模拟：读工程文件 → applyOps → saveProject 覆盖写；无变更集、无 journal、无 rev 前置条件。', tasks: [] },
    comparison: [],
    notes: [],
  };

  if (agent === 'dsh' && !dsh.available) {
    report.status = 'skipped';
    report.skipReason = 'DSH-TUI not found：`npm i -g @deepseek-ai/dsh` 或把 VDM_DSH 指到它的 lib/bin.js';
    report.notes.push('本次没有真 dsh 数字（找不到 dsh）；--agent=scripted 可以在没有 dsh 的机器上跑。');
    return report;
  }

  let sample = null;
  const capture = (prepared) => {
    if (sample) return;
    sample = sourceMeta(prepared, { project });
    report.project = sample;
    if (prepared.beats.source === 'bench-seeded') {
      report.notes.push(`源工程没有 meta.beats / meta.tempo：基准在副本里按 ${bpm} bpm 种了一组帧对齐节拍（只改副本）。`);
    }
  };

  // ---- the change-set / agent side
  for (const task of selected) {
    const taskReport = {
      id: task.id, title: task.title, prompt: task.prompt, kind: task.select ? 'edit' : 'create', runs: [], status: 'ok',
    };
    for (let run = 1; run <= count; run++) {
      log(`[bench-agent] ${agent} · ${task.id} · run ${run}/${count}`);
      let record;
      try {
        record = agent === 'dsh'
          ? await runDshTask(task, {
            source: project, bpm, keep, timeoutMs, maxSteps: Math.max(20, maxSteps), resolveDsh,
            onProject: (prepared) => capture(prepared),
          })
          : await runScriptedTask(task, {
            source: project, bpm, keep, maxSteps,
            onProject: (prepared) => capture(prepared),
          });
      } catch (error) {
        record = FAILED_RUN(task.id, error);
      }
      taskReport.runs.push(record);
    }
    Object.assign(taskReport, summaryOf(taskReport.runs));
    if (taskReport.runs.some((run) => run.status === 'error')) {
      taskReport.status = 'error';
      report.notes.push(`${task.id}: ${taskReport.runs.filter((run) => run.status === 'error').length}/${taskReport.runs.length} 次运行报错（见 runs[].error）。`);
    }
    report.tasks.push(taskReport);
  }

  // ---- the direct-write baseline, same tasks, fresh copies
  for (const task of selected) {
    const baseReport = { id: task.id, title: task.title, runs: [], status: 'ok' };
    for (let run = 1; run <= count; run++) {
      log(`[bench-agent] direct · ${task.id} · run ${run}/${count}`);
      let record;
      try {
        record = await runDirectTask(task, {
          source: project, bpm, keep, onProject: (prepared) => capture(prepared),
        });
      } catch (error) {
        record = FAILED_RUN(task.id, error);
      }
      baseReport.runs.push(record);
    }
    Object.assign(baseReport, summaryOf(baseReport.runs));
    report.baseline.tasks.push(baseReport);
  }

  // ---- the comparison table
  for (const task of report.tasks) {
    const direct = report.baseline.tasks.find((entry) => entry.id === task.id);
    report.comparison.push({
      id: task.id,
      title: task.title,
      changeset: {
        ms: task.ms, writeMs: task.writeMs, toolCalls: task.toolCalls, changesets: task.changesets,
        propertiesChanged: task.propertiesChanged, revAfter: task.revAfter, verified: task.verified,
        failures: task.failures, refusals: task.refusals,
        revertMs: task.revertMs, revertGranularity: task.revertGranularity, revertRestored: task.revertRestored,
        journalEntries: task.journalAfterTask,
      },
      direct: direct ? {
        ms: direct.ms, writeMs: direct.writeMs, toolCalls: direct.toolCalls, changesets: direct.changesets,
        propertiesChanged: direct.propertiesChanged, revAfter: direct.revAfter, verified: direct.verified,
        failures: direct.failures, refusals: direct.refusals,
        revertMs: direct.revertMs, revertGranularity: direct.revertGranularity, revertRestored: direct.revertRestored,
        journalEntries: direct.journalAfterTask,
      } : null,
      deltaMs: direct?.ms != null && task.ms != null ? round(task.ms - direct.ms) : null,
      deltaWriteMs: direct?.writeMs != null && task.writeMs != null ? round(task.writeMs - direct.writeMs) : null,
    });
  }

  const bypassed = report.tasks.filter((task) => task.bypassed);
  const unrestored = report.tasks.filter((task) => task.revertAttempted && task.revertRestored === false);
  if (report.tasks.length && report.tasks.every((task) => task.status === 'error')) report.status = 'error';
  if (unrestored.length) {
    report.notes.push(`回退未完全复原：${unrestored.map((task) => `${task.id}（${task.revertDecisions ?? '?'} 个冲突决策）`).join('、')} —— `
      + '变更集的逐属性回退在不一致时留成决策（needs-decision），不会像直接写盘那样整份覆盖；细节见 runs[].revert。');
  }
  if (bypassed.length) {
    report.notes.push(`旁路写入（能力缺口）：${bypassed.map((task) => task.id).join('、')} —— 工程 rev 变了，但没有变更集 / journal 记录；`
      + 'agent 在变更集之外直接改了工程文件（见 runs[].bypass 与 evidence）。');
  }
  report.notes.push(
    '数字只有本轮：同一台机器、同一进程内 runtime（startServer），不是历史基线，也不是「A Rusty Dream」旧版直接写脚本的真实数据。',
    '走变更集的每条任务都用旧 rev 重放一次同样的写，确认被拒（REV_CONFLICT）、rev 与 journal 未变。',
    'verified 是脚本在任务结束后独立读盘核对字段（字号 / 起点 / x / 新增元素）并取 `vdm_inspect_coverage` 的取证，不采信 agent 自述。',
    '「直接写盘」基线不走 MCP：JSON.parse → applyOps → saveProject，工具调用为 0；两条路径的差别是整条工作流（含 RPC 开销），不只是变更集本身。',
    '直接写盘的回退 = 用任务前的整份文件覆盖回去（粒度 file、rev 会回退且不留记录）；变更集的回退是逐属性（粒度 property，进 journal）。',
    '复现：`node scripts/bench-agent.mjs --agent=scripted --runs 3`；真工程用 `--project <副本目录>`（例如 .scratch/wp0.1/miku-swiss）。',
  );
  if (!project) report.notes.push('默认工程是脚本内建的 3 秒夹具（3 个元素）；真工程请传 --project。');

  return report;
}

// ------------------------------------------------------------------ printing

const fmtMs = (value) => (value == null ? '—' : `${Math.round(value)} ms`);
const fmtNum = (value) => (value == null ? '—' : String(value));
const fmtYes = (value) => (value ? '✅' : '❌');
const fmtRevert = (entry) => {
  if (!entry || entry.attempted === false) return '—';
  const kind = entry.granularity === 'file' ? '整文件' : '逐属性';
  const outcome = entry.restored === true
    ? '已复原'
    : entry.restored === false
      ? `未复原${entry.decisions ? `（${entry.decisions} 个冲突）` : ''}`
      : '—';
  return `${kind} · ${fmtMs(entry.ms)} · ${outcome}`;
};
const table = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `|${header.map((_, index) => (index === 0 ? '---' : index === header.length - 1 ? '---' : '---')).join('|')}|`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
];

/** The report template: JSON is the data, this is the table a human reads. */
export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Agent 基准 · ${report.agent} · ${report.generatedAt}`);
  lines.push('');
  if (report.status === 'skipped') {
    lines.push('**跳过**：' + report.skipReason);
    lines.push('');
    for (const note of report.notes) lines.push(`- ${note}`);
    return `${lines.join(NL)}${NL}`;
  }
  const project = report.project || {};
  lines.push(`工程：${project.source === 'fixture' ? 'fixture' : project.source} · ${project.title ?? '?'} · `
    + `${project.elements ?? '?'} 元素 · ${project.fps ?? '?'} fps · ${fmtNum(project.duration)} s · rev ${fmtNum(project.rev)} · `
    + `节拍 ${project.beats?.source ?? '?'}（${fmtNum(project.beats?.count)} 个）`);
  const dshState = report.env.dsh?.available ? `可用（${report.env.dsh.bin}）` : '不可用';
  lines.push(`环境：${report.env.node} · ${report.env.platform} · dsh：${dshState} · 直接写盘基线：同机模拟`);
  lines.push(`工具面：${report.surface} · 运行 ${report.runs} 次/任务 · 表里是中位数`);
  lines.push('');
  lines.push('## 走变更集');
  lines.push('');
  lines.push(...table(
    ['任务', '总耗时', '写入耗时', '工具调用', '变更集', '改动属性', 'rev', 'verified', '失败/拒绝', '旁路写入', '回退（粒度 · 耗时 · 结果）'],
    report.tasks.map((task) => [
      `${task.title} \`${task.id}\``,
      fmtMs(task.ms),
      fmtMs(task.writeMs),
      fmtNum(task.toolCalls),
      fmtNum(task.changesets),
      fmtNum(task.propertiesChanged),
      `${fmtNum(task.runs[0]?.revBefore)}→${fmtNum(task.revAfter)}`,
      fmtYes(task.verified),
      `${fmtNum(task.failures)} / ${fmtNum(task.refusals)}`,
      task.bypassed ? '⚠️ 是' : '—',
      fmtRevert({ granularity: task.revertGranularity, ms: task.revertMs, restored: task.revertRestored, decisions: task.revertDecisions, attempted: task.revertAttempted }),
    ]),
  ));
  lines.push('');
  lines.push('## 直接写盘（模拟基线，无变更集）');
  lines.push('');
  lines.push(...table(
    ['任务', '总耗时', '写入耗时', '工具调用', '变更集', 'rev', 'verified', '回退（粒度 · 耗时 · 结果）'],
    report.baseline.tasks.map((task) => [
      `${task.title} \`${task.id}\``,
      fmtMs(task.ms),
      fmtMs(task.writeMs),
      fmtNum(task.toolCalls),
      fmtNum(task.changesets),
      `${fmtNum(task.runs[0]?.revBefore)}→${fmtNum(task.revAfter)}`,
      fmtYes(task.verified),
      fmtRevert({ granularity: task.revertGranularity, ms: task.revertMs, restored: task.revertRestored, decisions: task.revertDecisions, attempted: task.revertAttempted }),
    ]),
  ));
  lines.push('');
  lines.push('## 对比');
  lines.push('');
  lines.push(...table(
    ['任务', '总耗时（变更集 / 直接）', '写入耗时（变更集 / 直接）', '回退（变更集 / 直接）', '变更集记录'],
    report.comparison.map((row) => [
      `${row.title} \`${row.id}\``,
      `${fmtMs(row.changeset.ms)} / ${fmtMs(row.direct?.ms)}`,
      `${fmtMs(row.changeset.writeMs)} / ${fmtMs(row.direct?.writeMs)}`,
      `${fmtMs(row.changeset.revertMs)} / ${fmtMs(row.direct?.revertMs)}`,
      `${fmtNum(row.changeset.changesets)} 个 / ${fmtNum(row.changeset.journalEntries)} 条 journal`,
    ]),
  ));
  lines.push('');
  lines.push('说明：');
  for (const note of report.notes) lines.push(`- ${note}`);
  return `${lines.join(NL)}${NL}`;
}

// ------------------------------------------------------------------- CLI glue

function parseArgs(argv) {
  const argOf = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
    const equal = argv.find((entry) => entry.startsWith(`--${name}=`));
    return equal !== undefined ? equal.slice(name.length + 3) : fallback;
  };
  const has = (name) => argv.includes(`--${name}`);
  return {
    help: has('help') || has('h'),
    agent: argOf('agent', 'scripted'),
    project: argOf('project'),
    tasks: argOf('tasks'),
    runs: argOf('runs') ? Number(argOf('runs')) : null,
    bpm: Number(argOf('bpm', 128)),
    out: argOf('out'),
    md: argOf('md'),
    json: has('json'),
    keep: has('keep'),
    noOut: has('no-out'),
    timeoutMs: Number(argOf('timeout', 600)) * 1000,
  };
}

const HELP = [
  'Agent 对比基准（docs/DESIGN-BACKEND-V2.md §8.4 / WP5.3）',
  '',
  '用法：',
  '  node scripts/bench-agent.mjs --agent=scripted [--project <副本>] [--runs 3] [--tasks id,id]',
  '  node scripts/bench-agent.mjs --agent=dsh [--project <副本>] [--timeout 600]',
  '',
  '选项：',
  '  --agent=scripted|dsh   scripted：ScriptedAgent 固定脚本走 MCP 工具面（可重复，回归用）',
  '                         dsh：真 dsh（engine/dsh-agent.js），找不到时跳过并说明',
  '  --project=<dir>        工程目录；默认是脚本内建的 3 秒夹具。会复制到临时目录，不写源工程',
  '  --tasks=<ids>          只跑指定任务（逗号分隔）',
  '  --runs=<n>             每个任务跑几次（scripted 默认 3，dsh 默认 1）',
  '  --bpm=<n>              工程没有 meta.beats/tempo 时，给副本种一组节拍（默认 128）',
  '  --out=<file>           JSON 报告路径（默认 .scratch/bench-agent/…json）',
  '  --md=<file>            markdown 表路径（默认与 JSON 同名 .md）',
  '  --json                 只把 JSON 打到 stdout',
  '  --no-out               不写文件，只打表',
  '  --keep                 保留临时工程副本（排查用）',
].join(NL);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.agent !== 'scripted' && options.agent !== 'dsh') {
    console.error(`[bench-agent] --agent must be scripted or dsh (got ${options.agent})`);
    process.exitCode = 1;
    return;
  }
  const report = await runBench({
    agent: options.agent,
    project: options.project,
    tasks: options.tasks,
    runs: options.runs,
    bpm: Number.isFinite(options.bpm) ? options.bpm : 128,
    keep: options.keep,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 600000,
    log: (line) => console.error(line),
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderMarkdown(report));

  if (!options.noOut || options.out) {
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    const out = path.resolve(options.out ?? path.join(REPO, '.scratch', 'bench-agent', `${report.agent}-${stamp}.json`));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(report, null, 2)}${NL}`);
    const md = path.resolve(options.md ?? out.replace(/\.json$/, '.md'));
    await fs.writeFile(md, renderMarkdown(report));
    console.error(`[bench-agent] wrote ${path.relative(process.cwd(), out)} and ${path.relative(process.cwd(), md)}`);
  }
  if (report.status === 'error') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`[bench-agent] ${error.message}`);
    process.exitCode = 1;
  }
}
