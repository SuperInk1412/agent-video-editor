// Line diffs for sources (WP3.6b, docs/DESIGN-WP3.6-4.6-UI.md §2.2 / §7.1).
//
// 载入外部修改 has to say *which lines* an external editor changed before it
// writes anything; these are the pure functions behind that panel.
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffLines, sourceFileDiff, diffSummary, sourceLines, DEFAULT_CONTEXT } from '../core/source-diff.js';

test('sourceLines counts like an editor and folds CRLF', () => {
  assert.deepEqual(sourceLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(sourceLines('a\nb'), ['a', 'b']);
  assert.deepEqual(sourceLines('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(sourceLines(''), []);
  assert.deepEqual(sourceLines('a\n\n'), ['a', '']);
});

test('diffLines: one changed line keeps both line numbers', () => {
  const diff = diffLines('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.beforeLines, 3);
  assert.equal(diff.afterLines, 3);
  assert.deepEqual(diff.lines.map((line) => line.kind), ['same', 'del', 'add', 'same']);
  assert.deepEqual(
    diff.lines.map((line) => [line.a, line.b]),
    [[1, 1], [2, null], [null, 2], [3, 3]],
  );
  assert.equal(diff.lines[1].text, 'two');
  assert.equal(diff.lines[2].text, 'TWO');
});

test('diffLines: an inserted line is only a + at the right line number', () => {
  const diff = diffLines('a\nb\n', 'a\nnew\nb\n');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 0);
  const added = diff.lines.filter((line) => line.kind === 'add');
  assert.deepEqual(added.map((line) => [line.a, line.b, line.text]), [[null, 2, 'new']]);
});

test('diffLines: identical text has no lines at all', () => {
  const diff = diffLines('a\nb\n', 'a\nb\n');
  assert.deepEqual({ added: diff.added, removed: diff.removed, lines: diff.lines }, { added: 0, removed: 0, lines: [] });
});

test('diffLines: CRLF vs LF is not a change', () => {
  const diff = diffLines('a\r\nb\r\n', 'a\nb\n');
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
});

test('diffLines: long unchanged runs collapse into one gap', () => {
  const before = Array.from({ length: 40 }, (_v, i) => `line ${i + 1}`).join('\n');
  const after = before.replace('line 20', 'line twenty');
  const diff = diffLines(before, after);
  const kinds = diff.lines.map((line) => line.kind);
  assert.deepEqual(kinds, ['gap', 'same', 'same', 'same', 'del', 'add', 'same', 'same', 'same', 'gap']);
  const context = DEFAULT_CONTEXT;
  assert.equal(kinds.filter((kind) => kind === 'same').length, 2 * context);
  // The gap rows carry no line number, so nothing pretends to be a line.
  for (const line of diff.lines.filter((row) => row.kind === 'gap')) assert.deepEqual([line.a, line.b, line.text], [null, null, null]);
  // The changed lines are numbered where they are in the file, not in the hunk.
  const del = diff.lines.find((line) => line.kind === 'del');
  assert.deepEqual([del.a, del.b], [20, null]);
  assert.equal(diff.lines.find((line) => line.kind === 'add').b, 20);
});

test('diffLines: every line of a tiny file is a change or context', () => {
  const diff = diffLines('x\n', 'y\n');
  assert.deepEqual(diff.lines.map((line) => line.kind), ['del', 'add']);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
});

test('diffLines: an empty side is a full add / full remove', () => {
  assert.deepEqual(diffLines('', 'a\nb\n').lines.map((line) => [line.kind, line.b, line.text]), [
    ['add', 1, 'a'], ['add', 2, 'b'],
  ]);
  assert.deepEqual(diffLines('a\nb\n', '').lines.map((line) => [line.kind, line.a, line.text]), [
    ['del', 1, 'a'], ['del', 2, 'b'],
  ]);
});

test('sourceFileDiff: changed / added / removed / same in a stable order', () => {
  const before = [
    { path: 'manifest.json', content: '{}\n' },
    { path: 'main.js', content: 'const a = 1;\n' },
    { path: 'old.css', content: 'x\n' },
  ];
  const after = [
    { path: 'main.js', content: 'const a = 2;\n' },
    { path: 'manifest.json', content: '{}\n' },
    { path: 'style.css', content: 'y\n' },
  ];
  const diff = sourceFileDiff(before, after);
  assert.deepEqual(diff.files.map((file) => `${file.path}:${file.status}`), [
    'manifest.json:same', 'main.js:changed', 'old.css:removed', 'style.css:added',
  ]);
  assert.equal(diff.changedFiles, 3);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);

  const summary = diffSummary(diff);
  assert.deepEqual(summary.paths, ['main.js', 'old.css', 'style.css']);
  assert.equal(summary.changedFiles, 3);
  assert.equal(summary.empty, false);
  assert.equal(diffSummary(sourceFileDiff(before, before)).empty, true);
});

test('sourceFileDiff: byte counts come from the real texts', () => {
  const diff = sourceFileDiff([{ path: 'main.js', content: 'abc' }], [{ path: 'main.js', content: 'abcd' }]);
  assert.deepEqual([diff.files[0].beforeBytes, diff.files[0].afterBytes], [3, 4]);
});

test('sourceFileDiff: malformed entries are ignored instead of thrown', () => {
  const diff = sourceFileDiff([{ path: 'a.js', content: 'x' }, null, { content: 'no path' }], [{ path: 'a.js', content: 'x' }]);
  assert.deepEqual(diff.files.map((file) => file.path), ['a.js']);
});

test('diffLines: the whole-file fallback stays correct for huge rewrites', () => {
  // Beyond MAX_CELLS the middle becomes del-all/add-all; the totals must agree.
  const before = Array.from({ length: 2200 }, (_v, i) => `a${i}`).join('\n');
  const after = Array.from({ length: 2200 }, (_v, i) => `b${i}`).join('\n');
  const diff = diffLines(before, after);
  assert.equal(diff.removed, 2200);
  assert.equal(diff.added, 2200);
  assert.equal(diff.lines.reduce((n, line) => n + (line.kind === 'same' ? 1 : 0), 0), 0);
});
