// Change sets and element locks — docs/DESIGN-BACKEND-V2.md §8.1 / §8.3, WP2.2.
//
// What this file guards:
//   * one applied change set = the transactions it committed (`changesetId` in
//     `.vdm/transactions.json`), the §8.3 diff in `changed[]` and a status;
//   * the three selective-revert cases: nobody touched the property (clean
//     revert), somebody changed the same property (conflict, needs-decision,
//     nothing forced) and the host was deleted (reported, no throw);
//   * `revertOne` undoes exactly one property and leaves the set applied;
//   * `preview()` is a shadow run: not one byte on disk, no revision, no journal;
//   * `locked: true` hosts reject agent writes with LOCKED for elements,
//     cameras and 3D objects, while ui/human/local may write (and unlock);
//   * the four MCP tools match their schema and their behaviour (`apply` bumps
//     the revision and stamps the change set id on the transaction);
//   * a lost `.vdm/changesets.json` is rebuilt from the journal, and such a
//     record refuses to revert (what it changed is unknown).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectService } from '../engine/projects.js';
import { CHANGESET_STATUS, ChangeSetService } from '../application/changeset-service.js';
import { callTool, listTools } from '../mcp/tools.js';

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const journalOf = async (root) => readJson(path.join(root, '.vdm', 'transactions.json'));

async function fixture(t, extra = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-changeset-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = projectService(root);
  await service.transact({ command: { type: 'initialize', options: { title: 'changeset', duration: 6 } } }, { actorId: 'cli' });
  await service.transact({ ops: [{ op: 'addElement', element: { id: 'el_1', type: 'solid', duration: 4 } }] }, { actorId: 'ui' });
  if (extra.length) await service.transact({ ops: extra }, { actorId: 'ui' });
  return { root, service, changesets: new ChangeSetService(service) };
}

const set = (id, property, value) => ({ op: 'set', id, path: property, value });

test('apply commits one transaction, stamps changesetId and reports the changed properties', async (t) => {
  const { root, service, changesets } = await fixture(t);
  const base = await service.read();
  const record = await changesets.apply({
    ops: [set('el_1', 'style.size', 150)],
    actorId: 'agent:dsh',
    intent: '歌词 2 加到 150 号字',
  });

  assert.equal(record.version, 1);
  assert.match(record.id, /^cs_[0-9a-f]{16}$/);
  assert.equal(record.status, 'applied');
  assert.equal(record.actorId, 'agent:dsh');
  assert.equal(record.intent, '歌词 2 加到 150 号字');
  assert.equal(record.baseRev, base.rev);
  assert.equal(record.rev, base.rev + 1);
  assert.equal(record.transactions.length, 1);
  assert.equal(record.opsCount, 1);
  assert.deepEqual(record.changed, [
    { id: 'el_1', kind: 'element', change: 'modified', path: 'style.size', before: 96, after: 150 },
  ]);
  // §8.3 report: diff counts + honest verification state (nothing is "verified").
  assert.equal(record.report.version, 1);
  assert.equal(record.report.total, 1);
  assert.deepEqual(record.report.counts.byKind, { element: 1 });
  assert.equal(record.report.before.rev, base.rev);
  assert.equal(record.report.after.rev, base.rev + 1);
  assert.equal(record.report.verification.status, 'unverified');
  assert.equal(record.report.verification.verified, 0);
  assert.equal(record.report.verification.unverified, 1);

  const project = await service.read();
  assert.equal(project.rev, base.rev + 1);
  assert.equal(project.elements[0].style.size, 150);

  const entry = (await journalOf(root)).entries.at(-1);
  assert.equal(entry.changesetId, record.id, 'the transaction carries the change set id');
  assert.equal(entry.transactionId, record.transactions[0]);
  assert.equal(entry.actorId, 'agent:dsh');
  assert.equal(entry.beforeRev, base.rev);
  assert.equal(entry.rev, base.rev + 1);

  // Filtering the journal by change set is how a review finds its transaction.
  const filtered = await service.repository.history({ changesetId: record.id });
  assert.equal(filtered.entries.length, 1);
  assert.equal((await service.repository.history()).entries.filter((e) => e.changesetId === record.id).length, 1);

  const list = await changesets.list();
  assert.equal(list.total, 1);
  assert.equal(list.changesets[0].id, record.id);
  assert.equal(list.changesets[0].status, 'applied');
  assert.deepEqual(list.changesets[0].counts, { changed: 1, added: 0, removed: 0 });
  const shown = await changesets.show(record.id);
  assert.equal(shown.changedTotal, 1);
  assert.equal(shown.changed[0].path, 'style.size');
  assert.equal(shown.changed[0].before, 96);
  assert.equal(shown.changed[0].after, 150);
  assert.deepEqual(CHANGESET_STATUS, ['proposed', 'applied', 'reverted', 'needs-decision']);
});

