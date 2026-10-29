import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_LINK_DEPTH, cameraValueWithLinks, elementOverlay, findLinkTarget, linkContribution,
  linkIssues, linkTargets, normalizeHostKind, normalizeLink, normalizeLinks,
  objectPoseWithLinks, projectLinkIssues, resolveEffectiveValue, resolveLocalValue,
  wouldLinkCycle, writeBackLocalValue,
} from '../core/links.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';
import { evalElement, motionDelta } from '../core/evaluate.js';
import { legacyElementNode } from '../core/spatial.js';
import { basisFromDir, objectPose } from '../core/scene.js';
import { cameraParamValue } from '../core/camera.js';
import { screenCenterY } from '../core/space.js';
import { PUBLIC_OPS, EDIT_SCHEMA } from '../core/contracts.js';
import { validateContract } from '../application/validate-contract.js';
import { projectService } from '../engine/projects.js';

const meta = { width: 1920, height: 1080 };
const near = (a, b, eps = 1e-6, msg = '') => {
  assert.ok(Number.isFinite(a), `${msg}: ${a} is not finite`);
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};
const linkOp = (id, to, from, extra = {}) => ({ op: 'propLink', id, to, from, t: 0, ...extra });

const fresh = (opts = {}) => normalizeProject(createProject({ title: 'links', duration: 8, ...opts }));

function addEl(p, over = {}) {
  return applyOp(p, { op: 'addElement', element: { type: 'solid', duration: 8, ...over } }).element;
}

function addObj(p, over = {}) {
  const result = applyOp(p, { op: 'objectAdd', object: { type: 'empty', start: 0, duration: 8, ...over } });
  return p.scene.objects.find((o) => o.id === result.changed[0]);
}

function addCam(p, over = {}) {
  const result = applyOp(p, {
    op: 'addCamera',
    camera: { name: 'cam', path: [{ t: 0, pos: [0, screenCenterY(meta), 20], look: [0, screenCenterY(meta), 0] }], ...over },
  });
  return result.camera;
}

test('links: add combine follows the parent local value with a bind offset', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a', pivot: [0, 10, 0] });
  const b = addObj(p, { id: 'ob_b' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'pivot', t: 0, v: [0, 0, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'pivot', t: 2, v: [100, 0, 0] });
  const { link } = applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }));

  assert.equal(a.links.length, 1);
  assert.equal(link.id, 'lnk_1');
  assert.equal(link.combine, 'add');
  assert.equal(link.bindParentValue, 0);
  assert.deepEqual(link.from, { host: 'ob', id: 'ob_b', path: 'pivot.x' });
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 0), 10, 1e-9, 'bind time');
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 1), 60, 1e-9, 'local + parent');
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 2), 110, 1e-9, 'end');
  near(resolveLocalValue(p, 'ob_a', 'pivot.y', 1), 10, 1e-9, 'the local value never moves');
  near(linkContribution(p, 'ob_a', link, 1), 50, 1e-9, 'contribution = parent − bind');

  // A.Y <- A.X: same host, another property path.
  const c = addObj(p, { id: 'ob_c', pivot: [0, 5, 0] });
  applyOp(p, { op: 'objectKey', id: 'ob_c', path: 'pivot.x', t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_c', path: 'pivot.x', t: 2, v: 10 });
  applyOp(p, linkOp('ob_c', 'pivot.y', { host: 'ob', id: 'ob_c', path: 'pivot.x' }, { t: 0 }));
  near(resolveEffectiveValue(p, 'ob_c', 'pivot.y', 1), 10, 1e-9, 'self host link');
  near(resolveEffectiveValue(p, 'ob_c', 'pivot.x', 1), 5, 1e-9, 'the source path stays local');
  assert.equal(validateProject(p).length, 0);
});

test('links: mul combine scales by the parent ratio (scale / percentage)', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a', scale: [3, 3, 3] });
  const b = addObj(p, { id: 'ob_b', scale: [2, 2, 2] });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'scale.y', t: 0, v: 2, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'scale.y', t: 2, v: 4 });
  const { link } = applyOp(p, linkOp('ob_a', 'scale.x', { host: 'ob', id: 'ob_b', path: 'scale.y' }));

  assert.equal(link.combine, 'mul', 'ratios default to mul');
  near(link.bindParentValue, 2, 1e-9);
  near(resolveEffectiveValue(p, 'ob_a', 'scale.x', 0), 3, 1e-9, 'local × 2/2');
  near(resolveEffectiveValue(p, 'ob_a', 'scale.x', 1), 4.5, 1e-9, 'local × 3/2');
  near(resolveEffectiveValue(p, 'ob_a', 'scale.x', 2), 6, 1e-9, 'local × 4/2');
  near(writeBackLocalValue(p, 'ob_a', 'scale.x', 2, 9), 4.5, 1e-9, 'effective / ratio');
  assert.equal(findLinkTarget('ob', a, 'opacity').combine, 'mul');
  assert.equal(findLinkTarget('ob', a, 'pivot.z').combine, 'add');
});

