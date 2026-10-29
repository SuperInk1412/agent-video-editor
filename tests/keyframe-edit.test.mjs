import test from 'node:test';
import assert from 'node:assert/strict';
import {
  keyframeMoveOps, normalizeFps, frameIndex, frameKeyTimeForFrame, snapKeyframeTimes,
} from '../core/keyframe-edit.js';
import * as rendererMath from '../app/renderer/js/timeline-math.js';
import {
  cameraRef, objectRef, elementRef, keyframeRef,
} from '../core/selection.js';
import { applyOp } from '../core/ops.js';

const kf = (host, path, t) => keyframeRef(host, path, t);
const elKf = (id, path, t) => kf(elementRef(id), path, t);
const obKf = (id, path, t) => kf(objectRef(id), path, t);
const camKf = (id, path, t) => kf(cameraRef(id), path, t);

/** Stored time for `t` moved by `frames` (what the eye should see). */
const at = (t, frames, fps = 24) => frameKeyTimeForFrame(frameIndex(t, fps) + frames, fps);

const project = ({ duration = 4, fps = 24 } = {}) => ({
  meta: { fps, duration },
  cameraOrder: ['cam_1'],
  activeCameraId: 'cam_1',
  cameras: [{
    id: 'cam_1',
    path: [
      { t: 0, pos: [0, 10, 0], look: null, fov: 50 },
      {
        t: 1,
        pos: [1, 10, 2],
        look: [0, 0, 0],
        fov: 40,
        ease: 'linear',
        out: [0.2, 0, 0],
        in: [0.1, 0, 0],
        speed: [[0, 1], [1, 1]],
      },
    ],
    tracks: {
      fov: [
        { t: 0, v: 50, ease: 'linear' },
        { t: 2, v: 70 },
      ],
    },
  }],
  camera: null,
  scene: {
    objects: [{
      id: 'ob_1',
      tracks: {
        pivot: [{ t: 1, v: [0, 0, 0], ease: 'linear', out: [1, 0, 0], in: [-1, 0, 0] }],
        'pivot.x': [{ t: 1, v: 3, ease: 'linear' }],
        'pivot.y': [{ t: 1, v: 4 }],
        'pivot.z': [{ t: 3, v: 1 }],
      },
    }],
  },
  elements: [
    {
      id: 'el_1',
      keyframes: [
        { t: 0.5, path: 'transform.scale', value: 1, ease: 'linear' },
        { t: 1.5, path: 'transform.scale', value: 2 },
      ],
    },
    {
      id: 'el_2',
      keyframes: [{ t: 0.5, path: 'transform.scale', value: 9 }],
    },
  ],
});

// The core copy exists so the renderer can import a pure module; it must stay
// bit-identical to the renderer's own timeline math.
test('keyframe-edit: core frame math mirrors app/renderer timeline-math', () => {
  for (const fps of [24, 25, 30, 60, 1, -2, 0, '30', undefined]) {
    assert.equal(normalizeFps(fps), rendererMath.normalizeFps(fps));
  }
  for (const fps of [24, 30, 60]) {
    for (let f = 0; f <= 240; f++) {
      assert.equal(
        frameKeyTimeForFrame(f, fps),
        rendererMath.frameKeyTimeForFrame(f, fps),
        `frame ${f} @ ${fps}`,
      );
      const t = f / fps;
      assert.equal(frameIndex(t, fps), rendererMath.frameIndex(t, fps), `t ${t} @ ${fps}`);
    }
  }
});