test('revert with nothing touching the value since is clean, and is idempotent', async (t) => {
  const { root, service, changesets } = await fixture(t);
  const base = await service.read();
  const record = await changesets.apply({ ops: [set('el_1', 'style.size', 150)], actorId: 'agent:dsh' });
  assert.equal((await service.read()).elements[0].style.size, 150);

  const reverted = await changesets.revert({ id: record.id, actorId: 'ui' });
  assert.equal(reverted.status, 'reverted');
  assert.equal(reverted.revert.reverted, 1);
  assert.equal(reverted.revert.already, 0);
  assert.equal(reverted.revert.conflicts, 0);
  assert.deepEqual(reverted.report.decisions, []);
  assert.equal(reverted.revert.rev, base.rev + 2);
  assert.equal(reverted.revert.transactions.length, 1);

  const project = await service.read();
  assert.equal(project.rev, base.rev + 2, 'the revert is its own transaction');
  assert.equal(project.elements[0].style.size, 96, 'the old value is restored');
  assert.equal(project.elements[0].locked, undefined);

  // Same change set id on both transactions, so the pair reads as one story.
  const entries = (await journalOf(root)).entries.filter((entry) => entry.changesetId === record.id);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.rev), [base.rev + 1, base.rev + 2]);

  const again = await changesets.revert({ id: record.id });
  assert.equal(again.alreadyReverted, true);
  assert.equal((await service.read()).rev, base.rev + 2, 'no second transaction');
});

