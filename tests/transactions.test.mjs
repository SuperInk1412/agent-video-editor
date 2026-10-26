import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectService } from '../engine/projects.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-transactions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = projectService(root);
  await service.transact({ command: { type: 'initialize', options: { title: 'fixture' } } });
  return { root, service };
}
const add = { op: 'addElement', element: { type: 'solid', duration: 2 } };

test('transactions enforce revision conflicts and persist retries, generated IDs and history', async (t) => {
  const { root, service } = await fixture(t);
  const input = { expectedRev: 1, requestId: 'create', ops: [add] };
  const first = await service.transact(input);
  const second = await projectService(root).transact(input);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.opResults, first.opResults);
  assert.equal(second.transactionId, first.transactionId);
  assert.equal(second.project.elements.length, 1);
  await assert.rejects(service.transact({ expectedRev: 1, ops: [add] }), { code: 'REV_CONFLICT', currentRev: 2 });
  await assert.rejects(service.transact({ ...input, ops: [{ ...add, element: { ...add.element, duration: 3 } }] }), { code: 'REQUEST_ID_CONFLICT' });
  const undo = await projectService(root).transact({ expectedRev: 2, command: { type: 'undo' } });
  assert.equal(undo.rev, 3);
  assert.equal(undo.project.elements.length, 0);
  const redo = await service.transact({ command: { type: 'redo' } });
  assert.equal(redo.rev, 4);
  assert.equal(redo.project.elements.length, 1);
});

test('dry-run and invalid batches leave project, history and receipts unchanged', async (t) => {
  const { root, service } = await fixture(t);
  const files = ['project.vdm.json', '.vdm/transactions.json'];
  const before = await Promise.all(files.map((name) => fs.readFile(path.join(root, name), 'utf8')));
  const preview = await service.transact({ requestId: 'preview', dryRun: true, ops: [add] });
  assert.equal(preview.rev, 1);
  assert.equal(preview.project.elements.length, 1);
  assert.equal(preview.transactionId, null);
  await assert.rejects(service.transact({ ops: [add, { op: 'removeElement', id: 'missing' }] }));
  assert.deepEqual(await Promise.all(files.map((name) => fs.readFile(path.join(root, name), 'utf8'))), before);
  const noop = await service.transact({ ops: [{ op: 'setMeta', path: 'title', value: 'fixture' }] });
  assert.equal(noop.didChange, false);
  assert.equal(noop.rev, 1);
  assert.equal((await service.history()).undo, 0);
});

for (const failure of ['prepared', 'project']) test(`recovery after ${failure} never repeats a create operation`, async (t) => {
  const { root } = await fixture(t);
  const input = { requestId: 'recover', expectedRev: 1, ops: [add] };
  const broken = projectService(root, { checkpoint: async (stage) => { if (stage === failure) throw new Error('crash'); } });
  await assert.rejects(broken.transact(input), /crash/);
  const service = projectService(root);
  const result = await service.transact(input);
  assert.equal(result.replayed, true);
  assert.equal(result.rev, 2);
  assert.equal(result.project.elements.length, 1);
  assert.equal((await service.history()).undo, 1);
});

test('concurrent application instances serialize CAS and global history', async (t) => {
  const { root } = await fixture(t);
  const outcomes = await Promise.allSettled([1, 2, 3].map(() => projectService(root).transact({ expectedRev: 1, ops: [add] })));
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(outcomes.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'REV_CONFLICT'));
});

for (const stage of ['prepared', 'project']) test(`a terminated writer at ${stage} recovers its lock, snapshot and receipt together`, async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/transaction-crash.mjs', import.meta.url)), root, stage]), { code: 17 });
  const result = await projectService(root).transact({ expectedRev: 1, requestId: 'killed-writer', ops: [{ op: 'addElement', element: { type: 'solid', duration: 1 } }] });
  assert.equal(result.replayed, true);
  assert.equal(result.project.elements.length, 1);
  assert.equal(result.rev, 2);
  assert.equal((await projectService(root).history()).undo, 1);
});

test('unrecognizable journal state blocks writes instead of dropping receipts and history', async (t) => {
  const { root, service } = await fixture(t);
  const before = await fs.readFile(path.join(root, 'project.vdm.json'), 'utf8');
  await fs.writeFile(path.join(root, '.vdm/transactions.json'), JSON.stringify({ version: 99 }));
  await assert.rejects(service.transact({ ops: [add] }), { code: 'UNKNOWN_COMMIT_STATE' });
  assert.equal(await fs.readFile(path.join(root, 'project.vdm.json'), 'utf8'), before);
});