test('keyframe-edit: one element track moves by whole frames, value/ease kept', () => {
  const p = project();
  const res = keyframeMoveOps([elKf('el_1', 'transform.scale', 0.5)], 1, p, 24);
  assert.equal(res.error, null);
  assert.equal(res.deltaFrames, 1);
  assert.equal(res.moves.length, 1);
  const to = at(0.5, 1);
  assert.equal(to, 0.542, '24fps frame 12 -> 13 stores ceil-ms 0.542');
  assert.deepEqual(res.moves[0], {
    ref: 'el:el_1:transform.scale:0.5',
    refNew: 'el:el_1:transform.scale:0.542',
    type: 'el',
    id: 'el_1',
    path: 'transform.scale',
    t: 0.5,
    to,
  });
  assert.deepEqual(res.ops, [
    { op: 'keyRemove', id: 'el_1', path: 'transform.scale', t: 0.5 },
    { op: 'keySet', id: 'el_1', path: 'transform.scale', t: to, value: 1, ease: 'linear' },
  ]);
  // One drag = one batch = one save / one undo step.
  assert.equal(res.batch.op, 'batch');
  assert.deepEqual(res.batch.ops, res.ops);

  applyOp(p, res.batch);
  assert.deepEqual(p.elements[0].keyframes.map((k) => k.t), [to, 1.5]);
  assert.equal(p.elements[0].keyframes[0].value, 1);
  assert.equal(p.elements[0].keyframes[0].ease, 'linear');
  // The untouched element is not part of the move.
  assert.deepEqual(p.elements[1].keyframes.map((k) => k.t), [0.5]);
});

test('keyframe-edit: all selected keys of one track travel together', () => {
  const p = project();
  const res = keyframeMoveOps([
    elKf('el_1', 'transform.scale', 0.5),
    elKf('el_1', 'transform.scale', 1.5),
  ], 2, p, 24);
  assert.equal(res.error, null);
  assert.equal(res.moves.length, 2);
  applyOp(p, res.batch);
  assert.deepEqual(p.elements[0].keyframes.map((k) => k.t), [at(0.5, 2), at(1.5, 2)]);
  assert.deepEqual(p.elements[0].keyframes.map((k) => k.value), [1, 2]);
});

test('keyframe-edit: a object pivot dot expands to every axis track, handles kept', () => {
  const p = project();
  const res = keyframeMoveOps([obKf('ob_1', 'pivot', 1)], 1, p, 24);
  assert.equal(res.error, null);
  const to = at(1, 1);
  assert.deepEqual(res.ops, [
    { op: 'objectUnkey', id: 'ob_1', path: 'pivot', t: 1 },
    { op: 'objectUnkey', id: 'ob_1', path: 'pivot.x', t: 1 },
    { op: 'objectUnkey', id: 'ob_1', path: 'pivot.y', t: 1 },
    {
      op: 'objectKey',
      id: 'ob_1',
      path: 'pivot',
      t: to,
      v: [0, 0, 0],
      ease: 'linear',
      out: [1, 0, 0],
      in: [-1, 0, 0],
    },
    { op: 'objectKey', id: 'ob_1', path: 'pivot.x', t: to, v: 3, ease: 'linear' },
    { op: 'objectKey', id: 'ob_1', path: 'pivot.y', t: to, v: 4 },
  ]);
  applyOp(p, res.batch);
  const tracks = p.scene.objects[0].tracks;
  assert.deepEqual(tracks.pivot.map((k) => k.t), [to]);
  assert.deepEqual(tracks['pivot.x'].map((k) => k.t), [to]);
  assert.deepEqual(tracks['pivot.y'].map((k) => k.t), [to]);
  // pivot.z had no key at 1: it is not dragged along.
  assert.deepEqual(tracks['pivot.z'].map((k) => k.t), [3]);
  assert.deepEqual(tracks.pivot[0].out, [1, 0, 0]);
  assert.deepEqual(tracks.pivot[0].in, [-1, 0, 0]);
  assert.equal(tracks['pivot.x'][0].v, 3);
});

test('keyframe-edit: camera parameter keys keep value and ease', () => {
  const p = project();
  const res = keyframeMoveOps([camKf('cam_1', 'fov', 0)], 1, p, 24);
  assert.equal(res.error, null);
  const to = at(0, 1);
  assert.deepEqual(res.ops, [
    { op: 'cameraParamUnkey', id: 'cam_1', path: 'fov', t: 0 },
    { op: 'cameraParamKey', id: 'cam_1', path: 'fov', t: to, v: 50, ease: 'linear' },
  ]);
  applyOp(p, res.batch);
  assert.deepEqual(p.cameras[0].tracks.fov.map((k) => k.t), [to, 2]);
  assert.equal(p.cameras[0].tracks.fov[0].v, 50);
  assert.equal(p.cameras[0].tracks.fov[0].ease, 'linear');
});

