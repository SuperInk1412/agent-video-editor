import test from 'node:test';
import assert from 'node:assert/strict';
import { OP_KINDS } from '../core/ops.js';
import { ELEMENT_TYPES } from '../core/schema.js';
import { PUBLIC_OPS, EDIT_SCHEMA } from '../core/contracts.js';
import { validateContract } from '../application/validate-contract.js';

test('every public core or extension operation is available through the editing contract', () => {
  const internal = new Set(['restoreProject', 'replaceTimeline']);
  assert.deepEqual([...PUBLIC_OPS].sort(), OP_KINDS.filter((op) => !internal.has(op)).sort());
});

test('the public element creation contract accepts every supported element type', () => {
  for (const type of ELEMENT_TYPES) validateContract({ ops: [
    { op: 'addElement', element: { type, duration: 2 } },
  ] }, { ...EDIT_SCHEMA, required: ['ops'] });
});
