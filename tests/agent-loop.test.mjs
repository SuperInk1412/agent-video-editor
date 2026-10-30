// Agent tool loop — docs/DESIGN-BACKEND-V2.md §8.4 / WP2.4.
//
// What this file guards:
//   * the fixed task "把 01 词2 改成 150 号字并卡到最近拍点" runs the whole
//     loop — read → plan → propose a change set → still → measure → report —
//     and the report names the element, the property, the before/after values,
//     the still paths and sizes, the measured text box and the beat data source;
//   * every write is a change set that goes `proposed` → `applied` (WP2.2), so
//     it is in the journal with its `changesetId`;
//   * the plan phase writes nothing: the project file is byte-identical and the
//     revision does not move while only a `proposed` change set exists;
//   * a write outside the request scope is refused (`PATH_OUTSIDE_SCOPE`) and a
//     locked host is refused (`LOCKED`) — in both cases the revision and
//     `.vdm/transactions.json` stay where they were;
//   * reverting the agent's change set restores the project content (hash),
//     even though the raw file must take a new revision and save stamp;
//   * the agent's ops are validated against `core/contracts.js` — an unknown op,
//     an unknown field or a missing field is refused, and the report counts the
//     comparisons;
//   * the line-protocol transport (`ProcessAgent`) drives the same loop over
//     stdin/stdout, so a real dsh adapter has a seam that is already tested;
//   * a one-shot transport that answers with legacy {"note","ops"} still lands
//     in the journal as one change set — no path around WP2.2.
//
// Everything here is a scripted agent (no dsh, no network, no Electron): the
// still renderer is a tiny PNG writer, so the suite stays hermetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import { saveProject } from '../engine/storage.js';
import { projectService } from '../engine/projects.js';
import { ChangeSetService } from '../application/changeset-service.js';
import { content } from '../application/project-service.js';
import { CONTRACT_VERSION, PUBLIC_OPS } from '../core/contracts.js';
import {
  AgentLoop, LOOP_TOOLS, LOOP_VERSION, PATH_OUTSIDE_SCOPE, ProcessAgent, ScriptedAgent,
  checkScope, nearestBeat, opTargets, pngSize,
} from '../engine/agent.js';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const contentHash = (project) => sha256(JSON.stringify(content(project)));
const projectFile = (root) => path.join(root, 'project.vdm.json');
const journalFile = (root) => path.join(root, '.vdm', 'transactions.json');
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
/** Journal length; a project nobody wrote to has no journal file at all. */
async function journalEntries(root) {
  try {
    return (await readJson(journalFile(root))).entries.length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

const TASK = '把 01 词2 改成 150 号字并卡到最近拍点';
/** Only the lyric and only the two properties the task needs, plus structure. */
const SCOPE = { elements: ['s1_w2'], paths: ['style.size', 'start', '@host'] };

// ---------------------------------------------------------------- fixture

const nodeOf = (pivot) => ({ pivot, position: [0, 0, 0], scale: [1, 1, 1], rotation: [0, 0, 0] });

/** A 3 s, 30 fps project with one lyric named "01 词2 幻想" (size 230). */
function fixtureProject({ beats = [0.1, 0.85, 1.6, 2.35], tempo = 80 } = {}) {
  return {
    schema: 'vdm.project/1', rev: 1,
    meta: {
      title: 'agent loop fixture', fps: 30, width: 1920, height: 1080, duration: 3,
      background: '#05070d', beats, tempo, fx: {}, style: 'default', curvePresets: [],
    },
    segments: [],
    elements: [
      {
        id: 'bg', name: '底色', type: 'solid', start: 0, duration: 3, z: 1, visible: true,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        node: nodeOf([0, 0, -2]), style: { w: 9600, h: 5400, fill: '#111111' },
      },
      {
        id: 's1_w2', name: '01 词2 幻想', type: 'text', start: 0.5, duration: 1.167, z: 5, visible: true,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        node: nodeOf([0, 0, 0]), style: { text: '幻想', size: 230, color: '#F2F0EB', align: 'center' },
      },
    ],
    cameras: [{ id: 'cam_a', name: 'A', path: [{ t: 0, pos: [0, 0, 20], look: [0, 0, 0] }], fov: 50, start: 0, duration: 3, visible: true }],
    cameraOrder: ['cam_a'], activeCameraId: 'cam_a',
    world: { source: 'none' },
  };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-agent-loop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveProject(root, fixtureProject(options), { by: 'test' });
  const service = projectService(root);
  const changesets = new ChangeSetService(service);
  const project = await service.read();
  return { root, service, changesets, project, rev: project.rev };
}

// ------------------------------------------------------------ tiny PNG writer
// The still step must produce a real PNG so the report can quote a real size;
// a 20-line encoder keeps the suite free of ffmpeg/Electron/canvas.
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
const chunk = (type, data) => {
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
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height); // every row: filter 0 + transparent black
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** `renderStill` stand-in: writes a real PNG where the loop asked for it. */
const fakeStill = () => async ({ dir, frame, label }) => {
  const file = path.join(dir, '.vdm', 'agent', 'stills', `${label}-f${frame}.png`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const png = pngBuffer();
  await fs.writeFile(file, png);
  return { path: file, width: 1920, height: 1080, bytes: png.length, ms: 1, backend: 'fake-png' };
};

// ------------------------------------------------------- the fixed task script

/**
 * The agent half of "把 01 词2 改成 150 号字并卡到最近拍点". Every step reads
 * what the previous tool returned — the policy decides, the loop only enforces.
 */
function fixedTaskScript() {
  let target = null;
  let snap = null;
  const ops = () => ([
    { op: 'set', id: target.id, path: 'style.size', value: 150 },
    { op: 'moveElement', id: target.id, start: snap.frameAligned },
  ]);
  return [
    () => ({ tool: 'read', args: { what: 'project' } }),
    () => ({ tool: 'read', args: { what: 'elements', name: '01 词2' } }),
    (ctx) => {
      [target] = ctx.lastOk('read').elements;
      assert.equal(target.id, 's1_w2');
      return { tool: 'read', args: { what: 'beats', near: { id: target.id, edge: 'start' } } };
    },
    (ctx) => {
      snap = ctx.lastOk('read').nearest[0].nearest;
      return {
        tool: 'plan',
        args: {
          intent: TASK,
          steps: [
            { title: '改字号', kind: 'style', ops: [ops()[0]] },
            { title: '卡到最近拍点', kind: 'timing', ops: [ops()[1]] },
          ],
        },
      };
    },
    () => ({ tool: 'ops', args: { ops: ops() } }),
    () => ({ tool: 'changeset', args: { action: 'propose', ops: ops(), intent: '字号 150 + 卡到最近拍点' } }),
    () => ({ tool: 'still', args: { t: target.start + target.duration / 2, label: 'before' } }),
    (ctx) => ({ tool: 'changeset', args: { action: 'apply', id: ctx.lastOk('changeset').id } }),
    () => ({ tool: 'still', args: { t: snap.frameAligned + target.duration / 2, label: 'after' } }),
    () => ({ tool: 'measure', args: { what: 'stackAt', t: snap.frameAligned + target.duration / 2, point: [960, 540] } }),
    () => ({
      tool: 'measure',
      args: {
        what: 'coverage', focus: target.id,
        f0: Math.round(snap.frameAligned * 30), f1: Math.round((snap.frameAligned + target.duration) * 30),
      },
    }),
    () => ({ tool: 'measure', args: { what: 'textBox', id: target.id } }),
    (ctx) => ({ tool: 'measure', args: { what: 'diff', id: ctx.toolResults('changeset').at(-1).result.id } }),
    () => ({ tool: 'report', args: {} }),
    () => ({ type: 'final', text: '已把 01 词2 改成 150 号字并卡到最近拍点' }),
  ];
}

// --------------------------------------------------------------- acceptance 1

test('agent loop: 固定任务走完 计划 → 变更集 → 出图 → 测量 → 报告', { timeout: 60000 }, async (t) => {
  const { root, changesets } = await fixture(t);
  const loop = new AgentLoop({
    root, scope: SCOPE, changesets,
    agent: new ScriptedAgent({ script: fixedTaskScript() }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());

  // Phase 1: plan only. A proposal exists; the project is untouched.
  const planned = await loop.run({ task: TASK, planOnly: true });
  assert.equal(planned.status, 'awaiting-approval');
  assert.equal(planned.changesets.length, 1);
  assert.equal(planned.changesets[0].status, 'proposed');
  assert.equal(planned.plan.intent, TASK);
  assert.equal(planned.plan.steps.length, 2);
  assert.equal(planned.plan.opsCount, 2);
  assert.equal(planned.plan.needsApproval, false, 'two ops on one host is a micro-tune, not a big plan');

  // Phase 2: approve, then apply → still → measure → report.
  const done = await loop.approve({ planId: planned.plan.id });
  assert.equal(done.status, 'completed');
  const applied = done.changesets.find((entry) => entry.status === 'applied');
  assert.ok(applied, 'the proposal ended up applied');
  assert.equal(applied.baseRev, planned.report.planPhase.before);
  assert.equal(applied.rev, applied.baseRev + 1, 'one change set = one revision');
  assert.equal(applied.transactions.length, 1);
  assert.equal(applied.changed.length, 2);

  // ... the model reached the project through the change-set service ...
  const project = await changesets.service.read();
  const lyric = project.elements.find((el) => el.id === 's1_w2');
  assert.equal(lyric.style.size, 150);
  assert.equal(lyric.start, 0.867, 'start lands on frame 26 (26/30 s, stored to 3 decimals)');
  assert.equal(project.rev, applied.rev);

  // ... and the journal carries the change set id (WP2.2).
  const journal = await readJson(journalFile(root));
  const entry = journal.entries.at(-1);
  assert.equal(entry.changesetId, applied.id);
  assert.equal(entry.actorId, 'agent:dsh');
  assert.equal(entry.rev, applied.rev);

  // ---- the report has to carry the evidence, not the agent's prose ----
  const report = done.report;
  assert.equal(report.version, LOOP_VERSION);
  assert.equal(report.kind, 'agent-report');
  assert.equal(report.task, TASK);
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.scope.paths, SCOPE.paths);
  assert.equal(report.agentText, '已把 01 词2 改成 150 号字并卡到最近拍点');
  assert.equal(report.mismatch, null);

  const size = report.comparison.find((row) => row.path === 'style.size');
  assert.equal(size.id, 's1_w2');
  assert.equal(size.before, 230);
  assert.equal(size.after, 150);
  assert.equal(size.delta, -80);
  assert.deepEqual(size.measured.before.box, [621, 432.4], 'text box before, estimateTextBox');
  assert.deepEqual(size.measured.after.box, [405, 282], 'text box after, estimateTextBox');
  assert.equal(size.measured.after.boxSource, 'estimate');

  const timing = report.comparison.find((row) => row.path === 'start');
  assert.equal(timing.before, 0.5);
  assert.equal(timing.after, 0.867);
  assert.equal(timing.measured.after.beatStart.frame, 26);
  assert.equal(timing.measured.after.beatStart.deltaFrames, 0);
  assert.equal(Math.abs(timing.measured.before.beatStart.deltaFrames), 11, 'before the snap the start is 11 frames off');

  // beat data source: stored markers, with tempo and fps alongside
  assert.equal(report.beats.source, 'meta.beats');
  assert.equal(report.beats.count, 4);
  assert.equal(report.beats.tempo, 80);
  assert.equal(report.beats.fps, 30);

  // stills: real files with real sizes, before and after the apply
  assert.equal(report.stills.length, 2);
  assert.deepEqual(report.stills.map((still) => still.label), ['before', 'after']);
  for (const still of report.stills) {
    assert.equal(still.width, 1920);
    assert.equal(still.height, 1080);
    assert.equal(still.backend, 'fake-png');
    const bytes = await fs.readFile(path.join(root, still.path));
    assert.deepEqual(pngSize(bytes), { width: 1920, height: 1080 });
    assert.equal(bytes.length, still.bytes);
  }
  assert.deepEqual(report.stills.map((still) => still.rev), [planned.report.planPhase.before, applied.rev]);

  // measurements: stackAt / coverage / textBox / diff, all recorded
  const kinds = report.measurements.map((row) => row.what);
  for (const kind of ['stackAt', 'coverage', 'textBox', 'diff']) assert.ok(kinds.includes(kind), `missing ${kind}`);
  const coverageRow = report.measurements.find((row) => row.what === 'coverage');
  assert.ok(coverageRow.data.summary.framesPresent >= 30, 'the lyric is present for its whole span');
  assert.ok(coverageRow.data.summary.samplesUnoccluded > 0);
  // The loop's own before/after set samples a 5x5 grid over the changed host.
  // 26/30 s is stored as 0.867, which is 0.0003 s after the frame boundary, so
  // frame 26 is counted as "not yet started" and 34 of 35 frames are present.
  assert.equal(size.measured.after.coverage.framesPresent, 34);
  assert.equal(size.measured.after.coverage.samplesUnoccluded, 850);
  assert.equal(size.measured.before.coverage.samplesUnoccluded, 875);
  assert.equal(report.measurements.find((row) => row.what === 'textBox').data.box[0], 405);

  // §8.3 verification rows: nothing claimed that was not measured
  assert.equal(report.verificationSummary.unverified, 0);
  assert.ok(report.verificationSummary.verified >= 8);
  const claims = report.verification.map((row) => `${row.claim} ${row.evidence}`).join('\n');
  assert.match(claims, /style\.size：230 → 150/);
  assert.match(claims, /文本包围盒 621×432\.4 → 405×282/);
  assert.match(claims, /第 2 拍 @0\.85s → 帧 26/);
  assert.match(claims, /meta\.beats/);
  assert.match(claims, /proposed@baseRev \d+ → applied@rev \d+/);

  // the flow log covers every phase, in order
  const steps = report.steps.map((step) => step.step);
  for (const step of ['read', 'plan', 'propose', 'approve', 'still', 'apply', 'measure', 'final', 'report']) {
    assert.ok(steps.includes(step), `log misses ${step}: ${steps.join(',')}`);
  }
  assert.ok(steps.indexOf('propose') < steps.indexOf('apply'));
  assert.ok(steps.indexOf('apply') < steps.indexOf('measure'));
  assert.match(report.log.join('\n'), /read\(elements\) → 1 个元素 · s1_w2\(01 词2 幻想\)/);
  assert.match(report.log.join('\n'), /changeset → cs_\w+ applied · rev \d+ · 2 处/);

  // the report is on disk, addressable from the panel's data layer
  assert.match(done.reportPath, /^\.vdm\/agent\/reports\/loop-[\w-]+\.json$/);
  const saved = await readJson(path.join(root, done.reportPath));
  assert.equal(saved.runId, done.runId);
  assert.equal(saved.comparison.length, 2);
});

// --------------------------------------------------------------- acceptance 3

test('agent loop: 计划阶段不动项目（字节与 rev 都不变）', { timeout: 30000 }, async (t) => {
  const { root, rev } = await fixture(t);
  const before = await fs.readFile(projectFile(root));
  const journalBefore = await journalEntries(root);
  const loop = new AgentLoop({
    root, scope: SCOPE, agent: new ScriptedAgent({ script: fixedTaskScript() }), renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const planned = await loop.run({ task: TASK, planOnly: true });

  const after = await fs.readFile(projectFile(root));
  assert.equal(sha256(after), sha256(before), 'project.vdm.json is byte-identical during the plan phase');
  assert.equal((await loop.service.read()).rev, rev, 'no revision was taken');
  assert.equal(await journalEntries(root), journalBefore, 'no journal entry');

  assert.equal(planned.report.planPhase.unchanged, true);
  assert.equal(planned.report.planPhase.before, rev);
  assert.equal(planned.report.planPhase.after, rev);
  assert.equal(planned.report.changesets[0].status, 'proposed');
  const stored = await planned.changesets[0];
  const record = await readJson(path.join(root, '.vdm', 'changesets.json'));
  assert.ok(JSON.stringify(record).includes(stored.id), 'the proposal is recorded in .vdm/changesets.json');
  const planRow = planned.report.verification.find((row) => row.claim.startsWith('计划阶段没有动项目'));
  assert.equal(planRow.status, 'verified');
});

// --------------------------------------------------------------- acceptance 2

test('agent loop: 范围外写入被拒，rev 与 transactions.json 不变', { timeout: 30000 }, async (t) => {
  const { root, rev } = await fixture(t);
  const before = await fs.readFile(projectFile(root));
  const journalBefore = await journalEntries(root);
  const script = [
    { tool: 'read', args: { what: 'elements', name: '01 词2' } },
    // 1. the right element, a property outside the whitelist
    { tool: 'changeset', args: { action: 'propose', ops: [{ op: 'set', id: 's1_w2', path: 'style.color', value: '#ff0000' }] } },
    // 2. an element outside the id whitelist
    { tool: 'changeset', args: { action: 'propose', ops: [{ op: 'set', id: 'bg', path: 'style.size', value: 12 }] } },
    // 3. creation, which the scope does not extend to (`@new`)
    { tool: 'changeset', args: { action: 'propose', ops: [{ op: 'addElement', element: { type: 'text', style: { text: '新词', size: 40 } } }] } },
    { tool: 'changeset', args: { action: 'list' } },
    { type: 'final', text: '范围外，放弃' },
  ];
  const loop = new AgentLoop({ root, scope: SCOPE, agent: new ScriptedAgent({ script }), renderStill: fakeStill() });
  t.after(() => loop.close());
  const result = await loop.run({ task: '改颜色并删掉它' });

  assert.equal(result.status, 'completed');
  assert.equal(result.rejections.length, 3);
  const errors = result.rejections.map((entry) => entry.error);
  for (const error of errors) assert.equal(error.code, PATH_OUTSIDE_SCOPE);
  assert.match(errors[0].message, /style\.color/, 'the message names the property');
  assert.match(errors[0].message, /paths: style\.size, start, @host/, 'and the whitelist it violated');
  assert.equal(errors[0].path, 'style.color');
  assert.equal(errors[0].id, 's1_w2');
  assert.match(errors[1].message, /targets bg, outside scope/);
  assert.match(errors[2].message, /targets @new, outside scope/);

  // nothing was written: bytes, revision, journal and change-set registry
  assert.equal(sha256(await fs.readFile(projectFile(root))), sha256(before));
  assert.equal((await loop.service.read()).rev, rev);
  assert.equal(await journalEntries(root), journalBefore);
  assert.equal(result.changesets.length, 0, 'no change set exists for a refused write');
  assert.equal((await loop.changesets.list()).total, 0);

  const report = result.report;
  assert.equal(report.counts.outsideScope, 3);
  assert.equal(report.counts.applied, 0);
  const refused = report.verification.find((row) => row.claim.startsWith('请求范围外的写入'));
  assert.equal(refused.status, 'verified');
  assert.match(refused.evidence, /3 次被拒（PATH_OUTSIDE_SCOPE/);
  // A claim of work with no applied change set is flagged, not accepted.
  assert.equal(report.mismatch, null, 'the agent never claimed a change, so nothing is flagged');
  assert.equal(report.agentText, '范围外，放弃');
});

test('agent loop: 锁定宿主的写入被拒（LOCKED，来自 WP2.2）', { timeout: 30000 }, async (t) => {
  const { root, service, rev } = await fixture(t);
  // The lock is a user action: written by the editor, not by the agent.
  await service.transact({
    ops: [{ op: 'set', id: 's1_w2', path: 'locked', value: true }],
  }, { actorId: 'ui' });
  const lockedRev = (await service.read()).rev;
  const journalBefore = await journalEntries(root);
  const loop = new AgentLoop({
    root, scope: { elements: ['s1_w2'], paths: ['locked', 'style.size'] },
    agent: new ScriptedAgent({
      script: [
        { tool: 'changeset', args: { action: 'propose', ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150 }] } },
        { type: 'final', text: '' },
      ],
    }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const result = await loop.run({ task: '改锁定元素的字号' });
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].error.code, 'LOCKED');
  assert.match(result.rejections[0].error.message, /locked/i);
  assert.equal((await service.read()).rev, lockedRev);
  assert.equal(await journalEntries(root), journalBefore);
  assert.ok(rev < lockedRev, 'the fixture lock itself took a revision');
  const row = result.report.verification.find((entry) => entry.claim.includes('LOCKED'));
  assert.equal(row.status, 'verified');
});

// --------------------------------------------------------------- acceptance 4

test('agent loop: 变更集 revert 后项目内容回到执行前（hash 相同）', { timeout: 30000 }, async (t) => {
  const { root, service, changesets } = await fixture(t);
  const before = await service.read();
  const beforeHash = contentHash(before);
  const beforeRaw = await readJson(projectFile(root));
  const loop = new AgentLoop({
    root, scope: SCOPE, agent: new ScriptedAgent({ script: fixedTaskScript() }), renderStill: fakeStill(), changesets,
  });
  t.after(() => loop.close());
  const planned = await loop.run({ task: TASK, planOnly: true });
  const done = await loop.approve({ planId: planned.plan.id });
  const applied = done.changesets.find((entry) => entry.status === 'applied');
  const appliedProject = await service.read();
  assert.notEqual(contentHash(appliedProject), beforeHash);

  const reverted = await changesets.revert({ id: applied.id, actorId: 'agent:dsh' });
  assert.equal(reverted.status, 'reverted');
  assert.equal(reverted.revert.reverted, 2);
  assert.equal(reverted.revert.conflicts, 0);
  const now = await service.read();
  assert.equal(contentHash(now), beforeHash, 'the project content is back to the pre-run state');
  assert.equal(now.elements.find((el) => el.id === 's1_w2').style.size, 230);
  assert.equal(now.elements.find((el) => el.id === 's1_w2').start, 0.5);
  // The file itself is back: the two edited properties and the revision trail.
  const rawNow = await readJson(projectFile(root));
  const rawLyric = rawNow.elements.find((el) => el.id === 's1_w2');
  assert.equal(rawLyric.style.size, 230);
  assert.equal(rawLyric.start, 0.5);
  assert.equal(rawNow.rev, applied.rev + 1);
  assert.notEqual(rawNow.rev, beforeRaw.rev);
  // project.vdm.json's *bytes* cannot match: the first transaction normalizes a
  // hand-written project (defaults, camera alias, world) and every write takes a
  // revision + save stamp. The content hash is the fair comparison, and it
  // matches; `content()` drops exactly `rev` and `meta.savedAt`.
  assert.equal(contentHash(now), contentHash(before));
});

test('agent loop: agent 自己发起的 revert 在报告里标成已验证', { timeout: 30000 }, async (t) => {
  const { root } = await fixture(t);
  const loop = new AgentLoop({
    root, scope: SCOPE,
    agent: new ScriptedAgent({
      script: [
        { tool: 'changeset', args: { action: 'propose', ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150 }] } },
        (ctx) => ({ tool: 'changeset', args: { action: 'apply', id: ctx.lastOk('changeset').id } }),
        (ctx) => ({ tool: 'changeset', args: { action: 'revert', id: ctx.toolResults('changeset').filter((message) => message.result?.status === 'applied').at(-1).result.id } }),
        (ctx) => ({ tool: 'read', args: { what: 'element', id: 's1_w2' } }),
        { type: 'final', text: '改完又退回去了' },
      ],
    }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const result = await loop.run({ task: '试一下再退回' });
  assert.equal(result.status, 'completed');
  const revertRow = result.report.verification.find((row) => row.claim.includes('可回退'));
  assert.equal(revertRow.status, 'verified');
  assert.match(revertRow.evidence, /与执行前相同/);
  assert.equal(result.report.changesets.at(-1).status, 'reverted');
  assert.equal(result.report.mismatch, null);
});

// --------------------------------------------------------------- acceptance 6

test('agent loop: 生成的 ops 用 core/contracts.js 校验，非法 op / 字段被拒', { timeout: 30000 }, async (t) => {
  const { root, rev } = await fixture(t);
  const before = await fs.readFile(projectFile(root));
  const loop = new AgentLoop({
    root, scope: { elements: ['s1_w2'], paths: ['*'] },
    agent: new ScriptedAgent({
      script: [
        { tool: 'contracts', args: { what: 'op', name: 'set' } },
        { tool: 'contracts', args: { what: 'paths', host: 'el' } },
        { tool: 'ops', args: { ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150 }] } },
        { tool: 'ops', args: { ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150, oops: 1 }] } },
        { tool: 'ops', args: { ops: [{ op: 'notAnOp' }] } },
        { tool: 'ops', args: { ops: [{ op: 'set', id: 's1_w2', path: 'style.size' }] } },
        { tool: 'ops', args: { ops: [{ op: 'keySet', id: 's1_w2', path: 'style.size', t: 'soon', value: 1 }] } },
        { type: 'final', text: '' },
      ],
    }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const result = await loop.run({ task: '自我校验' });

  const results = result.report.measurements; // nothing measured
  assert.equal(results.length, 0);
  const toolMessages = result.log.filter((line) => line.includes('ops'));
  assert.ok(toolMessages.length >= 4);

  // Two contract queries and five validations, four of which were refused.
  assert.equal(result.report.contract.version, CONTRACT_VERSION);
  assert.equal(result.report.contract.checks, 5);
  assert.equal(result.report.contract.ops, 1, 'only the valid batch contributed ops');
  assert.equal(result.report.contract.failures, 4);
  assert.equal(result.rejections.length, 4);
  for (const entry of result.rejections) assert.equal(entry.error.code, 'OP_INVALID');
  const messages = result.rejections.map((entry) => entry.error.message).join('\n');
  assert.match(messages, /op #1 \(set\): input: unknown field oops/);
  assert.match(messages, /op #1 \(notAnOp\): unknown op/);
  assert.match(messages, /op #1 \(set\): input: missing value/);
  assert.match(messages, /op #1 \(keySet\): t: must be number/);

  // A refused batch never reaches the project.
  assert.equal(sha256(await fs.readFile(projectFile(root))), sha256(before));
  assert.equal((await loop.service.read()).rev, rev);
  const row = result.report.verification.find((entry) => entry.claim.startsWith('ops 契约校验'));
  assert.equal(row.status, 'verified');
  assert.match(row.evidence, /core\/contracts\.js/);

  // The contract surface the agent was handed is the real one.
  const contracts = await loop.agent.calls;
  assert.ok(LOOP_TOOLS.some((tool) => tool.name === 'contracts'));
  const opRows = result.log.find((line) => line.includes('contracts'));
  assert.ok(opRows, 'the contract query is in the log');
  assert.ok(PUBLIC_OPS.includes('set'));
});

// ------------------------------------------------------------ plan approval

test('agent loop: 大计划先停下等批准（创作模式），批准后每步一个变更集', { timeout: 30000 }, async (t) => {
  const { root, rev } = await fixture(t);
  const ops = () => ([
    { op: 'set', id: 's1_w2', path: 'style.size', value: 180 },
    { op: 'set', id: 's1_w2', path: 'style.color', value: '#ffd400' },
    { op: 'set', id: 's1_w2', path: 'style.lineHeight', value: 1.4 },
    { op: 'moveElement', id: 's1_w2', start: 0.5, duration: 1.2 },
  ]);
  const loop = new AgentLoop({
    root, mode: 'create', scope: { elements: ['s1_w2'], paths: ['style.*', 'start', 'duration', '@host'] },
    agent: new ScriptedAgent({
      script: [
        { tool: 'read', args: { what: 'element', id: 's1_w2' } },
        { tool: 'plan', args: { intent: '大改一句歌词', steps: [{ title: '样式', ops: ops().slice(0, 3) }, { title: '时间', ops: ops().slice(3) }] } },
        { tool: 'changeset', args: { action: 'propose', ops: ops(), intent: '大改一句歌词' } },
        (ctx) => ({ tool: 'changeset', args: { action: 'apply', id: ctx.lastOk('changeset').id } }),
        { type: 'final', text: '大改完成' },
      ],
    }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const planned = await loop.run({ task: '大改这句歌词' });
  assert.equal(planned.status, 'awaiting-approval');
  assert.equal(planned.plan.needsApproval, true);
  assert.equal(planned.plan.hosts, 1);
  assert.equal(planned.changesets[0].status, 'proposed');
  assert.equal((await loop.service.read()).rev, rev, 'still nothing written');
  assert.equal(planned.report.status, 'awaiting-approval');

  const done = await loop.approve({ planId: planned.plan.id, note: '可以' });
  assert.equal(done.status, 'completed');
  assert.equal(done.approved.planId, planned.plan.id);
  assert.equal(done.changesets.filter((entry) => entry.status === 'applied').length, 1);
  assert.equal(done.report.approval.mode, 'auto');
  assert.ok(done.report.approval.approvedAt);
});

// ----------------------------------------------------- transport + scope unit

test('agent loop: ProcessAgent 用行协议驱动同一个循环', { timeout: 60000 }, async (t) => {
  const { root } = await fixture(t);
  const stub = path.join(os.tmpdir(), `vdm-agent-loop-stub-${process.pid}-${Date.now()}.mjs`);
  await fs.writeFile(stub, [
    "import readline from 'node:readline';",
    'const rl = readline.createInterface({ input: process.stdin });',
    'let step = 0;',
    'const send = (message) => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));',
    'rl.on("line", (line) => {',
    '  let message;',
    '  try { message = JSON.parse(line); } catch { return; }',
    '  if (message.type === "user") { send({ type: "tool", id: "t1", name: "read", args: { what: "elements", name: "01 词2" } }); return; }',
    '  if (message.type !== "tool_result") return;',
    '  step += 1;',
    '  if (step === 1) { send({ type: "tool", id: "t2", name: "read", args: { what: "beats", near: { id: "s1_w2", edge: "start" } } }); return; }',
    '  send({ type: "final", text: "峰值 " + step + " 步" });',
    '  rl.close();',
    '});',
  ].join('\n'));
  t.after(() => fs.rm(stub, { force: true }));
  const loop = new AgentLoop({
    root, scope: { elements: ['s1_w2'], paths: ['style.size'] },
    agent: new ProcessAgent({ node: process.execPath, bin: stub, cwd: root }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const result = await loop.run({ task: '读一下这句' });
  assert.equal(result.status, 'completed');
  assert.equal(result.agentText, '峰值 2 步');
  assert.equal(result.report.beats.source, 'meta.beats');
  assert.equal(result.report.contract.checks, 0, 'no ops were proposed, so no contract check');
  assert.ok(result.log.some((line) => line.includes('read(elements)')));
  await loop.close();
});

test('agent loop: 一次性 legacy 答复 {note,ops} 也只能落成一个变更集', { timeout: 30000 }, async (t) => {
  const { root, rev } = await fixture(t);
  const legacyText = JSON.stringify({ note: '直接把字号改成 150', ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150 }] });
  const planLoop = new AgentLoop({
    root, scope: SCOPE, agent: new ScriptedAgent({ script: [{ type: 'final', text: legacyText }] }), renderStill: fakeStill(),
  });
  t.after(() => planLoop.close());
  const planned = await planLoop.run({ task: '改字号', planOnly: true });
  assert.equal(planned.status, 'awaiting-approval');
  assert.equal(planned.changesets[0].status, 'proposed');
  assert.equal((await planLoop.service.read()).rev, rev);
  const done = await planLoop.approve({ planId: planned.plan?.id });
  assert.equal(done.status, 'completed');
  assert.equal(done.changesets[0].status, 'applied');
  assert.equal((await planLoop.service.read()).elements.find((el) => el.id === 's1_w2').style.size, 150);
  assert.equal(done.report.changesets.length, 1);
  assert.equal(done.report.stills.length, 1, 'the loop rendered the default still the agent skipped');
  assert.equal(done.report.stills[0].label, 'auto-after');
});

test('scope: opTargets derives every property an op can write, and checkScope enforces it', () => {
  assert.deepEqual(opTargets({ op: 'set', id: 'a', path: 'style.size', value: 1 }).map((row) => ({ id: row.id, paths: [...row.paths] })),
    [{ id: 'a', paths: ['style.size'] }]);
  const patch = opTargets({ op: 'updateElement', id: 'a', patch: { style: { size: 2, color: '#fff' }, z: 4 } });
  assert.deepEqual([...patch[0].paths].sort(), ['style.color', 'style.size', 'z']);
  const created = opTargets({ op: 'addElement', element: { id: 'b', type: 'text', style: { text: 'x', size: 120 } } });
  assert.equal(created[0].id, '@new');
  assert.ok(created[0].paths.has('@create'));
  assert.ok(created[0].paths.has('style.size'));
  const move = opTargets({ op: 'moveElement', id: 'a', start: 1.2 });
  assert.deepEqual([...move[0].paths].sort(), ['@host', 'start']);
  const batch = opTargets({ op: 'batch', ops: [{ op: 'set', id: 'a', path: 'style.size', value: 1 }, { op: 'setMeta', path: 'title', value: 'x' }] });
  assert.deepEqual(batch.map((row) => row.id), ['a', '@project']);

  // A patch touching two properties needs both in the whitelist.
  assert.throws(
    () => checkScope([{ op: 'updateElement', id: 'a', patch: { style: { size: 2, color: '#fff' } } }], { elements: ['a'], paths: ['style.size'] }),
    (error) => error.code === PATH_OUTSIDE_SCOPE && /style\.color/.test(error.message),
  );
  assert.throws(
    () => checkScope([{ op: 'addElement', element: { id: 'b', type: 'text' } }], { elements: ['a'], paths: ['*'] }),
    (error) => error.code === PATH_OUTSIDE_SCOPE && /@new/.test(error.message),
  );
  assert.doesNotThrow(() => checkScope([{ op: 'addElement', element: { id: 'b', type: 'text' } }], { elements: ['a', '@new'], paths: ['*'] }));
  assert.doesNotThrow(() => checkScope([{ op: 'set', id: 'a', path: 'style.size', value: 1 }], { elements: ['*'], paths: ['style.*'] }));
  // A request without a scope is invalid, not unrestricted.
  assert.throws(() => checkScope([], undefined), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => checkScope([{ op: 'set', id: 'a', path: 'style.size', value: 1 }], { elements: [], paths: ['*'] }),
    (error) => error.code === 'INVALID_ARGUMENT');
});

test('nearestBeat: 拍点对齐到帧网格，报告原始偏差', () => {
  const beats = [0.1, 0.85, 1.6];
  const hit = nearestBeat(beats, 0.5, 30);
  assert.equal(hit.index, 1);
  assert.equal(hit.beat, 0.85);
  assert.equal(hit.frame, 26);
  assert.equal(hit.frameAligned, 0.867);
  assert.equal(hit.deltaFrames, -11, '0.5 s is 11 frames before frame 26');
  assert.equal(hit.rawDeltaFrames, -10.5, '0.5 s vs the 0.85 s marker, in frames');
  // A time already on the frame grid of the marker is a perfect snap.
  assert.equal(nearestBeat(beats, 26 / 30, 30).deltaFrames, 0);
  assert.equal(nearestBeat([], 0.5, 30), null);
});

test('pngSize reads the IHDR of the still the loop produced', () => {
  assert.deepEqual(pngSize(pngBuffer(640, 360)), { width: 640, height: 360 });
  assert.throws(() => pngSize(Buffer.from('not a png at all, definitely not')), /not a PNG/);
});

test('agent loop: 节拍回退到 meta.tempo（没有标记时）', { timeout: 30000 }, async (t) => {
  const { root } = await fixture(t, { beats: [], tempo: 120 });
  const loop = new AgentLoop({
    root, scope: { elements: ['s1_w2'], paths: ['*'] },
    agent: new ScriptedAgent({ script: [{ tool: 'read', args: { what: 'beats' } }, { type: 'final', text: '' }] }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const result = await loop.run({ task: '看一下节拍' });
  assert.equal(result.report.beats.source, 'meta.tempo');
  assert.equal(result.report.beats.tempo, 120);
  assert.equal(result.report.beats.count, 6, '3 s at 120 bpm = six beats (the end boundary is not a beat)');
  assert.deepEqual(result.report.beats.fps, 30);
  assert.equal(result.report.changesets.length, 0);
});

test('agent loop: 没有节拍数据时把卡拍点标成没做，而不是假装做到', { timeout: 30000 }, async (t) => {
  const { root } = await fixture(t, { beats: [], tempo: 0 });
  const loop = new AgentLoop({
    root, scope: SCOPE,
    agent: new ScriptedAgent({
      script: [
        {
          tool: 'changeset',
          args: {
            action: 'propose',
            ops: [
              { op: 'set', id: 's1_w2', path: 'style.size', value: 150 },
              { op: 'moveElement', id: 's1_w2', start: 0.6 },
            ],
          },
        },
        (ctx) => ({ tool: 'changeset', args: { action: 'apply', id: ctx.lastOk('changeset').id } }),
        { type: 'final', text: '只改了字号' },
      ],
    }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const result = await loop.run({ task: '只改字号' });
  assert.equal(result.report.beats.source, 'none');
  const row = result.report.verification.find((entry) => entry.claim.includes('卡到最近拍点'));
  assert.equal(row.status, 'skipped');
  assert.match(row.evidence, /没有节拍数据/);
});

test('agent loop: agent 声称改了但没有任何变更集时报告标红', { timeout: 30000 }, async (t) => {
  const { root } = await fixture(t);
  const loop = new AgentLoop({
    root, scope: SCOPE,
    agent: new ScriptedAgent({ script: [{ type: 'final', text: '已改好字号并卡到拍点' }] }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const result = await loop.run({ task: '改一下' });
  assert.equal(result.report.mismatch.flagged, true);
  assert.match(result.report.mismatch.reason, /没有任何变更集被应用/);
  assert.equal(result.report.counts.applied, 0);
});

test('agent loop: 被拒之后在同一轮里修正，再提交就通过（读 → 计划 → 变更集 → 测量 → 修正）', { timeout: 30000 }, async (t) => {
  const { root, service } = await fixture(t);
  const loop = new AgentLoop({
    root, scope: SCOPE,
    agent: new ScriptedAgent({
      script: [
        // 1. a batch the contract refuses (unknown field) — the agent reads the
        //    error and fixes it instead of giving up.
        { tool: 'ops', args: { ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150, bogus: 1 }] } },
        { tool: 'changeset', args: { action: 'propose', ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150, bogus: 1 }] } },
        // 2. corrected batch
        { tool: 'changeset', args: { action: 'propose', ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150 }] } },
        (ctx) => ({ tool: 'changeset', args: { action: 'apply', id: ctx.lastOk('changeset').id } }),
        { tool: 'measure', args: { what: 'textBox', id: 's1_w2' } },
        { type: 'final', text: '修正字段后改好了' },
      ],
    }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const result = await loop.run({ task: '把字号改成 150' });
  assert.equal(result.status, 'completed');
  assert.equal(result.rejections.length, 2, 'both attempts with the bogus field were refused');
  for (const entry of result.rejections) assert.equal(entry.error.code, 'OP_INVALID');
  assert.match(result.rejections[0].error.message, /unknown field bogus/);
  // Two proposals reached the engine, only the corrected one became a change set.
  assert.equal(result.report.changesets.length, 1);
  assert.equal(result.report.changesets[0].status, 'applied');
  assert.equal(result.report.contract.checks, 3);
  assert.equal(result.report.contract.failures, 2);
  const project = await service.read();
  assert.equal(project.elements.find((el) => el.id === 's1_w2').style.size, 150);
  assert.equal(result.report.mismatch, null);
  assert.equal(result.report.steps.filter((step) => step.step === 'propose').length, 1);
});

// ------------------------------------------------------- cancel + close

test('agent loop: cancel 在步间生效，状态 cancelled，close 幂等', { timeout: 30000 }, async (t) => {
  const { root } = await fixture(t);
  const events = [];
  const loop = new AgentLoop({
    root, scope: SCOPE,
    onEvent: (event) => events.push(event),
    agent: new ScriptedAgent({
      script: [
        // The step in flight is allowed to finish; the flag is checked after it.
        () => new Promise((resolve) => setTimeout(() => resolve({ tool: 'read', args: { what: 'project' } }), 80)),
        { tool: 'read', args: { what: 'elements' } },
        { type: 'final', text: '不该走到这里' },
      ],
    }),
    renderStill: fakeStill(),
  });
  const run = loop.run({ task: '慢慢读一下工程' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(loop.running, true, 'the slow first step is still in flight');
  assert.equal(loop.cancel('用户打断'), true);
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.equal(loop.state.status, 'cancelled');
  assert.equal(loop.running, false);
  assert.equal(loop.cancel(), false, 'nothing left to cancel');
  assert.equal(loop.state.steps.at(-1).step, 'cancel');
  assert.equal(result.report.status, 'cancelled');
  assert.ok(events.some((event) => event.type === 'loop' && event.phase === 'cancelled'));
  // The in-flight step ran, the next one did not (cancel lands between steps).
  const toolCalls = events.filter((event) => event.type === 'tool').map((event) => `${event.name}:${event.args?.what}`);
  assert.deepEqual(toolCalls, ['read:project']);
  assert.ok(!events.some((event) => event.type === 'loop' && event.phase === 'done'), 'a cancelled run is not "done"');
  // close() after a finished run is a no-op, and safe to call twice.
  await loop.close();
  await loop.close();
});

test('agent loop: 等待批准时 cancel 收成 cancelled，approve 不再可用', { timeout: 30000 }, async (t) => {
  const { root, rev } = await fixture(t);
  const events = [];
  const loop = new AgentLoop({
    root, scope: SCOPE,
    onEvent: (event) => events.push(event),
    agent: new ScriptedAgent({
      script: [{ tool: 'changeset', args: { action: 'propose', ops: [{ op: 'set', id: 's1_w2', path: 'style.size', value: 150 }] } }],
    }),
    renderStill: fakeStill(),
  });
  t.after(() => loop.close());
  const planned = await loop.run({ task: '改字号', planOnly: true });
  assert.equal(planned.status, 'awaiting-approval');
  assert.equal(loop.state.status, 'awaiting-approval');
  assert.equal(loop.cancel('不要了'), true);
  assert.equal(loop.state.status, 'cancelled');
  assert.ok(events.some((event) => event.type === 'loop' && event.phase === 'cancelled'));
  await assert.rejects(loop.approve({ planId: planned.plan?.id }),
    (error) => error.code === 'INVALID_ARGUMENT' && /awaiting approval/.test(error.message));
  assert.equal((await loop.service.read()).rev, rev, 'cancelling the plan wrote nothing');
});

test('agent loop: close() 打断正在跑的运行并等它结束', { timeout: 30000 }, async (t) => {
  const { root } = await fixture(t);
  const loop = new AgentLoop({
    root, scope: SCOPE,
    agent: new ScriptedAgent({
      script: [
        () => new Promise((resolve) => setTimeout(() => resolve({ tool: 'read', args: { what: 'project' } }), 80)),
        { type: 'final', text: '不该走到这里' },
      ],
    }),
    renderStill: fakeStill(),
  });
  const run = loop.run({ task: '慢慢读一下工程' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await loop.close();
  const result = await run;
  assert.equal(result.status, 'cancelled');
  assert.equal(loop.running, false);
});

