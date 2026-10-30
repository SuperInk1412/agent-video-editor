// Write back one edited value into the source layer (WP4.3, §7.8.3).
//
// Real files on a throwaway project: the shared `html-title-card` fixture is
// registered, compiled and applied the way the UI does it, then edited through
// the frozen contract — reason matrix first, then the three-step transaction
// (source text → element mirror → recompiled base.json), one-step undo, and the
// HTTP surface (`POST /api/sources/<id>/writeback`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectService } from '../engine/projects.js';
import { setup as httpSetup } from './helpers/http.mjs';
import {
  applyCompiled, basePath, clearFontCache, compileSource, elementForNode, readBase,
  writeBack, writeBackOps, WRITEBACK_REASONS,
} from '../application/source-service.js';
import { findNodes, writeNodeValue } from '../application/source-writeback.js';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'sources', 'html-title-card');
const SOURCE = 'html-title-card';
const NODE = 'n_title';
// `elementIdOf` keeps `-` (it is a legal element-id character), so the mirror
// element of `n_title` is `src_<sourceId>_<nodeId>` with the source id as is.
const TITLE = 'src_html-title-card_n_title';
const KICKER = 'src_html-title-card_n_kicker';
const TITLE_TEXT = '一整个夏天都在下坠';

/** `{ manifest, files }` of the shared fixture, as the source registry stores it. */
async function fixture() {
  const names = await fs.readdir(FIXTURE);
  const files = {};
  let manifest = null;
  for (const name of names) {
    const text = await fs.readFile(path.join(FIXTURE, name), 'utf8');
    if (name === 'manifest.json') manifest = JSON.parse(text);
    else files[name] = text;
  }
  return { manifest, files };
}

/** Temp project with the fixture registered, compiled and applied. */
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-writeback-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); clearFontCache(); });
  const service = projectService(root);
  await service.transact({ command: { type: 'initialize', options: { title: 'writeback fixture', duration: 2 } } });
  const { manifest, files } = await fixture();
  await service.transact({ ops: [{ op: 'sourceAdd', id: SOURCE, manifest, files }] });
  const applied = await applyCompiled({ project: await service.read(), sourceId: SOURCE, root });
  await service.transact({ ops: [applied.op] });
  const first = await readBase({ root, sourceId: SOURCE });
  return { root, service, original: files, originalHash: first.snapshot.hash };
}

const entryText = (project) => project.sources.find((record) => record.id === SOURCE).files['index.html'];

test('write-back splice: attributes, SVG ids and the unwritable shapes', () => {
  // `src` is one attribute: added when missing, escaped when replaced, and a
  // second write of the same value changes nothing (§7.8.3 `changed:false`).
  const doc = '<main>\n  <img data-vdm-id="n_pic" alt="a">\n</main>';
  const added = writeNodeValue({ text: doc, nodeId: 'n_pic', path: 'src', value: 'a.png' });
  assert.equal(added.ok, true);
  assert.equal(added.changed, true);
  assert.equal(added.text, '<main>\n  <img data-vdm-id="n_pic" alt="a" src="a.png">\n</main>');
  const replaced = writeNodeValue({ text: added.text, nodeId: 'n_pic', path: 'src', value: 'b&c.png' });
  assert.ok(replaced.text.includes('src="b&amp;c.png"'));
  assert.equal(writeNodeValue({ text: replaced.text, nodeId: 'n_pic', path: 'src', value: 'b&c.png' }).changed, false);
  assert.equal(writeNodeValue({ text: '<p data-vdm-id="n_t">a</p>', nodeId: 'n_t', path: 'src', value: 'a.png' }).ok, false, 'only an <img> takes `src`');

  // SVG sources are located by `id` (§7.1), HTML by `data-vdm-id`.
  const svg = '<svg><rect id="n_box" width="10" height="10"/></svg>';
  assert.equal(findNodes({ text: svg, nodeId: 'n_box', runtime: 'svg' }).length, 1);
  assert.equal(findNodes({ text: svg, nodeId: 'n_box', runtime: 'html' }).length, 0);
  assert.equal(writeNodeValue({ text: svg, nodeId: 'n_box', runtime: 'svg', path: 'style.text', value: 'x' }).ok, false);

  // Comments do not count as elements, and a value that would need markup is escaped.
  const commented = '<!-- <p data-vdm-id="n_c">old</p> --><p data-vdm-id="n_c">real</p>';
  assert.equal(findNodes({ text: commented, nodeId: 'n_c' }).length, 1);
  const escaped = writeNodeValue({ text: commented, nodeId: 'n_c', path: 'style.text', value: '</p><script>' });
  assert.ok(escaped.text.endsWith('<p data-vdm-id="n_c">&lt;/p&gt;&lt;script&gt;</p>'));
});

