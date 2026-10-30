// Text geometry (docs/DESIGN-BACKEND-V2.md §4.4 v4, WP1.3): the font parser, the
// typesetter and the triangulator in core/glyphs.js, plus the IR's `meshes`.
//
// These tests run against **real fonts on this machine** (a TrueType Latin face,
// a TrueType CJK face and a collection) because a hand-written TTF reader has to
// be proven on real `glyf` data, not on a fixture: composite glyphs, quadratic
// curves, `cmap` format 4 / 12 and a 20 MB CJK font are all part of the job.
//
//   * what a font says (unitsPerEm, advances, glyph bboxes) matches the tables;
//   * a glyph mesh is finite, its triangles do not leave the outline, a hole
//     (`0`, `口`, `回`) stays empty, and the filled area is a sane share of the
//     bounding box;
//   * typesetting covers ASCII, CJK, mixed runs, line breaks and all three
//     alignments, and it is the *only* typesetting (the IR carries the box);
//   * the IR keeps `mesh: null` / `size: null` when no font is available — the
//     v3 fallback path.
//
// Fonts that are not on this machine are skipped with a note (the acceptance
// report says which ones were really exercised).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GlyphError, parseFont, glyphId, glyphInfo, glyphContours, contourPolyline,
  triangulateRings, glyphMesh, layoutText, textMesh, textMeshId, pointInPolygonStrict,
  fontHash,
} from '../core/glyphs.js';
import { buildFrameIR, FRAME_IR_VERSION, textGeometryOf } from '../core/frame-ir.js';
import { normalizeProject, createProject } from '../core/schema.js';
import { applyOps } from '../core/ops.js';
import { compileProject } from '../core/tracks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = {
  latin: ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
  cjk: ['C:/Windows/Fonts/simhei.ttf', '/usr/share/fonts/truetype/arphic/uming.ttc'],
  cjk2: ['C:/Windows/Fonts/msyh.ttc'],
};
const found = {};
for (const [key, list] of Object.entries(CANDIDATES)) {
  const file = list.find((f) => fs.existsSync(f));
  found[key] = file || null;
}
const read = (file) => new Uint8Array(fs.readFileSync(file));
const skipped = (key, t) => {
  if (!found[key]) { t?.diagnostic?.(`skipped: no ${key} font on this machine`); return true; }
  return false;
};

// ---------------------------------------------------------------- parsing

test('glyphs: a real TrueType font parses (head / hhea / maxp / hmtx / cmap)', (t) => {
  if (skipped('latin', t)) return;
  const font = parseFont(read(found.latin));
  assert.ok(font.unitsPerEm >= 16 && font.unitsPerEm <= 16384, 'unitsPerEm');
  assert.ok(font.numGlyphs > 100, 'glyph count');
  assert.ok(font.ascender > 0 && font.descender < 0, 'vertical metrics');
  assert.equal(font.format, 'truetype');
  assert.equal(typeof font.familyName, 'string');
  const a = font.glyphs.A;
  assert.ok(a && a.gid > 0, '"A" is mapped');
  assert.ok(a.advance > font.unitsPerEm * 0.3, '"A" advance is plausible');
  // its bbox is the glyf header: x within an em, cap height above the baseline
  assert.ok(a.bbox && a.bbox[3] > font.unitsPerEm * 0.4, '"A" cap height');
  assert.equal(font.glyphs[' '].bbox, null, 'a space has no outline');
  assert.equal(glyphId(font, '\u0000'), 0, 'an unmapped code point is .notdef');
});

test('glyphs: a font collection is read as its first face', (t) => {
  if (skipped('cjk2', t)) return;
  const font = parseFont(read(found.cjk2));
  assert.ok(font.unitsPerEm > 0);
  assert.ok(font.numGlyphs > 1000);
  assert.ok(Object.keys(font.glyphs).length > 1000, 'a CJK face maps thousands of code points');
  for (const ch of ['未', '來', 'を']) {
    const info = glyphInfo(font, ch);
    if (!info) continue;
    assert.ok(info.gid > 0 && info.advance > 0, `${ch} has a glyph and an advance`);
  }
});

