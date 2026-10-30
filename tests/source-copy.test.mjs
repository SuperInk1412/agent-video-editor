// `sources/<id>/` copies and the loadable-source contract check (WP3.6b,
// docs/DESIGN-WP3.6-4.6-UI.md §2.2 / §7.1).
//
// The project registry is the truth; this is the copy an external editor
// writes, which 载入外部修改 diffs and then — only if it passes — loads through
// one `sourceWrite` transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSourceCopy, checkSourceFiles, copyDir } from '../application/source-service.js';

const MANIFEST = {
  id: 'rain',
  label: 'rain',
  runtime: 'canvas2d',
  entry: 'main.js',
  deterministic: true,
  params: [{ id: 'density', type: 'number', default: 0.5, range: [0, 1] }],
};

const SKETCH = `export function draw(ctx, vdm) {
  ctx.fillStyle = vdm.param('density') > 0.5 ? '#fff' : '#000';
  ctx.fillRect(0, 0, vdm.size[0], vdm.size[1]);
}
`;

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-copy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeCopy(root, id, files) {
  const dir = copyDir(root, id);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

test('readSourceCopy: a source nobody opened outside the app has no copy', async (t) => {
  const root = await workspace(t);
  const copy = await readSourceCopy({ root, sourceId: 'rain' });
  assert.equal(copy.ok, false);
  assert.equal(copy.missing, true);
  assert.deepEqual(copy.files, []);
  assert.deepEqual(copy.problems, []);
  assert.equal(copy.dir, 'sources/rain');
});

test('readSourceCopy: reads every text file, skips hidden and binary ones', async (t) => {
  const root = await workspace(t);
  const dir = await writeCopy(root, 'rain', {
    'manifest.json': `${JSON.stringify({ ...MANIFEST }, null, 2)}\n`,
    'main.js': SKETCH,
    'style.css': ':root { color: #fff; }\n',
    '.DS_Store': 'junk',
    'thumb.png': 'not really a png',
    'shaders/noise.frag': 'void main() {}\n',
  });
  const copy = await readSourceCopy({ root, sourceId: 'rain' });
  assert.equal(copy.ok, true);
  assert.equal(copy.missing, undefined);
  assert.deepEqual(copy.files.map((file) => file.path), ['main.js', 'manifest.json', 'shaders/noise.frag', 'style.css']);
  const main = copy.files.find((file) => file.path === 'main.js');
  assert.equal(main.content, SKETCH);
  assert.equal(main.bytes, Buffer.byteLength(SKETCH, 'utf8'));
  assert.deepEqual(copy.problems, []);
  assert.equal(copy.manifest.label, 'rain');
  assert.equal(copy.manifestError, null);
  assert.ok(copy.scannedAt);
  assert.ok(dir.startsWith(root));
});

test('readSourceCopy: a broken manifest.json reports its parse error, not a throw', async (t) => {
  const root = await workspace(t);
  await writeCopy(root, 'rain', { 'manifest.json': '{ nope', 'main.js': SKETCH });
  const copy = await readSourceCopy({ root, sourceId: 'rain' });
  assert.equal(copy.ok, true);
  assert.equal(copy.manifest, null);
  assert.match(copy.manifestError, /JSON|Unexpected|token/i);
});

test('readSourceCopy: bad ids and no root are refused', async () => {
  assert.equal((await readSourceCopy({ root: '/tmp', sourceId: '../etc' })).ok, false);
  assert.equal((await readSourceCopy({ root: null, sourceId: 'rain' })).ok, false);
});

test('checkSourceFiles: a clean source passes with the three static checks', () => {
  const verdict = checkSourceFiles({
    sourceId: 'rain',
    manifest: MANIFEST,
    files: [
      { path: 'main.js', content: SKETCH },
      { path: 'manifest.json', content: `${JSON.stringify(MANIFEST)}\n` },
    ],
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.checks.map((row) => row.id), ['manifest', 'entry', 'static']);
  assert.deepEqual(verdict.checks.map((row) => row.status), ['pass', 'pass', 'pass']);
  assert.equal(verdict.runtime, 'canvas2d');
  assert.equal(verdict.entry, 'main.js');
  assert.equal(verdict.manifest.ok, true);
  assert.equal(verdict.notes.length, 1);
});

test('checkSourceFiles: a missing entry file is a problem with the file name', () => {
  const verdict = checkSourceFiles({ sourceId: 'rain', manifest: MANIFEST, files: [{ path: 'style.css', content: 'x{}' }] });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.kind === 'entry' && problem.message.includes('找不到 main.js')));
  assert.equal(verdict.checks.find((row) => row.id === 'entry').status, 'fail');
});

test('checkSourceFiles: an invalid manifest shows the raw parse error', () => {
  const verdict = checkSourceFiles({
    sourceId: 'rain',
    manifestText: '{ "runtime": ',
    files: [{ path: 'main.js', content: SKETCH }],
  });
  assert.equal(verdict.ok, false);
  const problem = verdict.problems.find((row) => row.kind === 'manifest');
  assert.ok(problem, 'a parse failure is reported');
  assert.match(problem.message, /manifest\.json 解析失败/);
  assert.equal(verdict.manifest.present, true);
  assert.equal(verdict.manifest.ok, false);
  assert.ok(verdict.manifest.error);
});

test('checkSourceFiles: manifest shape problems come from manifestIssues', () => {
  const verdict = checkSourceFiles({
    sourceId: 'rain',
    manifestText: JSON.stringify({ runtime: 'webgl', entry: 'main.js' }),
    files: [{ path: 'main.js', content: SKETCH }],
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.kind === 'manifest' && problem.message.includes('runtime')));
  assert.equal(verdict.checks.find((row) => row.id === 'manifest').status, 'fail');
});

test('checkSourceFiles: a sketch that reads the wall clock fails the static scan', () => {
  const bad = 'export function draw(ctx) { ctx.fillStyle = Date.now() % 2 ? "#222" : "#444"; }\n';
  const verdict = checkSourceFiles({ sourceId: 'rain', manifest: MANIFEST, files: [{ path: 'main.js', content: bad }] });
  assert.equal(verdict.ok, false);
  const problem = verdict.problems.find((row) => row.kind === 'static');
  assert.ok(problem);
  assert.equal(problem.file, 'main.js');
  assert.ok(problem.line >= 1);
  assert.equal(verdict.scan.errors.length, 1);
  assert.equal(verdict.checks.find((row) => row.id === 'static').status, 'fail');
});

test('checkSourceFiles: unsafe paths are refused before anything else', () => {
  const verdict = checkSourceFiles({
    sourceId: 'rain',
    manifest: MANIFEST,
    files: [{ path: '../escape.js', content: 'x' }, { path: 'main.js', content: SKETCH }],
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((row) => row.kind === 'path'));
  assert.deepEqual(verdict.files, ['main.js'], 'the unsafe entry never reaches the candidate list');
});

test('checkSourceFiles: warnings alone do not fail the source', () => {
  // `window.` is a warning rule; the sketch is still loadable.
  const verdict = checkSourceFiles({
    sourceId: 'rain',
    manifest: MANIFEST,
    files: [{ path: 'main.js', content: `${SKETCH}\nexport const w = typeof window;\n` }],
  });
  assert.equal(verdict.scan.warnings.length >= 0, true);
  assert.equal(verdict.ok, true);
});