test('writeBack reasons: only §7.4 write-back rows ever look at the source', async (t) => {
  const { root, service } = await setup(t);
  const before = await service.read();
  for (const at of ['transform.x', 'transform.scale', 'fx.glow', 'crop.left', 'node.pivot.x']) {
    const out = await writeBack({ project: before, sourceId: SOURCE, nodeId: 'n_title', path: at, value: 12, root });
    assert.equal(out.ok, false, at);
    assert.equal(out.fallback, 'editor-layer', at);
    assert.equal(out.reason, 'path-editor-only', at);
    assert.equal(out.path, at);
    assert.equal(out.value, 12);
    assert.equal(out.op, undefined, 'a table-out path produces no op');
    assert.equal(typeof out.message, 'string');
    assert.ok(out.message.length > 0);
  }
  // Nothing was written: the same project the caller passed is untouched.
  assert.deepEqual((await service.read()).sources, before.sources);
});

test('writeBack reasons: source-missing, node-missing, type-mismatch', async (t) => {
  const { root, service } = await setup(t);
  const project = await service.read();
  const call = (extra) => writeBack({ project, sourceId: SOURCE, nodeId: 'n_title', path: 'style.text', value: 'x', root, ...extra });

  const noSource = await call({ sourceId: 'no-such-source' });
  assert.equal(noSource.reason, 'source-missing');
  assert.equal(noSource.ok, false);

  const noNode = await call({ nodeId: 'n_absent' });
  assert.equal(noNode.reason, 'node-missing');
  assert.match(noNode.message, /快照里没有节点 n_absent/);

  // n_rule is a solid: a text path cannot be carried by it.
  const solid = await call({ nodeId: 'n_rule' });
  assert.equal(solid.reason, 'type-mismatch');
  assert.match(solid.message, /solid/);

  // `src` belongs to an image node; the title is text.
  const notImage = await writeBack({ project, sourceId: SOURCE, nodeId: 'n_title', path: 'src', value: 'a.png', root });
  assert.equal(notImage.reason, 'type-mismatch');
  assert.equal(notImage.ok, false);

  // Every reason in the enum is a string the frozen document names.
  for (const reason of ['source-missing', 'node-missing', 'path-editor-only', 'path-overridden',
    'node-unwritable', 'type-mismatch']) {
    assert.ok(WRITEBACK_REASONS.includes(reason), reason);
  }
  assert.deepEqual((await service.read()).sources, project.sources, 'a degraded write-back writes nothing');
});

test('writeBack: an overridden path is not attempted (§7.8.3, R1 #1)', async (t) => {
  const { root, service } = await setup(t);
  const before = await service.read();
  const element = elementForNode({ project: before, sourceId: SOURCE, nodeId: 'n_title' });
  assert.equal(element.id, TITLE);
  await service.transact({
    ops: [{ op: 'set', id: TITLE, path: 'sourceMode', value: { 'style.text': 'override' } }],
  });
  const project = await service.read();
  assert.equal(project.elements.find((el) => el.id === TITLE).sourceMode['style.text'], 'override');

  const out = await writeBack({ project, sourceId: SOURCE, nodeId: 'n_title', path: 'style.text', value: '接管后', root });
  assert.equal(out.ok, false);
  assert.equal(out.fallback, 'editor-layer');
  assert.equal(out.reason, 'path-overridden');
  assert.match(out.message, /override/);
  assert.equal(entryText(project), before.sources.find((r) => r.id === SOURCE).files['index.html'], 'the source text is untouched');
});