test('links: binding stores the parent value at t and never jumps the value', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a', pivot: [0, 10, 0] });
  const b = addObj(p, { id: 'ob_b' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'pivot', t: 0, v: [0, 0, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'pivot', t: 2, v: [100, 0, 0] });
  const { link } = applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }, { t: 1 }));

  near(link.bindParentValue, 50, 1e-6, 'parent value at bind');
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 1), 10, 1e-5, 'bind is a no-op at t');
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 0), -40, 1e-5, 'before the bind');
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 2), 60, 1e-5, 'after the bind');

  // An explicit bindParentValue is respected and does not touch the local value.
  const d = addObj(p, { id: 'ob_d', pivot: [0, 10, 0] });
  const explicit = applyOp(p, linkOp('ob_d', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }, { t: 1, bindParentValue: 0 }));
  assert.equal(explicit.link.bindParentValue, 0);
  near(resolveEffectiveValue(p, 'ob_d', 'pivot.y', 1), 60, 1e-9);
  near(resolveLocalValue(p, 'ob_d', 'pivot.y', 1), 10, 1e-9);
});

test('links: chains compose through the parent link, not through the local value', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a' });
  const b = addObj(p, { id: 'ob_b' });
  const c = addObj(p, { id: 'ob_c' });
  applyOp(p, { op: 'objectKey', id: 'ob_a', path: 'pivot.z', t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_a', path: 'pivot.z', t: 2, v: 4 });
  applyOp(p, linkOp('ob_b', 'pivot.x', { host: 'ob', id: 'ob_a', path: 'pivot.z' }));
  applyOp(p, linkOp('ob_c', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }));

  near(resolveEffectiveValue(p, 'ob_b', 'pivot.x', 1), 2, 1e-9, 'first link');
  near(resolveEffectiveValue(p, 'ob_c', 'pivot.y', 1), 2, 1e-9, 'chained link');
  near(resolveLocalValue(p, 'ob_b', 'pivot.x', 1), 0, 1e-9, 'the middle local value is still 0');
  near(linkContribution(p, 'ob_c', c.links[0], 1), 2, 1e-9, 'contribution reads the parent effective value');
  assert.equal(wouldLinkCycle(p, 'ob_c', 'pivot.z', { host: 'ob', id: 'ob_b', path: 'pivot.x' }), false);
  assert.equal(validateProject(p).length, 0);
});

test('links: cycles are refused by propLink and reported by validation', () => {
  const p = fresh();
  addObj(p, { id: 'ob_a' });
  addObj(p, { id: 'ob_b' });
  applyOp(p, linkOp('ob_a', 'pivot.x', { host: 'ob', id: 'ob_b', path: 'pivot.y' }));
  assert.equal(wouldLinkCycle(p, 'ob_b', 'pivot.y', { host: 'ob', id: 'ob_a', path: 'pivot.x' }), true);
  assert.throws(() => applyOp(p, linkOp('ob_b', 'pivot.y', { host: 'ob', id: 'ob_a', path: 'pivot.x' })), /cycle/);
  assert.throws(() => applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_a', path: 'pivot.y' })), /cycle/, 'self path');

  // Two paths on one host are fine; closing them is not.
  const d = addObj(p, { id: 'ob_d' });
  applyOp(p, linkOp('ob_d', 'pivot.y', { host: 'ob', id: 'ob_d', path: 'pivot.x' }));
  assert.throws(() => applyOp(p, linkOp('ob_d', 'pivot.x', { host: 'ob', id: 'ob_d', path: 'pivot.y' })), /cycle/);

  // Hand-written cycle -> validateProject reports it instead of looping.
  const raw = JSON.parse(JSON.stringify(p));
  const a = raw.scene.objects.find((o) => o.id === 'ob_a');
  a.links.push({ id: 'lnk_9', to: 'pivot.z', from: { host: 'ob', id: 'ob_b', path: 'pivot.z' }, combine: 'add', bindParentValue: 0, enabled: true });
  const b = raw.scene.objects.find((o) => o.id === 'ob_b');
  b.links = [{ id: 'lnk_8', to: 'pivot.z', from: { host: 'ob', id: 'ob_a', path: 'pivot.z' }, combine: 'add', bindParentValue: 0, enabled: true }];
  assert.ok(validateProject(raw).some((issue) => /cycle/.test(issue.msg)));
});

test('links: a missing or disabled parent falls back to the local value', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a', pivot: [0, 10, 0] });
  const b = addObj(p, { id: 'ob_b', pivot: [5, 0, 0] });
  applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }));
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 0), 10, 1e-9, 'bind is a no-op');
  applyOp(p, { op: 'propLinkPatch', id: 'ob_a', to: 'pivot.y', patch: { enabled: false } });
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 0), 10, 1e-9, 'disabled link');
  near(writeBackLocalValue(p, 'ob_a', 'pivot.y', 0, 42), 42, 1e-9, 'inverting a disabled link is a passthrough');
  applyOp(p, { op: 'propLinkPatch', id: 'ob_a', to: 'pivot.y', patch: { enabled: true } });

  p.scene.objects = p.scene.objects.filter((o) => o.id !== 'ob_b');
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 0), 10, 1e-9, 'dangling link falls back');
  assert.ok(validateProject(p).some((issue) => /unknown host/.test(issue.msg)));
});

