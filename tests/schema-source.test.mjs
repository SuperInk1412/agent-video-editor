// `el.source` / `el.sourceMode` in the project schema (§7.8.2, WP4.2).
//
// Normalisation only *keeps* legal values — it never fabricates a binding and a
// broken one is dropped whole, because loading a project must not fail
// (`normalizeProject` throws `OP_INVALID` for the document, never for a field).
// `validateProject` is the reporting side: it never repairs.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createProject, normalizeProject, sourceIssues, sourceModeIssues, validateProject } from '../core/schema.js';

/** A project with the given elements, normalised on the way in. */
const project = (elements) => normalizeProject({
  ...createProject({ title: 'source binding', duration: 2, fps: 10 }),
  elements,
});

const solid = (over = {}) => ({
  id: 'el_a', type: 'solid', start: 0, duration: 2, z: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  style: { w: 100, h: 100 },
  ...over,
});

test('schema: `el.source` keeps exactly { id, node }', () => {
  const p = project([solid({ source: { id: 'html-lyrics', node: 'n_line_1', extra: 'dropped' } })]);
  assert.deepEqual(p.elements[0].source, { id: 'html-lyrics', node: 'n_line_1' });
  assert.deepEqual(validateProject(p).filter((i) => i.path.includes('source')), []);
});

test('schema: an unusable `el.source` is dropped, not repaired, and never throws', () => {
  const cases = [
    { id: 'html-lyrics' }, // no node
    { node: 'n_line_1' }, // no id
    { id: '', node: 'n_line_1' },
    { id: 'html-lyrics', node: '' },
    { id: 7, node: 'n_line_1' },
    { id: 'html-lyrics', node: null },
    { id: 'bad id!', node: 'n_line_1' }, // not an `isSafeSourceId`
    'html-lyrics',
    42,
  ];
  for (const source of cases) {
    const p = project([solid({ source })]);
    assert.equal(p.elements[0].source, undefined, `dropped: ${JSON.stringify(source)}`);
    // ... and the overlay table goes with it.
    assert.equal(p.elements[0].sourceMode, undefined);
  }
});

test('schema: `el.sourceMode` keeps only legal, the closed paths and no `mul` on text', () => {
  const p = project([solid({
    source: { id: 'html-lyrics', node: 'n_line_1' },
    sourceMode: {
      'transform.opacity': 'add',
      'transform.x': 'override',
      'transform.scale': 'mul',
      'style.text': 'mul', // a string has nothing to multiply
      'style.color': 'add',
      'transform.z': 'add', // not a source path
      'style.size': 'bogus', // not a mode
    },
  })]);
  assert.deepEqual(p.elements[0].sourceMode, {
    'transform.x': 'override',
    'transform.scale': 'mul',
    'transform.opacity': 'add',
    'style.color': 'add',
  });
  // An all-default table is removed: loading stays write-free.
  const empty = project([solid({
    source: { id: 'html-lyrics', node: 'n_line_1' },
    sourceMode: { 'transform.z': 'add' },
  })]);
  assert.equal(empty.elements[0].sourceMode, undefined);
  // No `source` ⇒ no `sourceMode` (§7.8.2).
  const orphan = project([solid({ sourceMode: { 'transform.x': 'override' } })]);
  assert.equal(orphan.elements[0].sourceMode, undefined);
});

test('schema: `sourceMode` is not created out of nothing', () => {
  const p = project([solid()]);
  assert.equal(p.elements[0].source, undefined);
  assert.equal(p.elements[0].sourceMode, undefined);
  assert.ok(!JSON.stringify(p.elements[0]).includes('source'));
});

test('schema: validateProject reports a broken binding without repairing it', () => {
  assert.deepEqual(
    sourceIssues({ id: 'html-lyrics', node: 'n_line_1' }).map((i) => i.path),
    [],
  );
  assert.deepEqual(
    sourceIssues({ id: 'bad id!', node: '' }).map((i) => i.path).sort(),
    ['source.id', 'source.node'],
  );
  assert.deepEqual(sourceIssues({ id: 'a', node: 'n', extra: 1 }).map((i) => i.path), ['source.extra']);
  assert.deepEqual(sourceIssues(null).map((i) => i.path), ['source']);
  assert.deepEqual(
    sourceModeIssues(
      { 'transform.z': 'add', 'style.text': 'mul', 'style.size': 'bogus' },
      'sourceMode',
      { id: 'html-lyrics', node: 'n_line_1' },
    ).map((i) => i.path).sort(),
    ['sourceMode.style.size', 'sourceMode.style.text', 'sourceMode.transform.z'],
  );
  assert.deepEqual(sourceModeIssues({}, 'sourceMode', null).map((i) => i.path), ['sourceMode']);

  const bad = {
    ...createProject({ title: 'bad', duration: 2, fps: 10 }),
    elements: [solid({
      source: { id: 'html-lyrics' }, // no node
      sourceMode: { 'transform.x': 'add' },
    })],
  };
  const issues = validateProject(bad).filter((i) => i.path.includes('source'));
  assert.deepEqual(issues.map((i) => i.path), ['elements[0].source.node']);
  // validateProject never mutates: the broken record is still there.
  assert.deepEqual(bad.elements[0].source, { id: 'html-lyrics' });
});

test('schema: an element without source fields normalises write-free', () => {
  const raw = {
    ...createProject({ title: 'plain', duration: 2, fps: 10 }),
    elements: [solid()],
  };
  const p = normalizeProject(raw);
  const after = p.elements[0];
  assert.ok(!('source' in after) && !('sourceMode' in after));
  assert.ok(!JSON.stringify(after).includes('source'));
  // Loading is idempotent: the second pass adds and removes nothing.
  const twice = normalizeProject(JSON.parse(JSON.stringify(p))).elements[0];
  assert.deepEqual(twice, after);
  assert.equal(p.rev, 0, 'normalisation is not an edit');
});
