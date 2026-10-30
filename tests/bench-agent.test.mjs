// Agent comparison benchmark — docs/DESIGN-BACKEND-V2.md §8.4 / WP5.3.
//
// What this file guards:
//   * `scripts/bench-agent.mjs` runs its fixed task set through the MCP tool
//     surface (`callTool`) with a `ScriptedAgent` script, without dsh, so the
//     benchmark itself is a regression test;
//   * every run records the fields the comparison needs: wall time, tool calls,
//     change sets, the final revision, whether the task's acceptance check
//     passed, failures/refusals, and what reverting costs;
//   * the revision precondition is exercised on every task: the same write is
//     replayed against the stale revision, is refused with REV_CONFLICT, and
//     does not move the project or the journal;
//   * the simulated "no change set, write the file" baseline runs the same task
//     on its own copy, so "times" are not compared across different inputs;
//   * the markdown table renders (that is the human-facing deliverable);
//   * `--agent=dsh` without dsh is skipped with a reason instead of failing,
//     and the skip still renders.
//
// The real dsh path is not exercised here: it needs dsh installed and a model
// behind it, so a run would be slow and non-deterministic. `resolveDsh` is
// injected in the skip test.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BENCH_VERSION, TASKS, fixtureProject, renderMarkdown, runBench,
} from '../scripts/bench-agent.mjs';

const TASK_ID = 'font-size-and-beat';

test('bench-agent: scripted 固定任务走 MCP 工具面，记录字段齐全且能出表', { timeout: 180000 }, async () => {
  const report = await runBench({ agent: 'scripted', tasks: [TASK_ID], runs: 1 });

  assert.equal(report.version, BENCH_VERSION);
  assert.equal(report.kind, 'agent-benchmark');
  assert.equal(report.status, 'ok');
  assert.equal(report.agent, 'scripted');
  assert.match(report.surface, /callTool/);
  assert.equal(report.runs, 1);
  assert.equal(report.project.source, 'fixture');
  assert.equal(report.project.kind, 'fixture');
  assert.equal(report.project.elements, 3);

  assert.equal(report.tasks.length, 1);
  const task = report.tasks[0];
  assert.equal(task.id, TASK_ID);
  assert.equal(task.status, 'ok');
  assert.equal(task.runs.length, 1);
  const run = task.runs[0];

  // The fields the comparison table is built from.
  for (const field of [
    'ms', 'writeMs', 'toolCalls', 'changesets', 'propertiesChanged', 'revBefore', 'revAfter',
    'verified', 'failures', 'refusals', 'checks', 'evidence', 'calls', 'revert', 'journalAfterTask',
  ]) {
    assert.ok(field in run, `run record misses ${field}`);
  }
  assert.ok(run.ms > 0, 'wall time is measured');
  assert.equal(run.changesets, 1, 'one task = one change set');
  assert.equal(run.revAfter, run.revBefore + 1, 'one change set = one revision');
  assert.equal(run.verified, true);
  assert.equal(run.failures, 0);
  assert.equal(run.refusals, 1, 'the stale-rev replay is the one refusal');
  assert.equal(run.journalAfterTask, 1, 'the write is in the journal');

  // Every tool call is on the MCP surface and the script really read before it wrote.
  assert.ok(run.toolCalls >= 6);
  assert.ok(run.calls.every((call) => String(call.tool).startsWith('vdm_')), JSON.stringify(run.calls.map((call) => call.tool)));
  const order = run.calls.map((call) => call.tool);
  assert.ok(order.indexOf('vdm_project_read') < order.indexOf('vdm_changeset_apply'));
  assert.ok(order.indexOf('vdm_changeset_apply') < order.indexOf('vdm_inspect_coverage'));
  assert.equal(run.calls.filter((call) => !call.ok).length, 1);
  assert.equal(run.calls.at(-1).code, 'REV_CONFLICT');

  // The precondition check: refused, nothing written, journal unchanged.
  assert.equal(run.guard.code, 'REV_CONFLICT');
  assert.equal(run.guard.refused, true);
  assert.equal(run.guard.revUnchanged, true);
  assert.equal(run.guard.journalUnchanged, true);
  assert.equal(run.guard.passed, true);

  // Acceptance evidence comes from measuring, not from the agent's prose.
  const checks = run.checks.map((entry) => `${entry.name}:${entry.ok}`);
  assert.ok(checks.includes('字号写成 150:true'));
  assert.ok(checks.includes('起点卡到最近拍点:true'));
  assert.equal(run.evidence.beat.frameAligned, 0.867);
  assert.ok(run.evidence.coverage.framesUnoccluded > 0);
  assert.equal(run.evidence.element.start, 0.867);

  // Revert through the change set restores the project (property granularity).
  assert.equal(run.revert.attempted, true);
  assert.equal(run.revert.granularity, 'property');
  assert.equal(run.revert.restored, true);
  assert.equal(run.revert.counts.conflicts, 0);
  assert.ok(run.journalAfterRevert >= 2, 'the revert is journalled too');
  assert.equal(run.bypass.detected, false);

  // ... and the baseline is a real second run of the same task.
  assert.equal(report.baseline.kind, 'simulated-direct-write');
  assert.match(report.baseline.note, /saveProject/);
  assert.equal(report.baseline.tasks.length, 1);
  const direct = report.baseline.tasks[0];
  assert.equal(direct.id, TASK_ID);
  assert.equal(direct.status, 'ok');
  const directRun = direct.runs[0];
  assert.equal(directRun.changesets, 0);
  assert.equal(directRun.toolCalls, 0, 'the direct path does not go through MCP');
  assert.equal(directRun.verified, true);
  assert.equal(directRun.revAfter, directRun.revBefore + 1);
  assert.equal(directRun.journalAfterTask, 0, 'no journal entry on the direct path');
  assert.equal(directRun.revert.granularity, 'file');
  assert.equal(directRun.revert.restored, true);
  assert.equal(directRun.guard.supported, false);

  // The comparison row stitches both sides together.
  assert.equal(report.comparison.length, 1);
  const row = report.comparison[0];
  assert.equal(row.id, TASK_ID);
  assert.equal(row.changeset.changesets, 1);
  assert.equal(row.direct.changesets, 0);
  assert.ok(Number.isFinite(row.deltaMs));

  // The markdown is the report template: both paths and the caveats are there.
  const markdown = renderMarkdown(report);
  assert.match(markdown, /^\| 任务 \|/m);
  assert.match(markdown, /走变更集/);
  assert.match(markdown, /直接写盘/);
  assert.match(markdown, new RegExp(TASK_ID));
  assert.match(markdown, /Rev|rev/);
  assert.match(markdown, /旁路写入/);
  assert.match(markdown, /只有本轮/);
  assert.match(markdown, /REV_CONFLICT/);
  assert.ok(report.notes.some((note) => note.includes('只有本轮')));
});

