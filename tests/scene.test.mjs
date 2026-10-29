import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_VERSION, PX_PER_M, pxToM, mToPx, speedWarp, sampleChannel, sampleVec3,
  sampleDir, basisFromDir, objectPose, poseMatrix, normalizeObject, normalizeScene,
  normalizeSceneTree, sampleAxes,
} from '../core/scene.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearVec = (a, b, eps = 1e-6) => a.forEach((v, i) => near(v, b[i], eps));
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('units: conversion is 100 px per metre', () => {
  assert.equal(PX_PER_M, 100);
  assert.equal(pxToM(1920), 19.2);
  assert.equal(mToPx(10.8), 1080);
});

test('speedWarp: linear curve is the identity, custom curves re-time', () => {
  near(speedWarp([[0, 1], [1, 1]], 0.3), 0.3);
  near(speedWarp([[0, 3], [1, 1]], 0), 0);
  near(speedWarp([[0, 3], [1, 1]], 1), 1);
  // fast start: half the time covers 62.5% of the distance
  near(speedWarp([[0, 3], [1, 1]], 0.5), 0.625);
  // garbage falls back to the identity
  near(speedWarp(null, 0.42), 0.42);
  near(speedWarp([[0, 1]], 0.42), 0.42);
});

test('sampleChannel: keys are hit exactly and ease in between', () => {
  const keys = [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 10 }];
  near(sampleChannel(keys, 0, -1), 0);
  near(sampleChannel(keys, 1, -1), 10);
  near(sampleChannel(keys, 0.5, -1), 5);
  near(sampleChannel(keys, -3, -1), 0);
  near(sampleChannel(keys, 9, -1), 10);
  near(sampleChannel([], 1, 7), 7);
});

test('sampleChannel: a speed curve re-times without moving the keys', () => {
  const keys = [{ t: 0, v: 0, speed: [[0, 3], [1, 1]] }, { t: 1, v: 10 }];
  assert.ok(sampleChannel(keys, 0.5, -1) > 5, 'fast start covers more distance by mid-segment');
  near(sampleChannel(keys, 0, -1), 0);
  near(sampleChannel(keys, 1, -1), 10);
});

test('sampleVec3: catmull hits keys, stays smooth, respects speed curves', () => {
  const keys = [{ t: 0, v: [0, 0, 0] }, { t: 1, v: [10, 0, 0] }];
  nearVec(sampleVec3(keys, 0, [1, 1, 1]), [0, 0, 0]);
  nearVec(sampleVec3(keys, 1, [1, 1, 1]), [10, 0, 0]);
  nearVec(sampleVec3(keys, 0.5, [1, 1, 1]), [5, 0, 0], 1e-4);

  const three = [{ t: 0, v: [0, 0, 0] }, { t: 1, v: [10, 0, 0] }, { t: 2, v: [20, 0, 0] }];
  nearVec(sampleVec3(three, 1, [0, 0, 0]), [10, 0, 0]);
  assert.ok(sampleVec3(three, 0.5, [0, 0, 0])[0] > 0);

  const slow = [{ t: 0, v: [0, 0, 0], speed: [[0, 3], [1, 1]] }, { t: 1, v: [10, 0, 0] }];
  assert.ok(sampleVec3(slow, 0.5, [0, 0, 0])[0] > 5);
});

test('sampleDir: points stay on the sphere and the path bends smoothly', () => {
  const keys = [{ t: 0, v: [0, 0, 1], ease: 'linear' }, { t: 1, v: [1, 0, 0] }];
  const mid = sampleDir(keys, 0.5, [0, 0, -1]);
  near(len(mid), 1);
  assert.ok(mid[0] > 0.6 && mid[2] > 0.6, 'diagonal between +Z and +X');
  nearVec(sampleDir(keys, 0, [0, 0, -1]), [0, 0, 1]);
  nearVec(sampleDir(keys, 1, [0, 0, -1]), [1, 0, 0]);
  near(len(sampleDir([], 0, [0, 0, 5])), 1);
});

test('basisFromDir: orthonormal frame, forward = dir, roll twists it', () => {
  const b = basisFromDir([0, 0, -1]);
  nearVec(b.right, [1, 0, 0]);
  nearVec(b.up, [0, 1, 0]);
  nearVec(b.forward, [0, 0, -1]);
  near(dot(b.right, b.up), 0);

  const rolled = basisFromDir([0, 0, -1], 90);
  nearVec(rolled.right, [0, 1, 0], 1e-6);
  nearVec(rolled.up, [-1, 0, 0], 1e-6);
  near(dot(rolled.right, rolled.forward), 0);
});

test('objectPose: pivot + rotated geometry offset; scale and opacity', () => {
  const forward = objectPose({ pivot: [1, 2, 3], position: [0, 0, -5], rot: { dir: [0, 0, -1] } }, 0);
  nearVec(forward.worldPos, [1, 2, 8]); // local -Z is forward: the offset lands 5 m in front

  const side = objectPose({ pivot: [0, 0, 0], position: [0, 0, -5], rot: { dir: [1, 0, 0] } }, 0);
  nearVec(side.worldPos, [-5, 0, 0]);

  const scaled = objectPose({ pivot: [0, 0, 0], position: [0, 0, 0], scale: [2, 3, 4] }, 0);
  nearVec(scaled.scale, [2, 3, 4]);

  const faded = objectPose({
    opacity: 1,
    tracks: { opacity: [{ t: 0, v: 1 }, { t: 2, v: 0, ease: 'linear' }] },
  }, 1);
  near(faded.opacity, 0.5);
});