test('glyphs: a CFF/OTF font reports UNSUPPORTED_FONT instead of guessing', () => {
  const otf = ['C:/Windows/Fonts/SourceHanSansCN-Regular.otf', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']
    .find((f) => fs.existsSync(f) && /\.otf$/i.test(f));
  if (!otf) return;
  let error = null;
  try {
    parseFont(read(otf));
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof GlyphError, 'throws a GlyphError');
  assert.equal(error.code, 'UNSUPPORTED_FONT');
});

test('glyphs: the same bytes name the same font, different bytes do not', (t) => {
  if (skipped('latin', t)) return;
  const bytes = read(found.latin);
  const a = parseFont(bytes, { cache: new Map() });
  const b = parseFont(bytes, { cache: new Map() });
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash, fontHash(bytes));
  const other = new Uint8Array(bytes);
  other[other.length - 1] ^= 0xff;
  assert.notEqual(fontHash(other), a.hash);
});

// ---------------------------------------------------------------- meshes

/** Area covered by the triangles (absolute, no winding cancellation). */
function triangleArea(mesh) {
  let sum = 0;
  const { vertices: v, indices: idx } = mesh;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 2, idx[i + 1] * 2, idx[i + 2] * 2];
    sum += Math.abs((v[b] - v[a]) * (v[c + 1] - v[a + 1]) - (v[c] - v[a]) * (v[b + 1] - v[a + 1])) / 2;
  }
  return sum;
}

function bboxOf(mesh) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i < mesh.vertices.length; i += 2) {
    x0 = Math.min(x0, mesh.vertices[i]); x1 = Math.max(x1, mesh.vertices[i]);
    y0 = Math.min(y0, mesh.vertices[i + 1]); y1 = Math.max(y1, mesh.vertices[i + 1]);
  }
  return { x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) };
}

const covered = (mesh, x, y) => {
  const { vertices: v, indices: idx } = mesh;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 2, idx[i + 1] * 2, idx[i + 2] * 2];
    const pa = [v[a], v[a + 1]];
    const pb = [v[b], v[b + 1]];
    const pc = [v[c], v[c + 1]];
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(pa, pb, [x, y]);
    const d2 = o(pb, pc, [x, y]);
    const d3 = o(pc, pa, [x, y]);
    if ((d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9) || (d1 <= 1e-9 && d2 <= 1e-9 && d3 <= 1e-9)) return true;
  }
  return false;
};

test('glyphs: a mesh is finite, indexed and its triangles stay inside the outline', (t) => {
  if (skipped('latin', t)) return;
  const font = parseFont(read(found.latin));
  for (const ch of ['A', 'o', '8', 'B', '%']) {
    const mesh = glyphMesh(font, ch, { size: 120 });
    assert.ok(mesh.vertices.length > 0, `${ch} has vertices`);
    assert.ok(mesh.vertices.every(Number.isFinite), `${ch} vertices are finite`);
    assert.equal(mesh.indices.length % 3, 0, `${ch} indices are triangles`);
    assert.ok(mesh.indices.every((i) => Number.isInteger(i) && i >= 0 && i * 2 < mesh.vertices.length), `${ch} indices are in range`);
    const box = bboxOf(mesh);
    assert.ok(box.area > 0, `${ch} has a bounding box`);
    const ratio = triangleArea(mesh) / box.area;
    // the ink of a Latin letter fills roughly a third to two thirds of its box
    assert.ok(ratio > 0.15 && ratio < 1.01, `${ch} area ratio ${ratio.toFixed(3)} is sane`);
    // y = 0 is the baseline: ink above it, and only round letters overshoot below
    assert.ok(box.y0 < 0, `${ch} hangs above the baseline`);
    assert.ok(Math.abs(box.y1) < 120 * 0.06, `${ch} sits on the baseline (bottom ${box.y1.toFixed(2)})`);
  }
});

