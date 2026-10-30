// Extension point for operations that do not belong in the core switch.
//
// `core/ops.js` falls back to `applyExtOp()` when it meets an unknown op kind,
// so feature modules (hierarchy, presets, media objects, code layers, …) add
// operations without editing the big switch or the existing case names.
//
// Registering (docs/DESIGN-BACKEND-V2.md §10.4.3):
//
//   import { registerOps } from './ops-ext.js';
//   export const SOURCE_OPS = registerOps({
//     id: 'sources',                 // stable id, so a double import is a no-op
//     kinds: ['sourceAdd', …],       // appended to OP_KINDS, in this order
//     apply(project, op, api) { … }, // returns { changed } or null
//   });
//
// Contract:
//   - `kinds` are appended to `EXT_OP_KINDS`, which `core/ops.js` spreads into
//     OP_KINDS, so OP_KINDS/CLI/docs stay in sync without touching ops.js;
//   - `apply(project, op, api)` returns `{ changed: [ids...] }` when it handled
//     the op, or `null` to let the next handler (or core) report "unknown op";
//   - two modules may claim the same kind: the one with the lower `dispatch`
//     number runs first (registration order breaks a tie), so a legacy name can
//     keep the implementation it had;
//   - do NOT import `core/ops.js` from here (that would be a cycle). Use the
//     `api` helpers instead:
//       { fail, deepMerge, getPath, setPath, newId, coerceValue,
//         findElement, findObject, findCamera }
//
// Ops added here obey the same rules as core ops: mutate the project in place,
// return the ids that changed, and stay deterministic.

import { HIERARCHY_OP_KINDS, applyHierarchyOp, ELEMENT_PARENT_OP_KINDS, applyElementParentOp } from './hierarchy.js';
import { LEGACY_PARENT_OP_KINDS, PARENT_STRENGTH_OP_KINDS, applyParentStrengthOp } from './parent-strength.js';
import { DEFAULT_STYLE, DEFAULT_TRANSFORM } from './schema.js';
import { isSourceNodeId } from './source-eval.js';
import { isRecord } from './json.js';
import {
  SOURCE_MANIFEST, coerceParamValue, isCodeElement, isSafeParamName, isSafeSourceFile, isSafeSourceId,
  manifestIssues, sourceParams, sourceRecord, writeCodeParam,
} from './code-layer.js';

// ---------------------------------------------------------------- registry
//
// A kind maps to the ordered list of modules that claim it; `applyExtOp` asks
// them in turn until one answers. The kind list OP_KINDS inherits is the
// modules' `kinds` in registration order, deduped.

const modules = [];
const chains = new Map(); // kind -> module entries, sorted by (dispatch, index)
let nextIndex = 0;

/** Register one feature module's ops. Idempotent by `id`. */
export function registerOps(module) {
  const kinds = module?.kinds;
  if (!Array.isArray(kinds) || !kinds.length) throw new TypeError('registerOps: kinds must be a non-empty array');
  if (typeof module.apply !== 'function') throw new TypeError('registerOps: apply(project, op, api) is required');
  const id = String(module.id || kinds[0]);
  if (modules.some((entry) => entry.id === id)) return module;
  const entry = {
    id, kinds,
    claims: Array.isArray(module.claims) ? module.claims : [],
    dispatch: Number.isFinite(module.dispatch) ? module.dispatch : 100,
    apply: module.apply,
    index: nextIndex++,
  };
  modules.push(entry);
  for (const kind of new Set([...entry.kinds, ...entry.claims])) {
    const chain = chains.get(kind) || [];
    chain.push(entry);
    chain.sort((a, b) => a.dispatch - b.dispatch || a.index - b.index);
    chains.set(kind, chain);
  }
  EXT_OP_KINDS = Object.freeze([...new Set(modules.flatMap((entry) => entry.kinds))]);
  return module;
}

/**
 * Every kind a feature module registered, in registration order. `core/ops.js`
 * spreads this into OP_KINDS; the registrations below run while this module
 * loads, i.e. before ops.js reads it.
 */
export let EXT_OP_KINDS = Object.freeze([]);

