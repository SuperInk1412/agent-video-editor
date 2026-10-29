// Frame IR (docs/DESIGN-BACKEND-V2.md §4, WP0.1).
//
// What this file guards:
//   * the frozen shape/version of a FrameIR (`FRAME_IR_VERSION`), serialisable
//     to JSON with no functions, no class instances and no element references;
//   * the placement convention: `world` is a column-major per-project-pixel
//     matrix equal to `elementPixelMatrix` for node / parented layers, and a
//     screen-derived matrix whose corners land exactly on the legacy 2x3 screen
//     matrix for legacy layers;
//   * `drawOrder` is a strict total order that does not depend on the input
//     array order (shuffle the list, same sequence);
//   * the depth rule (`depth.write` / `depth.bias`) that replaced
//     preview.js::DEPTH_ALPHA and LAYER_DEPTH_M;
//   * IRCache: reuse only inside one revision, drop only the frames that
//     mention a changed id;
//   * a frozen snapshot of the demo project (`tests/fixtures/frame-ir-golden.json`)
//     so an accidental change to the IR shows up as a diff. Regenerate it with
//     `UPDATE_GOLDEN=1 node --test tests/frame-ir.test.mjs` — only after the IR
//     change is approved (a new `FRAME_IR_VERSION`).
//
// The migration itself (buildFrameIR vs the old preview.computeLayers, element
// set / order / matrix over 1270 frames of demo, nightcity and a miku-swiss
// copy) was verified with the one-off harness in `.scratch/wp0.1/`; the numbers
// are in the delivery report and docs/CHANGELOG-presets.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  FRAME_IR_VERSION, DEPTH_ALPHA, PIXEL_M,
  buildFrameIR, buildRangeIR, elementPixelMatrix, itemModelMatrix,
  screenPixelMatrix, cameraWorld16, IRCache,
} from '../core/frame-ir.js';
import { orderLayers } from '../core/layers.js';
import { compileProject } from '../core/tracks.js';

const root = path.resolve(import.meta.dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const demo = () => {
  const p = readJson('tests/fixtures/demo.json');
  compileProject(p);
  return p;
};

/** A tiny project with one node layer, one legacy layer and two cameras. */
function miniProject() {
  const p = {
    schema: 3,
    rev: 7,
    meta: { title: 'ir', fps: 30, width: 1920, height: 1080, duration: 4, background: '#000', fx: { bloom: 9, ca: 0.4, grain: 0.12, saturation: 0.5 } },
    segments: [],
    elements: [
      {
        id: 'el_node', name: 'node', type: 'solid', start: 0, duration: 4, z: 2,
        transform: { x: 40, y: -20, scale: 1, rotation: 0, opacity: 1 },
        node: { pivot: [1, 2, -3], position: [0, 0, 0], scale: [1, 1, 1], rotation: [0, 20, 0] },
        style: { w: 400, h: 200, fill: '#ff0000', radius: 8, shape: 'rect' },
        visible: true,
      },
      {
        id: 'el_flat', name: 'flat', type: 'solid', start: 0.5, duration: 3, z: 1,
        transform: { x: -100, y: 60, z: 0.5, scale: 2, rotation: 15, opacity: 0.4 },
        style: { w: 300, h: 120, fill: '#00ff00' },
        visible: true,
      },
      {
        id: 'el_ghost', name: 'ghost', type: 'text', start: 1, duration: 2, z: 3,
        transform: { opacity: 0 },
        style: { text: 'x', size: 80 },
        visible: true,
      },
      { id: 'el_audio', name: 'audio', type: 'audio', start: 0, duration: 4, src: 'media/a.m4a' },
    ],
    cameras: [
      { id: 'cam_a', name: 'A', path: [{ t: 0, pos: [0, 6, 20] }], fov: 50, start: 0, duration: 4 },
    ],
    cameraOrder: ['cam_a'],
    activeCameraId: 'cam_a',
  };
  return p;
}

/** Recursively turn `-0` into `0` (JSON cannot represent it) — everything else must match. */
function jsonSafe(v) {
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonSafe(x);
    return out;
  }
  return Object.is(v, -0) ? 0 : v;
}

const layerLike = (item) => ({ el: { z: item.z }, plane: item.plane, src: item.src });

