import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyOp } from '../core/ops.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { frameOf } from '../core/spatial.js';
import { objectPose } from '../core/scene.js';
import { facingRotation } from '../core/rotation-ops.js';
import { dirRollFromRotation } from '../core/rotation.js';
import { elementWorldNode } from '../app/renderer/js/node-at.js';
import { loadProject, saveProject } from '../engine/storage.js';

// docs/DESIGN-TRANSFORM-UNIFY.md §2: new data is written as rotation.x/y/z,
// and the old field names in ops still land in the right place.

const near = (a, b, eps, msg) => {
  if (Array.isArray(a)) return a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};
const fresh = () => { const p = normalizeProject(createProject({ title: 'ro', duration: 4 })); ensureSpace(p); return p; };
const frame = (p, id, t) => frameOf(elementWorldNode(p, p.elements.find((e) => e.id === id), t));

test('a new 2D element is a node with rotation and the old picture', () => {
  const p = fresh();
  const element = { type: 'solid', start: 0, duration: 4, transform: { x: 120, y: -80, scale: 1.5, rotation: 30 },
    keyframes: [{ t: 0, path: 'transform.x', value: 120, ease: 'linear' }, { t: 2, path: 'transform.x', value: -60 }] };
  const { element: el } = applyOp(p, { op: 'addElement', element: { ...element, id: 'el_new' } });
  assert.deepEqual(el.node.rotation, [0, 0, 30]);
  assert.ok(el.keyframes.every((k) => k.path === 'pivot.x'));
  // the same element kept in the old format
  const q = fresh();
  const { element: old } = applyOp(q, { op: 'addElement', element: { ...element, id: 'el_new' } });
  delete old.node; old.keyframes = structuredClone(element.keyframes);
  for (const t of [0, 1, 2]) {
    const a = frame(p, 'el_new', t), b = frame(q, 'el_new', t);
    near(a.pos, b.pos, 1e-6, `pos @${t}`);
    a.basis.forEach((v, i) => near(v, b.basis[i], 1e-9, `basis @${t}`));
    near(a.scale, b.scale, 1e-9, `scale @${t}`);
  }
  assert.deepEqual(validateProject(p), []);
});

test('old transform paths in key / set / update ops move the node', () => {
  const p = fresh();
  const { element: el } = applyOp(p, { op: 'addElement', element: { id: 'el_a', type: 'solid', start: 0, duration: 4 } });
  applyOp(p, { op: 'keySet', id: 'el_a', path: 'transform.rotation', t: 1, value: 45 });
  applyOp(p, { op: 'keySet', id: 'el_a', path: 'roll', t: 2, value: 50 });
  assert.deepEqual(el.keyframes.map((k) => [k.path, k.value]), [['rotation.z', 45], ['rotation.z', 50]]);
  applyOp(p, { op: 'set', id: 'el_a', path: 'transform.x', value: 300 });
  near(el.node.pivot[0], 3, 1e-9, 'x 300 px = 3 m');
  applyOp(p, { op: 'updateElement', id: 'el_a', patch: { transform: { scale: 2, rotation: -10 } } });
  near(el.node.scale, [2, 2, 1], 1e-9, 'scale');
  near(el.node.rotation, [0, 0, -10], 1e-9, 'rotation');
});

test('object dir / roll keys and roll links land on rotation', () => {
  const p = fresh();
  applyOp(p, { op: 'objectAdd', object: { id: 'ob_a', type: 'solid', rot: { dir: [1, 0, 0], roll: 0 } } });
  const o = p.scene.objects.find((x) => x.id === 'ob_a');
  assert.ok(Array.isArray(o.rotation) && o.rot === undefined, 'created with rotation');
  near(objectPose(o, 0).basis.forward, [1, 0, 0], 1e-9, 'same facing');
  applyOp(p, { op: 'objectKey', id: 'ob_a', path: 'roll', t: 1, v: 30 });
  near(objectPose(o, 1).roll, 30, 1e-6, 'roll key');
  near(objectPose(o, 1).basis.forward, [1, 0, 0], 1e-6, 'facing kept');
  applyOp(p, { op: 'objectKey', id: 'ob_a', path: 'dir', t: 2, v: [0, 0, 1] });
  near(objectPose(o, 2).basis.forward, [0, 0, 1], 1e-6, 'dir key');
  assert.ok(!o.tracks.roll && !o.tracks.dir);
  applyOp(p, { op: 'objectAdd', object: { id: 'ob_b', type: 'empty' } });
  applyOp(p, { op: 'propLink', host: 'ob', id: 'ob_b', to: 'roll', from: { host: 'ob', id: 'ob_a', path: 'roll' }, combine: 'add', t: 0 });
  const link = p.scene.objects.find((x) => x.id === 'ob_b').links[0];
  assert.equal(link.to, 'rotation.z');
  assert.equal(link.from.path, 'rotation.z');
});

test('facingRotation keeps the current self-rotation and unwraps near it', () => {
  for (const cur of [[0, 0, 0], [10, 20, 350], [15, 200, 40]]) {
    const next = facingRotation([1, 0, 0], cur);
    const rr = dirRollFromRotation(next);
    near(rr.dir, [1, 0, 0], 1e-6, `faces +X from ${cur}`);
    near(rr.roll, dirRollFromRotation(cur).roll, 1e-6, 'roll kept');
    next.forEach((v, i) => assert.ok(Math.abs(v - cur[i]) <= 180.000001,
      `axis ${i} stays near ${cur[i]}: ${v}`));
  }
  // a nearly-full-turn key does not spin the object around
  near(facingRotation([0, 0, 1], [0, 359, 0])[1], 360, 1e-6, 'no 359 -> 0 jump');
});

test('the old dir key translation is facingRotation at the key time', () => {
  const p = fresh();
  applyOp(p, { op: 'objectAdd', object: { id: 'ob_face', type: 'solid', rotation: [10, 20, 30] } });
  const o = p.scene.objects.find((x) => x.id === 'ob_face');
  applyOp(p, { op: 'objectKey', id: 'ob_face', path: 'dir', t: 1, v: [0, 1, 0] });
  const expected = facingRotation([0, 1, 0], [10, 20, 30]);
  ['x', 'y', 'z'].forEach((a, i) => {
    near(o.tracks[`rotation.${a}`][0].v, expected[i], 1e-6, `rotation.${a}`);
  });
  near(objectPose(o, 1).basis.forward, [0, 1, 0], 1e-6, 'faces up');
});

test('a fresh project opens without a migration, every time', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-rot-'));
  try {
    const p = fresh();
    applyOp(p, { op: 'addElement', element: { type: 'text', start: 0, duration: 2, style: { text: 'hi' } } });
    applyOp(p, { op: 'objectAdd', object: { type: 'solid' } });
    await saveProject(dir, p);
    const once = await loadProject(dir);
    assert.equal(once.meta.ui?.migration, undefined, JSON.stringify(once.meta.ui?.migration?.notes));
    await saveProject(dir, once);
    const twice = await loadProject(dir);
    assert.equal(twice.meta.ui?.migration, undefined);
    assert.equal(twice.cameras[0].roll, undefined);
    assert.deepEqual(twice.cameras[0].rotation, [0, 0, 0]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