// -- code layers (§6.1) -----------------------------------------------------
//
// `sources/<id>/` is a directory, so the project document owns the registry
// (`project.sources[]` = manifest + file texts) and the CLI / runtime materialise
// it with `core/code-layer.js::sourceFiles()`. That keeps every source edit
// inside the op log: locked, rev-checked, undoable, and visible to the agent.

export const CODE_OP_KINDS = Object.freeze(['sourceAdd', 'sourceWrite', 'sourceRemove', 'codeParamSet']);

const str = (value, d = '') => (value === undefined || value === null ? d : String(value));

/** Create or replace a registered source (`manifest` + `files`). */
function sourceAdd(project, op, fail) {
  const id = str(op.id);
  if (!isSafeSourceId(id)) fail(`sourceAdd: id 必须是 [A-Za-z0-9][A-Za-z0-9_-]{0,63}，收到 ${JSON.stringify(op.id)}`);
  if (!op.manifest || typeof op.manifest !== 'object' || Array.isArray(op.manifest)) {
    fail('sourceAdd 需要 manifest 对象（就是 sources/<id>/manifest.json 的内容）');
  }
  const issues = manifestIssues(op.manifest, 'manifest');
  if (issues.length) fail(`sourceAdd: ${issues[0].path} ${issues[0].msg}`);
  const given = op.files === undefined ? {} : op.files;
  if (!given || typeof given !== 'object' || Array.isArray(given)) fail('sourceAdd: files 必须是 { 相对路径: 文本 }');
  const files = {};
  for (const rel of Object.keys(given)) {
    if (typeof given[rel] !== 'string') fail(`sourceAdd: files["${rel}"] 必须是字符串`);
    if (rel === SOURCE_MANIFEST) fail('sourceAdd: manifest.json 由 manifest 字段生成，不要放进 files');
    if (!isSafeSourceFile(rel)) fail(`sourceAdd: files 里的路径不安全 ${JSON.stringify(rel)}`);
    files[rel] = given[rel];
  }
  // The directory name is the id: keep the two in sync no matter what the
  // caller put in the manifest body.
  const manifest = { ...op.manifest, id };
  const list = Array.isArray(project.sources) ? project.sources : (project.sources = []);
  const index = list.findIndex((entry) => entry && typeof entry === 'object' && str(entry.id) === id);
  const record = { id, manifest, files };
  if (index >= 0) list[index] = record; else list.push(record);
  list.sort((a, b) => (str(a?.id) < str(b?.id) ? -1 : str(a?.id) > str(b?.id) ? 1 : 0));
  return { changed: [id], source: record };
}

/** Replace one text file of a registered source. */
function sourceWrite(project, op, fail) {
  const id = str(op.id);
  const record = sourceRecord(project, id);
  if (!record) fail(`sourceWrite: 没有源 ${id}（先 vdm source new）`);
  const rel = str(op.path);
  if (rel === SOURCE_MANIFEST) fail('sourceWrite: 改 manifest 用 sourceAdd（它会重新校验参数格式）');
  if (!isSafeSourceFile(rel)) fail(`sourceWrite: 路径不安全 ${JSON.stringify(op.path)}`);
  if (typeof op.content !== 'string') fail('sourceWrite 需要 content 字符串');
  const files = record.files && typeof record.files === 'object' && !Array.isArray(record.files) ? { ...record.files } : {};
  if (files[rel] === op.content) return { changed: [] };
  files[rel] = op.content;
  record.files = files;
  return { changed: [id], path: rel, bytes: op.content.length };
}

/** Drop a registered source. Refuses while a `code` element still uses it. */
function sourceRemove(project, op, fail) {
  const id = str(op.id);
  const list = Array.isArray(project.sources) ? project.sources : null;
  const index = list ? list.findIndex((entry) => entry && typeof entry === 'object' && str(entry.id) === id) : -1;
  if (index < 0) fail(`sourceRemove: 没有源 ${id}`);
  const users = (Array.isArray(project.elements) ? project.elements : [])
    .filter((el) => isCodeElement(el) && str(el.code?.source) === id)
    .map((el) => str(el.id));
  if (users.length) {
    fail(`sourceRemove: 源 ${id} 还被 ${users.join(', ')} 使用 —— 先把这些元素的 code.source 改掉或删掉再删源`);
  }
  list.splice(index, 1);
  if (!list.length) delete project.sources;
  return { changed: [id] };
}