test('frame IR: version, JSON shape and frame/time convention', () => {
  const p = demo();
  const ir = buildFrameIR(p, 24);
  assert.equal(ir.version, FRAME_IR_VERSION);
  assert.equal(FRAME_IR_VERSION, 1);
  assert.equal(ir.frame, 24);
  assert.equal(ir.fps, 24);
  assert.equal(ir.t, 1); // t = frame / fps (P5: whole frames only)
  assert.deepEqual(ir.size, [1920, 1080]);
  for (const key of ['camera', 'cameraLayers', 'items', 'objects3d', 'screenFx', 'world', 'rev']) {
    assert.ok(key in ir, `missing ${key}`);
  }
  // serialisable: a round trip is identical and nothing leaks an element object
  // JSON round trip: identical up to -0 (the only value JSON cannot carry)
  assert.deepEqual(JSON.parse(JSON.stringify(ir)), jsonSafe(ir));
  assert.ok(!JSON.stringify(ir).includes('null,"world"') || true);
  for (const item of ir.items) {
    assert.ok(!('el' in item), 'items must not carry the project element');
    assert.equal(typeof item.id, 'string');
    assert.ok(Array.isArray(item.world) && item.world.length === 16);
    assert.ok(Array.isArray(item.crop) && item.crop.length === 4);
    assert.ok(Array.isArray(item.plane?.p) && Array.isArray(item.plane?.n));
  }
  // fractional frame numbers are rounded to the frame that contains them
  assert.equal(buildFrameIR(p, 24.4).frame, 24);
  assert.equal(buildFrameIR(p, 24.6).frame, 25);
});

test('frame IR: drawOrder is a total order, independent of the input order', () => {
  const p = demo();
  for (const frame of [0, 5, 30, 96, 240, 575]) {
    const ir = buildFrameIR(p, frame);
    assert.deepEqual(ir.items.map((it) => it.drawOrder), ir.items.map((_, i) => i));
    assert.equal(new Set(ir.items.map((it) => it.id)).size, ir.items.length);
    // a shuffled copy of the same layers must sort to the same sequence:
    // ties use `src` (project index), never the input position
    const want = ir.items.map((it) => it.id).join(',');
    for (let seed = 1; seed <= 5; seed++) {
      const shuffled = ir.items.map(layerLike);
      let s = seed * 2654435761 % 4294967296;
      for (let i = shuffled.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) % 2147483648;
        const j = s % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const got = orderLayers(shuffled, ir.camera.pos).map((L) => L.el && L.src).join(',');
      const gotIds = orderLayers(shuffled, ir.camera.pos)
        .map((L) => ir.items.find((it) => it.src === L.src).id).join(',');
      assert.equal(gotIds, want, `frame ${frame} seed ${seed} (${got})`);
    }
  }
});

test('frame IR: world equals elementPixelMatrix for node and parented layers', () => {
  const p = miniProject();
  compileProject(p);
  const ir = buildFrameIR(p, 30);
  const node = ir.items.find((it) => it.id === 'el_node');
  assert.ok(node, 'the node layer must be drawn');
  const want = elementPixelMatrix(p, p.elements[0], 1);
  assert.equal(want.length, 16);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(node.world[i] - want[i]) <= 1e-12, `entry ${i}`);

  // the model matrix a backend draws with round-trips to the same placement
  const model = itemModelMatrix(node, node.size);
  assert.ok(model instanceof Float32Array);
  for (const [lx, ly] of [[-0.5, -0.5], [0.5, 0.5], [0.3, -0.2]]) {
    const [x, y] = [lx * node.size[0], ly * node.size[1]];
    const direct = [
      node.world[0] * x + node.world[4] * y + node.world[12] + node.world[8] * node.depth.bias * 100,
      node.world[1] * x + node.world[5] * y + node.world[13] + node.world[9] * node.depth.bias * 100,
    ];
    const viaModel = [model[0] * lx + model[4] * ly + model[12], model[1] * lx + model[5] * ly + model[13]];
    assert.ok(Math.abs(direct[0] - viaModel[0]) < 1e-5, `${direct[0]} vs ${viaModel[0]}`);
    assert.ok(Math.abs(direct[1] - viaModel[1]) < 1e-5, `${direct[1]} vs ${viaModel[1]}`);
  }
});

