import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, OP_KINDS } from '../core/ops.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { evalElement } from '../core/evaluate.js';
import { cameraFrame, elementCarrier, carrierMatrix, mapPoint, ELEMENT_PARENT_OP_KINDS } from '../core/hierarchy.js';

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A project with the default camera, then a truck + pan + roll by 2 s. */
function rig() {
  const p = normalizeProject(createProject({ title: 'hud', duration: 4 }));
  ensureSpace(p);
  const cam = p.cameras[0].id;
  applyOp(p, { op: 'cameraKey', t: 2, pos: [6, 7, 18], look: [2, 6, 0] });
  applyOp(p, { op: 'cameraPatch', id: cam, patch: { roll: 12 } });
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'text', start: 0, duration: 4, transform: { x: 300, y: 380, z: 1 }, style: { text: '字幕' } } });
  return { p, cam, id: element.id };
}

/** Element centre in the world (screen plane + depth, then the camera carry). */
function centre(p, el, t) {
  const st = evalElement(el, t, p.meta);
  const local = [st.x / 100, p.meta.height / 200 - st.y / 100, st.z];
  const m = elementCarrier(p, el, t);
  return m ? mapPoint(m, local) : local;
}

/** Pinhole image-plane coordinates of a world point for camera `cam` at t. */
function project(p, cam, t, w) {
  const f = cameraFrame(p, cam, t);
  const d = sub(w, f.pos);
  const z = dot(d, f.basis[2]);
  return [dot(d, f.basis[0]) / z, dot(d, f.basis[1]) / z];
}

test('element-parent: ops are registered', () => {
  for (const k of ELEMENT_PARENT_OP_KINDS) assert.ok(OP_KINDS.includes(k), k);
});

test('element-parent: binding never moves the element and keeps it on screen while the camera moves', () => {
  const { p, cam, id } = rig();
  const el = () => p.elements.find((e) => e.id === id);
  const before = centre(p, el(), 0.5);
  applyOp(p, { op: 'elementParent', id, parent: cam, t: 0.5 });
  assert.equal(el().parent.id, cam);
  centre(p, el(), 0.5).forEach((v, i) => near(v, before[i], 1e-4, 'no jump'));
  const onScreen = project(p, cam, 0.5, centre(p, el(), 0.5));
  for (const t of [0, 1, 2, 3.5]) {
    const s = project(p, cam, t, centre(p, el(), t));
    near(s[0], onScreen[0], 1e-5, `screen x at ${t}`);
    near(s[1], onScreen[1], 1e-5, `screen y at ${t}`);
  }
  // an unparented element does move on screen (sanity check of the test rig)
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'solid', start: 0, duration: 4, transform: { x: 300, y: 380, z: 1 } } });
  const free = p.elements.find((e) => e.id === element.id);
  const a = project(p, cam, 0.5, centre(p, free, 0.5));
  const b = project(p, cam, 2, centre(p, free, 2));
  assert.ok(Math.abs(a[0] - b[0]) > 0.05, 'free element slides across the screen');
});

test('element-parent: unparent keeps the centre where it is', () => {
  const { p, cam, id } = rig();
  const el = () => p.elements.find((e) => e.id === id);
  applyOp(p, { op: 'keySet', id, path: 'transform.x', t: 0, value: 300, ease: 'linear' });
  applyOp(p, { op: 'keySet', id, path: 'transform.x', t: 4, value: 500 });
  applyOp(p, { op: 'elementParent', id, parent: cam, t: 0 });
  const at = centre(p, el(), 2);
  applyOp(p, { op: 'elementUnparent', id, t: 2 });
  assert.equal(el().parent, undefined);
  centre(p, el(), 2).forEach((v, i) => near(v, at[i], 1e-4, 'kept'));
  assert.equal(applyOp(p, { op: 'elementUnparent', id, t: 2 }).changed.length, 0, 'no-op when free');
});

test('element-parent: validation, re-parenting and persistence', () => {
  const { p, cam, id } = rig();
  assert.throws(() => applyOp(p, { op: 'elementParent', id, parent: 'cam_nope', t: 0 }), /no camera/);
  applyOp(p, { op: 'elementParent', id, parent: cam, t: 1 });
  applyOp(p, { op: 'elementParent', id, parent: cam, t: 3 }); // re-bind keeps the place
  const q = normalizeProject(JSON.parse(JSON.stringify(p)));
  const el = q.elements.find((e) => e.id === id);
  assert.equal(el.parent.id, cam);
  assert.equal(el.parent.bind.basis.length, 3);
  const m = carrierMatrix(elementCarrier(q, el, 3));
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].forEach((v, i) => near(m[i], v, 1e-5, `identity at bind ${i}`));
  applyOp(q, { op: 'elementParent', id, parent: null, t: 3 });
  assert.equal(q.elements.find((e) => e.id === id).parent, undefined, 'parent null = unparent');
});
