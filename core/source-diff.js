// Line diffs for registered sources (docs/DESIGN-WP3.6-4.6-UI.md §2.2 / §7.1,
// WP3.6b).
//
// The source view shows the **project** copy of a source; an external editor
// writes `sources/<id>/` instead. "载入外部修改" therefore has to answer two
// questions before it writes anything: which lines changed (+/- with line
// numbers), and whether the new text still passes the contract check. This
// module is the first half — pure ESM, no DOM, no filesystem, so the same diff
// can be used by the renderer, the CLI and the tests.
//
// Shape (unified diff, trimmed to hunks):
//
//   diffLines('a\\nb\\n', 'a\\nc\\n') -> {
//     added: 1, removed: 1, beforeLines: 2, afterLines: 2,
//     lines: [
//       { kind: 'same', a: 1, b: 1, text: 'a' },
//       { kind: 'del',  a: 2, b: null, text: 'b' },
//       { kind: 'add',  a: null, b: 2, text: 'c' },
//     ],
//   }
//
// `gap` entries stand for the lines that were trimmed between two hunks.
// Line endings are normalised (CRLF -> LF) before diffing: a Windows editor
// saving the same text must not read as "every line changed". The text that gets
// written stays exactly what the copy holds — this file only looks.

/** How many unchanged lines to keep on each side of a change. */
export const DEFAULT_CONTEXT = 3;

/**
 * Cells of the LCS table this module is willing to fill. Above it the changed
 * middle becomes one remove-all / add-all pair: still a correct diff, just not
 * a minimal one (a 2000-line rewrite is not the case this UI is for).
 */
const MAX_CELLS = 4_000_000;

/**
 * Lines of `text` the way an editor counts them: `'a\nb\n'` is two lines, and
 * a CRLF file diffs equal to its LF twin.
 */
export function sourceLines(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (src === '') return [];
  const lines = src.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest-common-subsequence edit script for two line arrays. */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text) => ({ kind: 'add', text }));
  if (!m) return a.map((text) => ({ kind: 'del', text }));
  if (n * m > MAX_CELLS) {
    return [...a.map((text) => ({ kind: 'del', text })), ...b.map((text) => ({ kind: 'add', text }))];
  }
  // table[i][j] = LCS length of a[i..] and b[j..]
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'same', text: a[i] }); i += 1; j += 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { ops.push({ kind: 'del', text: a[i] }); i += 1; }
    else { ops.push({ kind: 'add', text: b[j] }); j += 1; }
  }
  while (i < n) { ops.push({ kind: 'del', text: a[i] }); i += 1; }
  while (j < m) { ops.push({ kind: 'add', text: b[j] }); j += 1; }
  return ops;
}

/** Keep the changed lines plus `context` unchanged ones around them. */
function trimNumbered(rows, context) {
  if (!rows.some((row) => row.kind !== 'same')) return [];
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    const from = Math.max(0, index - context);
    const to = Math.min(rows.length - 1, index + context);
    for (let i = from; i <= to; i += 1) keep[i] = true;
  });
  const out = [];
  let skipped = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (!keep[index]) { skipped += 1; continue; }
    if (skipped) { out.push({ kind: 'gap', a: null, b: null, text: null }); skipped = 0; }
    out.push(rows[index]);
  }
  // The tail of the file is skipped too: one `gap` row says "there is more".
  if (skipped) out.push({ kind: 'gap', a: null, b: null, text: null });
  return out;
}

/** Assign the file line numbers an editor would show, then trim to hunks. */
function numberedOps(ops, context) {
  const rows = [];
  let aLine = 1;
  let bLine = 1;
  for (const op of ops) {
    if (op.kind === 'same') {
      rows.push({ kind: 'same', a: aLine, b: bLine, text: op.text });
      aLine += 1; bLine += 1;
    } else if (op.kind === 'del') {
      rows.push({ kind: 'del', a: aLine, b: null, text: op.text });
      aLine += 1;
    } else {
      rows.push({ kind: 'add', a: null, b: bLine, text: op.text });
      bLine += 1;
    }
  }
  return trimNumbered(rows, context);
}

/**
 * Unified line diff of two texts. `lines` is trimmed to hunks: unchanged runs
 * longer than `context` collapse into one `gap` entry.
 */