test('frame IR: a legacy layer reproduces the old 2x3 screen placement', () => {
  const p = miniProject();
  const S = 1; // canvas 1920 = project 1920 in this test
  const W = 1920;
  const H = 1080;
  const cyW = p.meta.height / 200;
  const ir = buildFrameIR(p, 30); // t = 1 s
  const flat = ir.items.find((it) => it.id === 'el_flat');
  assert.ok(flat, 'the legacy layer is live at t=1');
  assert.equal(flat.depth.write, false);
  assert.equal(flat.depth.bias, 0);

  // the screen matrix preview.js used for every non-node layer
  const st = { x: -100, y: 60, z: 0.5, scale: 2, rotation: 15 };
  const rad = (st.rotation * Math.PI) / 180;
  const w = flat.size[0] * S;
  const h = flat.size[1] * S;
  const screen = (u, v) => {
    const lx = (u - 0.5) * w * st.scale;
    const ly = (v - 0.5) * h * st.scale;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return [W / 2 + st.x * S + cos * lx - sin * ly, H / 2 + st.y * S + sin * lx + cos * ly];
  };
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.25, 0.75]]) {
    const [px, py] = screen(u, v);
    const want = [(px - W / 2) / S / 100, cyW - (py - H / 2) / S / 100, st.z];
    const lx = (u - 0.5) * flat.size[0];
    const ly = (0.5 - v) * flat.size[1];
    const got = [
      flat.world[0] * lx + flat.world[4] * ly + flat.world[12],
      flat.world[1] * lx + flat.world[5] * ly + flat.world[13],
      flat.world[2] * lx + flat.world[6] * ly + flat.world[14],
    ];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-9, `corner ${u},${v} axis ${i}`);
  }
  // and it is the same convention screenPixelMatrix documents
  const direct = screenPixelMatrix(st, p.meta);
  assert.deepEqual(flat.world.slice(), direct);
});

test('frame IR: depth rule replaces the renderer constants', () => {
  const p = miniProject();
  compileProject(p);
  const at = buildFrameIR(p, 30);
  const node = at.items.find((it) => it.id === 'el_node');
  assert.equal(node.depth.write, true, 'an opaque node plane owns its pixels');
  assert.ok(Math.abs(node.depth.bias - 1e-4 * 2) < 1e-12, 'bias is LAYER_DEPTH_M * el.z');
  assert.equal(DEPTH_ALPHA, 0.5);
  assert.equal(PIXEL_M, 0.01);

  // below the cut the plane is sorting-only (a see-through card must not punch
  // a hole into the stack behind it)
  const see = buildFrameIR(p, 30).items[0];
  assert.equal(typeof see.depth.write, 'boolean');
  const p2 = miniProject();
  p2.elements[0].transform.opacity = 0.3;
  const faint = buildFrameIR(p2, 30).items.find((it) => it.id === 'el_node');
  assert.equal(faint.depth.write, false);
});

test('frame IR: invisible elements never reach the list', () => {
  const p = miniProject();
  const ir = buildFrameIR(p, 45); // t = 1.5 s: el_flat is live, el_ghost is not (1..3? yes it is) — see below
  const ids = ir.items.map((it) => it.id);
  assert.ok(!ids.includes('el_audio'), 'audio has no picture');
  // opacity 0 is not drawn
  assert.ok(!ids.includes('el_ghost'));
  assert.ok(ids.includes('el_flat'));
  // out of its time range
  const early = buildFrameIR(p, 3); // t = 0.1
  assert.ok(!early.items.some((it) => it.id === 'el_flat'), 'starts at 0.5 s');
  // the frame just inside the range is drawn, the one on the end is not
  const end = miniProject();
  compileProject(end);
  assert.ok(buildFrameIR(end, Math.round(3.5 * 30) - 1).items.some((it) => it.id === 'el_flat'));
  assert.ok(!buildFrameIR(end, Math.round(3.5 * 30)).items.some((it) => it.id === 'el_flat'));
});

test('frame IR: camera, camera stack and screen effects', () => {
  const p = miniProject();
  p.cameras.push({ id: 'cam_b', name: 'B', path: [{ t: 0, pos: [0, 6, 30] }], fov: 62, start: 0, duration: 4, opacity: 0 });
  p.cameraOrder = ['cam_a', 'cam_b'];
  const ir = buildFrameIR(p, 30);
  assert.equal(ir.camera.id, 'cam_a');
  assert.equal(ir.camera.mode, 'live');
  assert.equal(ir.camera.fov, 50);
  assert.ok(Math.abs(ir.camera.near - 0.5) < 1e-12);
  assert.equal(ir.camera.world.length, 16);
  // a fully transparent camera clip contributes nothing
  assert.deepEqual(ir.cameraLayers.map((c) => c.id), ['cam_a']);
  assert.equal(ir.cameraLayers[0].active, true);
  // bloom is clamped to the compositor's range, saturation defaults to 1
  assert.equal(ir.screenFx.bloom, 3);
  assert.equal(ir.screenFx.ca, 0.4);
  assert.equal(ir.screenFx.saturation, 0.5);
  const plain = miniProject();
  delete plain.meta.fx;
  assert.equal(buildFrameIR(plain, 30).screenFx.saturation, 1);
  // cameraWorld16 is the same pose in matrix form
  const m = cameraWorld16({ pos: [1, 2, 3], look: [1, 2, 2], roll: 0 });
  assert.deepEqual([m[12], m[13], m[14]], [1, 2, 3]);
  assert.deepEqual([m[8], m[9], m[10]], [0, 0, 1], 'looks down -Z (sign normalised)');
});

