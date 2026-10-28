import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SpatialMigrationError, migratedNodeAt, planSpatialMigration,
} from '../core/migrate-spatial.js';
import { createProject, validateProject } from '../core/schema.js';
import { legacyElementNode } from '../core/spatial.js';
import { screenCenterY } from '../core/space.js';

const CLI = fileURLToPath(new URL('../scripts/migrate-spatial.mjs', import.meta.url));
const near = (a, b, eps = 1e-9, msg = '') => {
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${msg}: expected arrays`);
    assert.equal(a.length, b.length, `${msg}: length`);
    a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
    return;
  }
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

const LIVE_KEYS = [
  { t: 0, path: 'transform.x', value: 0, ease: 'linear' },
  { t: 2, path: 'transform.x', value: 200 },
  { t: 0, path: 'transform.y', value: 0, ease: 'linear' },
  { t: 2, path: 'transform.y', value: 100 },
  { t: 0, path: 'transform.z', value: 0, ease: 'linear' },
  { t: 2, path: 'transform.z', value: 4 },
  { t: 0, path: 'transform.scale', value: 1, ease: 'linear' },
  { t: 2, path: 'transform.scale', value: 2 },
  { t: 0, path: 'transform.rotation', value: 0, ease: 'linear' },
  { t: 2, path: 'transform.rotation', value: 90 },
  { t: 0, path: 'transform.opacity', value: 1 },
  { t: 0, path: 'style.color', value: '#ff0000' },
  { t: 0, path: 'fx.glow', value: 0.2 },
  { t: 0, path: 'audio.volume', value: 0.1 },
];
const FREE_KEYS = [
  { t: 0, path: 'transform.scale', value: 0.5, ease: 'linear' },
  { t: 3, path: 'transform.scale', value: 1.5 },
  { t: 0, path: 'style.size', value: 48 },
];

/** Minimal valid element; the project builder below pushes these into createProject(). */
const element = (over = {}) => ({
  id: 'el_1',
  type: 'solid',
  start: 0,
  duration: 4,
  z: 0,
  transform: { x: 0, y: 0, z: 0, scale: 1, rotation: 0, opacity: 1 },
  style: {},
  fx: {},
  motion: { type: 'none', amount: 0 },
  keyframes: [],
  visible: true,
  meta: {},
  ...over,
});

function makeProject() {
  const p = createProject({ title: 'migrate-spatial', width: 1920, height: 1080, duration: 10 });
  p.elements.push(
    element({
      id: 'el_live',
      type: 'text',
      z: 2,
      parent: { id: '@live' },
      transform: { x: 200, y: -100, z: 1.5, scale: 2, rotation: 30, opacity: 1 },
      keyframes: structuredClone(LIVE_KEYS),
    }),
    element({
      id: 'el_free',
      z: 1,
      transform: { x: -50, y: 25, z: 0, scale: 0.5, rotation: -10, opacity: 1 },
      keyframes: structuredClone(FREE_KEYS),
    }),
    element({ id: 'el_tagged', z: 0, meta: { tags: ['intro'] } }),
  );
  assert.deepEqual(validateProject(p), [], 'test fixture must be valid before migration');
  return p;
}

const byId = (project, id) => project.elements.find((el) => el.id === id);
const pathsOf = (keys) => keys.map((key) => key.path);

test('migrate-spatial: preserve converts 2D transforms and keeps @live', () => {
  const source = makeProject();
  const before = JSON.stringify(source);
  const plan = planSpatialMigration(source, { mode: 'preserve' });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.stats.total, 3);
  assert.equal(plan.stats.converted, 3);
  assert.equal(plan.stats.fromScreenParent, 1);
  assert.equal(plan.stats.fromFree, 2);
  assert.equal(plan.stats.screenParentKept, 1);
  assert.equal(plan.stats.screenParentReleased, 0);
  assert.equal(plan.diff.exact, true, 'preserve is a data-level no-op');
  assert.equal(JSON.stringify(source), before, 'the source project is never mutated');

  const live = byId(plan.project, 'el_live');
  assert.equal(live.parent.id, '@live', 'preserve keeps the screen parent');
  assert.deepEqual(live.node.position, [0, 0, 0]);
  assert.deepEqual(live.node.dir, [0, 0, 1]);
  near(live.node.pivot, [2, screenCenterY(source.meta) + 1, 1.5], 1e-12, 'screenToWorld pivot');
  assert.equal(live.node.roll, 30, 'roll = transform.rotation (core/spatial.js)');
  assert.deepEqual(live.node.scale, [2, 2, 1], 'uniform scale expands to xyz');
  assert.deepEqual(live.transform, {
    x: 200, y: -100, z: 1.5, scale: 2, rotation: 30, opacity: 1,
  }, 'old transform is kept');
  assert.deepEqual(live.legacy.transform, live.transform);
  assert.deepEqual(live.legacy.keyframes, LIVE_KEYS, 'old keyframes are kept for rollback');
  assert.equal(live.legacy.parent, undefined, 'a kept parent needs no legacy copy');

  const free = byId(plan.project, 'el_free');
  near(free.node.pivot, [-0.5, screenCenterY(source.meta) - 0.25, 0], 1e-12);
  assert.equal(free.node.roll, -10);
  assert.deepEqual(free.node.scale, [0.5, 0.5, 1]);
  assert.equal(free.parent, undefined);
});

test('migrate-spatial: spatial keyframes move to node paths, non-spatial keys stay', () => {
  const plan = planSpatialMigration(makeProject(), { mode: 'preserve' });
  const live = byId(plan.project, 'el_live');
  const paths = pathsOf(live.keyframes);

  assert.deepEqual(paths.filter((p) => p === 'pivot.x').length, 2);
  assert.deepEqual(paths.filter((p) => p === 'pivot.y').length, 2);
  assert.deepEqual(paths.filter((p) => p === 'pivot.z').length, 2);
  assert.deepEqual(paths.filter((p) => p === 'scale.x').length, 2);
  assert.deepEqual(paths.filter((p) => p === 'scale.y').length, 2);
  assert.deepEqual(paths.filter((p) => p === 'roll').length, 2);
  for (const old of ['transform.x', 'transform.y', 'transform.z', 'transform.scale', 'transform.rotation']) {
    assert.ok(!paths.includes(old), `${old} should have moved`);
  }
  assert.ok(paths.includes('transform.opacity'), 'opacity is not a node field');
  assert.ok(paths.includes('style.color'));
  assert.ok(paths.includes('fx.glow'));
  assert.ok(paths.includes('audio.volume'));

  const px = live.keyframes.filter((k) => k.path === 'pivot.x').map((k) => k.value);
  const py = live.keyframes.filter((k) => k.path === 'pivot.y').map((k) => k.value);
  const pz = live.keyframes.filter((k) => k.path === 'pivot.z').map((k) => k.value);
  const sx = live.keyframes.filter((k) => k.path === 'scale.x').map((k) => k.value);
  const sy = live.keyframes.filter((k) => k.path === 'scale.y').map((k) => k.value);
  const roll = live.keyframes.filter((k) => k.path === 'roll').map((k) => k.value);
  near(px, [0, 2], 1e-12, 'x px -> m');
  near(py, [screenCenterY(makeProject().meta), screenCenterY(makeProject().meta) - 1], 1e-12, 'y px -> world y');
  near(pz, [0, 4], 1e-12, 'z is already metres');
  near(sx, [1, 2], 1e-12);
  near(sy, [1, 2], 1e-12);
  near(roll, [0, 90], 1e-12);
  assert.deepEqual(
    live.keyframes.find((k) => k.path === 'transform.opacity'),
    { t: 0, path: 'transform.opacity', value: 1 },
  );

  // Migration is exact at every key time when sampled back through the node.
  for (const t of [-1, 0, 0.5, 1, 2, 3, 4, 6]) {
    const oldNode = legacyElementNode(makeProject().elements[0], makeProject().meta, t);
    const newNode = migratedNodeAt(live, t);
    near(newNode.pivot, oldNode.pivot, 1e-9, `pivot @${t}`);
    near(newNode.scale, oldNode.scale, 1e-9, `scale @${t}`);
    near(newNode.roll, oldNode.roll, 1e-9, `roll @${t}`);
  }
  assert.equal(plan.stats.keyframes.total, LIVE_KEYS.length + FREE_KEYS.length);
  assert.equal(plan.stats.keyframes.kept, 5, '4 non-spatial live keys + 1 free style key');
  assert.equal(plan.stats.keyframes.rewritten, 12);
  assert.equal(plan.stats.keyframes.output, 12 + 4 + 4 + 1, 'scale duplicates on x/y; non-spatial kept');
});

test('migrate-spatial: world releases @live but keeps the old parent for rollback', () => {
  const plan = planSpatialMigration(makeProject(), { mode: 'world' });
  assert.deepEqual(plan.issues, []);
  const live = byId(plan.project, 'el_live');
  assert.equal(live.parent, undefined, 'screen lock removed');
  assert.deepEqual(live.legacy.parent, { id: '@live' }, 'old parent kept in legacy');
  assert.deepEqual(live.node.pivot, planSpatialMigration(makeProject(), { mode: 'preserve' })
    .project.elements.find((el) => el.id === 'el_live').node.pivot, 'the node itself is unchanged');
  assert.equal(plan.stats.screenParentReleased, 1);
  assert.equal(plan.stats.screenParentKept, 0);
  assert.equal(plan.stats.freeAfter, 3);
  assert.equal(plan.diff.exact, true);
});

test('migrate-spatial: hybrid only converts selected ids or tagged elements', () => {
  const source = makeProject();
  const plan = planSpatialMigration(source, { mode: 'hybrid', ids: ['el_free'] });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.stats.converted, 1);
  assert.equal(plan.stats.skipped, 2);
  assert.ok(byId(plan.project, 'el_free').node);
  for (const id of ['el_live', 'el_tagged']) {
    const el = byId(plan.project, id);
    assert.equal(el.node, undefined, `${id} keeps the old transform`);
    assert.equal(el.legacy, undefined);
  }
  const live = byId(plan.project, 'el_live');
  assert.equal(live.parent.id, '@live', 'hybrid keeps the screen parent of unselected elements');
  assert.deepEqual(live.keyframes, LIVE_KEYS, 'unselected keyframes are untouched');

  const tagged = planSpatialMigration(source, { mode: 'hybrid', tags: ['intro'] });
  assert.equal(tagged.stats.converted, 1);
  assert.ok(byId(tagged.project, 'el_tagged').node);
  assert.equal(byId(tagged.project, 'el_free').node, undefined);

  // A selected @live element converts but keeps its screen lock (world releases it).
  const selectedLive = planSpatialMigration(source, { mode: 'hybrid', ids: ['el_live'] });
  assert.ok(byId(selectedLive.project, 'el_live').node);
  assert.equal(byId(selectedLive.project, 'el_live').parent.id, '@live');

  assert.throws(() => planSpatialMigration(source, { mode: 'hybrid' }), SpatialMigrationError);
  assert.throws(() => planSpatialMigration(source, { mode: 'hybrid', ids: ['nope'] }), /unknown element id/);
  assert.throws(() => planSpatialMigration(source, { mode: 'hybrid', tags: ['missing'] }), /no element is tagged/);
  assert.throws(() => planSpatialMigration(source, { mode: 'nope' }), /unknown mode/);
});

test('migrate-spatial: old elements without node are idempotent, node elements are untouched', () => {
  const once = planSpatialMigration(makeProject(), { mode: 'preserve' });
  const twice = planSpatialMigration(once.project, { mode: 'preserve' });
  assert.deepEqual(twice.project, once.project, 'second preserve is a byte-for-byte no-op');
  assert.equal(twice.stats.converted, 0);
  assert.equal(twice.stats.alreadyNode, 3);
  assert.deepEqual(twice.issues, []);

  const worldOnce = planSpatialMigration(makeProject(), { mode: 'world' });
  const worldTwice = planSpatialMigration(worldOnce.project, { mode: 'world' });
  assert.deepEqual(worldTwice.project, worldOnce.project);
  assert.equal(worldTwice.stats.screenParentReleased, 0, 'nothing is released twice');
  assert.equal(worldTwice.stats.alreadyNode, 3);

  // preserve -> world releases an already-migrated element without touching its node.
  const released = planSpatialMigration(once.project, { mode: 'world' });
  assert.equal(released.stats.converted, 0);
  assert.equal(released.stats.screenParentReleased, 1);
  const live = byId(released.project, 'el_live');
  assert.equal(live.parent, undefined);
  assert.deepEqual(live.legacy.parent, { id: '@live' });
  assert.deepEqual(live.node, byId(once.project, 'el_live').node);
  assert.deepEqual(planSpatialMigration(once.project, { mode: 'preserve' }).project, once.project,
    'preserve does not touch an already-migrated project');
});

test('migrate-spatial: output validates in every mode', () => {
  for (const options of [
    { mode: 'preserve' },
    { mode: 'world' },
    { mode: 'hybrid', ids: ['el_live', 'el_free'] },
    { mode: 'hybrid', tags: ['intro'] },
  ]) {
    const plan = planSpatialMigration(makeProject(), options);
    assert.deepEqual(plan.issues, [], JSON.stringify(options));
    assert.deepEqual(validateProject(plan.project), [], JSON.stringify(options));
  }
});

test('migrate-spatial: dry-run CLI prints the plan and writes nothing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-migrate-dry-'));
  try {
    const input = path.join(tmp, 'project.vdm.json');
    const outDir = path.join(tmp, 'out');
    fs.writeFileSync(input, JSON.stringify(makeProject()));
    const result = runCli([
      '--in', input, '--out', path.join(outDir, 'project.vdm.json'), '--mode', 'preserve', '--dry-run',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.written, false);
    assert.equal(report.stats.total, 3);
    assert.equal(report.stats.converted, 3);
    assert.deepEqual(report.issues, []);
    assert.equal(report.diff.exact, true);
    assert.equal(fs.existsSync(outDir), false, 'dry-run creates no output directory');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrate-spatial: CLI writes a validated project and never overwrites by default', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-migrate-write-'));
  try {
    const input = path.join(tmp, 'project.vdm.json');
    const out = path.join(tmp, 'out', 'project.vdm.json');
    fs.writeFileSync(input, JSON.stringify(makeProject()));

    const first = runCli(['--in', input, '--out', out, '--mode', 'world']);
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.written, true);
    assert.equal(fs.existsSync(out), true);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(validateProject(written), []);
    assert.equal(byId(written, 'el_live').parent, undefined);
    assert.deepEqual(byId(written, 'el_live').legacy.parent, { id: '@live' });

    const second = runCli(['--in', input, '--out', out, '--mode', 'world']);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/);

    const forced = runCli(['--in', input, '--out', out, '--mode', 'world', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), written);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrate-spatial: CLI resolves project and output directories', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-migrate-dirs-'));
  try {
    const inputDir = path.join(tmp, 'in-project');
    const outDir = path.join(tmp, 'out-project');
    fs.mkdirSync(inputDir);
    fs.writeFileSync(path.join(inputDir, 'project.vdm.json'), JSON.stringify(makeProject()));
    const result = runCli(['--in', inputDir, '--out', outDir, '--mode', 'preserve']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.input, path.join(inputDir, 'project.vdm.json'));
    assert.equal(report.output, path.join(outDir, 'project.vdm.json'));
    assert.equal(report.written, true);
    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'project.vdm.json'), 'utf8'));
    assert.deepEqual(validateProject(written), []);
    assert.ok(byId(written, 'el_live').node);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrate-spatial: failed input never writes the target', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-migrate-fail-'));
  try {
    const input = path.join(tmp, 'project.vdm.json');
    const out = path.join(tmp, 'out', 'project.vdm.json');

    // validateProject() accepts any scalar key value, so this fails inside the
    // converter after the input was read (and must still write nothing).
    const bad = makeProject();
    bad.elements[0].keyframes = [{ t: 0, path: 'transform.x', value: 'not-a-number' }];
    assert.deepEqual(validateProject(bad), [], 'the bad value passes shape validation');
    fs.writeFileSync(input, JSON.stringify(bad));
    const failed = runCli(['--in', input, '--out', out, '--mode', 'preserve']);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /expected a finite number/);
    assert.equal(fs.existsSync(out), false);

    // A typo in --ids is a hard error as well.
    fs.writeFileSync(input, JSON.stringify(makeProject()));
    const unknown = runCli(['--in', input, '--out', out, '--mode', 'hybrid', '--ids', 'nope']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown element id/);
    assert.equal(fs.existsSync(out), false);

    // And a real project path is refused even on a valid plan.
    const guarded = path.join(tmp, 'projects', 'demo', 'project.vdm.json');
    const blocked = runCli(['--in', input, '--out', guarded, '--mode', 'preserve']);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /refusing to write under projects\//);
    assert.equal(fs.existsSync(guarded), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const MIKU_CANDIDATES = [
  new URL('../.tmp/fixtures/miku-round3/project.vdm.json', import.meta.url),
  new URL('../../../../.tmp/fixtures/miku-round3/project.vdm.json', import.meta.url),
].map((url) => fileURLToPath(url));
const mikuFile = MIKU_CANDIDATES.find((file) => fs.existsSync(file));

test('migrate-spatial: miku fixture keeps 47 @live and converts 134 (47 locked + 87 free)', {
  skip: mikuFile ? false : 'miku-round3 fixture not present',
}, () => {
  const project = JSON.parse(fs.readFileSync(mikuFile, 'utf8'));
  const preserve = planSpatialMigration(project, { mode: 'preserve' });
  assert.equal(preserve.stats.total, 134);
  assert.equal(preserve.stats.converted, 134);
  assert.equal(preserve.stats.fromScreenParent, 47);
  assert.equal(preserve.stats.fromFree, 87);
  assert.equal(preserve.stats.screenParentKept, 47);
  assert.equal(preserve.stats.screenParentReleased, 0);
  assert.equal(preserve.project.elements.filter((el) => el.parent?.id === '@live').length, 47);
  assert.equal(preserve.project.elements.filter((el) => !el.node).length, 0);
  assert.equal(preserve.project.elements.filter((el) => !el.legacy?.transform).length, 0);
  assert.deepEqual(preserve.issues, []);
  assert.equal(preserve.diff.exact, true);
  assert.ok(preserve.diff.maxPivot < 1e-9);

  const world = planSpatialMigration(project, { mode: 'world' });
  assert.equal(world.stats.converted, 134);
  assert.equal(world.stats.screenParentReleased, 47);
  assert.equal(world.stats.screenParentKept, 0);
  assert.equal(world.project.elements.filter((el) => el.parent?.id === '@live').length, 0);
  assert.equal(world.project.elements.filter((el) => el.legacy?.parent?.id === '@live').length, 47);
  assert.deepEqual(world.issues, []);
  assert.equal(world.diff.exact, true);
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}
