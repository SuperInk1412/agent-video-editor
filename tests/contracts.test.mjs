// Contract single source (docs/DESIGN-BACKEND-V2.md §8.4, WP2.3).
//
// What this file guards:
//   * every public op has exactly one contract, and the JSON Schema in that
//     contract is the one another module validates against;
//   * `mcp/tools.js` publishes schemas derived from core/contracts.js — field by
//     field, both directions, so a hand-written op field cannot sneak back in;
//   * the property catalog is not a second opinion: every camera track ops.js
//     knows, every path links.js accepts and every default schema.js/templates.js
//     define is quoted (and cross-checked) instead of re-typed;
//   * `scripts/gen-contracts.mjs --check` is green on the committed tree in both
//     directions: clean files -> exit 0, one hand-edited byte -> exit != 0;
//   * docs/AGENT-PROTOCOL.md recommends the current fields: `transform.*` may
//     only appear inside the generated, explicitly marked legacy block.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CAMERA_TRACK_DIMS, OP_KINDS } from '../core/ops.js';
import { DEFAULT_SPATIAL_NODE, DEFAULT_STYLE, ELEMENT_TYPES } from '../core/schema.js';
import { linkTargets } from '../core/links.js';
import { PROPERTIES as TEMPLATE_PROPERTIES } from '../core/templates.js';
import {
  CHANGESET_APPLY_SCHEMA, CONTRACT_VERSION, EDIT_OPS_ARRAY, EDIT_SCHEMA, KEYABLE_PATHS,
  LEGACY_PATHS, LINKABLE_PATHS, OP_CONTRACTS, PROPERTY_PATHS, PROPERTY_PATHS_BY_HOST, PUBLIC_OPS,
  TOOL_SCHEMAS, UNITS,
} from '../core/contracts.js';
import { listTools } from '../mcp/tools.js';
import { validateContract } from '../application/validate-contract.js';
import { GENERATED_FILES } from '../scripts/gen-contracts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const INTERNAL_OPS = new Set(['restoreProject', 'replaceTimeline']);
const rowOf = (host, property) => PROPERTY_PATHS_BY_HOST[host].find((row) => row.path === property) || null;

test('every public core or extension operation is available through the editing contract', () => {
  assert.deepEqual([...PUBLIC_OPS].sort(), OP_KINDS.filter((op) => !INTERNAL_OPS.has(op)).sort());
});

test('every OP_KINDS entry has exactly one contract', (t) => {
  const missing = OP_KINDS.filter((op) => !INTERNAL_OPS.has(op) && !OP_CONTRACTS[op]);
  assert.deepEqual(missing, []);
  assert.deepEqual(Object.keys(OP_CONTRACTS).sort(), [...PUBLIC_OPS].sort());
  for (const op of INTERNAL_OPS) assert.equal(OP_CONTRACTS[op], undefined, `${op} stays internal`);
  let fields = 0;
  for (const op of PUBLIC_OPS) {
    const contract = OP_CONTRACTS[op];
    assert.equal(contract.op, op);
    assert.equal(contract.schema.properties.op.const, op, `${op}: the variant discriminator is the op name`);
    assert.equal(contract.schema.additionalProperties, false, `${op}: unknown fields are refused`);
    assert.deepEqual(contract.required, contract.schema.required.slice(1), `${op}: required matches the schema`);
    const fieldNames = contract.fields.map((field) => field.name).sort();
    const schemaNames = Object.keys(contract.schema.properties).filter((key) => key !== 'op').sort();
    assert.deepEqual(fieldNames, schemaNames, `${op}: every schema field has a contract row`);
    assert.deepEqual(contract.fields.filter((field) => field.required).map((field) => field.name).sort(),
      [...contract.required].sort(), `${op}: required flags match`);
    assert.ok(contract.summary.length >= 3, `${op}: summary`);
    assert.ok(contract.description.length > 10, `${op}: description`);
    assert.ok(contract.fields.every((field) => field.description.length > 4), `${op}: every field is documented`);
    assert.ok(contract.fields.every((field) => field.unit === null || Object.hasOwn(UNITS, field.unit)),
      `${op}: units come from the unit vocabulary`);
    fields += contract.fields.length;
  }
  t.diagnostic(`${Object.keys(OP_CONTRACTS).length} ops / ${fields} op fields have a contract`);
});