test('writeBack: value format is data validation — OP_INVALID, not a fallback', async (t) => {
  const { root, service } = await setup(t);
  const project = await service.read();
  await assert.rejects(
    writeBack({ project, sourceId: SOURCE, nodeId: 'n_title', path: 'style.size', value: 'big', root }),
    (error) => error.code === 'OP_INVALID' && /有限数字/.test(error.message),
  );
  await assert.rejects(
    writeBack({ project, sourceId: SOURCE, nodeId: 'n_title', path: 'style.text', value: 42, root }),
    (error) => error.code === 'OP_INVALID' && /字符串/.test(error.message),
  );
  await assert.rejects(
    writeBack({ project, sourceId: SOURCE, nodeId: 'bad id!', path: 'style.text', value: 'x', root }),
    (error) => error.code === 'OP_INVALID',
  );
  await assert.rejects(
    writeBack({ project, sourceId: SOURCE, nodeId: 'n_title', path: 'style.text', value: 'x' }),
    (error) => error.code === 'INVALID_ARGUMENT' && /root/.test(error.message),
  );
});

test('writeBack: style.text is a three-step transaction (text → mirror → base.json)', async (t) => {
  const { root, service, originalHash } = await setup(t);
  const before = await service.read();
  const beforeBases = await readBase({ root, sourceId: SOURCE });
  assert.equal(beforeBases.snapshot.hash, originalHash);
  const value = '新标题 A & B';

  // (1) the contract: ok is always there; op is a pending sourceWrite.
  const out = await writeBack({ project: before, sourceId: SOURCE, nodeId: 'n_title', path: 'style.text', value, root });
  assert.deepEqual(Object.keys(out).sort(), ['changed', 'file', 'ok', 'op', 'path', 'value']);
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(out.file, 'index.html');
  assert.equal(out.path, 'style.text');
  assert.equal(out.value, value);
  assert.equal(out.op.op, 'sourceWrite');
  assert.equal(out.op.id, SOURCE);
  assert.equal(out.op.path, 'index.html');
  // Byte-exact: only the element's text changed, the rest of the file did not.
  assert.equal(out.op.content, entryText(before).replaceAll(TITLE_TEXT, '新标题 A &amp; B'));
  assert.deepEqual((await service.read()).sources, before.sources, 'writeBack itself writes nothing');

  // (1)+(2) one transaction: the source text and the element mirror.
  const transaction = await service.transact({ ops: writeBackOps({ project: before, sourceId: SOURCE, nodeId: 'n_title', result: out }) });
  assert.equal(transaction.didChange, true);
  assert.equal(transaction.rev, before.rev + 1, 'rev + 1');
  const after = await service.read();
  assert.equal(after.rev, before.rev + 1);
  assert.ok(entryText(after).includes('>新标题 A &amp; B</h1>'), 'the source text changed');
  const mirror = after.elements.find((el) => el.id === TITLE);
  assert.equal(mirror.style.text, value, 'the element mirrors the new baseline');
  // The other nodes kept their own text (§7.8.3 touches one path).
  assert.deepEqual(
    after.elements.find((el) => el.id === KICKER).style,
    before.elements.find((el) => el.id === KICKER).style,
  );

  // (3) recompile: new base.json, new hash, the node carries the value.
  const recompiled = await compileSource({ project: after, sourceId: SOURCE, root });
  assert.notEqual(recompiled.hash, beforeBases.snapshot.hash);
  const afterBases = await readBase({ root, sourceId: SOURCE });
  assert.equal(afterBases.ok, true);
  assert.equal(afterBases.snapshot.hash, recompiled.hash);
  assert.equal(afterBases.snapshot.nodes.find((node) => node.id === 'n_title').props['style.text'], value);
  assert.equal(afterBases.snapshot.nodes.find((node) => node.id === 'n_title').props['style.text'], mirror.style.text);

  // A second write-back of the same value is a no-op: changed:false, op:null,
  // and it produces no transaction (§7.8.3 "源里已经是这个值").
  const again = await writeBack({ project: after, sourceId: SOURCE, nodeId: 'n_title', path: 'style.text', value, root });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.op, null);
  assert.deepEqual(writeBackOps({ project: after, sourceId: SOURCE, nodeId: 'n_title', result: again }), []);
});