test('bench-agent: dsh 缺失时跳过并说明原因，仍然能渲染报告', { timeout: 60000 }, async () => {
  const report = await runBench({
    agent: 'dsh',
    tasks: [TASK_ID],
    runs: 1,
    resolveDsh: async () => null,
  });
  assert.equal(report.status, 'skipped');
  assert.match(report.skipReason, /dsh/i);
  assert.match(report.skipReason, /npm i -g|VDM_DSH/);
  assert.equal(report.env.dsh.available, false);
  assert.equal(report.tasks.length, 0, 'no task is attempted without dsh');
  assert.equal(report.baseline.tasks.length, 0);

  const markdown = renderMarkdown(report);
  assert.match(markdown, /跳过/);
  assert.match(markdown, /dsh/i);
  assert.match(markdown, /scripted/);
});

test('bench-agent: 三个固定任务都有定义，作用域与验收检查是显式的', () => {
  const ids = TASKS.map((task) => task.id);
  for (const id of ['font-size-and-beat', 'add-element', 'fix-position']) {
    assert.ok(ids.includes(id), `missing task ${id}`);
  }
  for (const task of TASKS) {
    assert.ok(task.id);
    assert.ok(task.title);
    assert.ok(task.prompt && task.prompt.length > 6);
    assert.equal(typeof task.ops, 'function');
    assert.equal(typeof task.verify, 'function');
    assert.equal(typeof task.coverageTarget, 'function');
    assert.equal(typeof task.scope, 'function');
    assert.ok(Array.isArray(task.scope(task.select ? { id: 'el_x' } : null).elements));
    if (task.select) assert.ok(task.select instanceof RegExp);
  }
  // The default project carries the names the tasks select on.
  const fixture = fixtureProject();
  assert.ok(fixture.elements.some((el) => /01 词2/.test(String(el.name))));
  assert.ok(fixture.elements.some((el) => /01 词1/.test(String(el.name))));
  assert.ok(Array.isArray(fixture.meta.beats) && fixture.meta.beats.length > 0);
});