test('op examples validate against their own contract', () => {
  let examples = 0;
  for (const op of PUBLIC_OPS) {
    const example = OP_CONTRACTS[op].example;
    if (!example) continue;
    validateContract(example, OP_CONTRACTS[op].schema, EDIT_SCHEMA);
    assert.equal(example.op, op, `${op}: the example names its op`);
    examples += 1;
  }
  assert.ok(examples >= 10, `at least the main ops carry an example (got ${examples})`);
});

test('the public element creation contract accepts every supported element type', () => {
  for (const type of ELEMENT_TYPES) validateContract({ ops: [
    { op: 'addElement', element: { type, duration: 2 } },
  ] }, { ...EDIT_SCHEMA, required: ['ops'] });
});

test('key ops accept an explicit curve so a move never has to drop it', () => {
  const curve = { type: 'bezier', p1: [0.42, 0], p2: [1, 1] };
  const execution = { ...EDIT_SCHEMA, required: ['ops'] };
  // The curve panel and the timeline both move keys by removing + setting them
  // inside one batch; without `curve` on the contract the engine rejects the
  // whole edit with "does not match a supported variant".
  validateContract({ ops: [
    { op: 'keyRemove', id: 'el_1', path: 'transform.opacity', t: 0 },
    { op: 'keySet', id: 'el_1', path: 'transform.opacity', t: 0.5, value: 1, curve },
    { op: 'keySet', id: 'el_1', path: 'transform.opacity', t: 0.5, value: 1, curve: null },
    { op: 'objectUnkey', id: 'ob_1', path: 'pivot.x', t: 0 },
    { op: 'objectKey', id: 'ob_1', path: 'pivot.x', t: 0.5, v: 2, curve },
    { op: 'cameraParamUnkey', id: 'cam_1', path: 'fov', t: 0 },
    { op: 'cameraParamKey', id: 'cam_1', path: 'fov', t: 0.5, v: 50, curve },
    { op: 'keyCurve', host: 'element', id: 'el_1', path: 'transform.opacity', from: 0, to: 0.5, curve },
  ] }, execution);
});

test('the MCP tool schemas are derived from the contract, field by field', (t) => {
  const tools = listTools();
  const applyTool = tools.find((tool) => tool.name === 'vdm_project_apply_ops');
  const changeSetTool = tools.find((tool) => tool.name === 'vdm_changeset_apply');
  assert.ok(applyTool && changeSetTool, 'both op-bearing tools exist');

  // The published edit tool is the contract object, not a copy of it.
  assert.deepEqual(applyTool.inputSchema, EDIT_SCHEMA);
  assert.equal(applyTool.inputSchema, TOOL_SCHEMAS.vdm_project_apply_ops);

  const variants = applyTool.inputSchema.$defs.op.oneOf;
  assert.equal(variants.length, PUBLIC_OPS.length, 'one variant per public op');
  let comparedFields = 0;
  for (const variant of variants) {
    const op = variant.properties.op.const;
    const contract = OP_CONTRACTS[op];
    assert.ok(contract, `tool schema publishes ${op} without a contract`);
    assert.equal(variant.additionalProperties, false, `${op}: additionalProperties`);
    assert.deepEqual([...variant.required].sort(), ['op', ...contract.required].sort(), `${op}: required fields`);
    assert.deepEqual(Object.keys(variant.properties).filter((key) => key !== 'op').sort(),
      contract.fields.map((field) => field.name).sort(), `${op}: field set`);
    for (const field of contract.fields) {
      // Re-derive the field schema from the contract row and compare both ways.
      assert.deepEqual(variant.properties[field.name], contract.schema.properties[field.name], `${op}.${field.name}`);
      assert.equal(variant.properties[field.name].description, field.description, `${op}.${field.name}: description`);
      comparedFields += 1;
    }
  }

  assert.deepEqual(changeSetTool.inputSchema, CHANGESET_APPLY_SCHEMA);
  assert.equal(changeSetTool.inputSchema, TOOL_SCHEMAS.vdm_changeset_apply);
  assert.deepEqual(changeSetTool.inputSchema.properties.ops, EDIT_OPS_ARRAY);
  assert.deepEqual(changeSetTool.inputSchema.$defs, EDIT_SCHEMA.$defs, 'the op contract is embedded, not duplicated');
  assert.equal(changeSetTool.inputSchema.additionalProperties, false);
  t.diagnostic(`compared ${variants.length} ops / ${comparedFields} fields between mcp/tools.js and core/contracts.js`);
});

