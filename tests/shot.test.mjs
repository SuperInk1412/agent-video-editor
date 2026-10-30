import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProject } from '../core/schema.js';
import {
  bakeObjects, buildShot, buildShotV3, frameFromShotV3, loadProjectFonts, shotV3FrameItems, worldSnapshot,
} from '../engine/shot.js';
import { elementV3, unpackV3 } from '../engine/element-bake.js';
import { FRAME_IR_VERSION, buildFrameIR } from '../core/frame-ir.js';
import { compileProject } from '../core/tracks.js';
import { RENDER_PLAN_VERSION } from '../core/version.js';
import { applyOp } from '../core/ops.js';

const root = path.resolve(import.meta.dirname, '..');

const project = () => normalizeProject({
  schema: 'vdm.project/1', rev: 1,
  meta: { title: 'layers', fps: 24, width: 320, height: 180, duration: 1, background: '#000' },
  segments: [], elements: [],
  cameras: [
    {
      id: 'cam_top', name: '顶', visible: true,
      path: [{ t: 0, pos: [0, 10, 0] }, { t: 1, pos: [0, 10, -20] }],
      opacity: 0.8,
      tracks: {
        scale: [{ t: 0, v: [0.5, 0.5, 1] }],
        pictureOffset: [{ t: 0, v: [0.1, -0.2] }],
      },
    },
    {
      id: 'cam_bottom', name: '底', visible: true,
      path: [{ t: 0, pos: [5, 20, 0] }, { t: 1, pos: [5, 20, -20] }],
    },
    {
      id: 'cam_hidden', name: '藏', visible: false,
      path: [{ t: 0, pos: [9, 9, 9] }],
    },
  ],
  cameraOrder: ['cam_top', 'cam_bottom', 'cam_hidden'],
  activeCameraId: 'cam_top',
  world: {},
});

test('buildShot exposes one baked layer per visible camera, top first', () => {
  const shot = buildShot(project(), { fps: 24, from: 0, to: 1 });
  assert.deepEqual(shot.cameraLayers.map((l) => l.id), ['cam_top', 'cam_bottom']);
  assert.equal(shot.cameraLayers[0].frames.length, 25);
  assert.equal(shot.cameraLayers[0].frames[0].f, 1);
  assert.equal(shot.cameraLayers[0].frames[0].opacity, 0.8);
  assert.deepEqual(shot.cameraLayers[0].frames[0].scale, [0.5, 0.5]);
  assert.deepEqual(shot.cameraLayers[0].frames[0].pictureOffset, [0.1, -0.2]);
  assert.equal(shot.cameraLayers[0].camera.length, 25);
  assert.ok(shot.cameraLayers[0].camera[0].dof);
  // legacy camera remains the active camera's bake
  assert.equal(shot.camera.length, 25);
  assert.deepEqual(shot.camera[0].pos, shot.cameraLayers[0].camera[0].pos);
});

test('hidden 3D objects do not appear in the render package', () => {
  const p = project();
  applyOp(p, { op: 'objectAdd', object: { id: 'hidden', type: 'solid', visible: false, duration: 1 } });
  applyOp(p, { op: 'objectAdd', object: { id: 'shown', type: 'solid', duration: 1 } });
  const baked = bakeObjects(p);
  assert.deepEqual(baked.map((obj) => obj.id), ['shown']);
  assert.equal(baked[0].frames[0].opacity, 1);
  assert.equal(baked[0].frames.at(-1).opacity, 0, 'the time range has an exclusive end');
});

test('worldSnapshot: a parented camera carries its parent animation into the city', () => {
  // The corridor clearing follows where the cameras fly. A camera parented to a
  // 3D object flies with that object's tracks, so the parent's animation is part
  // of the city's input — this is what the /api/world cache key has to include.
  const p = project();
  const ob = applyOp(p, {
    op: 'objectAdd',
    object: { type: 'empty', start: 0, duration: 1, pivot: [0, 10, 0] },
  }).changed[0];
  applyOp(p, { op: 'objectKey', id: ob, path: 'rotation.y', t: 0, v: 0, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: ob, path: 'rotation.y', t: 1, v: 90 });
  applyOp(p, { op: 'spatialParent', id: 'cam_top', parent: ob, t: 0 });
  const animated = worldSnapshot(p).hash;

  // Flatten the animation: same project, same rev, different flight corridor.
  applyOp(p, { op: 'objectKey', id: ob, path: 'rotation.y', t: 1, v: 0 });
  const still = worldSnapshot(p).hash;
  assert.notEqual(animated, still, 'the city bake follows the parented camera');
});