/**
 * Set one source parameter on a `code` element. Keyframes still go through the
 * existing `keySet`; when the parameter is already keyed this writes the key at
 * `t` (same rule as every other keyed property, core/links.js::setElementValue).
 */
function codeParamSet(project, op, fail, api) {
  const id = str(op.id);
  // `api.findElement` is already bound to the project: `findElement(id)`.
  const find = typeof api?.findElement === 'function' ? api.findElement : null;
  const el = find
    ? find(id)
    : (Array.isArray(project.elements) ? project.elements.find((e) => str(e?.id) === id) : null);
  if (!el) fail(`codeParamSet: 没有元素 ${id}`);
  if (!isCodeElement(el)) fail(`codeParamSet: ${id} 不是 code 元素（type 是 ${el.type}），普通属性请用 set / keySet`);
  const name = str(op.name);
  if (!isSafeParamName(name)) fail(`codeParamSet: 参数名必须是 [A-Za-z_][A-Za-z0-9_]*，收到 ${JSON.stringify(op.name)}`);
  const declared = sourceParams(project, str(el.code?.source)).find((param) => str(param?.id) === name) || null;
  const raw = op.value === undefined ? op.v : op.value;
  if (raw === undefined) fail('codeParamSet 需要 value');
  let value = coerceParamValue(declared?.type, raw);
  if (typeof value === 'number' && Array.isArray(declared?.range) && declared.range.length >= 2) {
    const min = Number(declared.range[0]);
    const max = Number(declared.range[1]);
    if (Number.isFinite(min) && Number.isFinite(max) && max >= min) value = Math.min(max, Math.max(min, value));
  }
  const t = Number.isFinite(Number(op.t)) ? Math.max(0, Number(op.t)) : 0;
  const written = writeCodeParam(el, name, value, t);
  return {
    changed: [str(el.id)],
    param: name,
    path: written.path,
    key: written.key,
    value: written.value,
    declared: !!declared,
  };
}

/** `apply` of the code-layer module: its four kinds share one entry point. */
function applyCodeOp(project, op, api) {
  const fail = typeof api?.fail === 'function' ? api.fail : (message) => {
    throw Object.assign(new Error(message), { code: 'OP_INVALID' });
  };
  if (op.op === 'sourceAdd') return sourceAdd(project, op, fail);
  if (op.op === 'sourceWrite') return sourceWrite(project, op, fail);
  if (op.op === 'sourceRemove') return sourceRemove(project, op, fail);
  return codeParamSet(project, op, fail, api);
}

// ---------------------------------------------------------------- registrations
//
// Registration order (not dispatch order) is what OP_KINDS inherits, and it is
// the order the old hand-written EXT_OP_KINDS array had: hierarchy, element
// parents, parent strength, code layers. `dispatch` only decides which module
// wins when two of them claim one kind.

registerOps({
  id: 'hierarchy',
  kinds: HIERARCHY_OP_KINDS,
  dispatch: 20,
  apply: (project, op, api) => applyHierarchyOp(project, op, api),
});
registerOps({
  id: 'element-parent',
  kinds: ELEMENT_PARENT_OP_KINDS,
  dispatch: 30,
  apply: (project, op, api) => applyElementParentOp(project, op, api),
});
// The old 3D parent names (objectParent, …) now write spatial parents
// (core/parent-strength.js) and must keep doing so even though `hierarchy`
// lists the same names: lower dispatch wins.
registerOps({
  id: 'parent-strength',
  kinds: PARENT_STRENGTH_OP_KINDS,
  claims: LEGACY_PARENT_OP_KINDS,
  dispatch: 10,
  apply: (project, op, api) => applyParentStrengthOp(project, op, api),
});
registerOps({
  id: 'code-layer',
  kinds: CODE_OP_KINDS,
  dispatch: 40,
  apply: applyCodeOp,
});

