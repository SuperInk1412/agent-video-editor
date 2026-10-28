// Effective-value bridge between legacy 2D element rows and core/links.js
// (app/renderer/js/element-link-value.js). The UI shows `transform.*` in screen
// units, while a link targets the spatial-node path; these tests pin the
// forward and inverse conversion and the linked-value display.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  elementRowKeyPath,
  elementRowTarget,
  effectiveElementRowValue,
  localElementRowValue,
  localElementRowValueAt,
  nodeRowPatch,
  rowToTarget,
  targetToRow,
} from '../app/renderer/js/element-link-value.js';

const tr = (x = 0, y = 0, z = 0, scale = 1, rotation = 0, opacity = 1) => ({
  x, y, z, scale, rotation, opacity,
});

function project() {
  return {
    meta: { width: 1920, height: 1080, fps: 30, duration: 5 },
    elements: [
      {
        id: 'a', name: 'A', type: 'solid', start: 0, duration: 5,
        transform: tr(0, 0), keyframes: [],
        links: [{
          id: 'lnk_1', to: 'pivot.y',
          from: { host: 'el', id: 'b', path: 'pivot.x' },
          combine: 'add', bindParentValue: 0, enabled: true,
        }],
      },
      {
        id: 'b', name: 'B', type: 'solid', start: 0, duration: 5,
        transform: tr(100, 0), keyframes: [], links: [],
      },
      {
        id: 'n', name: 'N', type: 'solid', start: 0, duration: 5,
        transform: tr(999, 0), keyframes: [],
        node: { pivot: [0, 0, 0], position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1] },
        links: [],
      },
    ],
  };
}

test('element-link-value: legacy rows map to and from node units', () => {
  const p = project();
  const a = p.elements[0];
  assert.equal(elementRowTarget(a, 'transform.x'), 'pivot.x');
  assert.equal(elementRowTarget(a, 'transform.y'), 'pivot.y');
  assert.equal(elementRowTarget(a, 'transform.z'), 'pivot.z');
  assert.equal(elementRowTarget(a, 'transform.scale'), 'scale.x');
  assert.equal(elementRowTarget(a, 'transform.rotation'), 'roll');
  assert.equal(elementRowTarget(a, 'transform.opacity'), 'opacity');
  assert.equal(elementRowTarget(a, 'style.color'), null);
  assert.equal(targetToRow(a, p.meta, 'pivot.x', 1), 100);
  assert.equal(targetToRow(a, p.meta, 'pivot.y', 5.4), 0);
  assert.equal(rowToTarget(a, p.meta, 'pivot.x', 100), 1);
  assert.equal(rowToTarget(a, p.meta, 'pivot.y', 0), 5.4);
});

test('element-link-value: the effective row value follows the parent local value', () => {
  const p = project();
  const a = p.elements[0];
  assert.equal(effectiveElementRowValue(p, a, 'transform.y', 0, 0), -100);
  assert.equal(effectiveElementRowValue(p, a, 'transform.x', 0, 0), 0, 'unlinked rows stay local');
  p.elements[1].transform.x = 0;
  assert.equal(effectiveElementRowValue(p, a, 'transform.y', 0, 0), 0);
});

test('element-link-value: editing the effective value writes the local value', () => {
  const p = project();
  const a = p.elements[0];
  assert.equal(localElementRowValue(p, a, 'transform.y', 0, 0), 100);
  assert.equal(localElementRowValue(p, a, 'transform.y', 0, -100), 0);
  assert.equal(localElementRowValue(p, a, 'transform.x', 0, 42), 42, 'unlinked rows pass through');
});

test('element-link-value: scale is a ratio link and opacity passes through', () => {
  const p = project();
  const a = p.elements[0];
  a.links = [{
    id: 'lnk_2', to: 'scale.x',
    from: { host: 'el', id: 'b', path: 'scale.x' },
    combine: 'mul', bindParentValue: 1, enabled: true,
  }];
  p.elements[1].transform.scale = 2;
  assert.equal(effectiveElementRowValue(p, a, 'transform.scale', 0, 1), 2);
  assert.equal(localElementRowValue(p, a, 'transform.scale', 0, 2), 1);
});

test('element-link-value: a disabled link falls back to the local value', () => {
  const p = project();
  const a = p.elements[0];
  a.links[0].enabled = false;
  assert.equal(effectiveElementRowValue(p, a, 'transform.y', 0, 0), 0);
  assert.equal(localElementRowValue(p, a, 'transform.y', 0, 0), 0);
});

test('element-link-value: node rows use pivot paths, keys and node patches', () => {
  const p = project();
  const n = p.elements[2];
  n.transform.x = 999;
  n.node.pivot = [1.25, 3.9, 0.5];
  n.node.scale = [2, 2, 1];
  n.node.roll = 30;
  assert.equal(elementRowTarget(n, 'transform.x'), 'pivot.x');
  assert.equal(elementRowTarget(n, 'pivot.x'), 'pivot.x');
  assert.equal(elementRowTarget(n, 'position.y'), 'position.y');
  assert.equal(elementRowKeyPath(n, 'transform.x'), 'pivot.x');
  assert.equal(elementRowKeyPath(n, 'transform.scale'), 'scale.x');
  assert.equal(elementRowKeyPath(n, 'transform.rotation'), 'roll');
  assert.equal(elementRowKeyPath(n, 'transform.opacity'), 'transform.opacity');
  assert.equal(localElementRowValueAt(p, n, 'transform.x', 0), 125);
  assert.equal(Math.round(localElementRowValueAt(p, n, 'transform.y', 0)), 150);
  assert.equal(localElementRowValueAt(p, n, 'transform.scale', 0), 2);
  assert.equal(localElementRowValueAt(p, n, 'transform.rotation', 0), 30);
  assert.equal(localElementRowValueAt(p, n, 'pivot.x', 0), 1.25, 'direct node rows are metres');
  assert.equal(localElementRowValue(p, n, 'pivot.y', 0, 0), 0, 'unlinked node rows pass through');
  assert.deepEqual(nodeRowPatch(n, 'pivot.x', 2.5, p.meta).node.pivot, [2.5, 3.9, 0.5]);
  assert.deepEqual(nodeRowPatch(n, 'position.x', 1, p.meta).node.position, [1, 0, 0]);
  assert.deepEqual(nodeRowPatch(n, 'transform.x', 250, p.meta).node.pivot, [2.5, 3.9, 0.5]);
  assert.deepEqual(nodeRowPatch(n, 'transform.y', 0, p.meta).node.pivot, [1.25, 5.4, 0.5]);
  assert.deepEqual(nodeRowPatch(n, 'transform.scale', 0.5, p.meta).node.scale, [0.5, 0.5, 1]);
  assert.equal(nodeRowPatch(n, 'transform.rotation', 45, p.meta).node.roll, 45);
  assert.equal(nodeRowPatch(n, 'transform.opacity', 0.4, p.meta).transform.opacity, 0.4);
});