test('poseMatrix: column-major basis, scale and translation', () => {
  const m = poseMatrix(objectPose({
    pivot: [1, 2, 3], position: [0, 0, 0], scale: [2, 3, 4], rot: { dir: [0, 0, -1] },
  }, 0));
  nearVec([m[0], m[1], m[2]], [2, 0, 0]);
  nearVec([m[4], m[5], m[6]], [0, 3, 0]);
  nearVec([m[8], m[9], m[10]], [0, 0, -4]);
  nearVec([m[12], m[13], m[14]], [1, 2, 3]);
  near(m[15], 1);
});

test('normalizeObject: defaults, type guard, sorted tracks', () => {
  const o = normalizeObject({
    id: 'x', type: 'nope', pivot: [1, 2], rot: { dir: [0, 0, 2] },
    tracks: { opacity: [{ t: 2, v: 0 }, { t: 0, v: 1 }] },
  });
  assert.equal(o.type, 'solid');
  nearVec(o.pivot, [1, 2, 0]);
  // a static dir/roll is stored as three-axis rotation: dir +Z, roll 0 -> [0, 0, 0]
  nearVec(o.rotation, [0, 0, 0]);
  assert.equal(o.rot, undefined);
  nearVec(o.scale, [1, 1, 1]);
  assert.deepEqual(o.tracks.opacity.map((k) => k.t), [0, 2]);
});

test('sampleVec3: explicit handles bend the path, keys stay exact', () => {
  const auto = [{ t: 0, v: [0, 0, 0] }, { t: 1, v: [10, 0, 0] }, { t: 2, v: [20, 0, 0] }];
  near(sampleVec3(auto, 0.5, [0, 0, 0])[0], 4.375, 1e-6); // Catmull with auto handles
  const bent = [{ t: 0, v: [0, 0, 0], out: [0, 0, -9] }, { t: 1, v: [10, 0, 0] }, { t: 2, v: [20, 0, 0] }];
  const mid = sampleVec3(bent, 0.5, [0, 0, 0]);
  assert.ok(Math.abs(mid[2]) > 1, 'pulled off the straight line by the out handle');
  nearVec(sampleVec3(bent, 0, [0, 0, 0]), [0, 0, 0]);
  nearVec(sampleVec3(bent, 1, [0, 0, 0]), [10, 0, 0]);
});

test('sampleAxes: per-axis tracks are exact, a vec3 track wins', () => {
  const tracks = {
    'pivot.x': [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 10 }],
    'pivot.y': [{ t: 0, v: 0 }, { t: 1, v: -10 }],
  };
  nearVec(sampleAxes(tracks, 'pivot', 0.5, [0, 0, 0]), [5, -5, 0]);
  assert.deepEqual(sampleAxes(tracks, 'pivot', 0, [0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(sampleAxes(tracks, 'pivot', 1, [0, 0, 0]), [10, -10, 0]);

  const both = { ...tracks, pivot: [{ t: 0, v: [1, 1, 1] }, { t: 1, v: [3, 3, 3] }] };
  nearVec(sampleAxes(both, 'pivot', 0.5, [0, 0, 0]), [2, 2, 2]);
});

test('normalizeScene: version, camera detection, annotations', () => {
  const s = normalizeScene({
    objects: [{ id: 'cam1', type: 'camera' }, { id: 'el', type: 'text' }],
    annotations: [{ t: 3, text: '起飞' }, { t: 1, text: '开场' }],
  });
  assert.equal(s.version, SCENE_VERSION);
  assert.equal(s.units, 'm');
  assert.equal(s.cameraId, 'cam1');
  assert.deepEqual(s.annotations.map((a) => a.text), ['开场', '起飞']);
});

test('normalizeSceneTree: every sub-scene is a full independent scene', () => {
  const t = normalizeSceneTree({
    sceneId: 'root',
    scenes: {
      root: { world: { seed: 4242 }, background: '#05070d', objects: [{ id: 'cam1', type: 'camera' }] },
      sc_1: { world: null, background: 'transparent', objects: [{ id: 'el', type: 'text' }] },
    },
  });
  assert.equal(t.sceneId, 'root');
  assert.equal(t.scenes.root.world.seed, 4242);
  assert.equal(t.scenes.root.background, '#05070d');
  assert.equal(t.scenes.sc_1.world, null);
  assert.equal(t.scenes.sc_1.background, 'transparent');
  // objects do not leak between scenes
  assert.equal(t.scenes.root.objects[0].type, 'camera');
  assert.equal(t.scenes.sc_1.objects.length, 1);
  assert.equal(t.scenes.sc_1.objects[0].type, 'text');
});

test('normalizeSceneTree: falls back to an empty root scene', () => {
  const t = normalizeSceneTree({});
  assert.equal(t.sceneId, 'root');
  assert.ok(t.scenes.root);
  assert.equal(t.scenes.root.background, 'transparent');
});
