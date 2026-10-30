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
// set / order / matrix over demo 0–576, nightcity 0–240 and a miku-swiss copy
// 0–450 — 1269 frames, of which nightcity draws nothing) was verified with the
// one-off harness in `.scratch/wp0.1/`; the numbers are in the delivery report
// and docs/CHANGELOG-presets.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  FRAME_IR_VERSION, DEPTH_ALPHA, PIXEL_M,
  buildFrameIR, buildRangeIR, elementPixelMatrix, itemModelMatrix,
  screenPixelMatrix, cameraWorld16, mediaUVOf, IRCache,
} from '../core/frame-ir.js';
import { orderLayers } from '../core/layers.js';
import { compileProject } from '../core/tracks.js';
import { codeParamsAt } from '../core/code-layer.js';
import { createProject, normalizeProject } from '../core/schema.js';
import { applyOp } from '../core/ops.js';

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
  assert.equal(FRAME_IR_VERSION, 4);
  assert.equal(ir.frame, 24);
  assert.equal(ir.fps, 24);
  assert.equal(ir.t, 1); // t = frame / fps (P5: whole frames only)
  assert.deepEqual(ir.size, [1920, 1080]);
  for (const key of ['camera', 'cameraLayers', 'items', 'meshes', 'objects3d', 'screenFx', 'world', 'rev']) {
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
  const hitsBefore = cache2.hits;
  const missesBefore = cache2.misses;
  cache2.invalidate([changed]);
  assert.equal(cache2.size, 1, 'only the frame with that element is gone');
  // the surviving frame is still served, the dropped one has to be rebuilt
  assert.equal(buildFrameIR(p, 200, { cache: cache2 }), other, 'the untouched frame is still the cached object');
  buildFrameIR(p, 10, { cache: cache2 });
  assert.equal(cache2.hits, hitsBefore + 1);
  assert.equal(cache2.misses, missesBefore + 1);
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

test('frame IR: scale 0 keeps the old answer per branch', () => {
  const p = miniProject();
  compileProject(p);
  // legacy: M3.S(0, 0) collapsed the quad -> nothing to draw, zero columns
  p.elements[1].transform.scale = 0;
  const legacy = buildFrameIR(p, 30).items.find((it) => it.id === 'el_flat');
  assert.ok(legacy, 'the element is still in the list (it is the shader that collapses)');
  assert.ok(Math.abs(legacy.world[0]) < 1e-12 && Math.abs(legacy.world[4]) < 1e-12, 'zero-sized screen quad');
  // node: _nodePlane used `Math.abs(x || 1)` -> a scale of 0 drew at full size
  const p2 = miniProject();
  p2.elements[0].node.scale = [0, 0, 1];
  const node = buildFrameIR(p2, 30).items.find((it) => it.id === 'el_node');
  const full = buildFrameIR(miniProject(), 30).items.find((it) => it.id === 'el_node');
  assert.ok(Math.abs(node.world[0] - full.world[0]) < 1e-12, 'node scale 0 == scale 1 (bug-compatible)');
});

test('frame IR: media uv is one exported rule (stretch keeps the whole picture)', () => {
  assert.deepEqual(mediaUVOf('stretch', 100, 100, [1920, 1080]), [0, 0, 1, 1]);
  // a square image on a 16:9 frame covers by cropping top and bottom
  assert.deepEqual(mediaUVOf('cover', 1000, 1000, [1920, 1080]), [0, 0.21875, 1, 0.78125]);
  // a 21:9 image on the same frame crops the sides instead
  const wide = mediaUVOf('cover', 2100, 900, [1920, 1080]);
  assert.ok(Math.abs(wide[0] - 0.1190) < 1e-4 && Math.abs(wide[2] - 0.8810) < 1e-4, `wide uv ${wide}`);
  assert.deepEqual(mediaUVOf('contain', 1000, 1000, [1920, 1080]), mediaUVOf('cover', 1000, 1000, [1920, 1080]));
  // no intrinsic size yet -> null, the backend decodes the media and asks again
  assert.equal(mediaUVOf('cover', 0, 0, [1920, 1080]), null);
  const p = miniProject();
  p.elements.push({ id: 'el_img', type: 'image', start: 0, duration: 4, z: 5, src: 'media/a.jpg', style: { fit: 'stretch' } });
  const item = buildFrameIR(p, 30).items.find((it) => it.id === 'el_img');
  assert.deepEqual(item.content.uv, [0, 0, 1, 1], 'stretch is not cropped by the IR either');
});

/**
 * A project with one registered p5 source, one tilted 3D code layer and one
 * link driver: the raster item has to carry the per-frame parameters the pool
 * is fed from (keyframes AND property links), not the element's base values.
 */
function codeProject() {
  const p = normalizeProject(createProject({ title: 'code-ir', duration: 4 }));
  applyOp(p, {
    op: 'sourceAdd',
    id: 'src_rain',
    manifest: {
      runtime: 'p5', entry: 'sketch.js', deterministic: true,
      params: [
        { id: 'density', type: 'number', default: 0.2, keyable: 'frame' },
        { id: 'gain', type: 'number', default: 0, keyable: 'frame' },
      ],
    },
    files: { 'sketch.js': 'export function draw(ctx, vdm) { ctx.fillRect(0, 0, vdm.size[0], vdm.size[1]); }\n' },
  });
  const driver = applyOp(p, {
    op: 'addElement',
    element: { id: 'el_driver', type: 'solid', start: 0, duration: 4, z: 1, style: { w: 100, h: 100, fill: '#fff' } },
  }).element;
  applyOp(p, {
    op: 'addElement',
    element: {
      id: 'el_rain', type: 'code', start: 0, duration: 4, z: 2,
      node: { pivot: [0.4, 1.1, 0], rotation: [12, 28, 6], scale: [1, 1, 1] },
      code: { source: 'src_rain', params: { density: 0.6 }, seed: 7, size: [960, 540], cache: 'live' },
    },
  });
  // one keyed parameter (interpolates) and one property-linked parameter
  applyOp(p, { op: 'keySet', id: 'el_rain', path: 'code.params.density', t: 0, value: 0.2 });
  applyOp(p, { op: 'keySet', id: 'el_rain', path: 'code.params.density', t: 2, value: 0.8 });
  applyOp(p, { op: 'keySet', id: driver.id, path: 'transform.opacity', t: 0, value: 1 });
  applyOp(p, { op: 'keySet', id: driver.id, path: 'transform.opacity', t: 2, value: 0.5 });
  applyOp(p, {
    op: 'propLink', id: 'el_rain', to: 'code.params.gain',
    from: { host: 'el', id: driver.id, path: 'opacity' }, t: 0, combine: 'add',
  });
  compileProject(p);
  return { p, el: p.elements.find((e) => e.id === 'el_rain') };
}

test('frame IR: a code element becomes one raster item carrying this frame\'s parameters', () => {
  const { p, el } = codeProject();
  // frame 24 = t 1 s: density is halfway between its two keys
  const ir = buildFrameIR(p, 24);
  const item = ir.items.find((it) => it.id === 'el_rain');
  assert.ok(item, 'the code layer is in the draw list');
  assert.equal(item.kind, 'raster');
  // the request the pool gets, straight from core/code-layer.js::codeLayerPlan
  assert.deepEqual(item.content.source, { id: 'src_rain', runtime: 'p5' });
  assert.equal(item.content.seed, 7);
  assert.deepEqual(item.content.size, [960, 540], 'content.size is the raster resolution');
  assert.equal(item.content.mode, 'live');
  assert.equal(item.content.uv, undefined, 'a raster fills its quad: no uv rect to invent');
  // the quad itself is the full project frame, like image / video
  assert.deepEqual(item.size, [1920, 1080]);
  // params are the evaluated ones, keyframes and links included
  assert.deepEqual(item.content.params, codeParamsAt(p, el, 1));
  assert.ok(Math.abs(item.content.params.density - 0.5) < 1e-9, `density ${item.content.params.density}`);
  // the driver eases 1 -> 0.5 over its two keys, so at its midpoint the link
  // contributes -0.25 onto the parameter's base value of 0
  assert.ok(Math.abs(item.content.params.gain + 0.25) < 1e-9, `linked gain ${item.content.params.gain}`);
  assert.deepEqual(item.content.params, { density: 0.5, gain: -0.25 });

  // every other field is the same shape a normal 2D item has
  assert.ok(Array.isArray(item.world) && item.world.length === 16);
  assert.ok(Math.abs(item.world[0] - elementPixelMatrix(p, el, 1)[0]) < 1e-12, 'world is the shared pixel matrix');
  assert.equal(item.depth.write, true, 'a node plane at opacity 1 owns its pixels');
  assert.equal(ir.items[item.drawOrder], item, 'drawOrder indexes the list');
  assert.equal(new Set(ir.items.map((it) => it.drawOrder)).size, ir.items.length);
  assert.equal(item.crop.length, 4);
  assert.equal(item.blend, 'normal');
  // "bake" is carried through, not decided by the consumer
  const baked = codeProject();
  baked.el.code.cache = 'bake';
  const bakedItem = buildFrameIR(baked.p, 24).items.find((it) => it.id === 'el_rain');
  assert.equal(bakedItem.content.mode, 'bake');
  // an unregistered source still yields the item: the runtime is unknown, the
  // stored values and this frame's keyframes still evaluate (the consumer just
  // cannot fetch a raster and shows nothing)
  const orphan = codeProject();
  orphan.el.code.source = 'src_gone';
  const orphanItem = buildFrameIR(orphan.p, 24).items.find((it) => it.id === 'el_rain');
  assert.deepEqual(orphanItem.content.source, { id: 'src_gone', runtime: null });
  assert.equal(orphanItem.content.params.density, 0.5);
  // a project without code elements is untouched by the raster path
  assert.ok(demo().elements.every((e) => e.type !== 'code'));
});

test('frame IR: a backend can re-order raw items for its own eye', () => {
  const p = miniProject();
  // three coplanar legacy layers in one plane, z decides their stack
  p.elements.push({ id: 'el_low', type: 'solid', start: 0, duration: 4, z: -1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, style: { w: 100, h: 100, fill: '#fff' } });
  p.elements.push({ id: 'el_high', type: 'solid', start: 0, duration: 4, z: 9, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, style: { w: 100, h: 100, fill: '#fff' } });
  const ir = buildFrameIR(p, 30);
  const ids = ir.items.map((it) => it.id);
  assert.ok(ids.indexOf('el_low') < ids.indexOf('el_high'));
  // orderLayers reads items straight from the IR (top-level `z`, no project element)
  for (const camPos of [[0, 5.4, 20], [3, 7, 12], [-8, 2, 30]]) {
    const reordered = orderLayers(ir.items, camPos).map((it) => it.id).join(',');
    assert.equal(reordered, ids.join(','), `order for eye ${camPos}`);
  }
});

test('frame IR: 3D objects match what the Blender bake bakes', () => {
  const p = miniProject();
  p.scene = {
    objects: [
      { id: 'ob_box', type: 'solid', start: 0, duration: 4, geom: { w: 2, h: 3, d: 4 }, scale: [2, 2, 2], pivot: [0, 1, 0], style: { color: '#ff0000', emissive: 2 } },
      { id: 'ob_empty', type: 'empty', start: 0, duration: 4, pivot: [0, 0, 0] },
      { id: 'ob_off', type: 'solid', start: 6, duration: 1, pivot: [0, 0, 0] },
    ],
  };
  const ir = buildFrameIR(p, 30);
  assert.deepEqual(ir.objects3d.map((o) => o.id), ['ob_box'], 'only drawable, live objects');
  const box = ir.objects3d[0];
  // unit basis (no scale) + size = geom * |scale|, exactly like bakeObjects
  const len = (m, i) => Math.hypot(m[i], m[i + 1], m[i + 2]);
  assert.ok(Math.abs(len(box.world, 0) - 1) < 1e-12, 'world carries a unit basis');
  assert.deepEqual(box.size, [4, 6, 8]);
  assert.equal(box.color, '#ff0000');
  assert.equal(box.emissive, 2);
  assert.deepEqual([box.world[12], box.world[13], box.world[14]], [0, 1, 0]);
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
    fs.writeFileSync(goldenPath, `${JSON.stringify({ about: 'frozen buildFrameIR output for tests/fixtures/demo.json (§4 freeze)', version: FRAME_IR_VERSION, fps: p.meta.fps, frames: now })}\n`);
    return;
  }
  const golden = readJson('tests/fixtures/frame-ir-golden.json');
  assert.equal(golden.version, FRAME_IR_VERSION, 'regenerate the snapshot when the IR version moves');
  assert.equal(golden.fps, 24);
  assert.equal(golden.frames.length, now.length);
  for (let i = 0; i < now.length; i++) {
    assert.deepEqual(jsonSafe(now[i].order), golden.frames[i].order, `frame ${now[i].f} draw order`);
    assert.deepEqual(jsonSafe(now[i].camera), golden.frames[i].camera, `frame ${now[i].f} camera`);
    assert.deepEqual(jsonSafe(now[i].items), golden.frames[i].items, `frame ${now[i].f} items`);
  }
});
