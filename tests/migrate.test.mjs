import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { migrateProject, orthoScreen, evaluateMigratedObject } from '../core/migrate.js';
import { objectPose, sampleChannel } from '../core/scene.js';
import { evalCamera, normalizeCamera } from '../core/camera.js';
import { evalElement, motionDelta, fadeMul } from '../core/evaluate.js';
import { applyLegacy } from '../core/legacy.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';

const load = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((x) => x / l); };

test('migrate: demo becomes a v3 scene tree with a 2D ortho camera', () => {
  const v2 = load('demo');
  const v3 = migrateProject(v2);
  assert.equal(v3.units, 'm');
  assert.equal(v3.sceneId, 'root');
  const scene = v3.scenes.root;
  assert.equal(scene.objects.length, v2.elements.length + 1);
  const cam = scene.objects.find((o) => o.id === scene.cameraId);
  assert.equal(cam.type, 'camera');
  assert.equal(cam.camera.projection, 'ortho');
  assert.equal(cam.camera.orthoScale, 19.2);
  assert.equal(scene.annotations.length, 6);
  assert.equal(scene.annotations[0].text, '镜 01 — 夜之城不睡');
});

test('migrate: every 2D element keeps its exact screen transform', () => {
  const v2 = load('demo');
  const v3 = migrateProject(v2);
  const scene = v3.scenes.root;
  const { width, height } = v2.meta;
  for (const el of v2.elements) {
    const obj = scene.objects.find((o) => o.id === el.id);
    assert.ok(obj, el.id);
    const times = [el.start, el.start + el.duration / 2, el.start + el.duration - 1e-3];
    for (const t of times) {
      const old = evalElement(el, t, v2.meta);
      const md = motionDelta(el, t, v2.meta);
      const fade = fadeMul(el, t) || 1;
      const sx = old.x - md.x;
      const sy = old.y - md.y;
      const sScale = old.scale / (md.scale || 1);
      const sRot = old.rotation - md.rotation;
      const sOpacity = old.opacity / fade;
      const pose = objectPose(obj, t);
      const [px, py] = orthoScreen(v2.meta, pose.pivot);
      near(px, width / 2 + sx, 1e-6);
      near(py, height / 2 + sy, 1e-6);
      near(pose.scale[0], sScale, 1e-6);
      near(pose.scale[1], sScale, 1e-6);
      near(-pose.roll, sRot, 1e-6);
      near(pose.opacity, sOpacity, 1e-6);
    }
  }
});

test('migrate: legacy motion/fade is preserved for the switchover', () => {
  const v2 = load('demo');
  const v3 = migrateProject(v2);
  const title = v3.scenes.root.objects.find((o) => o.id === 'el_title');
  assert.equal(title.legacy.motion.type, 'in');
  near(title.legacy.motion.amount, 0.06);
});

test('migrate + legacy: demo matches the v2 evaluator pixel for pixel', () => {
  const v2 = load('demo');
  const v3 = migrateProject(v2);
  const scene = v3.scenes.root;
  for (const el of v2.elements) {
    const obj = scene.objects.find((o) => o.id === el.id);
    const step = el.duration / 10;
    for (let t = el.start; t < el.start + el.duration; t += step) {
      const old = evalElement(el, t, v2.meta);
      const pose = applyLegacy(objectPose(obj, t), obj, t, v2.meta);
      const [px, py] = orthoScreen(v2.meta, pose.pivot);
      near(px, v2.meta.width / 2 + old.x, 1e-6);
      near(py, v2.meta.height / 2 + old.y, 1e-6);
      near(pose.scale[0], old.scale, 1e-6);
      near(-pose.roll, old.rotation, 1e-6);
      near(pose.opacity, old.opacity, 1e-6);
    }
  }
});

test('migrate: the 3D camera keeps its exact flight path', () => {
  const v2 = load('nightcity');
  const v3 = migrateProject(v2);
  const scene = v3.scenes.root;
  const cam = scene.objects.find((o) => o.type === 'camera');
  assert.ok(cam, 'camera object');
  assert.equal(cam.camera.projection, 'perspective');
  assert.equal(cam.tracks.pivot.length, v2.camera.path.length);
  near(cam.legacy.shake.amp, v2.camera.shake.amp);

  // shake is a live modifier: compare against the unshaken path
  const clean = {
    ...v2,
    camera: normalizeCamera({ ...v2.camera, shake: { ...v2.camera.shake, amp: 0 } }),
    cameras: [], cameraOrder: [], activeCameraId: null,
  };
  let worst = 0;
  for (let t = 0; t <= v2.meta.duration; t += 0.25) {
    const old = evalCamera(clean, t);
    const pose = objectPose(cam, t);
    worst = Math.max(worst, Math.hypot(...pose.pivot.map((v, i) => v - old.pos[i])));
  }
  assert.ok(worst < 2e-6, `camera position drift ${worst}`);

  for (const k of v2.camera.path) {
    const old = evalCamera(clean, k.t);
    const dir = norm(old.look.map((v, i) => v - old.pos[i]));
    const pose = objectPose(cam, k.t);
    assert.ok(dot(pose.dir, dir) > 0.9999, `direction at ${k.t}s`);
  }
});

test('migrate: is idempotent', () => {
  const v3 = migrateProject(load('nightcity'));
  assert.equal(migrateProject(v3), v3);
});

test('orthoScreen: metres map back onto project pixels', () => {
  const [x, y] = orthoScreen({ width: 1920, height: 1080 }, [1, 2, 0]);
  near(x, 1060, 1e-9);
  near(y, 340, 1e-9);
});

test('hybrid migration preserves every camera, object and exact animated camera evaluation', () => {
  const p = createProject({ duration: 4 });
  for (let i = 0; i < 2; i++) applyOp(p, { op: 'addCamera', camera: {
    id: `camera_${i}`, visible: i === 0, center: [i, 2, 3],
    path: [{ t: 0, pos: [0, 10, 0], speed: [[0, 0], [1, 2]] }, { t: 4, pos: [0, 20, -100] }],
    tracks: { center: [{ t: 0, v: [0, 0, 0] }, { t: 4, v: [20, 0, 5] }], fov: [{ t: 0, v: 60 }, { t: 4, v: 110 }] },
  } });
  applyOp(p, { op: 'objectAdd', object: { id: 'object_1', type: 'solid', pivot: [3, 5, 7], duration: 4 } });
  normalizeProject(p);
  const before = JSON.stringify(p);
  const result = migrateProject(p), scene = result.scenes.root;
  assert.equal(scene.objects.length, 3);
  assert.deepEqual(scene.cameraOrder, p.cameraOrder);
  assert.equal(scene.cameraId, p.activeCameraId);
  assert.deepEqual(scene.objects.find((o) => o.id === 'object_1'), p.scene.objects[0]);
  for (const camera of p.cameras) {
    const migrated = scene.objects.find((o) => o.id === camera.id);
    assert.equal(migrated.visible, camera.visible);
    for (let time = 0; time <= 4; time += 0.125) {
      const expected = evalCamera({ camera, meta: p.meta }, time);
      const actual = evaluateMigratedObject(migrated, time, p.meta);
      assert.deepEqual(actual.worldPos, expected.pos);
      assert.equal(actual.camera.fov, expected.fov);
      assert.equal(actual.roll, expected.roll);
    }
  }
  assert.equal(JSON.stringify(p), before, 'migration does not mutate the source project');
});
