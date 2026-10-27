import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCamera, pathPos, pathFov, evalCamera, bakeCameraTrack, cameraTransform, cameraParamValue, v3,
  pathArcTable, pathPointAtArc, retimePathSpan,
} from '../core/camera.js';
import { ease } from '../core/time.js';
import { presetCurve, normalizeCurve, sampleCurve } from '../core/curves.js';
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
  assert.throws(() => applyOp(p, { op: 'cameraParamKey', path: 'shake.seed', t: 1, v: 3 }), /not a keyed/);
  assert.throws(() => applyOp(p, { op: 'cameraParamKey', path: 'center', t: 1, v: [1, 2] }), /needs/);
});

test('lens, shake and DOF channels drive evalCamera per frame', () => {
  const p = project();
  p.camera.shake.amp = 0;
  p.camera.tracks = {
    fov: [{ t: 0, v: 40 }, { t: 2, v: 120 }],
    lookAhead: [{ t: 0, v: 30 }, { t: 2, v: 50 }],
    bankGain: [{ t: 0, v: 0 }, { t: 2, v: 2 }],
    maxRoll: [{ t: 0, v: 0 }, { t: 2, v: 10 }],
    roll: [{ t: 0, v: 0 }, { t: 2, v: 20 }],
    'dof.enabled': [{ t: 0, v: false }, { t: 2, v: true }],
    'dof.fstop': [{ t: 0, v: 8 }, { t: 2, v: 2 }],
  };
  assert.equal(cameraParamValue(p.camera, 'fov', 2), 120);
  assert.equal(cameraParamValue(p.camera, 'dof.enabled', 2), true);
  const c = evalCamera(p, 2);
  assert.equal(c.fov, 120);
  assert.equal(c.dof.enabled, true);
  assert.equal(c.dof.fstop, 2);
  assert.ok(c.roll >= 10, `manual roll survives banking: ${c.roll}`);
  assert.ok(Math.abs(v3.len(v3.sub(c.look, c.pos)) - 50) < 0.01, 'lookAhead is sampled');
  assert.ok(c.focus > 0);
  const baked = bakeCameraTrack(p, { fps: 24, from: 0, to: 2 });
  const last = baked[baked.length - 1];
  assert.equal(last.fov, 120);
  assert.equal(last.dof.enabled, true);
  assert.equal(last.dof.fstop, 2);
  assert.ok(last.focus > 0);

  const quiet = project();
  quiet.camera.shake.amp = 0;
  quiet.camera.tracks = { 'shake.amp': [{ t: 0, v: 0 }] };
  const base = v3.add(quiet.camera.center, pathPos(quiet.camera, 2.4));
  assert.ok(v3.len(v3.sub(evalCamera(quiet, 2.4).pos, base)) < 1e-9);
});

