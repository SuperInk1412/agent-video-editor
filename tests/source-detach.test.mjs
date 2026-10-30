// Detach from a source + conflict decisions — docs/DESIGN-WP3.6-4.6-UI.md
// §7.3 / §7.4 R1 (WP4.6b).
//
// `sourceDetach` / `sourceDetachSource` freeze one frame and drop the binding:
// the service expands `{ id }` / `{ ids }` against `.vdm/sources/<id>/base.json`
// (§7.8.6 #1: core never reads `.vdm/`), core writes the frozen values and
// deletes `el.source` / `el.sourceMode`, and one transaction puts the binding
// back on Ctrl+Z. `ChangeSetService.decide` is the review page's 应用: the
// chosen values go through the same transact every edit uses and the merge
// change set leaves `needs-decision`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectService } from '../engine/projects.js';
import { ChangeSetService } from '../application/changeset-service.js';
import {
  applyCompiled, clearFontCache, compileSource, mergeSource, readBase,
} from '../application/source-service.js';
import { snapshotProblems } from '../core/source-eval.js';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'sources', 'html-title-card');
const clone = (value) => JSON.parse(JSON.stringify(value));
const SOURCE = 'html-title-card';

/** `{ manifest, files }` of the shared fixture, as the registry stores it. */
async function fixture() {
  const names = await fs.readdir(FIXTURE);
  const files = {};
  let manifest = null;
  for (const name of names) {
    const text = await fs.readFile(path.join(FIXTURE, name), 'utf8');
    if (name === 'manifest.json') manifest = JSON.parse(text);
    else files[name] = text;
  }
  return { manifest, files };
}

/** Temp project with the fixture compiled and applied (§7.8.1 / §7.8.2). */
async function setupProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-source-detach-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); clearFontCache(); });
  const service = projectService(root);
  const changesets = new ChangeSetService(service);
  await service.transact({ command: { type: 'initialize', options: { title: 'source detach', duration: 2 } } });
  const { manifest, files } = await fixture();
  await service.transact({ ops: [{ op: 'sourceAdd', id: SOURCE, manifest, files }] });
  let project = await service.read();
  await compileSource({ project, sourceId: SOURCE, root });
  const applied = await applyCompiled({ project, sourceId: SOURCE, root });
  await service.transact({ ops: [applied.op] });
  project = await service.read();
  const byNode = (nodeId) => project.elements.find((el) => el.source?.id === SOURCE && el.source.node === nodeId);
  return { root, service, changesets, byNode };
}

// --------------------------------------------------------------- the freeze
test('sourceDetach: freezes the frame value, drops the binding, one undo', async (t) => {
  const { root, service, changesets, byNode } = await setupProject(t);
  const kicker = byNode('n_kicker');
  const base = await readBase({ root, sourceId: SOURCE });

  // Source side: replace `n_kicker`'s tracks with a plain linear `transform.x`
  // move (0 → 100 over one second), baseline 0.
  const theirs = clone(base.snapshot);
  const node = theirs.nodes.find((entry) => entry.id === 'n_kicker');
  node.props['transform.x'] = 0;
  node.tracks = [
    { t: 0, path: 'transform.x', value: 0, ease: 'linear' },
    { t: 1, path: 'transform.x', value: 100, ease: 'linear' },
  ];
  const merged = await mergeSource({ project: await service.read(), sourceId: SOURCE, root, theirs, changesets, actorId: 'test' });
  assert.deepEqual(merged.conflicts, []);
  // ...plus a local overlay edit: +40 px on the same path (§7.8.2 叠加 = 相加).
  await service.transact({ ops: [{ op: 'set', id: kicker.id, path: 'transform.x', value: 40 }] });
  const bound = await service.read();
  const before = bound.elements.find((el) => el.id === kicker.id);
  assert.deepEqual(before.source, { id: SOURCE, node: 'n_kicker' });
  const rev0 = bound.rev;

  // t = 0.5 → source 50, base 0, local 40 → the picture is 90.
  await service.transact({ ops: [{ op: 'sourceDetach', id: kicker.id, t: 0.5 }] });
  const after = await service.read();
  const frozen = after.elements.find((el) => el.id === kicker.id);
  assert.equal(after.rev, rev0 + 1, 'one op = one transaction');
  assert.equal(frozen.source, undefined, 'el.source is gone (§7.4 R1: no re-attach)');
  assert.equal(frozen.sourceMode, undefined, 'el.sourceMode is gone too');
  assert.equal(frozen.transform.x, 90, 'the current frame is preserved as a local value');
  assert.equal(frozen.node.pivot[0], 0.9,
    'a node element takes the source delta too: 0.4 m local + 50 px delta');
  assert.equal(frozen.style.text, before.style.text, 'paths the source does not drive keep their value');

  // One undo puts the binding (and the local edit) back.
  await service.transact({ command: { type: 'undo' } });
  const back = (await service.read()).elements.find((el) => el.id === kicker.id);
  assert.deepEqual(back.source, { id: SOURCE, node: 'n_kicker' });
  assert.equal(back.transform.x, 40);
});

