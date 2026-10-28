// Spatial 2D render helpers (app/renderer/js/spatial-layers.js):
// shared draw/pick plane ordering and the node world matrix. Pure unit tests;
// WebGL itself is covered by the Electron screenshot checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NORMAL_EPS, PLANE_EPS, compareLayerPlanes, layerPlaneDistance, mul4,
  nodePlaneMatrix, orderLayers, planeOfFrame, sameLayerPlane, transformPlane,
} from '../app/renderer/js/spatial-layers.js';
import { basisFromDir } from '../core/scene.js';
import { frameOf } from '../core/spatial.js';
import { screenCenterY, screenToWorld } from '../core/space.js';

const near = (a, b, eps = 1e-9, msg = '') => {
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${msg}: keys`);
    for (const k of Object.keys(a)) near(a[k], b[k], eps, `${msg}.${k}`);
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${msg}: expected arrays (${a} / ${b})`);
    assert.equal(a.length, b.length, `${msg}: length`);
    a.forEach((v, i) => near(v, b[i], eps, `${msg}[${i}]`));
    return;
  }
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
};

const node = (over = {}) => ({
  pivot: [0, 0, 0], position: [0, 0, 0], dir: [0, 0, 1], roll: 0, scale: [1, 1, 1], ...over,
});

const layer = (z, plane) => ({ el: { z }, plane });
const flat = (p = [0, 5.4, 0]) => ({ p: p.slice(), n: [0, 0, 1] });
const CAM = [0, 5.4, 20];

// Column-major 3x3 helpers, same layout as preview.js::M3 — copied here so the
// test does not import the DOM/WebGL renderer module.
const M3 = {
  mul: (a, b) => {
    const o = new Array(9).fill(0);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        o[c * 3 + r] = a[0 * 3 + r] * b[c * 3 + 0] + a[1 * 3 + r] * b[c * 3 + 1] + a[2 * 3 + r] * b[c * 3 + 2];
      }
    }
    return o;
  },
  T: (x, y) => [1, 0, 0, 0, 1, 0, x, y, 1],
  S: (x, y) => [x, 0, 0, 0, y, 0, 0, 0, 1],
  R: (rad) => [Math.cos(rad), Math.sin(rad), 0, -Math.sin(rad), Math.cos(rad), 0, 0, 0, 1],
  apply: (m, x, y) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]],
};

test('spatial-layers: a node plane reproduces the legacy screen quad under the default framing', () => {
  // One element, placed both as the legacy 2x3 screen quad and as a node plane:
  // the world corners must agree (position, roll sign, scale, uv/v flip).
  const meta = { width: 1920, height: 1080 };
  const S = 1; // canvas == project pixels for this check
  const W = 1920, H = 1080;
  const cx = W / 2, cy = H / 2;
  const cyW = meta.height / 200;
  const st = { x: 120, y: -60, z: 0.5, scale: 2, rotation: 25 };
  const w = 300, h = 120;
  const rot = (st.rotation * Math.PI) / 180;
  const M = M3.mul(
    M3.mul(M3.mul(M3.T(cx + st.x * S, cy + st.y * S), M3.R(rot)), M3.S(st.scale, st.scale)),
    M3.mul(M3.T(-w / 2, -h / 2), M3.S(w, h)),
  );
  const frame = frameOf(node({
    pivot: screenToWorld(meta, st.x, st.y, st.z),
    roll: st.rotation,
    scale: [st.scale, st.scale, 1],
  }));
  // Unit quad: local = (u - 0.5, v - 0.5). The node branch flips v for the
  // texture, but the geometry corner for texture uv (u, v) is (u, 1 - v).
  const { model } = nodePlaneMatrix(frame, (w / (100 * S)) * st.scale, (h / (100 * S)) * st.scale);
  near(frame.pos, [1.2, cyW + 0.6, 0.5], 1e-12, 'node frame position');
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.25, 0.8]]) {
    const [px, py] = M3.apply(M, u, v);
    const legacy = [(px - W / 2) / S / 100, cyW - (py - H / 2) / S / 100, st.z];
    const lx = u - 0.5, ly = 0.5 - v;
    const world = [
      model[0] * lx + model[4] * ly + model[12],
      model[1] * lx + model[5] * ly + model[13],
      model[2] * lx + model[6] * ly + model[14],
    ];
    near(world, legacy, 1e-5, `corner ${u},${v}`); // Float32 model
  }
});

