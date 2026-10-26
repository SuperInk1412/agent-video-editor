import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, OP_KINDS } from '../core/ops.js';
import { applyExtOp, EXT_OP_KINDS } from '../core/ops-ext.js';
import { createProject, normalizeProject } from '../core/schema.js';

const fresh = () => normalizeProject(createProject({ title: 'ext', duration: 2 }));

test('ops-ext: extension kinds stay part of OP_KINDS', () => {
  assert.ok(Array.isArray(EXT_OP_KINDS));
  for (const kind of EXT_OP_KINDS) {
    assert.ok(OP_KINDS.includes(kind), `${kind} missing from OP_KINDS`);
  }
});

test('ops-ext: unhandled ops fall back to the core error', () => {
  assert.equal(applyExtOp({}, { op: 'definitely-not-an-op' }, {}), null);
  const p = fresh();
  assert.throws(() => applyOp(p, { op: 'definitely-not-an-op' }), /unknown op/);
});

test('ops-ext: core ops still work with the extension hook installed', () => {
  const p = fresh();
  const { element, changed } = applyOp(p, {
    op: 'addElement',
    element: { type: 'solid', start: 0, duration: 1 },
  });
  assert.equal(p.elements.length, 1);
  assert.equal(changed[0], element.id);
  assert.throws(() => applyOp(p, { op: 'batch', ops: [{ op: 'nope' }] }), /unknown op/);
});