test('sourceDetach: a multi-selection is one transaction; a plain element is refused', async (t) => {
  const { root, service, changesets, byNode } = await setupProject(t);
  const kicker = byNode('n_kicker');
  const title = byNode('n_title');
  const rev0 = (await service.read()).rev;
  await service.transact({ ops: [{ op: 'sourceDetach', ids: [kicker.id, title.id] }] });
  const after = await service.read();
  assert.equal(after.rev, rev0 + 1, 'two elements, one transaction');
  for (const id of [kicker.id, title.id]) {
    assert.equal(after.elements.find((el) => el.id === id).source, undefined, id);
  }
  // The untouched nodes keep their binding: a multi-selection detaches exactly
  // what it names.
  assert.ok(after.elements.some((el) => el.source?.node === 'n_subtitle'));

  await service.transact({ ops: [{ op: 'addElement', element: { id: 'el_plain', type: 'text', start: 0, duration: 1, style: { text: 'x' } } }] });
  await assert.rejects(
    service.transact({ ops: [{ op: 'sourceDetach', id: 'el_plain' }] }),
    (error) => error.code === 'INVALID_ARGUMENT' && /没有源/.test(error.message),
    'a local element has nothing to detach',
  );
  await assert.rejects(
    service.transact({ ops: [{ op: 'sourceDetach' }] }),
    { code: 'INVALID_ARGUMENT' },
    'neither id nor ids',
  );
  await assert.rejects(
    service.transact({ ops: [{ op: 'sourceDetach', id: kicker.id }] }),
    (error) => /没有源/.test(error.message),
    'detaching twice is refused, not a silent no-op',
  );
});

test('sourceDetach: a locally animated node path keeps its frame as a key at t', async (t) => {
  const { root, service, changesets, byNode } = await setupProject(t);
  const kicker = byNode('n_kicker');
  // The element animates its node position itself: 0 → 20 px over one second
  // (the unified-space write turns that into pivot.x 0 → 0.2 m).
  await service.transact({
    ops: [
      { op: 'keySet', id: kicker.id, path: 'transform.x', t: 0, value: 0 },
      { op: 'keySet', id: kicker.id, path: 'transform.x', t: 1, value: 20 },
    ],
  });
  // The source does not move x at t = 0.5 (its track is constant), so the
  // frozen frame is the sampled node value and it lands as a key at t.
  await service.transact({ ops: [{ op: 'sourceDetach', id: kicker.id, t: 0.5 }] });
  const frozen = (await service.read()).elements.find((el) => el.id === kicker.id);
  assert.equal(frozen.source, undefined);
  const keys = frozen.keyframes.filter((key) => key.path === 'pivot.x');
  const at = keys.find((key) => Math.abs(Number(key.t) - 0.5) < 1e-4);
  assert.ok(at, 'the frozen frame lands as a key at t');
  assert.equal(at.value, 0.1, 'half of 0 → 0.2 m');
  assert.deepEqual(keys.filter((key) => Math.abs(Number(key.t) - 0.5) >= 1e-4).map((key) => key.t), [0, 1],
    'the element keeps its own animation');
});

