// HTTP: reports (WP2.5c) — files under `.vdm/reports/`, never project state.
//
//   GET /api/reports, POST /api/reports, GET /api/reports/<id>,
//   POST /api/reports/<id>/remeasure
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setup, getter } from './helpers/http.mjs';

test('reports over HTTP: create, list, read, remeasure and a missing id', async (t) => {
  const { root, service, post } = await setup(t);
  const get = getter(service);
  const draft = { attachments: [{ kind: 'element', ref: 'el_1', label: '色块' }], tags: ['看不见'], note: '第二行没了' };
  const created = await post('api/reports', { draft, frame: 12 });
  assert.equal(created.status, 200);
  const report = (await created.json()).report;
  assert.match(report.id, /^rp_[0-9a-f]{16}$/);
  assert.equal(report.note, '第二行没了');
  assert.ok(report.measures.some((m) => m.kind === 'frame'), 'the report carries its measurements');
  const file = path.join(root, '.vdm', 'reports', `${report.id}.json`);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).id, report.id);

  const listed = await get('api/reports');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.reports.some((entry) => entry.id === report.id));
  const read = await get(`api/reports/${report.id}`);
  assert.equal(read.body.report.id, report.id);

  const remeasured = await post(`api/reports/${report.id}/remeasure`, {});
  assert.equal(remeasured.status, 200);
  assert.equal((await remeasured.json()).report.id, report.id);

  const missing = await get('api/reports/rp_0000000000000000');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'REPORT_NOT_FOUND');
});