test('keyframe-edit: camera path key keeps pos/look/fov/ease/handles/speed', () => {
  const p = project();
  const res = keyframeMoveOps([camKf('cam_1', 'path', 1)], 1, p, 24);
  assert.equal(res.error, null);
  const to = at(1, 1);
  assert.deepEqual(res.ops, [
    { op: 'cameraRemove', id: 'cam_1', t: 1 },
    {
      op: 'cameraKey',
      id: 'cam_1',
      t: to,
      pos: [1, 10, 2],
      look: [0, 0, 0],
      fov: 40,
      ease: 'linear',
      out: [0.2, 0, 0],
      in: [0.1, 0, 0],
      speed: [[0, 1], [1, 1]],
    },
  ]);
  applyOp(p, res.batch);
  const keys = p.cameras[0].path;
  assert.deepEqual(keys.map((k) => k.t), [0, to]);
  const moved = keys[1];
  assert.deepEqual(moved.pos, [1, 10, 2]);
  assert.deepEqual(moved.look, [0, 0, 0]);
  assert.equal(moved.fov, 40);
  assert.equal(moved.ease, 'linear');
  assert.deepEqual(moved.out, [0.2, 0, 0]);
  assert.deepEqual(moved.in, [0.1, 0, 0]);
  assert.deepEqual(moved.speed, [[0, 1], [1, 1]]);
});

test('keyframe-edit: camera path curve spans are refused, never silently cleared', () => {
  const p = project();
  const cam = p.cameras[0];
  cam.path = [
    { t: 0, pos: [0, 0, 0] },
    { t: 1, pos: [1, 0, 0], curve: { preset: 'easeInOut' }, spanTo: 2 },
    { t: 1.5, pos: [2, 0, 0] },
    { t: 2, pos: [3, 0, 0] },
  ];
  for (const t of [1, 1.5, 2]) {
    const res = keyframeMoveOps([camKf('cam_1', 'path', t)], 1, p, 24);
    assert.deepEqual(res.ops, [], `key at ${t} must be refused`);
    assert.match(res.error, /曲线段/);
    assert.equal(res.batch, null);
  }
  // A key outside the span is still movable, and the span survives untouched.
  const res = keyframeMoveOps([camKf('cam_1', 'path', 0)], 1, p, 24);
  assert.equal(res.error, null);
  applyOp(p, res.batch);
  const curved = p.cameras[0].path.find((k) => k.t === 1);
  assert.equal(curved.curve.preset, 'easeInOut');
  assert.equal(curved.spanTo, 2);
});

test('keyframe-edit: landing on an unselected key rejects the whole move', () => {
  const p = project();
  const res = keyframeMoveOps([elKf('el_1', 'transform.scale', 0.5)], 24, p, 24);
  assert.deepEqual(res.ops, []);
  assert.equal(res.batch, null);
  assert.deepEqual(res.moves, []);
  assert.match(res.error, /冲突/);
  // The project is never touched by a rejected move.
  assert.deepEqual(p.elements[0].keyframes.map((k) => k.t), [0.5, 1.5]);
});

test('keyframe-edit: two selected keys collapsing onto one frame are rejected', () => {
  const p = project();
  p.elements[0].keyframes = [
    { t: 0.5, path: 'transform.scale', value: 1 },
    { t: 0.505, path: 'transform.scale', value: 2 },
  ];
  // Both sit in frame 12 at 24fps; +1 frame would put both on frame 13.
  const res = keyframeMoveOps([
    elKf('el_1', 'transform.scale', 0.5),
    elKf('el_1', 'transform.scale', 0.505),
  ], 1, p, 24);
  assert.deepEqual(res.ops, []);
  assert.match(res.error, /多个键/);
});