test('glyphs: a hole stays a hole (0, 口, 回) — no triangle covers it', (t) => {
  if (skipped('cjk', t)) return;
  const font = parseFont(read(found.cjk));
  for (const ch of ['0', '口', '回', '日', '国']) {
    const gid = glyphId(font, ch);
    if (!gid) continue;
    const mesh = glyphMesh(font, ch, { size: 200 });
    assert.ok(mesh.indices.length > 0, `${ch} has triangles`);
    // ring nesting on the *same* polyline the mesh was built from
    const scale = 200 / font.unitsPerEm;
    const rings = [];
    for (const ring of glyphContours(font, gid)) {
      const poly = contourPolyline(ring, 1).map(([x, y]) => [x * scale, -y * scale]);
      if (poly.length >= 3) rings.push(poly);
    }
    const depthOf = (ring) => rings.filter((other) => other !== ring
      && pointInPolygonStrict(ring[0][0], ring[0][1], other)).length;
    const holes = rings.filter((ring) => depthOf(ring) % 2 === 1);
    assert.ok(holes.length > 0, `${ch} has at least one hole`);
    let sampled = 0;
    for (const hole of holes) {
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const [x, y] of hole) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      // an island inside a hole (回) is ink, so only sample points outside every
      // ring of the same or deeper nesting
      const inner = rings.filter((other) => other !== hole && depthOf(other) > depthOf(hole));
      for (let gx = 1; gx < 7; gx++) {
        for (let gy = 1; gy < 7; gy++) {
          const x = x0 + ((x1 - x0) * gx) / 7;
          const y = y0 + ((y1 - y0) * gy) / 7;
          if (!pointInPolygonStrict(x, y, hole)) continue;
          if (inner.some((ring) => pointInPolygonStrict(x, y, ring))) continue;
          sampled += 1;
          assert.equal(covered(mesh, x, y), false, `${ch}: (${x.toFixed(1)},${y.toFixed(1)}) is inside the hole but covered`);
        }
      }
    }
    assert.ok(sampled > 0, `${ch} produced hole samples`);
  }
});

test('glyphs: degenerate rings and NaN coordinates are dropped, never emitted', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.deepEqual(triangulateRings([[[0, 0], [0, 0], [0, 0]]]).indices, [], 'a zero-area ring yields nothing');
  const withNaN = [[0, 0], [Number.NaN, 3], [10, 0], [10, 10], [0, 10]];
  const { vertices, indices } = triangulateRings([withNaN]);
  assert.ok(indices.length > 0);
  assert.ok(vertices.every(Number.isFinite), 'no NaN survives');
  // overlapping contours of the same direction are one fill, not two (non-zero)
  const overlap = triangulateRings([square, [[6, 6], [16, 6], [16, 16], [6, 16]]]);
  const area = triangleArea(overlap);
  assert.ok(Math.abs(area - (100 + 100 - 16)) < 1e-6, `overlap area ${area}`);
});

// ---------------------------------------------------------------- typesetting

test('glyphs: layoutText lays out ASCII, CJK, mixed runs, line breaks and align', (t) => {
  if (skipped('latin', t) || skipped('cjk', t)) return;
  const latin = parseFont(read(found.latin));
  const cjk = parseFont(read(found.cjk));
  const style = { fontSize: 100, lineHeight: 1.2, letterSpacing: 0, align: 'left' };

  const ascii = layoutText(latin, 'Hello', style);
  assert.equal(ascii.lines.length, 1);
  assert.equal(ascii.lines[0].glyphs.map((g) => g.char).join(''), 'Hello');
  assert.ok(Math.abs(ascii.height - 120) < 1e-9, 'one line box is fontSize * lineHeight');
  assert.ok(ascii.width > 0);
  // advances are the font's own: the sum is the line width the mesh is built in
  const sum = ascii.lines[0].glyphs.reduce((a, g) => a + g.advance, 0);
  assert.ok(Math.abs(sum - ascii.width) < 1e-9);

  const han = layoutText(cjk, '未来幻想', style);
  assert.equal(han.lines[0].glyphs.length, 4);
  assert.ok(han.width > 300, 'four CJK glyphs are about four ems wide');

  const mixed = layoutText([latin, cjk], 'AB未来', style);
  assert.deepEqual(mixed.lines[0].glyphs.map((g) => g.char), ['A', 'B', '未', '来'], 'a mixed run keeps order');
  assert.deepEqual(mixed.missing, []);
  // the CJK glyphs come from the CJK font, the Latin ones from the Latin font
  assert.equal(mixed.lines[0].glyphs[2].font, cjk);
  assert.equal(mixed.lines[0].glyphs[0].font, latin);

  const two = layoutText(latin, 'One\nTwo\nThree', { ...style, align: 'center' });
  assert.equal(two.lines.length, 3);
  assert.ok(two.height > 3 * 100 * 1.2 - 1e-6);
  assert.ok(two.lines[0].baselineY < two.lines[1].baselineY, 'lines go down');

  const centred = layoutText(latin, 'i\nWWW', { ...style, align: 'center' });
  const right = layoutText(latin, 'i\nWWW', { ...style, align: 'right' });
  const left = layoutText(latin, 'i\nWWW', { ...style, align: 'left' });
  assert.ok(Math.abs(left.lines[0].glyphs[0].x) < 1e-9, 'left starts at 0');
  assert.ok(centred.lines[0].glyphs[0].x > left.lines[0].glyphs[0].x, 'center shifts the short line');
  assert.ok(right.lines[0].glyphs[0].x > centred.lines[0].glyphs[0].x, 'right shifts it further');

  const spaced = layoutText(latin, 'abc', { ...style, letterSpacing: 10 });
  assert.ok(Math.abs(spaced.width - (ascii.width - 2 * (ascii.width / 5) + spaced.width)) > 0, 'noop');
  const noSpace = layoutText(latin, 'abc', { ...style, letterSpacing: 0 });
  const withSpace = layoutText(latin, 'abc', { ...style, letterSpacing: 10 });
  assert.ok(Math.abs((withSpace.width - noSpace.width) - 20) < 1e-9, 'letterSpacing adds 10 px between three glyphs');

  // a character no font of the chain maps is reported, not silently dropped
  const missing = layoutText([latin], 'A\u{1F600}', style);
  assert.deepEqual(missing.missing, ['\u{1F600}']);
});