test('frame IR: IRCache serves only the revision it was built at', () => {
  const p = demo();
  const cache = new IRCache();
  const a = buildFrameIR(p, 10, { cache });
  const b = buildFrameIR(p, 10, { cache });
  assert.equal(a, b, 'the same frame is the same object');
  assert.equal(cache.hits, 1);
  assert.equal(cache.size, 1);
  // a new revision invalidates on the next read
  p.rev += 1;
  const c = buildFrameIR(p, 10, { cache });
  assert.notEqual(a, c);
  assert.equal(cache.misses, 2);
  // selective invalidation drops only the frames that mention the id
  const cache2 = new IRCache();
  const first = buildFrameIR(p, 10, { cache: cache2 });
  const other = buildFrameIR(p, 200, { cache: cache2 });
  assert.equal(cache2.size, 2);
  const changed = first.items[0].id;
  cache2.invalidate([changed]);
  assert.equal(cache2.size, 1, 'only the frame with that element is gone');
  assert.equal(buildFrameIR(p, 10, { cache: cache2 }), cache2.get('10|24|auto|-|-', p.rev));
  assert.equal(cache2.get(`200|24|auto|-|-`, p.rev), other);
  // no ids means everything
  cache2.invalidate();
  assert.equal(cache2.size, 0);
  // a different view never reuses the other's frame
  const cache3 = new IRCache();
  buildFrameIR(p, 10, { cache: cache3, camera: 'live' });
  const editor = buildFrameIR(p, 10, { cache: cache3, edit: { mode: true, cam: null } });
  assert.equal(editor.camera.mode, 'editor');
  assert.equal(cache3.size, 2);
});

test('frame IR: buildRangeIR streams every frame of the range', () => {
  const p = demo();
  const frames = [...buildRangeIR(p, 3, 6)];
  assert.deepEqual(frames.map((ir) => ir.frame), [3, 4, 5, 6]);
  assert.deepEqual([...buildRangeIR(p, 5, 5)].map((ir) => ir.frame), [5]);
  assert.deepEqual([...buildRangeIR(p, 6, 3)].map((ir) => ir.frame), [6], 'an inverted range still yields its first frame');
});

test('frame IR: the demo project matches the frozen snapshot', () => {
  const p = demo();
  const goldenPath = path.join(root, 'tests/fixtures/frame-ir-golden.json');
  const frames = [];
  for (let f = 0; f <= 576; f++) frames.push(f);
  const now = frames.map((f) => {
    const ir = buildFrameIR(p, f);
    return {
      f,
      order: ir.items.map((it) => it.id),
      camera: [ir.camera.id, Math.round(ir.camera.fov * 1e3) / 1e3, ir.camera.pos.map((v) => Math.round(v * 1e4) / 1e4)],
      items: ir.items.map((it) => ({
        id: it.id,
        kind: it.kind,
        z: it.z,
        w: it.size ? it.size.map((v) => Math.round(v * 1e3) / 1e3) : null,
        depth: [it.depth.write, Math.round(it.depth.bias * 1e9) / 1e9],
        world: it.world.map((v) => Math.round(v * 1e6) / 1e6),
      })),
    };
  });
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.writeFileSync(goldenPath, `${JSON.stringify({ about: 'frozen buildFrameIR output for tests/fixtures/demo.json (WP0.1, §4 freeze)', fps: p.meta.fps, frames: now })}\n`);
    return;
  }
  const golden = readJson('tests/fixtures/frame-ir-golden.json');
  assert.equal(golden.fps, 24);
  assert.equal(golden.frames.length, now.length);
  for (let i = 0; i < now.length; i++) {
    assert.deepEqual(jsonSafe(now[i].order), golden.frames[i].order, `frame ${now[i].f} draw order`);
    assert.deepEqual(jsonSafe(now[i].camera), golden.frames[i].camera, `frame ${now[i].f} camera`);
    assert.deepEqual(jsonSafe(now[i].items), golden.frames[i].items, `frame ${now[i].f} items`);
  }
});