test('spatial-layers: nodePlaneMatrix applies the node basis plus motion decoration only once', () => {
  const frame = frameOf(node({ pivot: [1, screenCenterY({ width: 1920, height: 1080 }), -2], roll: 30 }));
  const plain = nodePlaneMatrix(frame, 2, 1);
  near([plain.model[12], plain.model[13], plain.model[14]], [1, 5.4, -2], 1e-5, 'translation');
  near(Math.hypot(plain.model[0], plain.model[1], plain.model[2]), 2, 1e-5, 'quad width');
  near(Math.hypot(plain.model[4], plain.model[5], plain.model[6]), 1, 1e-5, 'quad height');
  near(plain.model[0] * plain.model[4] + plain.model[1] * plain.model[5] + plain.model[2] * plain.model[6], 0, 1e-12, 'square');
  // local X must be -right of the (rolled) node basis, so the picture reads
  // unmirrored from the front (preview3d.js::_planeItem convention).
  const b = basisFromDir([0, 0, 1], 30);
  near([plain.model[0], plain.model[1], plain.model[2]], [-b.right[0] * 2, -b.right[1] * 2, -b.right[2] * 2], 1e-5, 'x axis');
  near([plain.model[4], plain.model[5], plain.model[6]], [b.up[0], b.up[1], b.up[2]], 1e-5, 'y axis');

  const moved = nodePlaneMatrix(frame, 2, 1, { offset: [0.5, -1.5, 0], roll: 30, scale: 2 });
  near([moved.model[12], moved.model[13], moved.model[14]], [1.5, 3.9, -2], 1e-5, 'motion offset');
  near(moved.w, 4, 1e-12, 'motion scale width');
  near(moved.h, 2, 1e-12, 'motion scale height');
  const bref = basisFromDir([0, 0, 1], 60); // node roll 30 + motion roll 30
  near([moved.model[0], moved.model[1], moved.model[2]], [-bref.right[0] * 4, -bref.right[1] * 4, -bref.right[2] * 4], 1e-5, 'rolled x axis');
});

test('spatial-layers: one plane keeps el.z, never the array/creation order', () => {
  const p = flat();
  const order = orderLayers([layer(3, p), layer(1, p), layer(2, p)], CAM).map((L) => L.el.z);
  assert.deepEqual(order, [1, 2, 3]);
  // Same input, shuffled: still el.z.
  assert.deepEqual(orderLayers([layer(1, p), layer(3, p), layer(2, p)], CAM).map((L) => L.el.z), [1, 2, 3]);
  // Exact ties keep a deterministic source order (only the last-resort key).
  assert.deepEqual(orderLayers([layer(2, p), layer(2, p)], CAM).map((L) => L.el.z), [2, 2]);
});

test('spatial-layers: different planes sort far first and ignore el.z', () => {
  const far = layer(9, flat([0, 5.4, 0])); // 20 m away, top layer number
  const nearPlane = layer(0, flat([0, 5.4, 4])); // 16 m away, bottom layer number
  assert.deepEqual(orderLayers([nearPlane, far], CAM), [far, nearPlane]);
  assert.ok(layerPlaneDistance(far, CAM) > layerPlaneDistance(nearPlane, CAM));
});

test('spatial-layers: same plane needs both a parallel normal and an equal distance', () => {
  const a = layer(0, flat([0, 5.4, 0]));
  const b = layer(1, flat([0, 5.4, 0]));
  const tilted = { p: [0, 5.4, 0], n: [0, 0.6, 0.8] };
  assert.ok(sameLayerPlane(a, b, CAM));
  assert.ok(!sameLayerPlane(a, layer(2, tilted), CAM));
  assert.ok(!sameLayerPlane(a, layer(3, flat([0, 5.4, 0.01])), CAM));
  assert.ok(PLANE_EPS < 0.01);
  // Nearly parallel normals still count as one plane.
  const n0 = basisFromDir([0, 0, 1], 0).forward;
  const tilt = basisFromDir([0, 1e-7, 1], 0).forward;
  assert.ok(Math.abs(n0[0] * tilt[0] + n0[1] * tilt[1] + n0[2] * tilt[2] - 1) < NORMAL_EPS);
  // compareLayerPlanes never returns NaN for missing planes.
  assert.equal(Number.isFinite(compareLayerPlanes(layer(0), layer(1), CAM)), true);
});

test('spatial-layers: a carried plane is pulled toward the camera like the legacy carry', () => {
  // carry = translate(0,5.4,19) · scale(0.05): 1 m in front of a camera at z=20.
  const carry = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0.05, 0,
    0, 0, 19, 1,
  ]);
  const carried = transformPlane(flat([0, 5.4, 0]), carry);
  near(carried.p, [0, 5.4, 19], 1e-6, 'carried point');
  near(carried.n, [0, 0, 0.05], 1e-7, 'carried normal');
  near(layerPlaneDistance(layer(0, carried), CAM), 0.05, 1e-7, 'pulled-in distance');
  // Screen-locked layers stay in front of a world plane 1 m from the camera,
  // which is exactly what the old _planeDist produced.
  const front = layer(0, flat([0, 5.4, 1]));
  assert.deepEqual(orderLayers([front, layer(1, carried)], CAM)[1], layer(1, carried));
});

test('spatial-layers: planeOfFrame / mul4 accept the renderer layouts', () => {
  const f = { pos: [1, 2, 3], basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], scale: [1, 1, 1] };
  near(planeOfFrame(f).p, [1, 2, 3], 1e-12, 'plane point');
  near(planeOfFrame(f).n, [0, 0, 1], 1e-12, 'unit normal');
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const t = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]);
  near(Array.from(mul4(t, identity)), Array.from(t), 1e-12, 'identity');
  near(Array.from(mul4(identity, t)), Array.from(t), 1e-12, 'identity left');
  const composed = mul4(t, mul4(identity, t));
  near([composed[12], composed[13], composed[14]], [4, 6, 8], 1e-12, 'composed translation');
});
