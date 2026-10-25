import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCamera, pathPos, pathFov, evalCamera, bakeCameraTrack, v3 } from '../core/camera.js';
import { generateCity, cityHash, DEFAULT_WORLD } from '../engine/city.js';
import { normalizeProject } from '../core/schema.js';

const project = () => normalizeProject({
  schema: 'vdm.project/1', rev: 1,
  meta: { title: 'cam', fps: 24, width: 1920, height: 1080, duration: 6, background: '#000' },
  segments: [], elements: [],
  camera: {
    fov: 60, lookAhead: 80, bankGain: 1, maxRoll: 30,
    shake: { amp: 0, freq: 2, octaves: 3, speedGain: 1, seed: 3 },
    path: [
      { t: 0, pos: [0, 100, -200] },
      { t: 2, pos: [0, 40, -100] },
      { t: 4, pos: [60, 30, 0] },
      { t: 6, pos: [140, 80, 20] },
    ],
  },
  world: { ...DEFAULT_WORLD, seed: 42 },
});

test('camera path passes through its keys', () => {
  const p = project();
  for (const k of p.camera.path) {
    const got = pathPos(p.camera, k.t);
    assert.ok(v3.len(v3.sub(got, k.pos)) < 1e-6, `t=${k.t}`);
  }
  const mid = pathPos(p.camera, 1);
  assert.ok(mid[1] < 100 && mid[1] > 40, 'dives between keys');
});

test('camera fov keyframes override the default', () => {
  const cam = normalizeCamera({ fov: 60, path: [{ t: 0, pos: [0, 0, 0], fov: 90 }, { t: 2, pos: [0, 0, -10], fov: 40 }] });
  assert.equal(pathFov(cam, -1), 90);
  assert.equal(pathFov(cam, 3), 40);
  const mid = pathFov(cam, 1);
  assert.ok(mid > 40 && mid < 90);
});

test('fov is clamped to 1..360 (fisheye takes over at 180)', () => {
  assert.equal(normalizeCamera({ fov: 0 }).fov, 1);
  assert.equal(normalizeCamera({ fov: 400 }).fov, 360);
  assert.equal(normalizeCamera({ fov: 240 }).fov, 240);
  const cam = normalizeCamera({ fov: 60, path: [{ t: 0, pos: [0, 0, 0], fov: 999 }, { t: 2, pos: [0, 0, -10], fov: -20 }] });
  assert.equal(cam.path[0].fov, 360);
  assert.equal(cam.path[1].fov, 1);
});

test('evalCamera is deterministic and speed follows the path', () => {
  const p = project();
  const a = evalCamera(p, 3.3);
  const b = evalCamera(p, 3.3);
  assert.deepEqual(a.pos, b.pos);
  assert.ok(a.speed > 0);
  // look-ahead points roughly along the tangent
  const dir = v3.norm(v3.sub(a.look, a.pos));
  const tan = v3.norm(v3.sub(pathPos(p.camera, 3.4), pathPos(p.camera, 3.2)));
  assert.ok(v3.dot(dir, tan) > 0.9);
});

test('shake is seeded, bounded and toggled by amp', () => {
  const p = project();
  p.camera.shake.amp = 1.5;
  const c = evalCamera(p, 2.4);
  const base = pathPos(p.camera, 2.4);
  const off = v3.len(v3.sub(c.pos, base));
  assert.ok(off > 0, 'shake moves the camera');
  assert.ok(off < 6, 'shake stays bounded');
  const p2 = project();
  p2.camera.shake.amp = 1.5;
  p2.camera.shake.seed = 99;
  assert.notDeepEqual(evalCamera(p2, 2.4).pos, c.pos, 'seed changes the noise');
  const quiet = project();
  quiet.camera.shake.amp = 0;
  assert.ok(v3.len(v3.sub(evalCamera(quiet, 2.4).pos, pathPos(quiet.camera, 2.4))) < 1e-9);
});

test('banking rolls into the turn and respects maxRoll', () => {
  const p = project();
  p.camera.maxRoll = 12;
  p.camera.bankGain = 3;
  const c = evalCamera(p, 3.0);
  assert.ok(Math.abs(c.roll) <= 12.0001, `roll ${c.roll}`);
});

test('bakeCameraTrack covers the range', () => {
  const p = project();
  const track = bakeCameraTrack(p, { fps: 24, from: 0, to: 2 });
  assert.equal(track.length, 49);
  assert.equal(track[0].f, 1);
  assert.equal(track[48].f, 49);
  for (let i = 1; i < track.length; i++) assert.ok(track[i].f > track[i - 1].f);
  assert.ok(Array.isArray(track[10].look));
});

test('city generation is deterministic and bounded', () => {
  const w = { ...DEFAULT_WORLD, seed: 1234 };
  const a = generateCity(w);
  const b = generateCity(w);
  assert.equal(a.hash, b.hash);
  assert.equal(a.stats.buildings, b.stats.buildings);
  assert.deepEqual(a.buildings[0], b.buildings[0]);
  assert.ok(a.stats.buildings > 50);
  assert.ok(a.neons.length > 20);
  for (const bl of a.buildings.slice(0, 50)) {
    assert.ok(bl.h >= w.height.min - 1 && bl.h <= w.height.max + 1);
    assert.ok(bl.x > a.bounds.x0 && bl.x < a.bounds.x1);
  }
  const other = generateCity({ ...w, seed: 1235 });
  assert.notEqual(other.hash, a.hash);
});

test('cityHash ignores derived defaults but tracks params', () => {
  assert.equal(cityHash({ seed: 7 }), cityHash({ seed: 7 }));
  assert.notEqual(cityHash({ seed: 7 }), cityHash({ seed: 8 }));
});
