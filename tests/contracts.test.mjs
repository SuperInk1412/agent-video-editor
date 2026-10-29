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

test('key ops accept an explicit curve so a move never has to drop it', () => {
  const curve = { type: 'bezier', p1: [0.42, 0], p2: [1, 1] };
  const execution = { ...EDIT_SCHEMA, required: ['ops'] };
  // The curve panel and the timeline both move keys by removing + setting them
  // inside one batch; without `curve` on the contract the engine rejects the
  // whole edit with "does not match a supported variant".
  validateContract({ ops: [
    { op: 'keyRemove', id: 'el_1', path: 'transform.opacity', t: 0 },
    { op: 'keySet', id: 'el_1', path: 'transform.opacity', t: 0.5, value: 1, curve },
    { op: 'keySet', id: 'el_1', path: 'transform.opacity', t: 0.5, value: 1, curve: null },
    { op: 'objectUnkey', id: 'ob_1', path: 'pivot.x', t: 0 },
    { op: 'objectKey', id: 'ob_1', path: 'pivot.x', t: 0.5, v: 2, curve },
    { op: 'cameraParamUnkey', id: 'cam_1', path: 'fov', t: 0 },
    { op: 'cameraParamKey', id: 'cam_1', path: 'fov', t: 0.5, v: 50, curve },
    { op: 'keyCurve', host: 'element', id: 'el_1', path: 'transform.opacity', from: 0, to: 0.5, curve },
  ] }, execution);
});
