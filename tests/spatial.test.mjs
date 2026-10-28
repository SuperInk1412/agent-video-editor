import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, isValidSpatialNode, normalizeProject, normalizeSpatialNode, spatialNodeIssues, validateProject,
} from '../core/schema.js';

const node = () => ({
  pivot: [0, 0, 0], position: [0, 0, 0], dir: [0, 0, -1], roll: 0, scale: [1, 1, 1],
});

test('spatial schema: the unified node normalises, validates and survives loading', () => {
  assert.deepEqual(normalizeSpatialNode(null), node(), 'defaults');
  const loose = normalizeSpatialNode({ pivot: [1, 2], position: 'bad', dir: [0, 0, 0], roll: 'x', scale: [2] });
  assert.deepEqual(loose, {
    pivot: [1, 2, 0], position: [0, 0, 0], dir: [0, 0, -1], roll: 0, scale: [1, 1, 1],
  }, 'tolerant fields');
  assert.equal(isValidSpatialNode(undefined), true, 'an absent node is valid');
  assert.equal(isValidSpatialNode(node()), true);
  assert.deepEqual(
    spatialNodeIssues({ ...node(), dir: [0, 0, 0], roll: 'x' }).map((i) => i.path).sort(),
    ['node.dir', 'node.roll'],
  );

  const p = normalizeProject(createProject({ title: 'spatial' }));
  const nodeA = { pivot: [1, 2, 3], position: [0, 0, 0], dir: [0, 0, 1], roll: 45, scale: [2, 2, 1] };
  p.elements.push({ id: 'el_node', type: 'text', start: 0, duration: 2, node: { ...nodeA } });
  p.elements.push({ id: 'el_legacy', type: 'text', start: 0, duration: 2, transform: { x: 10, y: 20 } });
  const q = normalizeProject(p);
  assert.deepEqual(q.elements[0].node, nodeA, 'node data is preserved');
  assert.equal('node' in q.elements[1], false, 'legacy elements never gain a node');
  assert.deepEqual(validateProject(q), [], 'a full node validates');

  const partial = normalizeProject({ elements: [{ id: 'el_partial', type: 'text', start: 0, duration: 1, node: { roll: 5 } }] });
  assert.deepEqual(partial.elements[0].node, { roll: 5 }, 'partial nodes are not rewritten on load');

  const bad = structuredClone(q);
  bad.elements[0].node.pivot = [1, 2];
  bad.elements[0].node.dir = [0, 0, 0];
  const paths = validateProject(bad).map((i) => i.path);
  assert.ok(paths.includes('elements[0].node.pivot'), 'bad pivot is reported');
  assert.ok(paths.includes('elements[0].node.dir'), 'zero direction is reported');
  assert.ok(!paths.some((path) => path.startsWith('elements[1].node')), 'legacy element is unaffected');
});