test('keyframe-edit: cross-host moves stay in their own host and track', () => {
  const p = project();
  const refs = [
    elKf('el_1', 'transform.scale', 0.5),
    obKf('ob_1', 'pivot', 1),
    camKf('cam_1', 'fov', 0),
    camKf('cam_1', 'path', 1),
  ];
  const res = keyframeMoveOps(refs, 2, p, 24);
  assert.equal(res.error, null);
  assert.equal(res.moves.length, 4);
  assert.equal(res.batch.op, 'batch');
  // Every op addresses the host of the ref it came from; no cross-host writes.
  const ids = new Set(res.ops.map((o) => o.id));
  assert.deepEqual([...ids].sort(), ['cam_1', 'el_1', 'ob_1']);
  assert.equal(res.ops.filter((o) => o.id === 'el_1').length, 2);
  assert.equal(res.ops.filter((o) => o.id === 'ob_1').length, 6);
  assert.equal(res.ops.filter((o) => o.id === 'cam_1').length, 4);

  applyOp(p, res.batch);
  assert.deepEqual(p.elements[0].keyframes.map((k) => k.t), [at(0.5, 2), 1.5]);
  for (const name of ['pivot', 'pivot.x', 'pivot.y']) {
    assert.deepEqual(p.scene.objects[0].tracks[name].map((k) => k.t), [at(1, 2)]);
  }
  assert.deepEqual(p.scene.objects[0].tracks['pivot.z'].map((k) => k.t), [3]);
  assert.deepEqual(p.cameras[0].tracks.fov.map((k) => k.t), [at(0, 2), 2]);
  assert.deepEqual(p.cameras[0].path.map((k) => k.t), [0, at(1, 2)]);
});

test('keyframe-edit: 30fps moves keep the intended frame after 3-decimal storage', () => {
  const p = project({ fps: 30, duration: 4 });
  p.elements[0].keyframes = [{ t: 0.2, path: 'transform.scale', value: 1 }];
  // 0.2 is frame 6; frame 7 stores as 0.234 because round3(7/30) = 0.233
  // would be read back as frame 6 again.
  assert.equal(Math.round((7 / 30) * 1000) / 1000, 0.233);
  const res = keyframeMoveOps([elKf('el_1', 'transform.scale', 0.2)], 1, p, 30);
  assert.equal(res.error, null);
  assert.equal(res.moves[0].to, 0.234);
  assert.equal(frameIndex(res.moves[0].to, 30), 7);
  assert.equal(frameKeyTimeForFrame(7, 30), 0.234);
});

test('keyframe-edit: 0 / duration clamping moves the group as a block', () => {
  const p = project({ duration: 2 });
  p.elements[0].keyframes = [
    { t: 0.5, path: 'transform.scale', value: 1 },
    { t: 1.9, path: 'transform.scale', value: 2 },
  ];
  // The last key reaches the final frame, so the group stops: +3 frames, not +100.
  const res = keyframeMoveOps([
    elKf('el_1', 'transform.scale', 0.5),
    elKf('el_1', 'transform.scale', 1.9),
  ], 100, p, 24);
  assert.equal(res.error, null);
  assert.equal(res.deltaFrames, 3);
  assert.deepEqual(res.moves.map((m) => m.to), [at(0.5, 3), 2]);
  applyOp(p, res.batch);
  assert.deepEqual(p.elements[0].keyframes.map((k) => k.t), [0.625, 2]);

  // Already at 0 / duration: nothing to move, not an error.
  p.elements[0].keyframes.unshift({ t: 0, path: 'transform.scale', value: 0 });
  const atStart = keyframeMoveOps([elKf('el_1', 'transform.scale', 0)], -10, p, 24);
  assert.equal(atStart.error, null);
  assert.deepEqual(atStart.ops, []);
  const atEnd = keyframeMoveOps([elKf('el_1', 'transform.scale', 2)], 10, p, 24);
  assert.equal(atEnd.error, null);
  assert.deepEqual(atEnd.ops, []);
});

test('keyframe-edit: empty / stale refs are harmless no-ops', () => {
  const p = project();
  for (const refs of [[], null, ['nonsense'], ['el:missing:transform.scale:0'], ['el:el_1:nope:0.5']]) {
    const res = keyframeMoveOps(refs, 5, p, 24);
    assert.equal(res.error, null);
    assert.deepEqual(res.ops, []);
    assert.equal(res.batch, null);
  }
  // Zero / NaN deltas never produce ops.
  for (const delta of [0, NaN, 'nope']) {
    const res = keyframeMoveOps([elKf('el_1', 'transform.scale', 0.5)], delta, p, 24);
    assert.deepEqual(res.ops, []);
    assert.equal(res.error, null);
  }
});