test('links: @live and camera position are never link targets', () => {
  const p = fresh();
  const a = addEl(p, { id: 'el_a' });
  const ob = addObj(p, { id: 'ob_a' });
  const cam = addCam(p);

  assert.equal(findLinkTarget('cam', cam, 'position.x'), null);
  assert.ok(findLinkTarget('cam', cam, 'pivot.x'));
  assert.ok(findLinkTarget('cam', cam, 'fov'));
  assert.equal(resolveLocalValue(p, 'cam', 'position.x', 0), null);
  assert.throws(() => applyOp(p, linkOp('el_a', 'pivot.x', { host: 'el', id: '@live', path: 'pivot.x' })), /@live/);
  assert.throws(() => applyOp(p, linkOp(cam.id, 'position.x', { host: 'el', id: 'el_a', path: 'pivot.x' })), /camera position/);
  assert.throws(() => applyOp(p, linkOp('ob_a', 'pivot.x', { host: 'cam', id: cam.id, path: 'position.x' })), /camera position/);
  // angle -> angle is allowed: camera fov drives an element roll.
  const { link } = applyOp(p, linkOp('el_a', 'roll', { host: 'cam', id: cam.id, path: 'fov' }));
  assert.equal(link.from.host, 'cam');
  assert.equal(link.from.path, 'fov');

  const bad = linkIssues([{
    id: 'lnk_1', to: 'pivot.x', from: { host: 'el', id: '@live', path: 'pivot.x' },
    combine: 'add', bindParentValue: 0, enabled: true,
  }], 'l');
  assert.ok(bad.some((issue) => issue.path === 'l[0].from.id'));
  assert.ok(projectLinkIssues({ elements: [{ id: 'el_1', type: 'solid', links: [] }] }).length === 0);
  assert.equal(ob.links, undefined);
});

test('links: editing the effective value writes back the local value', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a', pivot: [0, 10, 0] });
  const b = addObj(p, { id: 'ob_b' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'pivot', t: 0, v: [0, 0, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'pivot', t: 2, v: [100, 0, 0] });
  applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }));

  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 1), 60, 1e-9);
  near(writeBackLocalValue(p, 'ob_a', 'pivot.y', 1, 80), 30, 1e-9, '80 − (50 − 0)');
  applyOp(p, { op: 'objectPatch', id: 'ob_a', patch: { pivot: [0, 30, 0] } });
  near(resolveLocalValue(p, 'ob_a', 'pivot.y', 1), 30, 1e-9);
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 1), 80, 1e-9, 'edited effective value');

  // An unlinked property passes through unchanged; an unknown path is null.
  near(writeBackLocalValue(p, 'ob_a', 'pivot.z', 1, 4), 4, 1e-9);
  assert.equal(writeBackLocalValue(p, 'ob_a', 'not.a.path', 1, 4), null);
  assert.equal(resolveEffectiveValue(p, 'ob_a', 'not.a.path', 1), null);
});

