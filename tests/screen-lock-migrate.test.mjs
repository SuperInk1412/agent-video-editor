import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, applyOps } from '../core/ops.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { evalElement } from '../core/evaluate.js';
import { cameraFrame } from '../core/hierarchy.js';
import { evalCameraWorld } from '../core/spatial-parent.js';
import { frameOf } from '../core/spatial.js';
import { elementWorldNode } from '../app/renderer/js/node-at.js';
import { migrateScreenLocks } from '../core/screen-lock-migrate.js';

// docs/DESIGN-TRANSFORM-UNIFY.md §1.2: a screen lock becomes spatial parents to
// the shot cameras (split at the cuts) — no feeds, no full-screen rig.

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

/** Normalised screen position of a world point seen by camera state `c` (roll 0). */
function project(c, x) {
  const f = norm(sub(c.look, c.pos));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const d = sub(x, c.pos);
  const k = 1 / Math.tan((c.fov * Math.PI) / 360);
  return [(dot(d, r) / dot(d, f)) * k, (dot(d, u) / dot(d, f)) * k];
}

/** Three cut shots (different places, moving) and a subtitle locked to the live shot. */
function rig() {
  const p = normalizeProject(createProject({ title: 'hud', duration: 6 }));
  ensureSpace(p);
  const base = p.cameras[0];
  const key = base.path[0];
  applyOp(p, { op: 'cameraPatch', id: base.id, patch: { start: 0, duration: 2 } });
  for (const [i, dx] of [[1, 30], [2, -40]]) {
    applyOp(p, { op: 'addCamera', camera: { ...JSON.parse(JSON.stringify(base)), id: `cam_s${i}`, name: `shot ${i}`,
      start: 2 * i, duration: 2, path: [{ t: 0, pos: [key.pos[0] + dx, key.pos[1] + 3, key.pos[2]], look: [dx, 4, -10] },
        { t: 6, pos: [key.pos[0] + dx + 5, key.pos[1], key.pos[2] - 4], look: [dx, 6, -10] }] } });
  }
  applyOp(p, { op: 'activateCamera', id: base.id });
  const { element } = applyOp(p, { op: 'addElement', element: { type: 'text', start: 0, duration: 6, transform: { x: 300, y: 380, z: 0.5 }, style: { text: '字幕' } } });
  // A lock as the retired elementParent op stored it: bound to the live shot at t=0.
  const f = cameraFrame(p, '@live', 0);
  p.elements.find((e) => e.id === element.id).parent = { id: '@live', kind: 'camera', bind: { pos: f.pos, basis: f.basis, depth: 19.5 } };
  return { p, el: element.id };
}

const TIMES = [0.3, 1.9, 2.5, 3.7, 4.2, 5.8];

/** Where the retired screen lock drew the element centre at each time (rigid carry). */
function lockedScreen(p, elId) {
  const el = p.elements.find((e) => e.id === elId);
  return TIMES.map((t) => {
    const st = evalElement(el, t, p.meta);
    const x = [st.x / 100, p.meta.height / 200 - st.y / 100, st.z];
    const now = cameraFrame(p, '@live', t);
    const b = el.parent.bind;
    const local = [0, 1, 2].map((i) => dot(sub(x, b.pos), b.basis[i]));
    const w = [0, 1, 2].map((r) => now.pos[r] + now.basis[0][r] * local[0] + now.basis[1][r] * local[1] + now.basis[2][r] * local[2]);
    return project(evalCameraWorld(p, t), w);
  });
}

/** The same, after the migration: the piece on screen at t, through the live camera. */
function migratedScreen(p, text) {
  return TIMES.map((t) => {
    const piece = p.elements.find((e) => e.style?.text === text && t >= e.start - 1e-6 && t < e.start + e.duration - 1e-6);
    assert.ok(piece, `a piece covers ${t}`);
    return project(evalCameraWorld(p, t), frameOf(elementWorldNode(p, piece, t)).pos);
  });
}

const sameScreen = (a, b) => a.forEach((s, i) => assert.ok(
  Math.abs(s[0] - b[i][0]) < 1e-6 && Math.abs(s[1] - b[i][1]) < 1e-6, `@${TIMES[i]}: ${b[i]} vs ${s}`));