test('keyframe-edit: a key value curve follows the moved key', () => {
  const p = project();
  p.elements[0].keyframes = [
    { t: 0.5, path: 'transform.scale', value: 1, ease: 'linear', curve: { preset: 'easeInOut' } },
    { t: 1.5, path: 'transform.scale', value: 2 },
  ];
  const res = keyframeMoveOps([elKf('el_1', 'transform.scale', 0.5)], 1, p, 24);
  assert.equal(res.error, null);
  const to = at(0.5, 1);
  const curveOp = res.ops.find((o) => o.op === 'keyCurve');
  assert.deepEqual(curveOp, {
    op: 'keyCurve',
    host: 'element',
    id: 'el_1',
    path: 'transform.scale',
    from: to,
    to: 1.5,
    curve: { preset: 'easeInOut' },
  });
  applyOp(p, res.batch);
  const moved = p.elements[0].keyframes.find((k) => k.t === to);
  assert.equal(moved.curve.type, 'bezier');
  assert.equal(moved.curve.preset, 'easeInOut');
  assert.equal(moved.value, 1);
  assert.equal(moved.ease, 'linear');
});

test('keyframe-edit: 3D / camera-param curves are re-attached with their host', () => {
  const p = project();
  p.cameras[0].tracks.fov = [
    { t: 0, v: 50, curve: { preset: 'easeIn' } },
    { t: 2, v: 70 },
  ];
  p.scene.objects[0].tracks['pivot.x'] = [
    { t: 0, v: 3, curve: { preset: 'easeOut' } },
    { t: 1, v: 4 },
  ];
  const res = keyframeMoveOps([
    camKf('cam_1', 'fov', 0),
    obKf('ob_1', 'pivot', 0),
  ], 1, p, 24);
  assert.equal(res.error, null);
  const curves = res.ops.filter((o) => o.op === 'keyCurve');
  assert.deepEqual(curves.map((o) => [o.host, o.path, o.from, o.to]), [
    ['camera', 'fov', at(0, 1), 2],
    ['object', 'pivot.x', at(0, 1), 1],
  ]);
  applyOp(p, res.batch);
  assert.equal(p.scene.objects[0].tracks['pivot.x'][0].curve.preset, 'easeOut');
  assert.equal(p.cameras[0].tracks.fov[0].curve.preset, 'easeIn');
  assert.deepEqual(p.cameras[0].tracks.fov.map((k) => k.t), [at(0, 1), 2]);
});

test('keyframe-edit: snapKeyframeTimes leaves whole-frame times alone', () => {
  const res = snapKeyframeTimes([0.5, 1, 1.5], { fps: 24 });
  assert.deepEqual(res.times, [0.5, 1, 1.5]);
  assert.equal(res.moved, 0);
  assert.deepEqual(snapKeyframeTimes([], {}), { times: [], moved: 0 });
});

test('keyframe-edit: snapKeyframeTimes pulls off-grid inner keys to the nearest frame', () => {
  // 24 fps: frame 24 is 1.000s, frame 25 is 1.042s.
  const res = snapKeyframeTimes([1.02, 1.6], { fps: 24 });
  assert.deepEqual(res.times, [1, 1.584]);
  assert.equal(res.moved, 2);
});

test('keyframe-edit: colliding frames slide forward instead of stacking', () => {
  // 0.010s and 0.020s both round to frame 0.
  const res = snapKeyframeTimes([0.01, 0.02], { fps: 24 });
  assert.deepEqual(res.times, [0, 0.042]);
  for (let i = 1; i < res.times.length; i++) {
    assert.ok(res.times[i] > res.times[i - 1], 'strictly increasing');
  }
});

test('keyframe-edit: snapKeyframeTimes refuses when the anchor leaves no room', () => {
  assert.equal(snapKeyframeTimes([0.01, 0.02], { fps: 24, from: 0, to: 0.03 }), null,
    'the second key would have to land past the anchor');
  const ok = snapKeyframeTimes([0.2], { fps: 24, from: 0, to: 2 });
  assert.deepEqual(ok.times, [0.209]);
});