test('revertOne undoes a single property and keeps the change set applied', async (t) => {
  const { service, changesets } = await fixture(t);
  const record = await changesets.apply({
    ops: [set('el_1', 'style.size', 150), set('el_1', 'style.color', '#ff0000')],
    actorId: 'agent:dsh',
  });
  assert.equal(record.changed.length, 2);
  const sizeAt = record.changed.findIndex((entry) => entry.path === 'style.size');
  assert.ok(sizeAt >= 0);

  const one = await changesets.revertOne({ id: record.id, index: sizeAt, actorId: 'ui' });
  assert.equal(one.revert.partial, true);
  assert.equal(one.status, 'applied', 'the other property is still applied');
  const project = await service.read();
  assert.equal(project.elements[0].style.size, 96);
  assert.equal(project.elements[0].style.color, '#ff0000');

  // Addressing the entry by entity/path works too.
  const colour = await changesets.revertOne({ id: record.id, entityId: 'el_1', path: 'style.color', actorId: 'ui' });
  assert.equal(colour.revert.entries.length, 1, 'only the addressed entry was planned');
  assert.equal(colour.revert.entries[0].path, 'style.color');
  assert.equal(colour.status, 'reverted', 'the whole group is undone now');
  const done = await service.read();
  assert.equal(done.elements[0].style.color, '#ffffff');
  await assert.rejects(changesets.revertOne({ id: record.id }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(changesets.revertOne({ id: record.id, index: 99 }), { code: 'INVALID_ARGUMENT' });
});

test('revert reports a property someone else changed instead of forcing it', async (t) => {
  const { service, changesets } = await fixture(t);
  const record = await changesets.apply({ ops: [set('el_1', 'style.size', 150)], actorId: 'agent:dsh' });
  // A human edits the same property afterwards.
  await service.transact({ ops: [set('el_1', 'style.size', 300)] }, { actorId: 'ui' });

  const reverted = await changesets.revert({ id: record.id, actorId: 'agent:dsh' });
  assert.equal(reverted.status, 'needs-decision');
  assert.equal(reverted.revert.conflicts, 1);
  assert.equal(reverted.revert.reverted, 0);
  assert.equal(reverted.revert.transactions.length, 0, 'nothing was written');
  const [decision] = reverted.report.decisions;
  assert.equal(decision.kind, 'conflict');
  assert.equal(decision.reason, 'changed-since');
  assert.equal(decision.id, 'el_1');
  assert.equal(decision.path, 'style.size');
  assert.equal(decision.expected, 150);
  assert.equal(decision.current, 300);
  assert.equal((await service.read()).elements[0].style.size, 300, 'the human value survives');
  assert.equal((await service.read()).rev, record.rev + 1, 'the human edit only');
  assert.equal((await changesets.list({ status: 'needs-decision' })).total, 1);
});

test('revert reports a deleted element and does not throw', async (t) => {
  const { service, changesets } = await fixture(t);
  const record = await changesets.apply({ ops: [set('el_1', 'style.size', 150)], actorId: 'agent:dsh' });
  await service.transact({ ops: [{ op: 'removeElement', id: 'el_1' }] }, { actorId: 'ui' });
  const rev = (await service.read()).rev;

  const reverted = await changesets.revert({ id: record.id, actorId: 'agent:dsh' });
  assert.equal(reverted.status, 'needs-decision');
  assert.equal(reverted.revert.conflicts, 1);
  assert.equal(reverted.revert.reverted, 0);
  assert.equal(reverted.report.decisions[0].reason, 'host-deleted');
  assert.equal(reverted.report.decisions[0].id, 'el_1');
  assert.equal((await service.read()).rev, rev, 'no write, no revision');
  assert.equal((await service.read()).elements.length, 0);

  // A whole-host removal is restored by a full revert, body and all.
  await service.transact({ ops: [{ op: 'addElement', element: { id: 'el_2', type: 'text', duration: 4, style: { text: '标题' } } }], actorId: 'ui' }, { actorId: 'ui' });
  const revAfter = (await service.read()).rev;
  const removed = await changesets.apply({ ops: [{ op: 'removeElement', id: 'el_2' }], actorId: 'agent:dsh' });
  assert.deepEqual(removed.removed.map((entry) => entry.id), ['el_2']);
  assert.equal((await service.read()).elements.length, 0);
  const restored = await changesets.revert({ id: removed.id, actorId: 'ui', expectedRev: revAfter + 1 });
  assert.equal(restored.status, 'reverted');
  assert.equal(restored.revert.reverted, 1);
  const back = await service.read();
  assert.equal(back.elements.length, 1);
  assert.equal(back.elements.find((element) => element.id === 'el_2').style.text, '标题');
});

test('preview is a shadow run: no bytes, no revision, no journal entry', async (t) => {
  const { root, service, changesets } = await fixture(t);
  const files = ['project.vdm.json', '.vdm/transactions.json'];
  const bytes = {};
  const stats = {};
  for (const name of files) {
    bytes[name] = await fs.readFile(path.join(root, name));
    stats[name] = await fs.stat(path.join(root, name));
  }
  const rev = (await service.read()).rev;
  const vdmBefore = (await fs.readdir(path.join(root, '.vdm'))).sort();

  const preview = await changesets.preview({ ops: [set('el_1', 'style.size', 150)], actorId: 'agent:dsh' });
  assert.equal(preview.baseRev, rev);
  assert.equal(preview.afterRev, rev + 1);
  assert.equal(preview.equal, false);
  assert.equal(preview.id, null, 'a preview is not a record');
  assert.deepEqual(preview.changed, [
    { id: 'el_1', kind: 'element', change: 'modified', path: 'style.size', before: 96, after: 150 },
  ]);

  for (const name of files) {
    const nowBytes = await fs.readFile(path.join(root, name));
    assert.ok(nowBytes.equals(bytes[name]), `${name} bytes unchanged`);
    assert.equal((await fs.stat(path.join(root, name))).mtimeMs, stats[name].mtimeMs, `${name} mtime unchanged`);
  }
  assert.equal((await service.read()).rev, rev, 'no revision consumed');
  assert.deepEqual((await fs.readdir(path.join(root, '.vdm'))).sort(), vdmBefore, 'no change set record was written');
  assert.equal((await service.repository.changesets()).length, 0);
  assert.equal((await changesets.list()).total, 0);
});

test('a proposal does not consume a revision and apply at its base revision is checked', async (t) => {
  const { service, changesets } = await fixture(t);
  const base = await service.read();
  const record = await changesets.propose({ ops: [set('el_1', 'style.size', 150)], actorId: 'agent:dsh', intent: 'proposal' });
  assert.equal(record.status, 'proposed');
  assert.equal(record.rev, null);
  assert.equal(record.transactions.length, 0);
  assert.equal((await service.read()).rev, base.rev);
  assert.equal((await service.read()).elements[0].style.size, 96);

  // Someone else writes first: the stored proposal is stale.
  await service.transact({ ops: [set('el_1', 'style.color', '#00ff00')] }, { actorId: 'ui' });
  await assert.rejects(changesets.apply({ id: record.id }), { code: 'REV_CONFLICT', currentRev: base.rev + 1 });
  assert.equal((await changesets.show(record.id)).status, 'proposed');

  // Re-proposing at the current revision applies.
  const fresh = await changesets.propose({ ops: [set('el_1', 'style.size', 150)], actorId: 'agent:dsh' });
  const applied = await changesets.apply({ id: fresh.id, requestId: 'cs-apply-1' });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.rev, base.rev + 2);
  assert.equal((await service.read()).elements[0].style.size, 150);

  // dryRun on a stored proposal writes nothing either.
  const rev = (await service.read()).rev;
  const dry = await changesets.revert({ id: applied.id, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.writes, true);
  assert.equal(dry.counts.reverted, 1);
  assert.equal((await service.read()).rev, rev);
});

test('discarding a proposal reverts the status without writing the project', async (t) => {
  const { root, service, changesets } = await fixture(t);
  const base = await service.read();
  const record = await changesets.propose({ ops: [set('el_1', 'style.size', 150)], actorId: 'agent:dsh' });
  const discarded = await changesets.revert({ id: record.id, actorId: 'ui' });
  assert.equal(discarded.status, 'reverted');
  assert.equal(discarded.revert.transactions.length, 0);
  assert.equal(discarded.revert.decisions[0].reason, 'never-applied');
  assert.equal((await service.read()).rev, base.rev);
  const entries = (await journalOf(root)).entries.filter((entry) => entry.changesetId === record.id);
  assert.equal(entries.length, 0);
});

test('keyframe changes are reverted key by key', async (t) => {
  const { service, changesets } = await fixture(t);
  const added = await changesets.apply({
    ops: [
      { op: 'keySet', id: 'el_1', path: 'style.size', t: 1, value: 150 },
      { op: 'keySet', id: 'el_1', path: 'style.color', t: 2, value: '#ff0000' },
    ],
    actorId: 'agent:dsh',
  });
  assert.equal(added.changed.length, 2);
  assert.equal((await service.read()).elements[0].keyframes.length, 2);
  const reverted = await changesets.revert({ id: added.id });
  assert.equal(reverted.status, 'reverted');
  assert.equal((await service.read()).elements[0].keyframes.length, 0);

  // A key that already exists gets a field change, not a whole-key entry.
  const base = await changesets.apply({
    ops: [{ op: 'keySet', id: 'el_1', path: 'style.size', t: 1, value: 150 }], actorId: 'agent:dsh',
  });
  const edited = await changesets.apply({
    ops: [{ op: 'keySet', id: 'el_1', path: 'style.size', t: 1, value: 170 }], actorId: 'agent:dsh',
  });
  assert.deepEqual(edited.changed.map((entry) => entry.path), ['keyframes[1].style.size.value']);
  const keyReverted = await changesets.revert({ id: edited.id });
  assert.equal(keyReverted.status, 'reverted');
  assert.equal((await service.read()).elements[0].keyframes[0].value, 150);
  assert.ok(base.id && base.id !== edited.id);
});

test('a lost change set registry is rebuilt from the journal and refuses to revert', async (t) => {
  const { root, service, changesets } = await fixture(t);
  const record = await changesets.apply({ ops: [set('el_1', 'style.size', 150)], actorId: 'agent:dsh' });
  const rev = (await service.read()).rev;
  await fs.rm(path.join(root, '.vdm', 'changesets.json'));
  assert.deepEqual(await changesets.list(), { version: 1, total: 0, count: 0, changesets: [] });

  const recovered = await changesets.show(record.id);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.status, 'applied');
  assert.deepEqual(recovered.transactions, record.transactions);
  assert.equal(recovered.report.decisions[0].reason, 'registry-lost');
  await assert.rejects(changesets.revert({ id: record.id }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await service.read()).rev, rev);
  await assert.rejects(changesets.show('cs_missing'), { code: 'CHANGESET_NOT_FOUND' });
});

test('locked elements, cameras and 3D objects reject agent writes with LOCKED', async (t) => {
  const { service, changesets } = await fixture(t, [
    { op: 'addCamera', camera: { id: 'cam_x', name: 'X' } },
    { op: 'activateCamera', id: 'cam_x' },
    { op: 'objectAdd', object: { id: 'ob_1', type: 'solid', position: [0, 1, 0], duration: 4 } },
    { op: 'set', id: 'el_1', path: 'locked', value: true },
    { op: 'cameraPatch', id: 'cam_x', patch: { locked: true } },
    { op: 'objectPatch', id: 'ob_1', patch: { locked: true } },
  ]);
  const locked = await service.read();
  assert.equal(locked.elements[0].locked, true);
  assert.equal(locked.cameras.find((camera) => camera.id === 'cam_x').locked, true);
  assert.equal(locked.scene.objects.find((object) => object.id === 'ob_1').locked, true);

  const agentWrites = [
    [set('el_1', 'transform.x', 9)],
    [{ op: 'updateElement', id: 'el_1', patch: { opacity: 0.5 } }],
    [{ op: 'removeElement', id: 'el_1' }],
    [{ op: 'cameraPatch', id: 'cam_x', patch: { fov: 40 } }],
    [{ op: 'removeCamera', id: 'cam_x' }],
    [{ op: 'objectPatch', id: 'ob_1', patch: { position: [1, 1, 0] } }],
    [{ op: 'objectRemove', id: 'ob_1' }],
  ];
  for (const ops of agentWrites) {
    await assert.rejects(service.transact({ ops }, { actorId: 'agent:dsh' }), (error) => {
      assert.equal(error.code, 'LOCKED');
      assert.equal(error.status, 409);
      assert.ok(error.issues.length >= 1);
      assert.equal(error.issues[0].msg.includes('locked'), true);
      return true;
    }, `agent write ${JSON.stringify(ops[0].op)} must be rejected`);
    // A change set is not a back door either.
    await assert.rejects(changesets.apply({ ops, actorId: 'agent:dsh' }), { code: 'LOCKED' });
  }
  assert.equal((await service.repository.changesets()).length, 0, 'a refused apply records nothing');
  const rev = (await service.read()).rev;

  // Humans still edit: ui/human/local are not agents.
  await service.transact({ ops: [set('el_1', 'transform.x', 9)] }, { actorId: 'ui' });
  await service.transact({ ops: [{ op: 'cameraPatch', id: 'cam_x', patch: { fov: 40 } }] }, { actorId: 'human' });
  await service.transact({ ops: [{ op: 'objectPatch', id: 'ob_1', patch: { position: [1, 1, 0] } }] }, { actorId: 'local' });
  const human = await service.read();
  assert.equal(human.elements[0].transform.x, 9);
  assert.equal(human.cameras.find((camera) => camera.id === 'cam_x').fov, 40);
  assert.deepEqual(human.scene.objects.find((object) => object.id === 'ob_1').position, [1, 1, 0]);
  assert.equal(human.rev, rev + 3);

  // Unlock as the human, then the agent may write again.
  await service.transact({
    ops: [
      set('el_1', 'locked', false),
      { op: 'cameraPatch', id: 'cam_x', patch: { locked: false } },
      { op: 'objectPatch', id: 'ob_1', patch: { locked: false } },
    ],
  }, { actorId: 'ui' });
  const unlocked = await service.read();
  assert.equal(unlocked.elements[0].locked, undefined, 'false is stored as absent');
  await service.transact({ ops: [set('el_1', 'transform.x', 11)] }, { actorId: 'agent:dsh' });
  await service.transact({ ops: [{ op: 'cameraPatch', id: 'cam_x', patch: { fov: 50 } }] }, { actorId: 'agent:dsh' });
  await service.transact({ ops: [{ op: 'objectPatch', id: 'ob_1', patch: { position: [2, 1, 0] } }] }, { actorId: 'agent:dsh' });
  const after = await service.read();
  assert.equal(after.elements[0].transform.x, 11);
  assert.equal(after.cameras.find((camera) => camera.id === 'cam_x').fov, 50);
  assert.deepEqual(after.scene.objects.find((object) => object.id === 'ob_1').position, [2, 1, 0]);
});

test('locked is normalised and validated, and the MCP tools report LOCKED', async (t) => {
  const { root, service, changesets } = await fixture(t);
  await service.transact({ ops: [set('el_1', 'locked', true)] }, { actorId: 'ui' });
  const raw = JSON.parse(await fs.readFile(path.join(root, 'project.vdm.json'), 'utf8'));
  assert.equal(raw.elements[0].locked, true, 'locked:true is persisted');
  const client = { info: { root } };
  const refused = await callTool(client, 'vdm_changeset_apply', { ops: [set('el_1', 'style.size', 200)], actorId: 'agent:mcp' });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'LOCKED');
  assert.equal(refused.structuredContent.error.issues[0].path, 'elements[0]');

  // validateProject rejects a non-boolean lock (no silent coercion).
  const { validateProject } = await import('../core/schema.js');
  await service.transact({ ops: [set('el_1', 'locked', false)] }, { actorId: 'ui' });
  const project = await service.read();
  assert.deepEqual(validateProject({ ...project, elements: [{ ...project.elements[0], locked: 'yes' }] })
    .filter((issue) => issue.path === 'elements[0].locked'), [{ path: 'elements[0].locked', msg: 'must be boolean' }]);
  assert.ok(changesets);
});