test('the derived schema keeps rejecting unknown ops, fields and missing fields', () => {
  const execution = { ...EDIT_SCHEMA, required: ['ops'] };
  validateContract({ ops: [{ op: 'set', id: 'el_1', path: 'pivot.x', value: 1 }] }, execution);
  assert.throws(() => validateContract({ ops: [{ op: 'set', id: 'el_1', path: 'pivot.x', value: 1, typo: 1 }] }, execution),
    /supported variant/);
  assert.throws(() => validateContract({ ops: [{ op: 'set', id: 'el_1' }] }, execution), /supported variant/);
  assert.throws(() => validateContract({ ops: [{ op: 'restoreProject', project: {} }] }, execution), /supported variant/);
});

test('the property catalog covers every path ops.js, links.js and schema.js know', (t) => {
  // Camera keyframe tracks: ops.js::CAMERA_TRACK_DIMS is the engine's list.
  const cameraKeyable = new Set(KEYABLE_PATHS.cam);
  assert.deepEqual(Object.keys(CAMERA_TRACK_DIMS).filter((property) => !cameraKeyable.has(property)), []);
  assert.deepEqual([...cameraKeyable].filter((property) => property !== 'path' && !(property in CAMERA_TRACK_DIMS)), []);

  // Property-link targets: links.js decides, the contract only documents them.
  const nodeHost = { type: 'text', node: { pivot: [0, 0, 0], position: [0, 0, 0], scale: [1, 1, 1] } };
  const codeHost = { ...nodeHost, type: 'code', code: { params: { radius: 1 } } };
  const codeParamTarget = /^code\.params\.[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const codeParamPlaceholder = 'code.params.<name>';
  const elementTargets = new Set([...linkTargets('el', nodeHost), ...linkTargets('el', codeHost)].map((target) => target.path));
  for (const property of elementTargets) {
    assert.ok(LINKABLE_PATHS.el.includes(property) || codeParamTarget.test(property), `el link target ${property} is documented`);
  }
  assert.ok(elementTargets.has('code.params.radius'), 'links.js exposes a declared code parameter');
  assert.ok(LINKABLE_PATHS.el.includes(codeParamPlaceholder), 'the code parameter placeholder is documented');
  for (const [kind, list] of [['ob', linkTargets('ob')], ['cam', linkTargets('cam')]]) {
    for (const target of list) assert.ok(LINKABLE_PATHS[kind].includes(target.path), `${kind} link target ${target.path} is documented`);
  }
  // ... and nothing claims to be linkable that links.js would refuse.
  for (const host of ['el', 'ob', 'cam']) {
    for (const property of LINKABLE_PATHS[host]) {
      if (property === codeParamPlaceholder) continue;
      const fake = host === 'cam' ? null : nodeHost;
      assert.ok(linkTargets(host, fake).some((target) => target.path === property), `${host}.${property} is really linkable`);
    }
  }

  // The keyframe rows must agree with the timeline's own keyed-row table.
  for (const property of ['pivot.x', 'pivot.y', 'pivot.z', 'scale.x', 'scale.y', 'scale.z', 'roll', 'rotation.x', 'audio.volume']) {
    assert.ok(rowOf('el', property)?.keyable, `el.${property} is keyable`);
    assert.ok(KEYABLE_PATHS.el.includes(property));
  }
  t.diagnostic(`property catalog: ${PROPERTY_PATHS.length} rows `
    + `(${KEYABLE_PATHS.el.length}/${KEYABLE_PATHS.ob.length}/${KEYABLE_PATHS.cam.length} keyable, `
    + `${LINKABLE_PATHS.el.length}/${LINKABLE_PATHS.ob.length}/${LINKABLE_PATHS.cam.length} linkable)`);
});

test('the contract quotes the real defaults instead of re-typing them', (t) => {
  assert.equal(rowOf('el', 'pivot.x').default, DEFAULT_SPATIAL_NODE.pivot[0]);
  assert.equal(rowOf('el', 'pivot.y').default, DEFAULT_SPATIAL_NODE.pivot[1]);
  assert.equal(rowOf('el', 'scale.x').default, DEFAULT_SPATIAL_NODE.scale[0]);
  assert.equal(rowOf('el', 'scale.y').default, DEFAULT_SPATIAL_NODE.scale[1]);
  assert.equal(rowOf('el', 'roll').default, DEFAULT_SPATIAL_NODE.roll);
  assert.equal(rowOf('el', 'style.size').default, DEFAULT_STYLE.size);
  assert.equal(rowOf('el', 'style.color').default, DEFAULT_STYLE.color);
  assert.equal(rowOf('el', 'audio.volume').default, 1);

  // Camera rows must match core/templates.js for every channel it describes.
  const templates = new Map();
  for (const entry of Object.values(TEMPLATE_PROPERTIES)) {
    if (entry.channel?.path && !templates.has(entry.channel.path)) templates.set(entry.channel.path, entry);
  }
  const kindOf = { 1: 'scalar', 2: 'vec2', 3: 'vec3' };
  const unitOf = { m: 'm', '°': 'deg', Hz: 'hz', normalized: 'normalized' };
  let checked = 0;
  for (const [property, dims] of Object.entries(CAMERA_TRACK_DIMS)) {
    const kind = property === 'dof.enabled' ? 'boolean' : kindOf[dims];
    const template = templates.get(property);
    if (!template || template.channel.kind !== kind) continue;
    const row = rowOf('cam', property);
    assert.ok(row, `cam.${property} has a contract row`);
    assert.deepEqual(row.default, template.default, `cam.${property} default`);
    assert.equal(row.label, template.label, `cam.${property} label`);
    if (template.unit) assert.equal(row.unit, unitOf[template.unit], `cam.${property} unit`);
    checked += 1;
  }
  assert.ok(checked >= 12, `camera rows cross-checked against templates.js (${checked})`);
  t.diagnostic(`${checked} camera rows match core/templates.js labels, units and defaults`);
});

test('mcp/contracts.generated.json is the same contract, machine-readable', async (t) => {
  const raw = await fs.readFile(path.join(ROOT, 'mcp/contracts.generated.json'), 'utf8');
  const snapshot = JSON.parse(raw);
  assert.equal(snapshot.contractVersion, CONTRACT_VERSION);
  assert.equal(snapshot.generatedBy, 'scripts/gen-contracts.mjs');
  assert.deepEqual(Object.keys(snapshot.ops).sort(), [...PUBLIC_OPS].sort());
  assert.equal(snapshot.counts.publicOps, PUBLIC_OPS.length);
  assert.equal(snapshot.counts.opFields, PUBLIC_OPS.reduce((sum, op) => sum + OP_CONTRACTS[op].fields.length, 0));
  assert.equal(snapshot.counts.propertyPaths, PROPERTY_PATHS.length);
  assert.deepEqual(snapshot.editSchema, EDIT_SCHEMA);
  assert.deepEqual(snapshot.changesetApplySchema, CHANGESET_APPLY_SCHEMA);
  assert.equal(snapshot.propertyPaths.length, PROPERTY_PATHS.length);
  for (const row of PROPERTY_PATHS) {
    const found = snapshot.propertyPaths.find((entry) => entry.host === row.host && entry.path === row.path);
    assert.ok(found, `${row.host}.${row.path} is in the JSON snapshot`);
    assert.deepEqual(
      { keyable: found.keyable, linkable: found.linkable, unit: found.unit, default: found.default, kind: found.kind },
      { keyable: row.keyable, linkable: row.linkable, unit: row.unit, default: row.default, kind: row.kind },
      `${row.host}.${row.path} round-trips`,
    );
  }
  for (const op of PUBLIC_OPS) assert.equal(snapshot.ops[op].fields.length, OP_CONTRACTS[op].fields.length);
  t.diagnostic(`JSON snapshot: ${Object.keys(snapshot.ops).length} ops, ${snapshot.propertyPaths.length} paths, ${raw.length} bytes`);
});

test('gen-contracts --check is green clean and red after a hand edit', { timeout: 60000 }, async (t) => {
  const clean = await run(process.execPath, ['scripts/gen-contracts.mjs', '--check'], { cwd: ROOT });
  assert.match(clean.stdout, /契约生成物一致/);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-contracts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const file of GENERATED_FILES) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.copyFile(path.join(ROOT, file), path.join(dir, file));
  }
  const copied = await run(process.execPath, ['scripts/gen-contracts.mjs', '--check', '--root', dir], { cwd: ROOT });
  assert.match(copied.stdout, /契约生成物一致/, 'the copied tree is green before the edit');

  const target = path.join(dir, 'docs/AGENT-PROTOCOL.md');
  await fs.appendFile(target, '\n手改一行，应该被 --check 抓出来\n');
  const failure = await run(process.execPath, ['scripts/gen-contracts.mjs', '--check', '--root', dir], { cwd: ROOT })
    .then(() => null, (error) => error);
  assert.ok(failure, 'a hand-edited generated file must fail --check');
  assert.notEqual(failure.code, 0);
  assert.match(`${failure.stdout}\n${failure.stderr}`, /不一致/);
  assert.match(`${failure.stdout}\n${failure.stderr}`, /AGENT-PROTOCOL\.md/);
  t.diagnostic(`--check exit codes: clean ${clean ? 0 : '?'} / edited ${failure.code}`);
});