test('writeBack: inline styles are the §7.4 rows and the compiler reads them back', async (t) => {
  const { root, service } = await setup(t);
  const before = await service.read();

  // style.color → `color: …` on the element itself.
  const color = await writeBack({ project: before, sourceId: SOURCE, nodeId: 'n_title', path: 'style.color', value: '#ff5c7a', root });
  assert.equal(color.ok, true);
  assert.ok(color.op.content.includes('<h1 class="title" data-vdm-id="n_title" style="color: #ff5c7a">'));
  await service.transact({ ops: writeBackOps({ project: before, sourceId: SOURCE, nodeId: 'n_title', result: color }) });

  // style.size → `font-size: 24px` on the kicker, then style.letterSpacing on
  // top of it: a second declaration lands next to the first one.
  const project = await service.read();
  const size = await writeBack({ project, sourceId: SOURCE, nodeId: 'n_kicker', path: 'style.size', value: 24, root });
  assert.equal(size.ok, true);
  assert.ok(size.op.content.includes('style="font-size: 24px"'));
  await service.transact({ ops: writeBackOps({ project, sourceId: SOURCE, nodeId: 'n_kicker', result: size }) });
  const sized = await service.read();
  const spacing = await writeBack({ project: sized, sourceId: SOURCE, nodeId: 'n_kicker', path: 'style.letterSpacing', value: 3.5, root });
  assert.equal(spacing.ok, true);
  assert.ok(spacing.op.content.includes('style="font-size: 24px; letter-spacing: 3.5px"'), spacing.op.content.match(/<p class="kicker"[^>]*>/)[0]);
  await service.transact({ ops: writeBackOps({ project: sized, sourceId: SOURCE, nodeId: 'n_kicker', result: spacing }) });
  const recompiled = await compileSource({ project: await service.read(), sourceId: SOURCE, root });
  const title = recompiled.nodes.find((node) => node.id === 'n_title');
  const kicker = recompiled.nodes.find((node) => node.id === 'n_kicker');
  assert.equal(title.props['style.color'], '#ff5c7a');
  assert.equal(kicker.props['style.size'], 24);
  assert.equal(kicker.props['style.letterSpacing'], 3.5);
  // The other text styles still come from the stylesheet, untouched.
  assert.equal(kicker.props['style.weight'], 500);
  assert.equal(title.props['style.weight'], 700);

  // A node without an inline style gets one; a font family with a space is quoted.
  const font = await writeBack({ project: await service.read(), sourceId: SOURCE, nodeId: 'n_kicker', path: 'style.font', value: 'Microsoft YaHei', root });
  assert.equal(font.ok, true);
  assert.ok(font.op.content.includes('font-family: &quot;Microsoft YaHei&quot;'));
});