test('cameraParamKey supports lens / shake / DOF frame channels', () => {
  const p = project();
  applyOp(p, { op: 'cameraParamKey', path: 'fov', t: 1, v: 999 });
  assert.equal(p.camera.tracks.fov[0].v, 360);
  applyOp(p, { op: 'cameraParamKey', path: 'dof.enabled', t: 1, v: true });
  assert.equal(p.camera.tracks['dof.enabled'][0].v, true);
  applyOp(p, { op: 'cameraParamKey', path: 'shake.amp', t: 1, v: -3 });
  assert.equal(p.camera.tracks['shake.amp'][0].v, 0);
  applyOp(p, { op: 'cameraParamUnkey', path: 'fov', t: 1 });
  assert.equal(p.camera.tracks.fov, undefined);
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

test('camera span curve changes speed without bending a straight path', () => {
  const cam = normalizeCamera({
    fov: 60,
    path: [{ t: 0, pos: [0, 0, 0] }, { t: 2, pos: [10, 0, 0] }],
  });
  cam.path[0].curve = presetCurve('easeIn');
  cam.path[0].spanTo = 2;
  const early = pathPos(cam, 0.5);
  assert.ok(early[0] > 0 && early[0] < 2.5, `easeIn lags, got x=${early[0]}`);
  assert.deepEqual(pathPos(cam, 0), [0, 0, 0]);
  assert.deepEqual(pathPos(cam, 2), [10, 0, 0]);
  for (let t = 0; t <= 2; t += 0.1) {
    const p = pathPos(cam, t);
    assert.ok(Math.abs(p[1]) < 1e-9 && Math.abs(p[2]) < 1e-9, `still on the straight path at ${t}`);
  }
  // Arc length is the parameter the curve drives: linear u = half the span arc.
  cam.path[0].curve = presetCurve('linear');
  const table = pathArcTable(cam);
  const mid = pathPointAtArc(cam, table.total / 2);
  const got = pathPos(cam, 1);
  assert.ok(v3.len(v3.sub(mid, got)) < 1e-6);
});

test('camera span overshoot continues into the next segment or holds at the end', () => {
  const endOnly = normalizeCamera({
    fov: 60,
    path: [{ t: 0, pos: [0, 0, 0] }, { t: 1, pos: [10, 0, 0] }],
  });
  endOnly.path[0].curve = presetCurve('elastic');
  endOnly.path[0].spanTo = 1;
  let maxEnd = 0;
  for (let t = 0; t <= 1; t += 0.01) maxEnd = Math.max(maxEnd, pathPos(endOnly, t)[0]);
  assert.ok(maxEnd <= 10 + 1e-6, 'no next segment: hold at the last position');
  assert.ok(maxEnd > 9.99, 'still reaches the end');

  const withNext = normalizeCamera({
    fov: 60,
    path: [
      { t: 0, pos: [0, 0, 0] },
      { t: 1, pos: [10, 0, 0] },
      { t: 2, pos: [20, 0, 0] },
    ],
  });
  withNext.path[0].curve = presetCurve('elastic');
  withNext.path[0].spanTo = 1;
  let maxNext = 0;
  for (let t = 0; t <= 1; t += 0.005) maxNext = Math.max(maxNext, pathPos(withNext, t)[0]);
  assert.ok(maxNext > 10.1, `overshoot runs past the key, got ${maxNext}`);
  assert.ok(maxNext <= 20 + 1e-6, 'clamped at the end of the trajectory');
});

test('camera span reverse overshoot clamps at the span start', () => {
  const cam = normalizeCamera({
    fov: 60,
    path: [{ t: 0, pos: [0, 0, 0] }, { t: 1, pos: [10, 0, 0] }],
  });
  const dip = normalizeCurve({ type: 'bezier', p1: [0.3, -0.5], p2: [0.7, 1] });
  assert.ok(sampleCurve(dip, 0.05) < 0, 'this curve starts below zero');
  cam.path[0].curve = dip;
  cam.path[0].spanTo = 1;
  assert.deepEqual(pathPos(cam, 0.05), [0, 0, 0]);
  assert.deepEqual(pathPos(cam, 0.1), [0, 0, 0]);
});

test('camera span retimes inner keys to their first forward arrival', () => {
  const p = project();
  const cam = p.camera;
  const curve = presetCurve('easeIn');
  const table = pathArcTable(cam);
  const res = retimePathSpan(cam, 0, 6, curve);
  assert.equal(res.times.length, 2);
  assert.ok(res.times[0] > 0 && res.times[0] < 6);
  assert.ok(res.times[1] > res.times[0] && res.times[1] < 6);
  res.times.forEach((nt, j) => {
    const u = nt / 6;
    assert.ok(Math.abs(sampleCurve(curve, u) - res.fractions[j]) < 2e-3, `key ${j}`);
  });
  // Retiming uses the *first* arrival: an overshooting curve must not push
  // the inner keys to its later return pass.
  const elastic = retimePathSpan(cam, 0, 6, presetCurve('elastic'));
  assert.ok(elastic.times[0] < elastic.times[1]);
  assert.ok(v3.len(v3.sub(pathPointAtArc(cam, table.keyArc[1]), cam.path[1].pos)) < 1e-9);
});

test('keyCurve on a camera path retimes keys and survives path edits', () => {
  const p = project();
  const cam = p.camera;
  const original = cam.path.map((k) => k.t);
  applyOp(p, {
    op: 'keyCurve', host: 'camera', id: cam.id, path: 'path', from: 0, to: 6,
    curve: presetCurve('easeIn'),
  });
  assert.equal(cam.path[0].spanTo, 6);
  assert.equal(cam.path[0].curve.preset, 'easeIn');
  assert.ok(cam.path[1].t > original[1], 'inner key retimed later for easeIn');
  assert.ok(cam.path[2].t > original[2]);

  applyOp(p, { op: 'keyCurve', host: 'camera', id: cam.id, path: 'path', from: 0, to: 6, curve: presetCurve('elastic') });
  assert.equal(cam.path[0].curve.type, 'elastic');

  // Editing a node / writing the whole path keeps the span metadata.
  applyOp(p, { op: 'cameraKey', t: cam.path[1].t, pos: [1, 2, 3] });
  assert.equal(cam.path[0].spanTo, 6);
  applyOp(p, { op: 'cameraPath', path: cam.path.map((k) => ({ ...k, pos: k.pos.slice() })) });
  assert.equal(cam.path[0].spanTo, 6);
  assert.equal(cam.path[0].curve.type, 'elastic');

  // Overlapping spans are rejected (a nested span inside the active one).
  assert.throws(() => applyOp(p, {
    op: 'keyCurve', host: 'camera', id: cam.id, path: 'path',
    from: cam.path[1].t, to: cam.path[2].t, curve: presetCurve('linear'),
  }), /overlap/);

  // Removing the right endpoint drops the span instead of leaving a dangling ref.
  applyOp(p, { op: 'cameraRemove', t: 6 });
  assert.equal(cam.path[0].curve, undefined);
  assert.equal(cam.path[0].spanTo, undefined);
});