export function diffLines(beforeText, afterText, { context = DEFAULT_CONTEXT } = {}) {
  const a = sourceLines(beforeText);
  const b = sourceLines(afterText);
  const ctx = Math.max(0, Math.round(Number(context)) || 0);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA -= 1; tailB -= 1; }

  const ops = [
    ...a.slice(0, head).map((text) => ({ kind: 'same', text })),
    ...lcsOps(a.slice(head, tailA), b.slice(head, tailB)),
    ...a.slice(tailA).map((text) => ({ kind: 'same', text })),
  ];

  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'add') added += 1;
    else if (op.kind === 'del') removed += 1;
  }
  return { added, removed, beforeLines: a.length, afterLines: b.length, lines: numberedOps(ops, ctx) };
}

/** `[{ path, content }]` -> Map(path -> content), ignoring malformed entries. */
function fileMap(files) {
  const map = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') continue;
    map.set(file.path, file.content);
  }
  return map;
}

/**
 * Per-file diff of two `[{ path, content }]` lists (the project copy vs the
 * `sources/<id>/` copy). Order follows `before` first, then the files only the
 * copy has (sorted), so the UI lists `manifest.entry` and friends predictably.
 */
export function sourceFileDiff(beforeFiles, afterFiles, { context = DEFAULT_CONTEXT } = {}) {
  const before = fileMap(beforeFiles);
  const after = fileMap(afterFiles);
  const order = [...before.keys(), ...[...after.keys()].filter((p) => !before.has(p)).sort()];
  const files = [];
  let added = 0;
  let removed = 0;
  let changedFiles = 0;
  for (const path of order) {
    const hasBefore = before.has(path);
    const hasAfter = after.has(path);
    if (!hasBefore) {
      const lines = diffLines('', after.get(path), { context });
      added += lines.added;
      changedFiles += 1;
      files.push({
        path, status: 'added', added: lines.added, removed: 0,
        beforeBytes: 0, afterBytes: after.get(path).length, lines: lines.lines,
      });
      continue;
    }
    if (!hasAfter) {
      const lines = diffLines(before.get(path), '', { context });
      removed += lines.removed;
      changedFiles += 1;
      files.push({
        path, status: 'removed', added: 0, removed: lines.removed,
        beforeBytes: before.get(path).length, afterBytes: 0, lines: lines.lines,
      });
      continue;
    }
    const lines = diffLines(before.get(path), after.get(path), { context });
    if (!lines.added && !lines.removed) {
      files.push({
        path, status: 'same', added: 0, removed: 0,
        beforeBytes: before.get(path).length, afterBytes: after.get(path).length, lines: [],
      });
      continue;
    }
    added += lines.added;
    removed += lines.removed;
    changedFiles += 1;
    files.push({
      path, status: 'changed', added: lines.added, removed: lines.removed,
      beforeBytes: before.get(path).length, afterBytes: after.get(path).length, lines: lines.lines,
    });
  }
  return { files, changedFiles, added, removed };
}

/** File statuses a load may write: a deletion is never applied (no op for it). */
export const LOADABLE_STATUSES = Object.freeze(['added', 'changed']);

/**
 * One-line summary the UI puts next to the 载入外部修改 button.
 *
 * `statuses` narrows what counts: the window's badge and the external-change
 * notice ask for `LOADABLE_STATUSES`, because a deletion in the copy is never
 * written (there is no op for it). The default counts every difference.
 *
 * @param {object} [options]
 * @param {string[]} [options.statuses] file statuses that count (default: all
 *   three, so a deletion a load would not apply still shows up)
 */
export function diffSummary(diff, { statuses = ['added', 'changed', 'removed'] } = {}) {
  const files = Array.isArray(diff?.files) ? diff.files : [];
  const wanted = new Set(statuses);
  const changed = files.filter((file) => file.status !== 'same' && wanted.has(file.status));
  return {
    changedFiles: changed.length,
    added: changed.reduce((total, file) => total + (Number(file.added) || 0), 0),
    removed: changed.reduce((total, file) => total + (Number(file.removed) || 0), 0),
    paths: changed.map((file) => file.path),
    empty: changed.length === 0,
  };
}