test('viewport, full render and partial render share one full-shot city', () => {
  const p = project();
  p.meta.fps = 12;
  p.cameras[1].path = [{ t: 0, pos: [140, 8, 0] }, { t: 1, pos: [140, 8, -150] }];
  const world = worldSnapshot(p);
  assert.deepEqual(buildShot(p).city, world);
  assert.deepEqual(buildShot(p, { from: 0.5, to: 0.75 }).city, world);
  p.activeCameraId = 'cam_bottom';
  p.camera = p.cameras[1];
  assert.deepEqual(worldSnapshot(p), world, 'selecting the edit camera does not change world geometry');
});

// -------------------------------------------------- shot v3 (WP1.1, DESIGN §10.2)
//
// The v3 half of the package is the frame IR compressed to `{ static, tracks }`
// records. What these tests pin:
//   * the frame base (render frame `f` = IR frame `f - 1`, §4.4) and the frame
//     count matching the legacy bakes;
//   * losslessness: `frameFromShotV3(v3, f + 1)` rebuilds every field of
//     `buildFrameIR(p, f)` — items (set, order, world, size, opacity, depth,
//     content), camera, cameraLayers, objects3d, size, world, fx — at 1e-9
//     (matrices at the 1e-6 §4.4 grants them);
//   * static fields written once, per-frame values only for fields that really
//     move (a translating matrix is 3 index tracks, not a copy per frame);
//   * an element that blinks out mid-life becomes two records (dense tracks
//     need contiguous spans);
//   * the deliberately baked hidden tail frame (commit e82f7d1) is untouched:
//     the legacy object bake keeps it, v3 carries the boundary state instead.

const near = (got, want, path, frame, tol) => {
  const t = /(^|\.)world($|\.)/.test(path) ? 1e-6 : 1e-9;
  assert.ok(Math.abs(got - want) <= Math.min(t, tol ?? Infinity),
    `frame ${frame} ${path}: ${got} vs ${want} (|Δ| ${Math.abs(got - want).toExponential(2)})`);
};

