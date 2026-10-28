import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOp } from '../core/ops.js';
import { createProject, normalizeProject, validateProject } from '../core/schema.js';
import { ensureSpace } from '../core/space.js';
import { evalElement } from '../core/evaluate.js';
import { cameraFrame } from '../core/hierarchy.js';
import { evalCameraWorld } from '../core/spatial-parent.js';
import { frameOf } from '../core/spatial.js';
import { elementWorldNode } from '../app/renderer/js/node-at.js';
import { feedPlan, programProject } from '../core/camfeed.js';
import { migrateScreenLocks, HUD_OFFSET } from '../core/screen-lock-migrate.js';

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

/** Three cut shots (different places) and a subtitle locked to the live shot. */
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

/** Where the retired screen lock drew a local point at t: rigid camera carry. */
function lockedWorld(p, el, t, x) {
  const now = cameraFrame(p, '@live', t);
  const b = el.parent.bind;
  const d = sub(x, b.pos);
  // Rd = now.basis(cols) · bind.basis(cols)ᵀ applied to d
  const local = [0, 1, 2].map((i) => dot(d, b.basis[i]));
  return [0, 1, 2].map((r) => now.pos[r] + now.basis[0][r] * local[0] + now.basis[1][r] * local[1] + now.basis[2][r] * local[2]);
}

test('screen locks become a HUD rig that films the shots through feeds', () => {
  const { p, el } = rig();
  const shots = p.cameras.map((c) => c.id);
  const report = migrateScreenLocks(p);
  assert.equal(report.elements, 1);
  assert.equal(report.feeds, 3);
  assert.deepEqual(report.approximations, []);
  assert.deepEqual(validateProject(p), []);
  const e = p.elements.find((x) => x.id === el);
  assert.equal(e.parent.mode, 'world', 'the subtitle is a spatial child of the rig');
  assert.equal(e.parent.id, report.rig);
  for (const id of shots) assert.equal(p.cameras.find((c) => c.id === id).output, false, id);
  const prog = programProject(p);
  assert.deepEqual(prog.cameras.map((c) => c.id), [report.hudCamera]);
  assert.equal(p.cameraOrder[0], report.hudCamera);
  const feeds = p.elements.filter((x) => x.type === 'camfeed');
  const clipStart = { cam_1: 0, cam_s1: 2, cam_s2: 4 };
  assert.deepEqual(feeds.map((f) => [f.feed.camera, f.start, f.duration]).sort(), shots.map((id) => [id, clipStart[id], 2]).sort());
  assert.deepEqual(feedPlan(p).sources.sort(), shots.slice().sort());
  assert.equal(migrateScreenLocks(p), null, 'idempotent');
});

test('the subtitle stays at the same place on screen in every shot', () => {
  const { p, el } = rig();
  const before = [];
  const times = [0.3, 1.9, 2.5, 3.7, 4.2, 5.8];
  for (const t of times) {
    const e = p.elements.find((x) => x.id === el);
    const st = evalElement(e, t, p.meta);
    const local = [st.x / 100, p.meta.height / 200 - st.y / 100, st.z];
    before.push(project(evalCameraWorld(p, t), lockedWorld(p, e, t, local)));
  }
  migrateScreenLocks(p);
  const prog = programProject(p);
  times.forEach((t, i) => {
    const e = p.elements.find((x) => x.id === el);
    const pos = frameOf(elementWorldNode(p, e, t)).pos;
    assert.ok(pos[0] > HUD_OFFSET - 100, 'lives in the HUD rig');
    const now = project(evalCameraWorld(prog, t), pos);
    assert.ok(Math.abs(now[0] - before[i][0]) < 1e-6 && Math.abs(now[1] - before[i][1]) < 1e-6, `@${t}: ${now} vs ${before[i]}`);
  });
});

test('a feed fills the HUD frame exactly where the shot used to be', () => {
  const { p } = rig();
  migrateScreenLocks(p);
  const prog = programProject(p);
  const feed = p.elements.find((x) => x.type === 'camfeed');
  const pos = frameOf(elementWorldNode(p, feed, 1)).pos;
  const s = project(evalCameraWorld(prog, 1), pos);
  assert.ok(Math.hypot(...s) < 1e-6, 'feed centred in the HUD picture');
});