test('glyphs: textMesh merges one glyph mesh per character and reports the box', (t) => {
  if (skipped('cjk', t)) return;
  const font = parseFont(read(found.cjk));
  const mesh = textMesh(font, '未来', { fontSize: 200, align: 'left' });
  assert.ok(mesh.vertices.length > 0 && mesh.indices.length > 0);
  assert.ok(mesh.vertices.every(Number.isFinite));
  assert.ok(mesh.size[0] > 300 && mesh.size[1] >= 200, `box ${mesh.size}`);
  assert.deepEqual(mesh.missing, []);
  const box = bboxOf(mesh);
  assert.ok(box.x0 >= -1 && box.x1 <= mesh.size[0] + 20, 'glyphs stay inside the box (within overshoot)');
  assert.ok(box.y1 <= mesh.size[1] + 20 && box.y0 >= -20);
  // repeated calls with a glyph cache give the same mesh
  const cache = new Map();
  const a = textMesh(font, '未', { fontSize: 200 }, { cache });
  const b = textMesh(font, '未', { fontSize: 200 }, { cache });
  assert.deepEqual(a.vertices, b.vertices);
  assert.deepEqual(a.indices, b.indices);
});

test('glyphs: a mesh id names the geometry, not the colour', (t) => {
  if (skipped('latin', t)) return;
  const font = parseFont(read(found.latin));
  const style = { fontSize: 100, lineHeight: 1.2, letterSpacing: 0, align: 'center' };
  const a = textMeshId(font.hash, 'Hi', style);
  assert.match(a, /^h_[0-9a-f]{24}$/);
  assert.equal(a, textMeshId(font.hash, 'Hi', { ...style }));
  assert.notEqual(a, textMeshId(font.hash, 'Hi!', style));
  assert.notEqual(a, textMeshId(font.hash, 'Hi', { ...style, fontSize: 101 }));
  assert.notEqual(a, textMeshId(font.hash, 'Hi', { ...style, letterSpacing: 1 }));
  assert.notEqual(a, textMeshId(font.hash, 'Hi', { ...style, lineHeight: 1.3 }));
  assert.notEqual(a, textMeshId(font.hash, 'Hi', { ...style, align: 'left' }));
  assert.notEqual(a, textMeshId('otherfont', 'Hi', style));
});

// ---------------------------------------------------------------- the IR

function textProject() {
  const p = normalizeProject(createProject({ title: 'glyphs', background: '#000000', duration: 2 }));
  applyOps(p, [
    { op: 'setFx', fx: { bloom: 0, ca: 0, grain: 0, vignette: 0, scanline: 0, grade: 0, contrast: 0, saturation: 1 } },
    { op: 'addElement', element: { id: 'tx_a', type: 'text', start: 0, duration: 2, z: 1,
      transform: { x: 0, y: 120 },
      style: { text: 'Hello 未', font: 'Arial', size: 120, color: '#ffcc00', align: 'center', lineHeight: 1.2 } } },
    { op: 'addElement', element: { id: 'tx_b', type: 'text', start: 0, duration: 2, z: 2,
      transform: { x: 0, y: -120 },
      style: { text: 'Hello 未', font: 'Arial', size: 120, color: '#ffffff', align: 'center', lineHeight: 1.2 } } },
  ]);
  compileProject(p);
  return p;
}