test('links: ops upsert by target, keep the value when re-parenting and undo cleanly', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a', pivot: [0, 10, 0] });
  const b = addObj(p, { id: 'ob_b' });
  const c = addObj(p, { id: 'ob_c', pivot: [50, 0, 0] });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'pivot', t: 0, v: [0, 0, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'pivot', t: 2, v: [100, 0, 0] });

  const first = applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }));
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 2), 110, 1e-9);
  const second = applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_c', path: 'pivot.x' }, { t: 2 }));

  assert.equal(a.links.length, 1, 'upsert keeps one link per target');
  assert.equal(second.link.id, first.link.id, 'upsert keeps the link id');
  assert.deepEqual(second.link.from, { host: 'ob', id: 'ob_c', path: 'pivot.x' });
  near(second.link.bindParentValue, 50, 1e-9, 'rebind parent value');
  near(resolveLocalValue(p, 'ob_a', 'pivot.y', 2), 110, 1e-9, 'the old effective value is baked into the local value at bind');
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 2), 110, 1e-9, 'no jump at bind');

  // Repeating the same op is idempotent (no second rebind, same bind value).
  const again = applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_c', path: 'pivot.x' }, { t: 2 }));
  near(again.link.bindParentValue, 50, 1e-9);
  assert.equal(a.links.length, 1);

  // propLinkPatch: combine switches rebind and keep the current value.
  applyOp(p, { op: 'objectKey', id: 'ob_c', path: 'pivot.x', t: 0, v: 50, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_c', path: 'pivot.x', t: 4, v: 100 });
  const patched = applyOp(p, { op: 'propLinkPatch', id: 'ob_a', to: 'pivot.y', patch: { combine: 'mul' }, t: 0 });
  assert.equal(patched.link.combine, 'mul');
  near(patched.link.bindParentValue, 50, 1e-9);
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 0), 110, 1e-9, 'combine switch keeps the value at bind');
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 4), 220, 1e-9, 'local × 100/50');

  // from patch re-parents and keeps the value too.
  const cam = addCam(p, { center: [7, 0, 0] });
  const moved = applyOp(p, { op: 'propLinkPatch', id: 'ob_a', to: 'pivot.y', patch: { combine: 'add', from: { host: 'cam', id: cam.id, path: 'pivot.x' } }, t: 4 });
  assert.deepEqual(moved.link.from, { host: 'cam', id: cam.id, path: 'pivot.x' });
  near(moved.link.bindParentValue, 7, 1e-9);
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 4), 220, 1e-6, 'value preserved across hosts');

  assert.throws(() => applyOp(p, { op: 'propLinkPatch', id: 'ob_a', to: 'pivot.y', patch: { nope: 1 } }), /cannot patch/);
  assert.throws(() => applyOp(p, { op: 'propLinkPatch', id: 'ob_a', to: 'pivot.z', patch: { enabled: false } }), /no property link/);
  assert.throws(() => applyOp(p, linkOp('ob_a', 'pivot.z', { host: 'ob', id: 'ob_c', path: 'scale.x' })), /units differ/);

  // Unlink drops only the link: the local value (already baked) stays.
  applyOp(p, { op: 'propUnlink', id: 'ob_a', to: 'pivot.y' });
  assert.equal('links' in a, false);
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 4), 220, 1e-9, 'unlink keeps the local value');
  assert.deepEqual(applyOp(p, { op: 'propUnlink', id: 'ob_a', to: 'pivot.y' }).changed, []);

  // A keyed child gets a key at the bind time instead of a new base value.
  const keyed = addObj(p, { id: 'ob_keyed', pivot: [0, 3, 0] });
  applyOp(p, { op: 'objectKey', id: 'ob_keyed', path: 'pivot', t: 0, v: [0, 3, 0], ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_keyed', path: 'pivot', t: 2, v: [0, 9, 0] });
  applyOp(p, linkOp('ob_keyed', 'pivot.x', { host: 'ob', id: 'ob_b', path: 'pivot.x' }, { t: 0 }));
  near(resolveEffectiveValue(p, 'ob_keyed', 'pivot.x', 1), 50, 1e-9);
  applyOp(p, linkOp('ob_keyed', 'pivot.x', { host: 'ob', id: 'ob_c', path: 'pivot.x' }, { t: 1 }));
  near(resolveLocalValue(p, 'ob_keyed', 'pivot.x', 1), 50, 1e-9, 'the effective value became a key at t');
  assert.ok((keyed.tracks.pivot || []).some((k) => Math.abs(k.t - 1) < 1e-4), 'a key was inserted at the bind time');
  near(resolveEffectiveValue(p, 'ob_keyed', 'pivot.x', 1), 50, 1e-6, 'no jump after the keyed rebind');
  assert.equal(validateProject(p).length, 0);
});

