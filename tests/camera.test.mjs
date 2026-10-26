import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCamera, pathPos, pathFov, evalCamera, bakeCameraTrack, cameraTransform, v3 } from '../core/camera.js';
import { ease } from '../core/time.js';
import { generateCity, cityHash, DEFAULT_WORLD } from '../engine/city.js';
import { normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';

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

test('auto handles reproduce the legacy Catmull-Rom path exactly', () => {
  const cam = normalizeCamera({
    fov: 60,
    path: [
      { t: 0, pos: [0, 10, 0] },
      { t: 1, pos: [5, 12, -3] },
      { t: 2.5, pos: [10, 8, -8] },
      { t: 4, pos: [3, 20, -15] },
    ],
  });
  const catmull = (p0, p1, p2, p3, u) => {
    const u2 = u * u, u3 = u2 * u;
    const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
    return [0, 1, 2].map((i) => f(p0[i], p1[i], p2[i], p3[i]));
  };
  const keys = cam.path;
  for (let t = 0; t <= 4; t += 0.05) {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const k1 = keys[i], k2 = keys[i + 1];
    const k0 = keys[Math.max(0, i - 1)];
    const k3 = keys[Math.min(keys.length - 1, i + 2)];
    const u = (t - k1.t) / (k2.t - k1.t);
    const old = catmull(k0.pos, k1.pos, k2.pos, k3.pos, ease(k1.ease || 'easeInOut', u));
    const now = pathPos(cam, t);
    [0, 1, 2].forEach((j) => assert.ok(Math.abs(old[j] - now[j]) < 1e-9, `t=${t} axis ${j}: ${old[j]} vs ${now[j]}`));
  }
});

test('explicit handles bend the path; normalize keeps them', () => {
  const cam = normalizeCamera({
    fov: 60,
    path: [
      { t: 0, pos: [0, 0, 0], out: [0, 0, -10], ease: 'linear' },
      { t: 1, pos: [10, 0, 0] },
    ],
  });
  assert.deepEqual(cam.path[0].out, [0, 0, -10]);
  const mid = pathPos(cam, 0.5);
  assert.ok(mid[2] < -1, 'pulled toward the out handle');
  assert.ok(mid[0] > 3 && mid[0] < 6);
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

test('center is a world point; path positions stay relative', () => {
  const p = project();
  p.camera.shake.amp = 0;
  p.camera.center = [10, -20, 5];
  const rel = pathPos(p.camera, 3.3);
  const c = evalCamera(p, 3.3);
  assert.deepEqual(c.position, rel);
  assert.deepEqual(c.pos, [10 + rel[0], -20 + rel[1], 5 + rel[2]]);
  // Moving the center must not change the path itself.
  assert.deepEqual(pathPos(p.camera, 3.3), rel);
});

test('camera transforms sample their keyed channels', () => {
  const cam = normalizeCamera({
    center: [0, 0, 0], opacity: 1, scale: [1, 1, 1],
    picturePivot: [0.5, 0.5], pictureOffset: [0, 0],
    path: [{ t: 0, pos: [0, 0, 0] }, { t: 2, pos: [4, 0, 0] }],
    tracks: {
      center: [{ t: 0, v: [0, 0, 0] }, { t: 2, v: [10, 20, 30] }],
      opacity: [{ t: 0, v: 1 }, { t: 2, v: 0.4 }],
      scale: [{ t: 0, v: [1, 1, 1] }, { t: 2, v: [2, 1, 0.5] }],
      picturePivot: [{ t: 0, v: [0.5, 0.5] }, { t: 2, v: [0.2, 0.8] }],
      pictureOffset: [{ t: 0, v: [0, 0] }, { t: 2, v: [-0.1, 0.25] }],
    },
  });
  const tr = cameraTransform(cam, 2);
  assert.deepEqual(tr.center, [10, 20, 30]);
  assert.deepEqual(tr.position, [4, 0, 0]);
  assert.deepEqual(tr.scale, [2, 1, 0.5]);
  assert.equal(tr.opacity, 0.4);
  assert.deepEqual(tr.picturePivot, [0.2, 0.8]);
  assert.deepEqual(tr.pictureOffset, [-0.1, 0.25]);

  const p = project();
  p.camera.shake.amp = 0;
  p.camera.tracks = cam.tracks;
  const c = evalCamera(p, 2);
  const rel = pathPos(p.camera, 2);
  assert.deepEqual(c.center, [10, 20, 30]);
  assert.deepEqual(c.position, rel);
  assert.deepEqual(c.pos, [10 + rel[0], 20 + rel[1], 30 + rel[2]]);
  assert.deepEqual(c.picturePivot, [0.2, 0.8]);
  assert.equal(c.opacity, 0.4);
});

test('cameraParamKey / cameraParamUnkey write transform channels', () => {
  const p = project();
  applyOp(p, { op: 'cameraParamKey', path: 'center', t: 1, v: [1, 2, 3] });
  assert.deepEqual(p.camera.tracks.center[0].v, [1, 2, 3]);
  applyOp(p, { op: 'cameraParamKey', path: 'center', t: 1, v: [4, 5, 6] });
  assert.equal(p.camera.tracks.center.length, 1);
  assert.deepEqual(p.camera.tracks.center[0].v, [4, 5, 6]);
  applyOp(p, { op: 'cameraParamKey', path: 'opacity', t: 1, v: 2 });
  assert.equal(p.camera.tracks.opacity[0].v, 1);
  applyOp(p, { op: 'cameraParamKey', path: 'picturePivot', t: 1, v: [1.4, -0.2] });
  assert.deepEqual(p.camera.tracks.picturePivot[0].v, [1, 0]);
  applyOp(p, { op: 'cameraParamUnkey', path: 'center', t: 1 });
  assert.equal(p.camera.tracks.center, undefined);
  assert.throws(() => applyOp(p, { op: 'cameraParamKey', path: 'fov', t: 1, v: 40 }), /not a keyed/);
  assert.throws(() => applyOp(p, { op: 'cameraParamKey', path: 'center', t: 1, v: [1, 2] }), /needs/);
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

test('evalCamera never mutates path keys (shake at/before the ends)', () => {
  const p = project();
  p.camera.shake.amp = 3;
  const before = JSON.stringify(p.camera.path.map((k) => k.pos));
  for (const t of [-2, 0, 3, 6, 11]) evalCamera(p, t);
  assert.equal(JSON.stringify(p.camera.path.map((k) => k.pos)), before);

  const one = project();
  one.camera.shake.amp = 3;
  one.camera.path = [one.camera.path[0]];
  const p0 = one.camera.path[0].pos.slice();
  evalCamera(one, 1);
  evalCamera(one, 0);
  assert.deepEqual(one.camera.path[0].pos, p0);
});

test('cameraKey keeps ease and bezier handles when only the position changes', () => {
  const p = project();
  const t = p.camera.path[0].t;
  applyOp(p, {
    op: 'cameraKey', t, pos: [1, 2, 3], ease: 'linear',
    out: [4, 0, 0], in: [-4, 0, 0],
  });
  applyOp(p, { op: 'cameraKey', t, pos: [9, 8, 7] });
  const k = p.camera.path.find((x) => Math.abs(x.t - t) < 1e-6);
  assert.deepEqual(k.pos, [9, 8, 7]);
  assert.equal(k.ease, 'linear');
  assert.deepEqual(k.out, [4, 0, 0]);
  assert.deepEqual(k.in, [-4, 0, 0]);
});

test('camera path speed curve re-times a segment without moving its keys', () => {
  const slowStart = project();
  // v=0.1 at the start: half the time only covers 27.5% of the segment
  slowStart.camera.path[0].speed = [[0, 0.1], [1, 1.9]];
  slowStart.camera = normalizeCamera(slowStart.camera);
  const a = slowStart.camera.path[0];
  const b = slowStart.camera.path[1];
  const tMid = (a.t + b.t) / 2;
  const p = pathPos(slowStart.camera, tMid);
  const d0 = Math.hypot(p[0] - a.pos[0], p[1] - a.pos[1], p[2] - a.pos[2]);
  assert.ok(d0 < 0.35 * Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]));
  for (const k of slowStart.camera.path) {
    const got = pathPos(slowStart.camera, k.t);
    assert.ok(Math.hypot(got[0] - k.pos[0], got[1] - k.pos[1], got[2] - k.pos[2]) < 1e-6);
  }
  // and the op round-trips it
  applyOp(slowStart, { op: 'cameraPath', path: slowStart.camera.path });
  assert.deepEqual(slowStart.camera.path[0].speed, [[0, 0.1], [1, 1.9]]);
  applyOp(slowStart, { op: 'cameraKey', t: a.t, pos: a.pos });
  assert.deepEqual(slowStart.camera.path[0].speed, [[0, 0.1], [1, 1.9]]);
});