/** Compare an IR frame with a v3 rebuild, field by field. */
function sameFrame(got, want, frame) {
  const walk = (a, b, p) => {
    if (typeof a === 'number' && typeof b === 'number') return near(a, b, p, frame);
    if (Array.isArray(a) || Array.isArray(b)) {
      assert.ok(Array.isArray(a) && Array.isArray(b), `frame ${frame} ${p}: array shape`);
      assert.equal(a.length, b.length, `frame ${frame} ${p}: length`);
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${p}.${i}`);
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `frame ${frame} ${p}: keys`);
      for (const k of Object.keys(a)) walk(a[k], b[k], p ? `${p}.${k}` : k);
      return;
    }
    assert.deepEqual(a, b, `frame ${frame} ${p}`);
  };
  walk(got, want, '');
}

/** Everything the v3 pack has to carry: node / legacy / text layers, a hole in
 *  presence, a moving 3D object and two overlapping cameras. */
function v3Project() {
  const p = normalizeProject({
    schema: 'vdm.project/1', rev: 9,
    meta: {
      title: 'v3', fps: 12, width: 640, height: 360, duration: 1.5, background: '#000',
      fx: { bloom: 0.4, ca: 0.1, grain: 0.2, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 0.9 },
    },
    segments: [], elements: [],
    cameras: [
      {
        id: 'cam_a', name: 'A', visible: true, start: 0, duration: 1.5,
        path: [{ t: 0, pos: [0, 5, 18], look: [0, 5, 0] }, { t: 1.5, pos: [1, 6, 14], look: [0, 5, 0] }],
      },
      {
        id: 'cam_b', name: 'B', visible: true, start: 0.5, duration: 1,
        path: [{ t: 0.5, pos: [6, 4, 10], look: [0, 4, 0] }],
      },
    ],
    cameraOrder: ['cam_a', 'cam_b'],
    activeCameraId: 'cam_a',
    world: { source: 'none' },
  });
  applyOp(p, {
    op: 'addElement',
    element: {
      id: 'el_node', type: 'solid', start: 0, duration: 1.5, z: 2,
      node: { pivot: [1, 6, 0], position: [0, 0, 0], rotation: [0, 20, 0], scale: [1, 1, 1] },
      style: { w: 200, h: 100, fill: '#ff2020' },
    },
  });
  // node plane that only translates: its world track is 1..3 indices, not 16
  applyOp(p, { op: 'keySet', id: 'el_node', path: 'transform.x', t: 0, value: 0, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: 'el_node', path: 'transform.x', t: 1.5, value: 120, ease: 'linear' });
  // a plain legacy layer: screen-derived world, moving in x only
  applyOp(p, {
    op: 'addElement',
    element: {
      id: 'el_flat', type: 'solid', start: 0, duration: 1.5, z: 1,
      transform: { x: -100, y: 60, z: 0.5, scale: 1.5, rotation: 15, opacity: 0.4 },
      style: { w: 300, h: 120, fill: '#00ff00' },
    },
  });
  applyOp(p, { op: 'keySet', id: 'el_flat', path: 'transform.x', t: 0, value: -100, ease: 'linear' });
  applyOp(p, { op: 'keySet', id: 'el_flat', path: 'transform.x', t: 1.5, value: 100, ease: 'linear' });
  // text that typesets itself (size null) and counts up
  applyOp(p, {
    op: 'addElement',
    element: {
      id: 'el_text', type: 'text', start: 0.25, duration: 1, z: 3,
      transform: { x: 0, y: -40 }, style: { text: '0', size: 64, color: '#ffffff', font: 'SimHei' },
    },
  });
  applyOp(p, { op: 'keySet', id: 'el_text', path: 'style.text', t: 0.3, value: '1' });
  applyOp(p, { op: 'keySet', id: 'el_text', path: 'style.text', t: 1.2, value: '7' });
  // blinks out mid-life: presence has a hole, so v3 must split the record
  applyOp(p, {
    op: 'addElement',
    element: {
      id: 'el_blink', type: 'solid', start: 0, duration: 1.5, z: 0,
      transform: { x: 0, y: 0 }, style: { w: 120, h: 80, fill: '#2040ff' },
    },
  });
  applyOp(p, { op: 'keySet', id: 'el_blink', path: 'transform.opacity', t: 0, value: 1 });
  applyOp(p, { op: 'keySet', id: 'el_blink', path: 'transform.opacity', t: 0.25, value: 1 });
  applyOp(p, { op: 'keySet', id: 'el_blink', path: 'transform.opacity', t: 0.4, value: 0 });
  applyOp(p, { op: 'keySet', id: 'el_blink', path: 'transform.opacity', t: 0.55, value: 0 });
  applyOp(p, { op: 'keySet', id: 'el_blink', path: 'transform.opacity', t: 0.7, value: 1 });
  // a 3D box that moves and whose life ends exactly at the project end
  applyOp(p, {
    op: 'objectAdd',
    object: {
      id: 'ob_box', type: 'solid', start: 0, duration: 1.5,
      pivot: [0, 2, 0], geom: { w: 1, h: 1, d: 1 }, style: { color: '#ffe020', emissive: 1 },
    },
  });
  applyOp(p, { op: 'objectKey', id: 'ob_box', path: 'pivot.y', t: 0, v: 2, ease: 'linear' });
  applyOp(p, { op: 'objectKey', id: 'ob_box', path: 'pivot.y', t: 1.5, v: 4 });
  return p;
}

test('shot v3: version, frame base and the legacy fields beside it', () => {
  const p = v3Project();
  const shot = buildShot(p);
  assert.equal(RENDER_PLAN_VERSION, 3);
  assert.equal(shot.version, 3);
  assert.equal(shot.v3.version, 3);
  // render frame f = IR frame f - 1, one past the exclusive end (hidden state)
  assert.equal(shot.v3.f0, 1);
  assert.equal(shot.v3.f1, Math.round(p.meta.duration * p.meta.fps) + 1);
  assert.equal(shot.v3.frames, shot.camera.length);
  assert.equal(shot.v3.frames, shot.v3.f1 - shot.v3.f0 + 1);
  assert.equal(shot.v3.fps, p.meta.fps);
  assert.equal(shot.v3.rev, p.rev);
  assert.deepEqual(shot.v3.size, [p.meta.width, p.meta.height]);
  assert.equal(shot.v3.irVersion, FRAME_IR_VERSION);
  const first = frameFromShotV3(shot.v3, shot.v3.f0);
  assert.equal(first.frame, 0);
  assert.equal(first.t, 0);
  assert.deepEqual(shotV3FrameItems(shot.v3, 5).map((i) => i.id), frameFromShotV3(shot.v3, 5).items.map((i) => i.id));
  // the package is plain JSON, and decoding does not mutate it
  const copy = JSON.parse(JSON.stringify(shot.v3));
  assert.deepEqual(copy, shot.v3);
  const a = frameFromShotV3(shot.v3, 5);
  const b = frameFromShotV3(copy, 5);
  assert.deepEqual(a, b);
  // legacy fields are untouched and still there (vdm_build.py's input)
  for (const key of ['camera', 'cameraLayers', 'objects', 'city', 'fx', 'cameraCfg', 'width', 'height', 'fps', 'frames']) {
    assert.ok(key in shot, `legacy field ${key} must stay`);
  }
});

test('shot v3: every frame rebuilds the frame IR it was packed from', () => {
  const p = v3Project();
  const shot = buildShot(p);
  const v3 = shot.v3;
  // the pack carries the city snapshot it was baked with; the IR only learns
  // that hash through `opts.city` (WP0.1 cache key), so compare like for like
  const city = { hash: v3.world.hash };
  for (let f = 0; f < v3.frames; f++) {
    // the IR as JSON: a key whose value is `undefined` is not a JSON value, so
    // the package (and its reader) cannot carry it either
    const want = JSON.parse(JSON.stringify(buildFrameIR(p, f, { fps: p.meta.fps, city })));
    const got = frameFromShotV3(v3, f + 1);
    assert.deepEqual(got.items.map((i) => i.id), want.items.map((i) => i.id), `frame ${f}: item set / order`);
    sameFrame(got.items, want.items, f);
    sameFrame(got.camera, want.camera, f);
    sameFrame(got.cameraLayers, want.cameraLayers, f);
    sameFrame(got.objects3d, want.objects3d, f);
    sameFrame(got.screenFx, want.screenFx, f);
    sameFrame(got.size, want.size, f);
    sameFrame(got.world, want.world, f);
    assert.equal(got.frame, want.frame);
    assert.equal(got.t, want.t);
  }
});

test('shot v3: static values are written once, only moving fields get tracks', () => {
  const p = v3Project();
  const v3 = buildShot(p).v3;
  const rec = (id) => v3.items.filter((r) => r.id === id);

  // the node plane only slides along x: the matrix lives in `static` once and
  // exactly one index column gets per-frame values
  const [node] = rec('el_node');
  assert.ok(Array.isArray(node.static.world) && node.static.world.length === 16, 'the matrix is written once');
  assert.ok(!('world' in node.tracks), 'the whole matrix must not be a track');
  const nodeTracks = Object.keys(node.tracks).sort();
  assert.deepEqual(nodeTracks.filter((k) => k.startsWith('world.')), ['world.12']);
  // its own fields that never change are static, not tracks
  for (const field of ['kind', 'src', 'z', 'size', 'crop', 'blend']) {
    assert.ok(field in node.static, `${field} is static`);
    assert.ok(!(field in node.tracks), `${field} must not be a track`);
  }

  // a layer whose camera-facing placement moves in x as well
  const [flat] = rec('el_flat');
  assert.ok(flat.static.world.length === 16);
  assert.ok(Object.keys(flat.tracks).some((k) => k.startsWith('world.')));

  // text: `size` is null (the content typesets itself) and the text itself moves
  const [text] = rec('el_text');
  assert.equal(text.static.size, null);
  assert.ok(text.tracks['content.text'] || text.static['content']?.text, 'the counting text is carried');

  // counts: a naive dense pack would write 16 numbers per element per frame
  const frames = v3.frames;
  const denseWorld = 16 * v3.items.reduce((a, r) => a + (r.span[1] - r.span[0] + 1), 0);
  let written = 0;
  const numbers = (v) => {
    if (typeof v === 'number') written++;
    else if (Array.isArray(v)) v.forEach(numbers);
    else if (v && typeof v === 'object') Object.values(v).forEach(numbers);
  };
  for (const r of v3.items) {
    numbers(r.static);
    for (const t of Object.values(r.tracks)) numbers(t.values);
  }
  assert.ok(written < denseWorld / 2, `${written} numbers written vs ${denseWorld} dense (${frames} frames)`);
});

test('shot v3: a hole in presence splits the record, dense tracks stay whole', () => {
  const p = v3Project();
  const v3 = buildShot(p).v3;
  const blink = v3.items.filter((r) => r.id === 'el_blink');
  assert.equal(blink.length, 2, 'an element that leaves and comes back is two records');
  assert.ok(blink[0].span[1] < blink[1].span[0], 'the spans do not overlap');
  assert.ok(blink[0].span[0] < blink[0].span[1] && blink[1].span[0] < blink[1].span[1]);
  // every track is dense across its record's span
  for (const r of blink) {
    for (const t of Object.values(r.tracks)) {
      assert.equal(t.f0, r.span[0]);
      assert.equal(t.values.length, r.span[1] - r.span[0] + 1);
    }
  }
  // the hole itself decodes to "not drawn"
  for (let f = blink[0].span[1] + 1; f < blink[1].span[0]; f++) {
    assert.equal(unpackV3(blink[0], f), null);
    assert.equal(unpackV3(blink[1], f), null);
  }
});

test('shot v3: the hidden tail frame (e82f7d1) keeps its meaning', () => {
  const p = v3Project();
  const shot = buildShot(p);
  // legacy: one extra baked frame past the exclusive end, carrying the hidden state
  assert.equal(shot.objects[0].frames.length, shot.v3.frames);
  assert.equal(shot.objects[0].frames.at(-1).opacity, 0);
  // v3: the object's record ends before the boundary frame, the boundary itself
  // is present in the package (an empty draw list, not a stale pose)
  const [box] = shot.v3.objects;
  assert.equal(box.id, 'ob_box');
  assert.ok(box.span[1] < shot.v3.f1, 'the object is gone at t = duration');
  assert.deepEqual(frameFromShotV3(shot.v3, shot.v3.f1).objects3d, []);
  assert.deepEqual(frameFromShotV3(shot.v3, shot.v3.f1 - 1).objects3d.map((o) => o.id), ['ob_box']);
});

test('shot v3: a partial render covers exactly its frames', () => {
  const p = v3Project();
  const fps = p.meta.fps;
  const shot = buildShot(p, { from: 0.5, to: 1 });
  const v3 = shot.v3;
  assert.equal(v3.f0, Math.round(0.5 * fps) + 1);
  assert.equal(v3.f1, Math.round(1 * fps) + 1);
  assert.equal(v3.frames, v3.f1 - v3.f0 + 1);
  assert.equal(v3.frames, shot.camera.length);
  for (let f = v3.f0; f <= v3.f1; f++) {
    const want = buildFrameIR(p, f - 1, { fps });
    const got = frameFromShotV3(v3, f);
    assert.deepEqual(got.items.map((i) => i.id), want.items.map((i) => i.id), `frame ${f}`);
  }
  // outside the baked window there is nothing to read
  assert.deepEqual(frameFromShotV3(v3, v3.f0 - 1).items, []);
  assert.deepEqual(frameFromShotV3(v3, v3.f1 + 1).items, []);
});

test('shot v3: elementV3 bakes one element from the same IR numbers', () => {
  const p = v3Project();
  const shot = buildShot(p);
  const [fromHelper] = elementV3(p, p.elements.find((el) => el.id === 'el_node'), { fps: p.meta.fps });
  const [fromShot] = shot.v3.items.filter((r) => r.id === 'el_node');
  assert.deepEqual(fromHelper.span, fromShot.span);
  assert.deepEqual(Object.keys(fromHelper.tracks).sort(), Object.keys(fromShot.tracks).sort());
  // the baked world is the IR's world (and elementPixelMatrix's), at the 1e-6
  // tolerance §4.4 grants the matrix
  for (let f = fromHelper.span[0]; f <= fromHelper.span[1]; f++) {
    const item = unpackV3(fromHelper, f);
    const want = buildFrameIR(p, f - 1, { fps: p.meta.fps }).items.find((it) => it.id === 'el_node');
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(item.world[i] - want.world[i]) <= 1e-6);
  }
});

// The real project (138 elements, 8 cameras, 451 frames) is not shipped in the
// test run: copy it into `.scratch/` first (§11 rule 5) and this case runs.
// It is the WP1.1 acceptance itself — every frame decoded from the package must
// equal `buildFrameIR` at that frame.
test('shot v3: the whole miku-swiss copy round-trips (optional real data)', (t) => {
  const candidates = ['miku-swiss', 'wp0.1/miku-swiss', 'wp1.1/miku-swiss']
    .map((rel) => path.join(root, '.scratch', rel));
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'project.vdm.json')));
  if (!dir) {
    t.skip(`no miku-swiss copy (looked in ${candidates.map((c) => path.relative(root, c)).join(', ')})`);
    return;
  }
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.vdm.json'), 'utf8'));
  compileProject(p);
  const fps = Number(p.meta.fps) || 24;
  const last = Math.round((Number(p.meta.duration) || 1) * fps);
  const shot = buildShot(p);
  const v3 = shot.v3;
  const city = { hash: v3.world.hash };
  let pairs = 0;
  let worstWorld = 0;
  let worstOther = 0;
  for (let f = 0; f <= last; f++) {
    const want = JSON.parse(JSON.stringify(buildFrameIR(p, f, { fps, city })));
    const got = frameFromShotV3(v3, f + 1);
    assert.deepEqual(got.items.map((i) => i.id), want.items.map((i) => i.id), `frame ${f}: item set / order`);
    for (let i = 0; i < want.items.length; i++) {
      const [a, b] = [got.items[i], want.items[i]];
      pairs++;
      for (let k = 0; k < 16; k++) {
        const d = Math.abs(a.world[k] - b.world[k]);
        worstWorld = Math.max(worstWorld, d);
        assert.ok(d <= 1e-6, `frame ${f} ${a.id} world.${k}: ${d}`);
      }
      for (const key of ['size', 'crop', 'opacity', 'blend', 'z', 'src', 'kind', 'drawOrder', 'depth', 'content']) {
        assert.deepEqual(a[key], b[key], `frame ${f} ${a.id}.${key}`);
      }
      for (const [k, v] of Object.entries(b.content)) {
        if (typeof v === 'number') {
          worstOther = Math.max(worstOther, Math.abs(a.content[k] - v));
          assert.ok(Math.abs(a.content[k] - v) <= 1e-9, `frame ${f} ${a.id} content.${k}`);
        }
      }
    }
    sameFrame(got.camera, want.camera, f);
    sameFrame(got.cameraLayers, want.cameraLayers, f);
    sameFrame(got.objects3d, want.objects3d, f);
  }
  assert.ok(pairs > 1000, `${pairs} item-frame pairs`);
  assert.ok(worstWorld <= 1e-6 && worstOther <= 1e-9);
});


// ---------------------------------------------------------------- text meshes

/**
 * Text geometry (§4.4 v4, WP1.3): `buildShotV3` typesets the text in JS and the
 * package carries the glyph meshes, so Blender only builds a mesh from the same
 * vertices. The font is copied into the project's media so the test does not
 * depend on a system font being installed under the name it looks for.
 */
function textProjectWithFont() {
  const system = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
    .find((f) => fs.existsSync(f));
  if (!system) return null;
  // `.scratch/` is gitignored; a fresh checkout has no such directory.
  fs.mkdirSync(path.join(root, '.scratch'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.scratch', 'shot-text-'));
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.copyFileSync(system, path.join(dir, 'media', 'face.ttf'));
  const p = normalizeProject({
    schema: 'vdm.project/1', rev: 3,
    meta: { title: 'text', fps: 12, width: 640, height: 360, duration: 1.5, background: '#000' },
    segments: [], elements: [],
    cameras: [{ id: 'cam_a', name: 'A', visible: true, start: 0, duration: 1.5,
      path: [{ t: 0, pos: [0, 5, 18], look: [0, 5, 0] }] }],
    cameraOrder: ['cam_a'],
    activeCameraId: 'cam_a',
    world: { source: 'none' },
  });
  applyOp(p, {
    op: 'addElement',
    element: {
      id: 'el_text', type: 'text', start: 0, duration: 1.5, z: 1,
      transform: { x: 0, y: 0 },
      // ASCII only: the chain has this one face, and a character no font of the
      // chain maps keeps the old path on purpose (see the glyphs test).
      style: { text: 'Hi 42', font: 'media/face.ttf', size: 48, color: '#ffffff', align: 'center', lineHeight: 1.2 },
    },
  });
  return { p, dir };
}

test('shot v3: text meshes travel in the package and rebuild the same frame IR', (t) => {
  const made = textProjectWithFont();
  if (!made) { t.diagnostic?.('skipped: no system font to copy'); return; }
  const { p, dir } = made;
  try {
    const v3 = buildShotV3(p, { fps: 12, from: 0, to: 1.5, root: dir });
    const ids = Object.keys(v3.meshes);
    assert.ok(ids.length > 0, 'the package carries the glyph meshes');
    assert.equal(ids.length, 1, 'one geometry for one text / size / spacing / align');
    const record = v3.meshes[ids[0]];
    assert.ok(record.vertices.length > 0 && record.indices.length > 0);
    assert.ok(record.vertices.every(Number.isFinite));
    assert.ok(Array.isArray(record.size) && record.size[0] > 0);
    const frame = frameFromShotV3(v3, v3.f0 + 2);
    const item = frame.items.find((it) => it.id === 'el_text');
    assert.equal(item.content.mesh, ids[0], 'the item names its mesh');
    assert.deepEqual(item.size, record.size, 'the item box is the mesh box');
    assert.deepEqual(frame.meshes[ids[0]], record, 'the frame carries only the meshes it draws');
    // the package is plain JSON and survives a round trip
    const copy = JSON.parse(JSON.stringify(v3));
    assert.deepEqual(copy.meshes, v3.meshes);
    // the same IR built from the project alone produces the same mesh record
    const fonts = loadProjectFonts(p, dir);
    const want = buildFrameIR(p, v3.f0 + 1, { fps: 12, city: { hash: v3.world.hash }, fonts });
    assert.deepEqual(want.items.find((it) => it.id === 'el_text').content.mesh, item.content.mesh);
    assert.deepEqual(want.meshes[ids[0]], record, 'the package mesh is the IR mesh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shot v3: without the project root a text item keeps the v3 shape', (t) => {
  const made = textProjectWithFont();
  if (!made) { t.diagnostic?.('skipped: no system font to copy'); return; }
  const { p, dir } = made;
  try {
    const v3 = buildShotV3(p, { fps: 12, from: 0, to: 1.5 });
    assert.deepEqual(v3.meshes, {}, 'no fonts, no meshes');
    const [rec] = v3.items.filter((r) => r.id === 'el_text');
    assert.equal(rec.static.size, null, 'the consumer still typesets the box');
    assert.equal(rec.static.content.mesh, null, 'and its mesh is null');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