test('writeBack: Ctrl+Z puts the source, the element and the hash back in one step', async (t) => {
  const { root, service, originalHash } = await setup(t);
  const before = await service.read();
  const out = await writeBack({ project: before, sourceId: SOURCE, nodeId: 'n_title', path: 'style.text', value: '撤销我', root });
  await service.transact({ ops: writeBackOps({ project: before, sourceId: SOURCE, nodeId: 'n_title', result: out }) });
  const written = await service.read();
  assert.ok(entryText(written).includes('撤销我'));
  await compileSource({ project: written, sourceId: SOURCE, root });
  assert.notEqual((await readBase({ root, sourceId: SOURCE })).snapshot.hash, originalHash);

  // One undo: both ops of the transaction (sourceWrite + mirror set) revert.
  const undone = await service.transact({ command: { type: 'undo' } });
  assert.equal(undone.didChange, true);
  const back = await service.read();
  assert.equal(back.rev, written.rev + 1, 'undo is its own rev');
  assert.equal(entryText(back), entryText(before), 'the source text is back byte for byte');
  const mirrorBack = back.elements.find((el) => el.id === TITLE);
  assert.equal(mirrorBack.style.text, TITLE_TEXT, 'the mirror is back too');
  assert.equal(mirrorBack.sourceMode?.['style.text'], undefined, 'no takeover was invented');

  // The snapshot is allowed to lag (§7.8.3 step 3 may be debounced); the next
  // compile converges on the original hash.
  const recompiled = await compileSource({ project: back, sourceId: SOURCE, root });
  assert.equal(recompiled.hash, originalHash);
  assert.equal((await readBase({ root, sourceId: SOURCE })).snapshot.hash, originalHash);
  await assert.doesNotReject(fs.stat(basePath(root, SOURCE)));
});

test('writeBack: a stale snapshot and an ambiguous id degrade instead of guessing', async (t) => {
  const { root, service } = await setup(t);
  const before = await service.read();
  const files = entryText(before);

  // The source dropped the node after the last compile: the text no longer has it.
  await service.transact({ ops: [{ op: 'sourceWrite', id: SOURCE, path: 'index.html', content: files.replace(' data-vdm-id="n_kicker"', '') }] });
  const gone = await writeBack({ project: await service.read(), sourceId: SOURCE, nodeId: 'n_kicker', path: 'style.text', value: 'x', root });
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, 'node-missing');
  assert.match(gone.message, /源文本里没有节点/);

  // The same id twice: §7.4 "有歧义" — do not pick one of two.
  const doubled = files.replace('</main>', `  <p data-vdm-id="n_kicker">dup</p>\n  </main>`);
  await service.transact({ ops: [{ op: 'sourceWrite', id: SOURCE, path: 'index.html', content: doubled }] });
  const ambiguous = await writeBack({ project: await service.read(), sourceId: SOURCE, nodeId: 'n_kicker', path: 'style.text', value: 'x', root });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'node-unwritable');
  assert.match(ambiguous.message, /出现了 2 次/);

  // A container node (§7.4: mixed content) is not a text node either.
  const nested = files.replace(`<p class="kicker" data-vdm-id="n_kicker">`, `<p class="kicker" data-vdm-id="n_kicker"><b>x</b>`);
  await service.transact({ ops: [{ op: 'sourceWrite', id: SOURCE, path: 'index.html', content: nested }] });
  const container = await writeBack({ project: await service.read(), sourceId: SOURCE, nodeId: 'n_kicker', path: 'style.text', value: 'x', root });
  assert.equal(container.ok, false);
  assert.equal(container.reason, 'node-unwritable');
  assert.match(container.message, /子元素/);
});