test('the MCP change set tools match their schema and their behaviour', async (t) => {
  const { root, service } = await fixture(t);
  const client = { info: { root } };
  const tools = listTools().filter((entry) => entry.name.startsWith('vdm_changeset'));
  assert.deepEqual(tools.map((entry) => entry.name).sort(), [
    'vdm_changeset_apply', 'vdm_changeset_list', 'vdm_changeset_revert', 'vdm_changeset_show',
  ]);
  for (const entry of tools) {
    assert.equal(entry.inputSchema.type, 'object');
    assert.equal(entry.inputSchema.additionalProperties, false);
    assert.equal(entry.changeset, undefined, 'the dispatch key is not part of the published schema');
    assert.ok(entry.description.length > 40);
  }
  const applyTool = tools.find((entry) => entry.name === 'vdm_changeset_apply');
  assert.equal(applyTool.annotations.readOnlyHint, false);
  assert.equal(applyTool.annotations.destructiveHint, true);
  assert.equal(tools.find((entry) => entry.name === 'vdm_changeset_list').annotations.readOnlyHint, true);
  assert.ok(applyTool.inputSchema.properties.ops, 'ops is on the schema');
  assert.ok(applyTool.inputSchema.$defs?.op, 'the op contract is embedded, not duplicated');

  const base = await service.read();
  const applied = await callTool(client, 'vdm_changeset_apply', {
    ops: [set('el_1', 'style.size', 150)], actorId: 'agent:mcp', intent: 'via mcp',
  });
  assert.equal(applied.isError, false);
  const record = applied.structuredContent;
  assert.equal(record.status, 'applied');
  assert.equal(record.rev, base.rev + 1, 'apply bumps the revision');
  assert.equal(record.changed[0].path, 'style.size');
  assert.equal(record.report.verification.status, 'unverified');
  assert.equal((await journalOf(root)).entries.at(-1).changesetId, record.id);

  // Unknown fields and malformed ops are refused by the published schema.
  const unknown = await callTool(client, 'vdm_changeset_apply', { ops: [set('el_1', 'style.size', 2)], opz: true });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.match(unknown.structuredContent.error.message, /unknown field opz/);
  const malformed = await callTool(client, 'vdm_changeset_apply', { ops: [{ op: 'set', id: 'el_1' }] });
  assert.equal(malformed.isError, true);
  assert.equal(malformed.structuredContent.error.code, 'INVALID_ARGUMENT');
  assert.equal((await callTool(client, 'vdm_changeset_apply', {})).isError, true);
  const both = await callTool(client, 'vdm_changeset_apply', { id: record.id, ops: [set('el_1', 'style.size', 2)] });
  assert.equal(both.isError, true);

  // dryRun through MCP writes nothing at all.
  const files = ['project.vdm.json', '.vdm/transactions.json', '.vdm/changesets.json'];
  const before = {};
  for (const name of files) before[name] = await fs.readFile(path.join(root, name));
  const dry = await callTool(client, 'vdm_changeset_apply', { ops: [set('el_1', 'style.size', 200)], dryRun: true });
  assert.equal(dry.isError, false);
  assert.equal(dry.structuredContent.dryRun, true);
  assert.equal(dry.structuredContent.rev, base.rev + 1);
  for (const name of files) assert.ok((await fs.readFile(path.join(root, name))).equals(before[name]), `${name} untouched`);

  const list = await callTool(client, 'vdm_changeset_list', {});
  assert.equal(list.isError, false);
  assert.equal(list.structuredContent.total, 1);
  assert.equal(list.structuredContent.changesets[0].id, record.id);
  const show = await callTool(client, 'vdm_changeset_show', { id: record.id });
  assert.equal(show.isError, false);
  assert.equal(show.structuredContent.changedTotal, 1);
  assert.equal(show.structuredContent.opsCount, 1);
  assert.equal((await callTool(client, 'vdm_changeset_show', {})).isError, true);

  const reverted = await callTool(client, 'vdm_changeset_revert', { id: record.id, actorId: 'ui' });
  assert.equal(reverted.isError, false);
  assert.equal(reverted.structuredContent.status, 'reverted');
  assert.equal(reverted.structuredContent.revert.reverted, 1);
  assert.equal((await service.read()).elements[0].style.size, 96);
  assert.equal((await callTool(client, 'vdm_changeset_revert', { id: record.id, index: 0 })).isError, false);

  // Without a project root there is no project to write to.
  const orphan = await callTool({}, 'vdm_changeset_list', {});
  assert.equal(orphan.isError, true);
  assert.equal(orphan.structuredContent.error.code, 'RUNTIME_UNAVAILABLE');
});
