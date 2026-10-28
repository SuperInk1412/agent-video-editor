import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, OP_KINDS } from '../core/ops.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { ELEMENT_PARENT_OP_KINDS, elementCarrier } from '../core/hierarchy.js';

// The screen lock (贴屏) is retired (docs/DESIGN-CAMFEED-PARENTS.md §2): the op
// names stay known so old scripts get a clear message, but nothing is bound,
// and no element is carried by a camera any more. Old locks are converted when
// a project is opened (tests/screen-lock-migrate.test.mjs).

function rig() {
  const p = normalizeProject(createProject({ title: 'hud', duration: 4 }));
  ensureSpace(p);
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'text', start: 0, duration: 4, style: { text: '字幕' } } });
  return { p, id: element.id, cam: p.cameras[0].id };
}

test('screen-lock ops are refused with a pointer to camera feeds', () => {
  const { p, id, cam } = rig();
  for (const k of ELEMENT_PARENT_OP_KINDS) assert.ok(OP_KINDS.includes(k), k);
  assert.throws(() => applyOp(p, { op: 'elementParent', id, parent: cam, t: 0 }), /贴屏已取消/);
  assert.throws(() => applyOp(p, { op: 'elementParent', id, parent: '@live', t: 0 }), /投屏/);
  assert.throws(() => applyOp(p, { op: 'elementUnparent', id, t: 0 }), /贴屏已取消/);
  assert.equal(p.elements.find((e) => e.id === id).parent, undefined);
});

test('no element is carried by a camera', () => {
  const { p, id } = rig();
  const el = p.elements.find((e) => e.id === id);
  el.parent = { id: '@live', kind: 'camera', bind: { pos: [0, 5.4, 20], basis: [[1, 0, 0], [0, 1, 0], [0, 0, -1]], depth: 20 } };
  assert.equal(elementCarrier(p, el, 1), null);
});
