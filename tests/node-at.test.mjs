// Sampled SpatialNode of a 2D element at time t (app/renderer/js/node-at.js).
// The spatial migrator writes the 2D placement keys as pivot.* / scale.* / roll
// on the element; the preview must read the same paths. Pure unit tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { elementNodeAt } from '../app/renderer/js/node-at.js';
import { elementNode, frameOf } from '../core/spatial.js';
import { screenToWorld } from '../core/space.js';

const near = (a, b, eps = 1e-9, msg = '') => {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${msg}: keys`);
    for (const k of Object.keys(a)) near(a[k], b[k], eps, `${msg}.${k}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${msg}: expected arrays (${a} / ${b})`);
    assert.equal(a.length, b.length, `${msg}: length`);
    a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
    return;
  }
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

const meta = { width: 1920, height: 1080 };

// ---------------------------------------------------------------- node-at

test('node-at: base node values win and legacy transform is not added twice', () => {
  const el = {
    type: 'text',
    transform: { x: 400, y: 300, z: 4, scale: 3, rotation: 70 },
    node: { pivot: [1, 6, 2], dir: [0, 0, 1], roll: 15, scale: [2, 2, 1] },
    keyframes: [],
  };
  const n = elementNodeAt(el, meta, 1);
  near(n.pivot, [1, 6, 2], 1e-12, 'pivot');
  near(n.dir, [0, 0, 1], 1e-12, 'dir');
  near(n.roll, 15, 1e-12, 'roll');
  near(n.scale, [2, 2, 1], 1e-12, 'scale');
});

test('node-at: samples the migrated pivot.* / scale.* / roll keyframes at t', () => {
  const el = {
    type: 'text',
    start: 0,
    duration: 2,
    transform: { x: 0, y: 0, z: 0, scale: 1, rotation: 0 },
    node: { pivot: [0, 5.4, 0], position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1] },
    keyframes: [
      { t: 0, path: 'pivot.x', value: 0 },
      { t: 2, path: 'pivot.x', value: 4 },
      { t: 0, path: 'pivot.y', value: 5.4 },
      { t: 2, path: 'pivot.y', value: 7.4 },
      { t: 0, path: 'pivot.z', value: 0 },
      { t: 2, path: 'pivot.z', value: 3 },
      { t: 0, path: 'roll', value: 0 },
      { t: 2, path: 'roll', value: 90 },
      { t: 0, path: 'scale.x', value: 1 },
      { t: 2, path: 'scale.x', value: 3 },
      { t: 0, path: 'scale.y', value: 1 },
      { t: 2, path: 'scale.y', value: 5 },
    ],
  };
  near(elementNodeAt(el, meta, 1).pivot, [2, 6.4, 1.5], 1e-9, 'midpoint pivot');
  near(elementNodeAt(el, meta, 1).roll, 45, 1e-9, 'midpoint roll');
  near(elementNodeAt(el, meta, 1).scale, [2, 3, 1], 1e-9, 'midpoint scale');
  near(elementNodeAt(el, meta, 0).pivot, [0, 5.4, 0], 1e-12, 'start pivot');
  near(elementNodeAt(el, meta, 2).scale, [3, 5, 1], 1e-12, 'end scale');
  // The renderer consumes the frame; a keyed pivot must move it.
  near(frameOf(elementNodeAt(el, meta, 1)).pos, [2, 6.4, 1.5], 1e-9, 'frame position');
});

test('node-at: keyed node paths do not leak into the legacy path', () => {
  const el = {
    type: 'text',
    transform: { x: 120, y: -60, z: 0.5, scale: 2, rotation: 25 },
    keyframes: [
      { t: 0, path: 'pivot.x', value: 0 },
      { t: 2, path: 'pivot.x', value: 10 },
    ],
  };
  near(elementNodeAt(el, meta, 1).pivot, screenToWorld(meta, 120, -60, 0.5), 1e-12, 'legacy pivot');
  near(elementNodeAt(el, meta, 1), elementNode(el, meta, 1), 1e-12, 'same as elementNode without a node');
});

test('node-at: a partial node keeps the legacy derivation for missing fields', () => {
  const el = {
    type: 'solid',
    transform: { x: 100, y: 0, z: 1, scale: 1.5, rotation: 40 },
    node: { dir: [0, 0, 1] },
    keyframes: [],
  };
  const n = elementNodeAt(el, meta, 0.5);
  near(n.pivot, screenToWorld(meta, 100, 0, 1), 1e-12, 'legacy pivot');
  near(n.roll, 40, 1e-12, 'legacy roll');
  near(n.scale, [1.5, 1.5, 1], 1e-12, 'legacy scale');
  // t = null returns the base node, exactly like elementNode.
  near(elementNodeAt(el, meta, null), elementNode(el, meta, null), 1e-12, 'no time');
});