test('links: schema keeps links on elements, objects and cameras without creating them', () => {
  const p = fresh();
  const a = addEl(p, { id: 'el_a' });
  const b = addEl(p, { id: 'el_b', transform: { x: 100 } });
  applyOp(p, linkOp('el_a', 'pivot.x', { host: 'el', id: 'el_b', path: 'pivot.x' }));
  const o1 = addObj(p, { id: 'ob_a' });
  const o2 = addObj(p, { id: 'ob_b', pivot: [2, 0, 0] });
  applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }));
  const cam = addCam(p);
  applyOp(p, linkOp(cam.id, 'roll', { host: 'ob', id: 'ob_b', path: 'roll' }));

  // Loading keeps every link and does not invent one.
  const q = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(q.elements.find((e) => e.id === 'el_a').links, a.links);
  assert.deepEqual(q.scene.objects.find((o) => o.id === 'ob_a').links, o1.links);
  assert.deepEqual(q.cameras.find((c) => c.id === cam.id).links, cam.links);
  assert.equal('links' in q.elements.find((e) => e.id === 'el_b'), false);
  assert.equal('links' in q.scene.objects.find((o) => o.id === 'ob_b'), false);
  assert.equal('links' in q.cameras.find((c) => c.id === cam.id), true);
  assert.deepEqual(validateProject(q), []);
  // A link-free project round-trips byte for byte.
  const clean = fresh();
  addEl(clean, { id: 'el_x' });
  const snapshot = JSON.stringify(clean);
  normalizeProject(clean);
  assert.equal(JSON.stringify(clean), snapshot);

  // addElement / updateElement carry links through the same validation.
  const c = addEl(p, {
    id: 'el_c',
    links: [{ id: 'lnk_9', to: 'pivot.x', from: { host: 'ob', id: 'ob_b', path: 'pivot.x' }, combine: 'add', bindParentValue: 2, enabled: true }],
  });
  assert.equal(c.links.length, 1);
  assert.equal(c.links[0].id, 'lnk_9');
  applyOp(p, { op: 'updateElement', id: 'el_c', patch: { links: [] } });
  assert.equal('links' in c, false);
  assert.throws(() => addEl(p, { links: 'nope' }), /links must be an array/);

  // Shape + graph validation on hand-edited data.
  const bad = JSON.parse(JSON.stringify(p));
  const badEl = bad.elements.find((e) => e.id === 'el_a');
  delete badEl.node; // a legacy 2D element (addElement now creates nodes)
  badEl.links[0].to = 'position.x'; // legacy elements have no position.*
  assert.ok(validateProject(bad).some((issue) => issue.path.endsWith('.links[0].to')));
  assert.ok(linkIssues([{ id: '' }], 'l').some((issue) => issue.path === 'l[0].id'));
  assert.ok(linkIssues([{ id: 'x', to: 'pivot.x', from: { host: 'el', id: 'el_1', path: 'pivot.x' }, combine: 'pow', bindParentValue: 0 }], 'l')
    .some((issue) => issue.path === 'l[0].combine'));
  assert.deepEqual(normalizeLinks([{ ...a.links[0] }, 'junk']).length, 1);
  assert.throws(() => normalizeLinks([{ ...a.links[0] }, { ...a.links[0] }], { strict: true }), /duplicate/);
});

test('links: deleting a host severs its readers, it never bakes the link', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a', pivot: [0, 2, 0] });
  const b = addObj(p, { id: 'ob_b', pivot: [3, 0, 0] });
  applyOp(p, linkOp('ob_a', 'pivot.y', { host: 'ob', id: 'ob_b', path: 'pivot.x' }));
  applyOp(p, { op: 'objectRemove', id: 'ob_b' });
  assert.equal('links' in a, false);
  near(resolveEffectiveValue(p, 'ob_a', 'pivot.y', 0), 2, 1e-9, 'local value kept');
  near(resolveLocalValue(p, 'ob_a', 'pivot.y', 0), 2, 1e-9);

  const elA = addEl(p, { id: 'el_a' });
  addEl(p, { id: 'el_b' });
  applyOp(p, linkOp('el_a', 'pivot.x', { host: 'el', id: 'el_b', path: 'pivot.x' }));
  applyOp(p, { op: 'removeElement', id: 'el_b' });
  assert.equal('links' in elA, false);

  const child = addObj(p, { id: 'ob_c' });
  const cam = addCam(p);
  applyOp(p, linkOp('ob_c', 'opacity', { host: 'cam', id: cam.id, path: 'opacity' }));
  applyOp(p, { op: 'removeCamera', id: cam.id });
  assert.equal('links' in child, false);
  assert.deepEqual(validateProject(p), []);
});

