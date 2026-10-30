// HTTP: change sets (WP2.2 / WP2.5a) — the review panel's protocol.
//
//   GET /api/changesets, GET /api/changesets/<id>, POST /api/changesets
//   actions: propose | preview | apply | revert | revert-one
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, getter } from './helpers/http.mjs';

test('change sets over HTTP: propose, shadow preview, apply, list, show, revert', async (t) => {
  const { root, service, post } = await setup(t);
  const get = getter(service);
  const file = path.join(root, 'project.vdm.json');
  const before = await fs.readFile(file, 'utf8');
  const beforeRev = (await get('api/project')).body.project.rev;
  const ops = [{ op: 'set', id: 'el_1', path: 'start', value: 0.5 }];

  // A preview is a shadow project: same revision, nothing on disk.
  const preview = await post('api/changesets', { action: 'preview', includeProject: true, ops });
  assert.equal(preview.status, 200);
  const shadow = await preview.json();
  assert.equal(shadow.equal, false);
  assert.equal(shadow.project.rev, beforeRev);
  assert.equal(shadow.project.elements.find((el) => el.id === 'el_1').start, 0.5);
  assert.equal(await fs.readFile(file, 'utf8'), before, 'a preview never writes');

  // Propose keeps the record; applying it is one transaction (one undo step).
  const proposed = await (await post('api/changesets', { action: 'propose', intent: 'http test', ops })).json();
  assert.equal(proposed.changeset.status, 'proposed');
  const byId = await post('api/changesets', { action: 'preview', id: proposed.changeset.id, includeProject: true });
  assert.equal(byId.status, 200);
  assert.equal((await byId.json()).project.elements.find((el) => el.id === 'el_1').start, 0.5);

  const applied = await post('api/changesets', { action: 'apply', id: proposed.changeset.id });
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()));
  const record = (await applied.json()).changeset;
  assert.equal(record.status, 'applied');
  assert.equal(record.rev, beforeRev + 1);
  assert.ok(record.changed.some((entry) => entry.id === 'el_1'), 'the diff names the host');

  const listed = await get('api/changesets');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.changesets.some((entry) => entry.id === record.id));
  const shown = await get(`api/changesets/${record.id}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.body.changeset.status, 'applied');

  const reverted = await post('api/changesets', { action: 'revert', id: record.id });
  assert.equal(reverted.status, 200);
  assert.equal((await reverted.json()).changeset.status, 'reverted');
  const current = (await get('api/project')).body.project;
  assert.equal(current.elements.find((el) => el.id === 'el_1').start, 0);
  assert.equal(current.rev, beforeRev + 2);

  const missing = await get('api/changesets/cs_missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'CHANGESET_NOT_FOUND');
});

test('the change set list is summaries by default and full records with detail=1', async (t) => {
  const { service, post } = await setup(t);
  const get = getter(service);
  const proposed = await (await post('api/changesets', { action: 'propose', intent: 'detail', ops: [{ op: 'set', id: 'el_1', path: 'start', value: 0.5 }] })).json();
  const id = proposed.changeset.id;

  const summaries = await get('api/changesets?status=proposed');
  const summary = summaries.body.changesets.find((record) => record.id === id);
  assert.equal(summary.changed, undefined, 'a summary carries counts, not the diff');
  assert.equal(summary.counts.changed, 1);

  const full = await get('api/changesets?status=proposed&detail=1');
  const record = full.body.changesets.find((entry) => entry.id === id);
  assert.ok(Array.isArray(record.changed));
  assert.ok(record.changed.some((entry) => entry.path === 'start'), 'the full record names the property');
  assert.equal(record.opsCount, 1);
});