// -- compiled sources (§7.8, WP4.1) ----------------------------------------
//
// An HTML/SVG source compiles into elements (`core/source-map.js` +
// `application/source-service.js`). The two ops below are the write path:
//
//   sourceCompile { id, compiled? }  the compile happened (base.json written by
//                                    the application layer, which is the only
//                                    side that may touch `.vdm/`); core sees
//                                    the result and validates the header.
//                                    Changes nothing in the project.
//   sourceApply { id, elements }    upsert the compiled elements, one op =
//                                    one transaction. Elements are compiled
//                                    payloads with `el.source = { id, node }`;
//                                    `{ id }` alone is expanded by
//                                    `application/source-service.js::
//                                    expandSourceOps` at the write boundary.
//
// §7.8.2: "4.1 的编译产物默认走旧 transform 路径" — a compiled element carries
// `transform` and no spatial `node`, so a stale node from an earlier migration
// is dropped instead of overriding the baseline.

export const SOURCE_COMPILE_OP_KINDS = Object.freeze(['sourceCompile', 'sourceApply']);

/** Element types a compiler may produce (§7.8.1). */
const COMPILED_ELEMENT_TYPES = Object.freeze(['text', 'solid', 'shape', 'image']);
const SNAPSHOT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** `sourceCompile`: record + validate a compile, change nothing. */
function sourceCompile(project, op, fail) {
  const id = str(op.id);
  if (!isSafeSourceId(id)) fail(`sourceCompile: id 必须是 [A-Za-z0-9][A-Za-z0-9_-]{0,63}，收到 ${JSON.stringify(op.id)}`);
  if (!sourceRecord(project, id)) fail(`sourceCompile: 没有源 ${id}`);
  if (op.compiled === undefined) {
    fail('sourceCompile: 编译要读源文件、算哈希并写 .vdm/sources/<id>/base.json，由 application/source-service.js 执行'
      + `（POST /api/sources/${id}/compile）；core 的 op 只登记并校验编译结果`);
  }
  if (!isRecord(op.compiled)) fail('sourceCompile: compiled 必须是对象');
  const hash = str(op.compiled.hash);
  if (!SNAPSHOT_HASH_RE.test(hash)) fail(`sourceCompile: compiled.hash 必须是 sha256:<64 位小写十六进制>，收到 ${JSON.stringify(op.compiled.hash)}`);
  const nodes = Number(op.compiled.nodes);
  if (!Number.isFinite(nodes) || nodes < 0) fail('sourceCompile: compiled.nodes 必须是非负数字');
  return {
    changed: [],
    compiled: { id, hash, nodes, builtAt: str(op.compiled.builtAt) },
  };
}