test('frame IR v4: a text item carries the mesh id, the box and one shared mesh', (t) => {
  if (skipped('latin', t) || skipped('cjk', t)) return;
  const p = textProject();
  const fonts = {
    Arial: read(found.latin),
    SimHei: read(found.cjk),
  };
  const cache = { fonts: new Map(), glyphs: new Map(), meshes: new Map() };
  const ir = buildFrameIR(p, 0, { fonts, textCache: cache });
  assert.equal(ir.version, FRAME_IR_VERSION);
  assert.equal(FRAME_IR_VERSION, 4);
  const items = ir.items.filter((it) => it.kind === 'text');
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.match(item.content.mesh, /^h_[0-9a-f]{24}$/);
    assert.ok(Array.isArray(item.size) && item.size[0] > 0 && item.size[1] > 0, 'the box is typeset in core/');
    const mesh = ir.meshes[item.content.mesh];
    assert.ok(mesh, 'the mesh is in the same IR (self-contained JSON)');
    assert.ok(mesh.vertices.length > 0 && mesh.indices.length > 0);
    assert.deepEqual(mesh.size, item.size, 'the mesh knows its box');
    assert.equal(mesh.opacity, 1);
  }
  // the same text, size, spacing, line height and align is the same mesh: two
  // items with different colours share it exactly once
  assert.equal(items[0].content.mesh, items[1].content.mesh);
  assert.equal(Object.keys(ir.meshes).length, 1);
  assert.deepEqual(ir.meshes[items[0].content.mesh].color, [1, 0.8, 0], 'the record keeps the style colour');
  // and the IR is plain JSON
  const copy = JSON.parse(JSON.stringify(ir));
  assert.deepEqual(copy.meshes, ir.meshes);
  assert.deepEqual(copy.items, ir.items);
});

test('frame IR v4: without font bytes text stays on the v3 path (mesh null, size null)', (t) => {
  if (skipped('latin', t) || skipped('cjk', t)) return;
  const p = textProject();
  for (const opts of [{}, { fonts: {} }, { fonts: { Arial: new Uint8Array([1, 2, 3, 4]) } }]) {
    const ir = buildFrameIR(p, 0, opts);
    assert.deepEqual(ir.meshes, {}, 'no meshes');
    for (const item of ir.items.filter((it) => it.kind === 'text')) {
      assert.equal(item.content.mesh, null, 'the consumer keeps its own text path');
      assert.equal(item.size, null, 'and measures the box itself');
    }
  }
  // a style the mesh path does not cover keeps the old picture too
  const styled = textProject();
  styled.elements[0].style.shadow = 4;
  const withShadow = buildFrameIR(styled, 0, { fonts: { Arial: read(found.latin), SimHei: read(found.cjk) } });
  const first = withShadow.items.find((it) => it.id === 'tx_a');
  assert.equal(first.content.mesh, null);
  assert.equal(first.size, null);
  const second = withShadow.items.find((it) => it.id === 'tx_b');
  assert.match(second.content.mesh, /^h_/, 'the other element still uses its mesh');
});

test('frame IR v4: textGeometryOf caches fonts, glyphs and meshes', (t) => {
  if (skipped('latin', t) || skipped('cjk', t)) return;
  const p = textProject();
  const fonts = { Arial: read(found.latin), SimHei: read(found.cjk) };
  const cache = { fonts: new Map(), glyphs: new Map(), meshes: new Map() };
  const first = buildFrameIR(p, 0, { fonts, textCache: cache });
  assert.equal(Object.keys(first.meshes).length, 1);
  assert.ok(cache.fonts.size >= 2, 'both fonts of the chain are memoised');
  assert.ok(cache.glyphs.size > 0, 'glyph templates are memoised');
  assert.ok(cache.meshes.size >= 1, 'mesh records are memoised');
  const second = buildFrameIR(p, 1, { fonts, textCache: cache });
  // the same mesh object is handed out, not a copy per frame
  const key = Object.keys(second.meshes)[0];
  assert.equal(second.meshes[key], first.meshes[key]);
  // a malformed blob is not a crash, it is "no mesh"
  const broken = textGeometryOf({ text: 'A', fontSize: 10, font: 'Arial' }, { Arial: new Uint8Array([9, 9, 9, 9]) });
  assert.equal(broken, null);
});
