// The three registration points WP-P added (docs/DESIGN-BACKEND-V2.md §10.4.3):
// a feature module adds its ops (core/ops-ext.js) and its contracts
// (core/contracts.js) without editing those files' main bodies, and the tables
// built from them stay consistent.
//
// This file is its own process, so the extra op / property row it registers
// cannot leak into other suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, OP_KINDS } from '../core/ops.js';
import { applyExtOp, EXT_OP_KINDS, registerOps } from '../core/ops-ext.js';
import {
  PROPERTY_PATHS, PROPERTY_PATHS_BY_HOST, PUBLIC_OPS, OP_CONTRACTS, registerContracts, TOOL_SCHEMAS,
} from '../core/contracts.js';

test('registerOps adds a kind and dispatches to its handler', () => {
  const before = EXT_OP_KINDS.length;
  const calls = [];
  registerOps({
    id: 'wp-p-probe',
    kinds: ['wpProbeOp'],
    apply(project, op) {
      calls.push(op.op);
      project.probed = true;
      return { changed: ['probe'] };
    },
  });
  assert.ok(EXT_OP_KINDS.includes('wpProbeOp'));
  assert.equal(EXT_OP_KINDS.length, before + 1);
  // OP_KINDS is the load-time table: a late registration dispatches but is not
  // retroactively listed (the documented ordering rule).
  assert.equal(OP_KINDS.includes('wpProbeOp'), false);

  const project = {};
  assert.deepEqual(applyOp(project, { op: 'wpProbeOp' }), { changed: ['probe'] });
  assert.deepEqual(calls, ['wpProbeOp']);
  assert.equal(project.probed, true);
});

test('registerOps is idempotent by id and does not replace the handler', () => {
  const before = EXT_OP_KINDS.length;
  registerOps({
    id: 'wp-p-probe',
    kinds: ['wpProbeOp'],
    apply() { throw new Error('the first registration must win'); },
  });
  assert.equal(EXT_OP_KINDS.length, before);
  assert.deepEqual(applyOp({}, { op: 'wpProbeOp' }), { changed: ['probe'] });
});

test('a handler that declines still ends in the unknown-op error', () => {
  registerOps({ id: 'wp-p-declines', kinds: ['wpDeclineOp'], apply: () => null });
  assert.equal(applyExtOp({}, { op: 'wpDeclineOp' }, {}), null);
  assert.throws(() => applyOp({}, { op: 'wpDeclineOp' }), /unknown op wpDeclineOp/);
  assert.equal(applyExtOp({}, { op: 'definitely-not-an-op' }, {}), null);
});

test('registerContracts appends a property row once and fills its defaults', () => {
  const paths = PROPERTY_PATHS.length;
  const row = { host: 'el', path: 'code.param.density', type: 'number', unit: 'any', default: 0.5, kind: 'field' };
  const fragment = {
    id: 'wp-p-contracts',
    opGroups: [{ id: 'wp-p', title: '探针', description: 'WP-P 登记测试' }],
    propertyPaths: [row, { ...row }],
  };
  assert.equal(registerContracts(fragment), true);
  assert.equal(PROPERTY_PATHS.length, paths + 1, 'the duplicate row is not added twice');
  const added = PROPERTY_PATHS[PROPERTY_PATHS.length - 1];
  assert.equal(added.path, 'code.param.density');
  assert.equal(added.label, 'code.param.density', 'the label default is filled in');
  assert.equal(added.required, false);
  assert.ok(PROPERTY_PATHS_BY_HOST.el.includes(added));
  assert.equal(registerContracts(fragment), false, 'the same id is a no-op');
  assert.equal(PROPERTY_PATHS.length, paths + 1);
});

test('registerContracts cannot replace a built-in contract or a published tool schema', () => {
  const before = Object.keys(OP_CONTRACTS).length;
  assert.throws(() => registerContracts({
    id: 'wp-p-replaces-set',
    opDefs: { set: { group: 'element', summary: '', description: '', required: [], fields: {} } },
  }), /contract set is built in/);
  assert.equal(Object.keys(OP_CONTRACTS).length, before);
  assert.equal(PUBLIC_OPS.length, 54);
  assert.equal(TOOL_SCHEMAS.vdm_project_apply_ops.properties.ops.items.$ref, '#/$defs/op');
  assert.equal(TOOL_SCHEMAS.vdm_project_apply_ops.$defs.op.oneOf.length, 54);
  // The refused fragment left no trace: the same id can be registered properly later.
  assert.equal(registerContracts({ id: 'wp-p-replaces-set', propertyPaths: [] }), true);
});