test('POST /api/sources/<id>/writeback: success and degradation over HTTP (§7.8.3)', async (t) => {
  const { post, get } = await httpSetup(t);
  const { manifest, files } = await fixture();
  assert.equal((await post('api/ops', { ops: [{ op: 'sourceAdd', id: SOURCE, manifest, files }] })).status, 200);
  assert.equal((await post(`api/sources/${SOURCE}/compile`, {})).status, 200);
  assert.equal((await post(`api/sources/${SOURCE}/apply`, {})).status, 200);
  const revBefore = (await get('api/project').then((response) => response.json())).project.rev;

  const written = await post(`api/sources/${SOURCE}/writeback`, { nodeId: 'n_title', path: 'style.text', value: 'HTTP 写回' });
  assert.equal(written.status, 200);
  const body = await written.json();
  assert.equal(body.ok, true);
  assert.equal(body.changed, true);
  assert.equal(body.node, 'n_title');
  assert.equal(body.path, 'style.text');
  assert.equal(body.transaction.didChange, true);
  assert.equal(body.transaction.rev, revBefore + 1);
  assert.match(body.compiled.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(body.project.rev, revBefore + 1);
  assert.ok(body.project.sources.find((record) => record.id === SOURCE).files['index.html'].includes('HTTP 写回'));
  const base = await get(`api/sources/${SOURCE}/base`).then((response) => response.json());
  assert.equal(base.snapshot.hash, body.compiled.hash, 'base.json was recompiled');
  assert.equal(base.snapshot.nodes.find((node) => node.id === 'n_title').props['style.text'], 'HTTP 写回');

  // Degradation is a 200 with ok:false — never a 4xx (§7.8.3).
  const degraded = await post(`api/sources/${SOURCE}/writeback`, { nodeId: 'n_title', path: 'transform.x', value: 10 });
  assert.equal(degraded.status, 200);
  const degradedBody = await degraded.json();
  assert.equal(degradedBody.ok, false);
  assert.equal(degradedBody.reason, 'path-editor-only');
  assert.equal(degradedBody.fallback, 'editor-layer');
  assert.equal(degradedBody.transaction, undefined);

  // `fallback: 'editor-layer'` keeps the edit in the editor layer and takes the
  // path over, in one transaction and without touching the source (§7.4).
  await post('api/ops', { ops: [{ op: 'set', id: TITLE, path: 'sourceMode', value: { 'style.color': 'override' } }] });
  const revBeforeFallback = (await get('api/project').then((response) => response.json())).project.rev;
  const fallback = await post(`api/sources/${SOURCE}/writeback`, {
    nodeId: 'n_title', path: 'style.color', value: '#00ff00', fallback: 'editor-layer',
  });
  assert.equal(fallback.status, 200);
  const fallbackBody = await fallback.json();
  assert.equal(fallbackBody.ok, false, 'a taken-over path is not written back');
  assert.equal(fallbackBody.reason, 'path-overridden');
  assert.equal(fallbackBody.editorLayer.override, true);
  assert.equal(fallbackBody.editorLayer.element, TITLE);
  assert.equal(fallbackBody.editorLayer.transaction.rev, revBeforeFallback + 1);
  const project = await get('api/project').then((response) => response.json());
  const element = project.project.elements.find((el) => el.id === TITLE);
  assert.equal(element.style.color, '#00ff00', 'the edit is not lost');
  assert.equal(element.sourceMode['style.color'], 'override');
  // The source text still has the stylesheet's colour: the fallback wrote nothing.
  assert.ok(!project.project.sources.find((record) => record.id === SOURCE).files['index.html'].includes('#00ff00'));

  // ...and after taking the path over, a plain write-back degrades the same way.
  const overridden = await post(`api/sources/${SOURCE}/writeback`, { nodeId: 'n_title', path: 'style.color', value: '#123456' });
  assert.equal(overridden.status, 200);
  assert.equal((await overridden.json()).reason, 'path-overridden');

  // A wrong value type is a real request error (§7.8.3: data validation throws).
  const invalid = await post(`api/sources/${SOURCE}/writeback`, { nodeId: 'n_title', path: 'style.size', value: 'big' });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.code, 'OP_INVALID');

  // Unknown source / bad node id still answer, never 500.
  const unknown = await post('api/sources/no-such-source/writeback', { nodeId: 'n_title', path: 'style.text', value: 'x' });
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).reason, 'source-missing');
});