/** `sourceApply`: upsert the compiled elements in one transaction step. */
function sourceApply(project, op, fail) {
  const id = str(op.id);
  if (!isSafeSourceId(id)) fail(`sourceApply: id 必须是 [A-Za-z0-9][A-Za-z0-9_-]{0,63}，收到 ${JSON.stringify(op.id)}`);
  const payloads = op.elements;
  if (!Array.isArray(payloads) || !payloads.length) {
    fail('sourceApply: 需要 elements（编译产物）：由 application/source-service.js::applyCompiled 从 base.json + 编译结果生成；'
      + `core 不读 .vdm/sources/${id}/base.json`);
  }
  if (payloads.length > 1000) fail('sourceApply: 一次最多 1000 个元素');
  if (!Array.isArray(project.elements)) project.elements = [];
  const changed = [];
  for (const payload of payloads) {
    if (!isRecord(payload)) fail('sourceApply: elements 里每一项必须是对象');
    // A page-background element (solid fill / gradient band) carries no node
    // binding; every other payload must belong to this source.
    const bound = isRecord(payload.source);
    const node = bound ? str(payload.source.node) : '';
    if (bound && str(payload.source.id) !== id) fail(`sourceApply: elements 里混进了别的源（${JSON.stringify(payload.source.id)}）`);
    if (bound && !isSourceNodeId(node)) fail(`sourceApply: 节点 id ${JSON.stringify(node)} 不合法`);
    if (!bound && !str(payload.id)) fail('sourceApply: 没有 source 绑定的元素必须带 id（页面背景带）');
    const type = str(payload.type);
    if (!COMPILED_ELEMENT_TYPES.includes(type)) fail(`sourceApply: 元素类型 ${JSON.stringify(payload.type)} 不是编译产物（text/solid/shape/image）`);
    const transform = { ...DEFAULT_TRANSFORM, ...(isRecord(payload.transform) ? payload.transform : {}) };
    const style = { ...DEFAULT_STYLE, ...(isRecord(payload.style) ? payload.style : {}) };
    const duration = Number(payload.duration);
    const start = Number(payload.start);
    const z = Number(payload.z);
    let el = (bound
      ? project.elements.find((entry) => isRecord(entry) && isRecord(entry.source)
        && str(entry.source.id) === id && str(entry.source.node) === node)
      : null)
      || project.elements.find((entry) => isRecord(entry) && str(entry.id) === str(payload.id))
      || null;
    if (el) {
      el.type = type;
      el.name = str(payload.name) || str(el.name) || node;
      el.src = str(payload.src, str(el.src));
      el.transform = transform;
      el.style = style;
      if (bound) el.source = { id, node };
      else delete el.source;
      if (Number.isFinite(start) && start >= 0) el.start = start;
      if (Number.isFinite(duration) && duration > 0) el.duration = duration;
      if (Number.isFinite(z)) el.z = z;
      if (isRecord(payload.sourceMode) && Object.keys(payload.sourceMode).length) el.sourceMode = { ...payload.sourceMode };
      else delete el.sourceMode;
      if (el.node !== undefined) delete el.node;
      changed.push(str(el.id));
      continue;
    }
    const taken = new Set(project.elements.map((entry) => str(entry?.id)));
    let elementId = str(payload.id) || `src_${id}_${node}`;
    for (let n = 2; taken.has(elementId); n++) elementId = `${str(payload.id) || `src_${id}_${node}`}_${n}`;
    const created = {
      id: elementId,
      name: str(payload.name) || node,
      type,
      src: str(payload.src),
      segment: null,
      start: Number.isFinite(start) && start >= 0 ? start : 0,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 1,
      z: Number.isFinite(z) ? z : 0,
      transform,
      style,
      fx: { glow: 0 },
      motion: { type: 'none', amount: 0, dir: 'in' },
      keyframes: [],
      visible: true,
      loop: false,
      fadeIn: 0,
      fadeOut: 0,
      punch: 0,
      srcIn: 0,
      meta: {},
      ...(bound ? { source: { id, node } } : {}),
    };
    if (isRecord(payload.sourceMode) && Object.keys(payload.sourceMode).length) created.sourceMode = { ...payload.sourceMode };
    project.elements.push(created);
    changed.push(elementId);
  }
  project.elements.sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0) || (Number(a.start) || 0) - (Number(b.start) || 0));
  return { changed, elements: changed };
}

/** `apply` of the compiled-source module. */
function applySourceCompileOp(project, op, api) {
  const fail = typeof api?.fail === 'function' ? api.fail : (message) => {
    throw Object.assign(new Error(message), { code: 'OP_INVALID' });
  };
  if (op.op === 'sourceCompile') return sourceCompile(project, op, fail);
  return sourceApply(project, op, fail);
}

registerOps({
  id: 'source-compile',
  kinds: SOURCE_COMPILE_OP_KINDS,
  dispatch: 45,
  apply: applySourceCompileOp,
});

/**
 * @param {object} op
 * @param {{fail:Function,deepMerge:Function,getPath:Function,setPath:Function,newId:Function,coerceValue:Function,findElement:Function,findObject:Function,findCamera:Function}} api
 * @returns {{changed: string[]}|null}
 */
export function applyExtOp(project, op, api) {
  const chain = chains.get(op?.op);
  if (!chain) return null;
  for (const entry of chain) {
    const result = entry.apply(project, op, api);
    if (result) return result;
  }
  return null;
}