test('sourceDetachSource: every element of one source, still one undo', async (t) => {
  const { root, service, changesets } = await setupProject(t);
  const before = await service.read();
  const bound = before.elements.filter((el) => el.source?.id === SOURCE).map((el) => el.id);
  assert.ok(bound.length >= 3, `the fixture binds ${bound.length} elements`);
  const rev0 = before.rev;
  await service.transact({ ops: [{ op: 'sourceDetachSource', id: SOURCE }] });
  const after = await service.read();
  assert.equal(after.rev, rev0 + 1);
  assert.deepEqual(after.elements.filter((el) => el.source?.id === SOURCE), [], 'the whole source is detached');
  assert.equal(after.elements.length, before.elements.length, 'elements stay, only the binding goes');
  await service.transact({ command: { type: 'undo' } });
  assert.deepEqual(
    (await service.read()).elements.filter((el) => el.source?.id === SOURCE).map((el) => el.id).sort(),
    [...bound].sort(),
    'one undo restores every binding',
  );
});

// ----------------------------------------------------------- conflict decide
test('decide: the chosen values are one transaction, the record leaves needs-decision', async (t) => {
  const { root, service, changesets, byNode } = await setupProject(t);
  const kicker = byNode('n_kicker');
  await service.transact({ ops: [{ op: 'set', id: kicker.id, path: 'style.text', value: 'editor text' }] });
  const base = await readBase({ root, sourceId: SOURCE });
  const theirs = clone(base.snapshot);
  theirs.nodes.find((entry) => entry.id === 'n_kicker').props['style.text'] = 'source text';
  const merged = await mergeSource({ project: await service.read(), sourceId: SOURCE, root, theirs, changesets, actorId: 'test' });
  assert.equal(merged.conflicts.length, 1);
  const pending = await changesets.get(merged.changesetId);
  assert.equal(pending.status, 'needs-decision');
  const provisional = await service.read();
  const rev0 = provisional.rev;
  assert.equal(provisional.elements.find((el) => el.id === kicker.id).style.text, 'source text', '冲突暂取 theirs');

  // 保留我的: one `set` back to `ours`, decided in one call.
  const decided = await changesets.decide({
    id: merged.changesetId,
    ops: [{ op: 'set', id: kicker.id, path: 'style.text', value: 'editor text' }],
    decisions: [{ index: 0, nodeId: 'n_kicker', path: 'style.text', choice: 'ours' }],
    actorId: 'ui',
  });
  assert.equal(decided.status, 'applied');
  assert.equal(decided.writes, true);
  assert.deepEqual(decided.merge.decisions.map((entry) => entry.choice), ['ours']);
  assert.deepEqual(decided.merge.conflicts, merged.conflicts, 'the evidence stays on the record');
  assert.deepEqual(decided.report.decisions, [], 'nothing is left to decide');
  const settled = await service.read();
  assert.equal(settled.rev, rev0 + 1, '应用 = one transaction');
  assert.equal(settled.elements.find((el) => el.id === kicker.id).style.text, 'editor text');
  assert.equal(decided.transactions.length, pending.transactions.length + 1);

  // One Ctrl+Z goes back to the provisional merge state (theirs).
  await service.transact({ command: { type: 'undo' } });
  assert.equal((await service.read()).elements.find((el) => el.id === kicker.id).style.text, 'source text');
});

test('decide: no ops = status only, and a decided record is not decided twice', async (t) => {
  const { root, service, changesets, byNode } = await setupProject(t);
  const kicker = byNode('n_kicker');
  await service.transact({ ops: [{ op: 'set', id: kicker.id, path: 'style.text', value: 'editor text' }] });
  const base = await readBase({ root, sourceId: SOURCE });
  const theirs = clone(base.snapshot);
  theirs.nodes.find((entry) => entry.id === 'n_kicker').props['style.text'] = 'source text';
  const merged = await mergeSource({ project: await service.read(), sourceId: SOURCE, root, theirs, changesets, actorId: 'test' });
  const rev0 = (await service.read()).rev;
  const decided = await changesets.decide({
    id: merged.changesetId,
    decisions: [{ nodeId: 'n_kicker', path: 'style.text', choice: 'theirs' }],
    actorId: 'ui',
  });
  assert.equal(decided.status, 'applied');
  assert.equal(decided.writes, false);
  assert.equal((await service.read()).rev, rev0, 'nothing written: 用源的 is already in place');
  const again = await changesets.decide({ id: merged.changesetId, actorId: 'ui' });
  assert.equal(again.alreadyApplied, true, 'a second 应用 is a no-op');
  assert.deepEqual(snapshotProblems(await readBase({ root, sourceId: SOURCE }).then((entry) => entry.snapshot)), []);
});