test('the generated protocol recommends current paths only', async (t) => {
  const protocol = await fs.readFile(path.join(ROOT, 'docs/AGENT-PROTOCOL.md'), 'utf8');
  const begin = protocol.indexOf('gen:legacy-begin');
  const end = protocol.indexOf('gen:legacy-end');
  assert.ok(begin > 0 && end > begin, 'the legacy block is marked so this test can find it');
  const outside = `${protocol.slice(0, begin)}\n${protocol.slice(end)}`;
  const stale = outside.match(/transform\.[A-Za-z.]+/g) || [];
  assert.deepEqual(stale, [], `transform.* must not be recommended any more (found ${stale.join(', ') || 'none'})`);

  // The block itself is not a recommendation: every row says what it is.
  for (const row of LEGACY_PATHS) {
    const line = protocol.split('\n').find((entry) => entry.startsWith(`| ${row.host} | ${row.path} |`));
    assert.ok(line, `${row.path} is listed in the legacy block`);
    assert.match(line, /已废弃|沿用旧名/, `${row.path} carries an explicit status`);
  }
  // Path names that never existed must not even be mentioned.
  assert.equal(protocol.includes('transform.roll'), false);
  assert.equal(protocol.includes('transform.x'), true, 'the deprecated block still documents the old names');
  // Generated-doc banner + the check command the reader can run.
  assert.match(protocol.slice(0, 500), /scripts\/gen-contracts\.mjs/);
  assert.match(protocol, /此段由 scripts\/gen-contracts\.mjs 生成，勿手改/);
  assert.match(protocol, /node scripts\/gen-contracts\.mjs --check/);
  assert.match(protocol, /已废弃（仅旧工程）/);
  t.diagnostic(`recommended sections: 0 transform.* / legacy block: ${(protocol.match(/transform\.[A-Za-z.]+/g) || []).length}`);
});