test('links: 2D element paths match the legacy node model', () => {
  const p = fresh();
  const a = addEl(p, { id: 'el_a', transform: { x: 0, y: 100 } });
  const b = addEl(p, { id: 'el_b' });
  delete a.node; delete b.node; // legacy 2D elements (addElement now creates nodes)
  applyOp(p, { op: 'keySet', id: 'el_b', path: 'transform.x', t: 0, value: 0, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: 'el_b', path: 'transform.x', t: 2, value: 200 });

  // The readers derive exactly the node core/spatial.js derives from transform.
  for (const t of [0, 0.75, 2]) {
    const node = legacyElementNode(b, meta, t);
    near(resolveLocalValue(p, 'el_b', 'pivot.x', t), node.pivot[0], 1e-12, `pivot.x @${t}`);
    near(resolveLocalValue(p, 'el_b', 'pivot.y', t), node.pivot[1], 1e-12, `pivot.y @${t}`);
    near(resolveLocalValue(p, 'el_b', 'pivot.z', t), node.pivot[2], 1e-12, `pivot.z @${t}`);
    near(resolveLocalValue(p, 'el_b', 'roll', t), node.roll, 1e-12, `roll @${t}`);
    near(resolveLocalValue(p, 'el_b', 'scale.x', t), node.scale[0], 1e-12, `scale.x @${t}`);
  }
  assert.equal(screenCenterY(meta), 5.4);

  applyOp(p, linkOp('el_a', 'pivot.y', { host: 'el', id: 'el_b', path: 'pivot.x' }));
  near(resolveEffectiveValue(p, 'el_a', 'pivot.y', 1), 5.4, 1e-9, '4.4 m local + 1 m parent');
  const overlay = elementOverlay(p, a, 1);
  near(overlay.y, 0, 1e-9, '100 px local + 100 px parent = screen centre');
  assert.equal('x' in overlay, false, 'only linked fields are overlaid');
  assert.equal(overlay.scale, undefined, 'unlinked fields are not overlaid');

  // evalElement applies the overlay before the motion preset (local → links → motion).
  applyOp(p, { op: 'updateElement', id: 'el_a', patch: { motion: { type: 'up', amount: 1 } } });
  const st = evalElement(a, 1, meta, elementOverlay(p, a, 1));
  near(st.y, overlay.y + motionDelta(a, 1, meta).y, 1e-9, 'motion layers on top');
  near(st.scale, evalElement(a, 1, meta).scale, 1e-9, 'untouched fields keep the local eval');

  // A keyed local value is preserved and the link still adds on top.
  applyOp(p, { op: 'keySet', id: 'el_a', path: 'transform.y', t: 0, value: 100, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: 'el_a', path: 'transform.y', t: 2, value: 200 });
  near(resolveEffectiveValue(p, 'el_a', 'pivot.y', 1), 4.9, 1e-9, 'keyed local 150 px = 3.9 m + 1 m');
  near(elementOverlay(p, a, 1).y, 50, 1e-9);

  // Legacy elements cannot link position.* / scale.z (uniform scale, no node yet).
  assert.equal(findLinkTarget('el', a, 'position.x'), null);
  assert.equal(findLinkTarget('el', a, 'scale.z'), null);
  assert.throws(() => applyOp(p, linkOp('el_a', 'position.x', { host: 'el', id: 'el_b', path: 'pivot.x' })), /no linkable property/);
  near(writeBackLocalValue(p, 'el_a', 'pivot.y', 1, 5.9), 4.9, 1e-9, 'legacy write-back in metres');
});

test('links: migrated node elements expose the full node model and key the write-back', () => {
  const p = fresh();
  const a = addEl(p, { id: 'el_node' });
  // (addElement keeps links but not `node`: a migrated element is written by
  // the upgrade path, so model one here.)
  a.node = { pivot: [1, 2, 3], position: [0, 0, 0], dir: [0, 0, 1], roll: 10, scale: [2, 2, 1] };
  const other = addEl(p, { id: 'el_other' });
  applyOp(p, { op: 'keySet', id: 'el_node', path: 'pivot.z', t: 0, value: 3, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: 'el_node', path: 'pivot.z', t: 2, value: 5 });
  near(resolveLocalValue(p, 'el_node', 'pivot.z', 1), 4, 1e-9, 'node keyframe');
  near(resolveLocalValue(p, 'el_node', 'roll', 0), 10, 1e-9, 'node base value');
  assert.ok(findLinkTarget('el', a, 'position.x'), 'node elements can link position.*');
  assert.ok(findLinkTarget('el', a, 'scale.z'), 'node elements link scale.z');

  const o1 = addObj(p, { id: 'ob_p', pivot: [0, 0, 0] });
  applyOp(p, linkOp('el_node', 'pivot.z', { host: 'ob', id: 'ob_p', path: 'pivot.z' }));
  near(resolveEffectiveValue(p, 'el_node', 'pivot.z', 1), 4, 1e-9);
  const o2 = addObj(p, { id: 'ob_q', pivot: [0, 0, 8] });
  applyOp(p, linkOp('el_node', 'pivot.z', { host: 'ob', id: 'ob_q', path: 'pivot.z' }, { t: 1 }));
  near(resolveEffectiveValue(p, 'el_node', 'pivot.z', 1), 4, 1e-9, 'rebind keeps the value');
  const keyAtOne = a.keyframes.find((k) => k.path === 'pivot.z' && Math.abs(k.t - 1) < 1e-4);
  assert.ok(keyAtOne, 'rebinding a keyed node path inserts a key at t');
  near(keyAtOne.value, 4, 1e-9);

  // Ratio link from a 3D object scale into the node scale.
  applyOp(p, linkOp('el_node', 'scale.x', { host: 'ob', id: 'ob_q', path: 'scale.x' }));
  near(resolveEffectiveValue(p, 'el_node', 'scale.x', 0), 2, 1e-9, 'mul bind is a no-op');
  const overlay = elementOverlay(p, a, 1);
  assert.equal(overlay, null, 'node elements are read through the node model, not the legacy overlay');
  assert.equal(validateProject(p).length, 0);
  assert.equal(other.links, undefined);
});