test('a live lock is split at the cuts and parented to each shot camera', () => {
  const { p, el } = rig();
  const report = migrateScreenLocks(p);
  assert.deepEqual(report, { elements: 1, pieces: 3, restoredHud: 0, fovShots: [] });
  assert.deepEqual(validateProject(p), []);
  const pieces = p.elements.filter((e) => e.style?.text === '字幕').sort((a, b) => a.start - b.start);
  assert.equal(pieces[0].id, el, 'the first piece keeps the id');
  assert.deepEqual(pieces.map((e) => [e.start, e.duration, e.parent.id, e.parent.mode]),
    [[0, 2, 'cam_1', 'world'], [2, 2, 'cam_s1', 'world'], [4, 2, 'cam_s2', 'world']]);
  assert.equal(p.elements.some((e) => e.type === 'camfeed'), false, 'no feeds');
  assert.equal(p.cameras.length, 3, 'no new camera');
  assert.equal(migrateScreenLocks(p), null, 'idempotent');
});

test('the subtitle stays at the same place on screen in every shot', () => {
  const { p, el } = rig();
  const before = lockedScreen(p, el);
  migrateScreenLocks(p);
  sameScreen(before, migratedScreen(p, '字幕'));
});

test('a project saved with the HUD rig is restored, then migrated the same way', () => {
  const { p, el } = rig();
  const before = lockedScreen(p, el);
  // Rebuild what the earlier migration saved: rig, HUD camera, one feed per shot.
  const lock = p.elements.find((e) => e.id === el).parent;
  delete p.elements.find((e) => e.id === el).parent;
  const base = JSON.parse(JSON.stringify(p.cameras.find((c) => c.id === 'cam_1')));
  delete base.start; delete base.duration;
  const look = lock.bind.pos.map((v, i) => v + lock.bind.basis[2][i] * 19.5);
  const ops = [
    { op: 'objectAdd', object: { id: 'ob_hud', type: 'empty', name: 'HUD 机位', pivot: [0, 0, 0] } },
    { op: 'addCamera', index: 0, camera: { ...base, id: 'cam_hud', name: 'HUD 相机', path: [{ t: 0, pos: lock.bind.pos, look }] } },
  ];
  for (const [cam, start] of [['cam_1', 0], ['cam_s1', 2], ['cam_s2', 4]]) {
    ops.push({ op: 'addElement', element: { id: `el_feed_${cam}`, type: 'camfeed', start, duration: 2, z: -5, feed: { camera: cam, delay: 0 } } });
    ops.push({ op: 'cameraPatch', id: cam, patch: { output: false } });
  }
  for (const id of ['cam_hud', 'el_feed_cam_1', 'el_feed_cam_s1', 'el_feed_cam_s2', el]) ops.push({ op: 'spatialParent', id, parent: 'ob_hud', t: 0 });
  ops.push({ op: 'objectPatch', id: 'ob_hud', patch: { pivot: [20000, 0, 0] } }, { op: 'activateCamera', id: 'cam_hud' });
  applyOps(p, ops);

  const report = migrateScreenLocks(p);
  assert.equal(report.restoredHud, 1);
  assert.equal(report.pieces, 3);
  assert.equal(p.scene.objects.some((o) => o.id === 'ob_hud'), false);
  assert.equal(p.cameras.some((c) => c.id === 'cam_hud'), false);
  assert.equal(p.elements.some((e) => e.type === 'camfeed'), false);
  assert.ok(p.cameras.every((c) => c.output === undefined), 'feed-only flags are gone');
  assert.deepEqual(validateProject(p), []);
  sameScreen(before, migratedScreen(p, '字幕'));
});

test('a shot with an animated FOV is reported', () => {
  const { p } = rig();
  applyOp(p, { op: 'cameraParamKey', id: 'cam_s1', path: 'fov', t: 2, v: 50 });
  applyOp(p, { op: 'cameraParamKey', id: 'cam_s1', path: 'fov', t: 4, v: 30 });
  assert.deepEqual(migrateScreenLocks(p).fovShots, ['cam_s1']);
});
