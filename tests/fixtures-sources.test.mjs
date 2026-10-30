// 共享源码夹具的校验（docs/DESIGN-BACKEND-V2.md §10.4.6 + §7.8.5，WP4.0）。
//
// 纯文件与 schema 检查：夹具必须能被渲染池/编译包直接拿去用，所以入口要存在、
// manifest 要合法、参数要能用（默认值在范围内、静态探针能改变画面）、代码图层
// 要过 core/code-layer.js 的静态扫描、sourceFiles() 往返要一致。**不跑浏览器、
// 不跑 Blender、不跑 Electron**——真正的画面验证属于各自的 WP 与对拍用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  KEYABLE_MODES, PROPERTY_TYPES, SOURCE_MANIFEST,
  isSafeParamName, isSafeSourceFile, isSafeSourceId, isScannableSourceFile,
  manifestIssues, paramProbes, scanSourceFiles, sourceFiles,
} from '../core/code-layer.js';
import { SOURCE_SNAPSHOT_VERSION } from '../core/version.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'tests', 'fixtures', 'sources');
const DOC = path.join(ROOT, 'docs', 'DESIGN-BACKEND-V2.md');
const FORMAT = 'vdm.source/1';
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The five sources WP4.0 owns; the other three (§10.4.6) come with their packages. */
const FIXTURES = [
  { id: 'p5-rain', runtime: 'p5', kind: 'code', entry: 'sketch.js' },
  { id: 'glsl-noise', runtime: 'glsl', kind: 'code', entry: 'main.frag' },
  { id: 'canvas2d-bars', runtime: 'canvas2d', kind: 'code', entry: 'main.js' },
  { id: 'html-title-card', runtime: 'html', kind: 'web', entry: 'index.html', assets: ['style.css'] },
  { id: 'html-lyrics', runtime: 'html', kind: 'web', entry: 'index.html', assets: ['style.css', 'script.js'] },
];

const NUMERIC_TYPES = new Set(['number', 'int', 'length', 'percent', 'angle']);
const TEXT_TYPES = new Set(['string', 'text', 'font', 'color', 'enum']);

/** Read one file as strict UTF-8; a BOM or an invalid byte throws with the path. */
async function readText(file) {
  const buffer = await fs.readFile(file);
  const bom = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
  assert.equal(bom, false, `${file} 不应带 UTF-8 BOM`);
  try {
    return UTF8.decode(buffer);
  } catch (error) {
    assert.fail(`${file} 不是合法 UTF-8：${error.message}`);
  }
}

/** Every regular file below `dir`, relative and `/`-separated, sorted. */
async function walk(dir, prefix = '') {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), `${rel}/`));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const cache = new Map();

/** Manifest + every file text of one fixture (read once per test file run). */
async function fixtureData(fixture) {
  if (!cache.has(fixture.id)) {
    const dir = path.join(DIR, fixture.id);
    const promise = (async () => {
      const files = await walk(dir);
      const manifestText = await readText(path.join(dir, SOURCE_MANIFEST));
      const manifest = JSON.parse(manifestText);
      const texts = {};
      for (const rel of files) {
        if (rel === SOURCE_MANIFEST) continue;
        texts[rel] = await readText(path.join(dir, rel));
      }
      return { dir, files, manifestText, manifest, texts };
    })();
    cache.set(fixture.id, promise);
  }
  return cache.get(fixture.id);
}

// ---------------------------------------------------------------------------
// The set itself
// ---------------------------------------------------------------------------