test('links: pose and camera bridges expose the effective values', () => {
  const p = fresh();
  const a = addObj(p, { id: 'ob_a', pivot: [1, 0, 0], rot: { dir: [0, 0, -1], roll: 0 } });
  const b = addObj(p, { id: 'ob_b', rot: { dir: [0, 0, -1], roll: 0 } });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'roll', t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_b', path: 'roll', t: 2, v: 40 });
  applyOp(p, linkOp('ob_a', 'roll', { host: 'ob', id: 'ob_b', path: 'roll' }));

  const pose = objectPoseWithLinks(p, a, 1);
  near(pose.roll, 20, 1e-9);
  const basis = basisFromDir(pose.dir, pose.roll);
  near(pose.basis.right[0], basis.right[0], 1e-9);
  near(objectPose(a, 1).roll, 0, 1e-9, 'the source pose is not mutated');

  const c = addObj(p, { id: 'ob_c' });
  applyOp(p, { op: 'objectKey', id: 'ob_c', path: 'pivot.x', t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_c', path: 'pivot.x', t: 2, v: 5 });
  applyOp(p, linkOp('ob_a', 'pivot.x', { host: 'ob', id: 'ob_c', path: 'pivot.x' }));
  near(objectPoseWithLinks(p, a, 2).pivot[0], 6, 1e-9, 'pivot link moves the world position');

  const cam = addCam(p, { center: [0, 0, 0] });
  applyOp(p, linkOp(cam.id, 'pivot.x', { host: 'ob', id: 'ob_c', path: 'pivot.x' }));
  near(cameraValueWithLinks(p, cam, 'pivot.x', 2), 5, 1e-9);
  near(cameraParamValue(cam, 'center', 2)[0], 0, 1e-9, 'the local camera value is untouched');
  assert.equal(cameraValueWithLinks(p, cam, 'position.x', 2), null, 'camera position is path animation');
  applyOp(p, linkOp(cam.id, 'roll', { host: 'ob', id: 'ob_b', path: 'roll' }));
  near(cameraValueWithLinks(p, cam, 'roll', 1), 20, 1e-9);
});

test('links: the property graph stops at MAX_LINK_DEPTH (32)', () => {
  const p = fresh();
  const objects = [];
  for (let i = 0; i < 33; i += 1) objects.push(addObj(p, { id: `ob_${i}`, pivot: [1, 0, 0] }));
  // Build the chain from the tail so every intermediate link has a real parent.
  for (let i = objects.length - 1; i >= 1; i -= 1) {
    applyOp(p, linkOp(`ob_${i - 1}`, 'pivot.x', { host: 'ob', id: `ob_${i}`, path: 'pivot.x' }, { bindParentValue: 0 }));
  }
  // 32 links sit above ob_0: the folded value is 33 × 1.
  near(resolveEffectiveValue(p, 'ob_0', 'pivot.x', 0), 33, 1e-9, '32 chained links resolve');
  near(resolveEffectiveValue(p, 'ob_1', 'pivot.x', 0), 32, 1e-9);
  // One more host on top would be the 33rd link: refused.
  addObj(p, { id: 'ob_head', pivot: [1, 0, 0] });
  assert.throws(
    () => applyOp(p, linkOp('ob_head', 'pivot.x', { host: 'ob', id: 'ob_0', path: 'pivot.x' }, { bindParentValue: 0 })),
    /deeper than 32/,
  );
  assert.equal(MAX_LINK_DEPTH, 32);
});

test('links: catalog and normalisers reject unusable data', () => {
  assert.equal(normalizeHostKind('element'), 'el');
  assert.equal(normalizeHostKind('CAM'), 'cam');
  assert.throws(() => normalizeHostKind('world'), /unknown link host/);
  const legacy = { type: 'solid', transform: {} };
  const nodeEl = { type: 'solid', node: { pivot: [0, 0, 0] } };
  assert.ok(linkTargets('el', legacy).some((t) => t.path === 'pivot.x'));
  assert.ok(!linkTargets('el', legacy).some((t) => t.path === 'position.x'));
  assert.ok(linkTargets('el', nodeEl).some((t) => t.path === 'position.x'));
  assert.ok(linkTargets('cam').some((t) => t.path === 'fov'));
  assert.equal(findLinkTarget('cam', null, 'position.z'), null);

  assert.equal(normalizeLink({ id: 'l', to: 'pivot.x', from: { host: 'ob', id: 'ob_1', path: 'pivot.y' }, combine: 'add', bindParentValue: 0 }).enabled, true);
  assert.equal(normalizeLink(null), null);
  assert.equal(normalizeLink({ id: 'l', to: 'bad path..', from: { host: 'ob', id: 'ob_1', path: 'pivot.y' } }), null);
  assert.equal(normalizeLink({ id: 'l', to: 'pivot.x', from: { host: 'ob', id: '@live', path: 'pivot.y' } }), null);
  assert.throws(() => normalizeLink({ id: 'l', to: 'pivot.x', from: { host: 'ob', id: 'ob_1', path: 'pivot.y' }, combine: 'add' }, { strict: true }), /bindParentValue|required/);
  assert.deepEqual(normalizeLinks(undefined), []);
  assert.deepEqual(normalizeLinks('junk'), []);
  assert.deepEqual(normalizeLinks([{ id: 'a', to: 'pivot.x', from: { host: 'el', id: 'el_1', path: 'pivot.x' }, combine: 'add', bindParentValue: 1 }, { id: 'b', to: 'pivot.x', from: { host: 'el', id: 'el_2', path: 'pivot.x' }, combine: 'add', bindParentValue: 1 }]).length, 1);
  assert.ok(linkIssues('nope', 'l').some((issue) => issue.path === 'l'));
  assert.ok(linkIssues(undefined, 'l').length === 0);
});

test('links: the property ops are part of the public editing contract', () => {
  for (const op of ['propLink', 'propLinkPatch', 'propUnlink']) assert.ok(PUBLIC_OPS.includes(op), `${op} is public`);
  validateContract({
    ops: [
      { op: 'propLink', id: 'el_1', to: 'pivot.x', from: { host: 'el', id: 'el_2', path: 'pivot.y' } },
      { op: 'propLinkPatch', id: 'el_1', to: 'pivot.x', patch: { combine: 'mul' } },
      { op: 'propUnlink', id: 'el_1', to: 'pivot.x' },
    ],
  }, { ...EDIT_SCHEMA, required: ['ops'] });
  assert.throws(() => validateContract({
    ops: [{ op: 'propLink', id: 'el_1', to: 'pivot.x', from: { host: 'el', id: 'el_2', path: 'pivot.y' }, extra: 1 }],
  }, { ...EDIT_SCHEMA, required: ['ops'] }), /supported variant|unknown field/);
  assert.throws(() => validateContract({
    ops: [{ op: 'propLink', id: 'el_1', to: 'pivot.x', from: { host: 'world', id: 'el_2', path: 'pivot.y' } }],
  }, { ...EDIT_SCHEMA, required: ['ops'] }), /supported variant|must be one of/);
});

test('links: one propLink transaction is one undo step', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vdm-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = projectService(root);
  await service.transact({ command: { type: 'initialize', options: { title: 'links' } } });
  const a = await service.transact({ ops: [{ op: 'objectAdd', object: { id: 'ob_a', type: 'empty' } }] });
  const b = await service.transact({ ops: [{ op: 'objectAdd', object: { id: 'ob_b', type: 'empty' } }] });
  const linked = await service.transact({
    expectedRev: b.rev,
    ops: [{ op: 'propLink', id: 'ob_a', to: 'pivot.x', from: { host: 'ob', id: 'ob_b', path: 'pivot.x' }, t: 0 }],
  });
  assert.equal(linked.rev, b.rev + 1, 'a link is one revision');
  assert.equal(a.rev + 1, b.rev);
  assert.equal(linked.project.scene.objects.find((o) => o.id === 'ob_a').links.length, 1);
  const undone = await service.transact({ expectedRev: linked.rev, command: { type: 'undo' } });
  assert.equal(undone.rev, linked.rev + 1);
  assert.equal('links' in undone.project.scene.objects.find((o) => o.id === 'ob_a'), false);
  assert.equal(undone.project.scene.objects.length, 2, 'undo removes only the link step');
  assert.equal((await service.history()).undo, 2);
});