test('the fixture directory holds exactly the five WP4.0 sources (§10.4.6)', async () => {
  const entries = await fs.readdir(DIR, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(dirs, FIXTURES.map((fixture) => fixture.id).sort());
  const readme = await readText(path.join(DIR, 'README.md'));
  for (const fixture of FIXTURES) assert.match(readme, new RegExp(`\`${fixture.id}\``), `README 缺 ${fixture.id}`);
});

// ---------------------------------------------------------------------------
// Manifest + parameter schema, per fixture
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES) {
  test(`fixture ${fixture.id}: manifest is ${FORMAT} and the entry file exists`, async () => {
    const { dir, files, manifest } = await fixtureData(fixture);
    assert.equal(manifest.format, FORMAT);
    assert.equal(manifest.id, fixture.id, '目录名必须等于 manifest.id');
    assert.equal(isSafeSourceId(manifest.id), true);
    assert.equal(manifest.runtime, fixture.runtime);
    assert.equal(manifest.deterministic, true);
    assert.equal(typeof manifest.entry, 'string');
    assert.equal(isSafeSourceFile(manifest.entry), true);
    assert.equal(manifest.entry, fixture.entry);
    assert.ok(files.includes(manifest.entry), `${fixture.id} 缺入口 ${manifest.entry}`);
    const stat = await fs.stat(path.join(dir, manifest.entry));
    assert.equal(stat.isFile(), true);
    assert.ok(files.includes(SOURCE_MANIFEST), `${fixture.id} 缺 ${SOURCE_MANIFEST}`);
    if (manifest.libs !== undefined) {
      assert.equal(typeof manifest.libs, 'object');
      assert.equal(Array.isArray(manifest.libs), false);
    }
  });

  test(`fixture ${fixture.id}: declared parameters are unique, typed and inside their range`, async () => {
    const { manifest } = await fixtureData(fixture);
    assert.ok(Array.isArray(manifest.params) && manifest.params.length >= 1, '夹具至少声明一个参数');
    const seen = new Set();
    for (const [index, param] of manifest.params.entries()) {
      const at = `params[${index}]`;
      assert.equal(typeof param, 'object', `${at} 必须是对象`);
      assert.equal(typeof param.id, 'string', `${at}.id`);
      assert.equal(isSafeParamName(param.id), true, `${at}.id 必须是合法参数名`);
      assert.equal(seen.has(param.id), false, `${fixture.id} 参数 id 重复：${param.id}`);
      seen.add(param.id);
      assert.ok(PROPERTY_TYPES.includes(param.type), `${at}.type 不合法：${param.type}`);
      assert.equal(typeof param.label, 'string', `${at}.label`);
      assert.notEqual(param.default, undefined, `${at}.default 必须是具体值`);
      if (param.keyable !== undefined) assert.ok(KEYABLE_MODES.includes(param.keyable), `${at}.keyable`);
      if (param.unit !== undefined) assert.equal(typeof param.unit, 'string', `${at}.unit`);
      // The default really has the declared type (no "default 0.5" on an int param, etc.).
      if (NUMERIC_TYPES.has(param.type)) {
        assert.equal(typeof param.default, 'number', `${at}.default 应为数字`);
        assert.ok(Number.isFinite(param.default));
        if (param.type === 'int') assert.equal(Number.isInteger(param.default), true, `${at} int 默认值应为整数`);
      } else if (param.type === 'boolean') {
        assert.equal(typeof param.default, 'boolean', `${at}.default 应为布尔`);
      } else if (TEXT_TYPES.has(param.type)) {
        assert.equal(typeof param.default, 'string', `${at}.default 应为字符串`);
      } else if (param.type === 'vec2' || param.type === 'vec3') {
        assert.ok(Array.isArray(param.default), `${at}.default 应为数组`);
        assert.equal(param.default.length, param.type === 'vec2' ? 2 : 3, `${at}.default 维度`);
      }
      if (param.range !== undefined) {
        assert.ok(Array.isArray(param.range) && param.range.length === 2, `${at}.range 应是 [min, max]`);
        const [min, max] = param.range.map(Number);
        assert.ok(Number.isFinite(min) && Number.isFinite(max), `${at}.range 必须是有限数`);
        assert.ok(max >= min, `${at}.range 的 max 不能小于 min`);
        if (typeof param.default === 'number') {
          assert.ok(param.default >= min && param.default <= max,
            `${at}.default ${param.default} 不在 range [${min}, ${max}] 内`);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Code-layer fixtures: the real scan + the registry round-trip
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES.filter((entry) => entry.kind === 'code')) {
  test(`fixture ${fixture.id}: passes the code-layer manifest check and the static scan`, async () => {
    const { manifest, texts } = await fixtureData(fixture);
    assert.deepEqual(manifestIssues(manifest), []);
    assert.equal(isScannableSourceFile(manifest.entry), true, '入口必须是可扫描的代码/着色器文件');
    const sources = Object.keys(texts).map((rel) => ({ path: rel, content: texts[rel] }));
    const scan = scanSourceFiles(sources, { runtime: manifest.runtime });
    assert.deepEqual(scan.errors, [], `静态扫描报了错误：${JSON.stringify(scan.errors)}`);
    assert.deepEqual(scan.warnings, [], '夹具不该带警告（会掩盖真正的问题）');
    assert.ok(scan.files >= 1, '至少扫描一个文件');
    assert.ok(texts[manifest.entry].trim().length > 0, '入口不能是空文件');
  });

  test(`fixture ${fixture.id}: sourceFiles() round-trips manifest and every file`, async () => {
    const { manifest, texts } = await fixtureData(fixture);
    const project = { sources: [{ id: manifest.id, manifest, files: texts }] };
    const materialised = sourceFiles(project, manifest.id);
    assert.equal(materialised.length, Object.keys(texts).length + 1, 'manifest.json 在最前面、其余一一对应');
    assert.equal(materialised[0].path, SOURCE_MANIFEST);
    assert.deepEqual(JSON.parse(materialised[0].content), { ...manifest, id: manifest.id });
    for (const file of materialised.slice(1)) {
      assert.equal(file.content, texts[file.path], `${file.path} 往返后内容变了`);
      assert.equal(isSafeSourceFile(file.path), true);
    }
  });

  test(`fixture ${fixture.id}: every declared parameter has a visible probe (§6.3 第 5 项)`, async () => {
    const { manifest } = await fixtureData(fixture);
    const probes = paramProbes(manifest);
    assert.equal(probes.length, manifest.params.length, '每个参数都要能被探测');
    for (const probe of probes) assert.notDeepEqual(probe.to, probe.from, `${probe.id} 的探测值没有变化`);
  });
}

// ---------------------------------------------------------------------------
// Web-compile fixtures: real static pages, no browser needed
// ---------------------------------------------------------------------------

for (const fixture of FIXTURES.filter((entry) => entry.kind === 'web')) {
  test(`fixture ${fixture.id}: is a standalone static page with compiled-node markers`, async () => {
    const { files, manifest, texts } = await fixtureData(fixture);
    const html = texts[manifest.entry];
    assert.equal(typeof html, 'string');
    assert.match(html, /<meta\s+charset="utf-8"/i);
    const ids = html.match(/data-vdm-id="([^"]+)"/g) || [];
    assert.ok(ids.length >= 2, '至少要两个带 data-vdm-id 的节点，编译才有东西可产出');
    for (const asset of fixture.assets) {
      assert.ok(files.includes(asset), `${fixture.id} 缺 ${asset}`);
      assert.match(html, new RegExp(`(?:href|src)="${asset.replace(/\./g, '\\.')}"`), `${asset} 没被引用`);
    }
    for (const rel of Object.keys(texts)) assert.equal(isSafeSourceFile(rel), true, `${fixture.id} 文件名不安全：${rel}`);
  });
}

// ---------------------------------------------------------------------------
// Byte-level hygiene + the frozen version/docs link
// ---------------------------------------------------------------------------

test('every fixture file is valid UTF-8 without a BOM', async () => {
  for (const fixture of FIXTURES) {
    const { files, dir } = await fixtureData(fixture);
    assert.ok(files.length >= 2, `${fixture.id} 至少要有 manifest 和一个源文件`);
    for (const rel of files) await readText(path.join(dir, rel));
  }
});

test('SOURCE_SNAPSHOT_VERSION = 1 is the frozen snapshot version referenced by §7.8', async () => {
  assert.equal(SOURCE_SNAPSHOT_VERSION, 1);
  const doc = await readText(DOC);
  assert.match(doc, /### 7\.8 冻结记录/);
  assert.match(doc, /SOURCE_SNAPSHOT_VERSION = 1/);
  assert.ok(doc.includes('writeBack(sourceId, nodeId, path, value)'), '§7.8 缺写回接口的签名');
  assert.ok(doc.includes('merge(base, ours, theirs)'), '§7.8 缺合并接口的签名');
  for (const fixture of FIXTURES) {
    assert.ok(doc.includes(`\`${fixture.id}\``), `§7.8.5 的夹具表缺 ${fixture.id}`);
  }
});
