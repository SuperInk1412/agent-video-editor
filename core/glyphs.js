// Text geometry: font parsing, typesetting and glyph triangulation — pure ESM,
// no DOM, no node:* (docs/DESIGN-BACKEND-V2.md §4.4 v4 / WP1.3,
// docs/DESIGN-PRESETS.md §8.5).
//
// Both backends draw the *same mesh*: `buildFrameIR(project, frame, { fonts })`
// typesets the text here (once, in core/), triangulates it and puts the result
// in the IR's top-level `meshes`; the WebGL preview and Blender only draw the
// vertices. This removes the second typesetting implementation that produced
// the ~20 px vertical drift between the preview's canvas raster and Blender's
// FONT curve.
//
// Coordinate convention (frozen with the IR):
//
//   * a mesh vertex is in **quad-local project pixels**, origin at the quad's
//     TOP-LEFT, y pointing DOWN, nominally x in [0, size[0]], y in [0, size[1]] —
//     the space the preview's canvas texture occupied, so `lx = x/size[0] - 0.5`,
//     `ly = 0.5 - y/size[1]` maps it onto the IR's frozen quad (`lx, ly` in
//     [-0.5, 0.5], top edge at ly = +0.5, §4.4). Both backends apply that
//     mapping and then their usual `itemModelMatrix` / pixel matrix.
//   * font outlines are in font units with y UP; `unitsPerEm` font units are one
//     em.
//
// Formats: TrueType (`glyf` / `loca`, simple + composite glyphs, `cmap` 4 and
// 12, `hmtx`, `head`/`hhea`/`maxp`/`name`), including a `ttcf` collection
// (face 0 only — documented limit). CFF / CFF2 outlines (`OTTO`) are *not*
// implemented: `parseFont` throws `UNSUPPORTED_FONT` and the caller falls back
// to the old picture path (`mesh: null`, `size: null`). Do not silently pretend
// otherwise.
//
// No module-level state: parse caches are opt-in (`opts.cache`, a Map), which
// keeps the browser and Node results identical and the tests independent.

/** Error with a stable `code`: `UNSUPPORTED_FONT` | `BAD_FONT`. */
export class GlyphError extends Error {
  constructor(message, code = 'BAD_FONT') {
    super(message);
    this.name = 'GlyphError';
    this.code = code;
  }
}

const UNSUPPORTED = (what) => new GlyphError(`unsupported font: ${what}`, 'UNSUPPORTED_FONT');
const bad = (what) => new GlyphError(`bad font: ${what}`, 'BAD_FONT');

// ---------------------------------------------------------------- hashing

function asBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw bad('input is not a byte array');
}

/**
 * FNV-1a 32-bit of the bytes, as 8 hex digits. Deliberately not `node:crypto`:
 * the browser and Node must name the same font the same way (the IR is built on
 * both sides and the mesh id has to match, §4.4).
 */
export function bytesHash(bytes) {
  const u8 = asBytes(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A font's content hash, prefixed so a mesh id never looks like a number. */
export function fontHash(bytes) {
  return `f${bytesHash(bytes)}`;
}

// ---------------------------------------------------------------- sfnt tables

const be16 = (b, o) => (b[o] << 8) | b[o + 1];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const s16 = (b, o) => (be16(b, o) << 16) >> 16;
const tagAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function readTableDirectory(b, base) {
  const numTables = be16(b, base + 4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > b.length) break;
    tables.set(tagAt(b, rec), { offset: be32(b, rec + 8), length: be32(b, rec + 12) });
  }
  return tables;
}

/** Face offsets of a file: `[0]` for a plain sfnt, one per face for a `ttcf`. */
export function faceOffsets(bytes) {
  const b = asBytes(bytes);
  if (b.length < 12) throw bad('file is too short');
  if (tagAt(b, 0) !== 'ttcf') return [0];
  const num = be32(b, 8);
  if (!(num >= 1 && num <= 1024)) throw bad('collection has no faces');
  const out = [];
  for (let i = 0; i < num && 12 + i * 4 + 4 <= b.length; i++) out.push(be32(b, 12 + i * 4));
  if (!out.length) throw bad('collection has no faces');
  return out;
}

// ---------------------------------------------------------------- cmap

/** The Unicode subtable a font offers: format 12 preferred, then format 4. */
function cmapTable(b, table) {
  if (!table || table.offset + 4 > b.length) return null;
  const o = table.offset;
  const count = be16(b, o + 2);
  let best = null;
  for (let i = 0; i < count; i++) {
    const rec = o + 4 + i * 8;
    if (rec + 8 > b.length) break;
    const platform = be16(b, rec);
    const encoding = be16(b, rec + 2);
    const sub = o + be32(b, rec + 4);
    if (sub + 2 > b.length) continue;
    const format = be16(b, sub);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) { best = { sub, format }; continue; }
    if (format === 4 && !best) best = { sub, format };
  }
  return best;
}

function glyphIdCmap(b, cmap, cp) {
  if (!cmap) return 0;
  if (cmap.format === 12) {
    const o = cmap.sub;
    const groups = be32(b, o + 12);
    let lo = 0;
    let hi = groups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const rec = o + 16 + mid * 12;
      if (rec + 12 > b.length) return 0;
      const start = be32(b, rec);
      const end = be32(b, rec + 4);
      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return be32(b, rec + 8) + (cp - start);
    }
    return 0;
  }
  const o = cmap.sub;
  if (cp > 0xffff) return 0;
  const segX2 = be16(b, o + 6);
  const ends = o + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  for (let i = 0; i < segX2 / 2; i++) {
    const end = be16(b, ends + i * 2);
    if (cp > end) continue;
    const start = be16(b, starts + i * 2);
    if (cp < start) return 0;
    const delta = s16(b, deltas + i * 2);
    const rangeOffset = be16(b, ranges + i * 2);
    if (!rangeOffset) return (cp + delta) & 0xffff;
    const at = ranges + i * 2 + rangeOffset + (cp - start) * 2;
    if (at + 2 > b.length) return 0;
    const gid = be16(b, at);
    return gid ? (gid + delta) & 0xffff : 0;
  }
  return 0;
}

/** Every code point the selected subtable maps, bounded (defensive on bad data). */
function cmapEntries(b, cmap, limit = 70000) {
  const out = [];
  if (!cmap) return out;
  if (cmap.format === 12) {
    const o = cmap.sub;
    const groups = be32(b, o + 12);
    for (let g = 0; g < groups && out.length < limit; g++) {
      const rec = o + 16 + g * 12;
      if (rec + 12 > b.length) break;
      const start = be32(b, rec);
      const end = Math.min(be32(b, rec + 4), 0x10ffff);
      const gid = be32(b, rec + 8);
      for (let cp = start; cp <= end && out.length < limit; cp++) out.push([cp, (gid + cp - start) & 0xffff]);
    }
    return out;
  }
  const o = cmap.sub;
  const segX2 = be16(b, o + 6);
  const ends = o + 14;
  const starts = ends + segX2 + 2;
  for (let i = 0; i < segX2 / 2 && out.length < limit; i++) {
    const start = be16(b, starts + i * 2);
    const end = be16(b, ends + i * 2);
    if (end < start || end === 0xffff) continue;
    for (let cp = start; cp <= end && out.length < limit; cp++) {
      const gid = glyphIdCmap(b, cmap, cp);
      if (gid) out.push([cp, gid]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- name

function familyName(b, table) {
  if (!table || table.offset + 6 > b.length) return '';
  const o = table.offset;
  const count = be16(b, o + 2);
  const strings = o + be16(b, o + 4);
  let preferred = '';
  let fallback = '';
  for (let i = 0; i < count; i++) {
    const rec = o + 6 + i * 12;
    if (rec + 12 > b.length) break;
    const platform = be16(b, rec);
    const encoding = be16(b, rec + 2);
    const language = be16(b, rec + 4);
    const nameId = be16(b, rec + 6);
    if (nameId !== 1) continue; // font family
    const length = be16(b, rec + 8);
    const at = strings + be16(b, rec + 10);
    if (at + length > b.length) continue;
    let text = '';
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(be16(b, at + k));
    } else if (platform === 1 && encoding === 0) {
      for (let k = 0; k < length; k++) text += String.fromCharCode(b[at + k]);
    } else if (platform === 0) {
      for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(be16(b, at + k));
    }
    if (!text) continue;
    // UTF-16BE is what the name table holds (BOM stripped when present).
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (platform === 3 && language === 0x0409) preferred = text;
    if (!fallback) fallback = text;
  }
  return preferred || fallback;
}

// ---------------------------------------------------------------- parse

/**
 * Parse a TrueType font (or face 0 of a TTF collection).
 *
 * `opts.cache` (a Map) memoises the result by the bytes' hash, so a caller that
 * builds the IR per frame parses a 20 MB CJK font once, not 450 times.
 *
 * Returns `{ unitsPerEm, ascender, descender, lineGap, numGlyphs, familyName,
 * hash, format, glyphs: { [char]: { gid, advance, bbox } } }` where `advance` /
 * `bbox` are in font units (`bbox` = [xMin, yMin, xMax, yMax], y up) and `bbox`
 * is null for a glyph whose `glyf` record is empty (a space).
 *
 * Throws a `GlyphError` (`UNSUPPORTED_FONT`, `BAD_FONT`) on anything it cannot
 * read; callers treat both as "no mesh, keep the old path".
 */
export function parseFont(bytes, opts = {}) {
  const b = asBytes(bytes);
  // Hashing 20 MB costs a few milliseconds: a caller that keeps the font object
  // around should cache by name and skip this function entirely (`opts.hash`
  // exists for a caller that already knows the digest).
  const hash = opts.hash || fontHash(b);
  const cache = opts.cache && typeof opts.cache.get === 'function' ? opts.cache : null;
  if (cache) {
    const hit = cache.get(hash);
    if (hit) return hit;
  }
  const font = parseFontUncached(b, hash);
  if (cache) cache.set(hash, font);
  return font;
}

function parseFontUncached(b, hash) {
  const [base] = faceOffsets(b);
  const version = tagAt(b, base);
  const tables = readTableDirectory(b, base);
  const isCff = tables.has('CFF ') || tables.has('CFF2') || version === 'OTTO';
  const hasGlyf = tables.has('glyf') && tables.has('loca');
  if (isCff && !hasGlyf) throw UNSUPPORTED('CFF / OTF outlines (only TrueType glyf is implemented)');
  if (!hasGlyf) throw UNSUPPORTED(`no glyf table (sfnt version ${JSON.stringify(version)})`);
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const maxp = tables.get('maxp');
  const hmtx = tables.get('hmtx');
  if (!head || !hhea || !maxp || !hmtx) throw bad('missing head / hhea / maxp / hmtx');
  const unitsPerEm = be16(b, head.offset + 18) || 1000;
  const longLoca = s16(b, head.offset + 50) === 1;
  const numGlyphs = be16(b, maxp.offset + 4);
  const numHMetrics = be16(b, hhea.offset + 34) || 1;
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  const advanceOf = (gid) => {
    const i = Math.min(Math.max(0, gid), numHMetrics - 1);
    const at = hmtx.offset + i * 4;
    return at + 2 <= b.length ? be16(b, at) : 0;
  };
  const glyphRange = (gid) => {
    if (!(gid >= 0 && gid < numGlyphs)) return null;
    const at = loca.offset + (longLoca ? gid * 4 : gid * 2);
    const step = longLoca ? 4 : 2;
    if (at + step * 2 > b.length) return null;
    const a = longLoca ? be32(b, at) : be16(b, at) * 2;
    const end = longLoca ? be32(b, at + 4) : be16(b, at + 2) * 2;
    if (!(end > a)) return null;
    const start = glyf.offset + a;
    const stop = glyf.offset + end;
    if (start + 10 > b.length || stop > b.length) return null;
    return [start, stop];
  };

  const cmap = cmapTable(b, tables.get('cmap'));
  const glyphs = Object.create(null);
  for (const [cp, gid] of cmapEntries(b, cmap)) {
    const char = String.fromCodePoint(cp);
    if (glyphs[char]) continue;
    glyphs[char] = { gid, advance: advanceOf(gid), bbox: glyphBBox(b, glyphRange(gid)) };
  }
  return {
    hash,
    format: 'truetype',
    unitsPerEm,
    ascender: be16S(hhea, b, 4) || unitsPerEm,
    descender: be16S(hhea, b, 6) || -Math.round(unitsPerEm * 0.2),
    lineGap: be16S(hhea, b, 8),
    numGlyphs,
    familyName: familyName(b, tables.get('name')),
    glyphs,
    // internals: outline extraction needs the raw tables (not part of the API)
    _bytes: b,
    _longLoca: longLoca,
    _glyphRange: glyphRange,
    _advanceOf: advanceOf,
    _cmap: cmap,
    _nameTable: tables.get('name'),
  };
}

function be16S(entry, b, off) {
  return s16(b, entry.offset + off);
}

function glyphBBox(b, range) {
  if (!range) return null;
  const [at] = range;
  return [s16(b, at + 2), s16(b, at + 4), s16(b, at + 6), s16(b, at + 8)];
}

/** Glyph id of one code point (0 = .notdef when the font does not map it). */
export function glyphId(font, char) {
  const entry = font.glyphs[char];
  if (entry) return entry.gid;
  const cp = typeof char === 'string' ? char.codePointAt(0) : NaN;
  if (!Number.isFinite(cp)) return 0;
  return glyphIdCmap(font._bytes, font._cmap, cp) || 0;
}

/** `{ gid, advance, bbox }` of one character (null when the font maps no glyph). */
export function glyphInfo(font, char) {
  const hit = font.glyphs[char];
  if (hit) return hit;
  const gid = glyphId(font, char);
  if (!gid) return null;
  return { gid, advance: font._advanceOf(gid), bbox: glyphBBox(font._bytes, font._glyphRange(gid)) };
}

// ---------------------------------------------------------------- outlines

const ON = 0x01;
const ARG_WORDS = 0x0001;
const ARGS_XY = 0x0002;
const HAVE_SCALE = 0x0008;
const MORE = 0x0020;
const HAVE_X_Y_SCALE = 0x0040;
const HAVE_2x2 = 0x0080;

/**
 * Outline of one glyph in font units (y up): an array of contours, each an array
 * of `{ x, y, on }` points in `glyf` order. Composite glyphs are flattened.
 */
export function glyphContours(font, gid, depth = 0) {
  if (depth > 8) return [];
  const b = font._bytes;
  const range = font._glyphRange(gid);
  if (!range) return [];
  const [at] = range;
  const nContours = s16(b, at);
  if (nContours < 0) return compositeContours(font, at, depth);
  if (!nContours) return [];
  const ends = [];
  for (let i = 0; i < nContours; i++) ends.push(be16(b, at + 10 + i * 2));
  let p = at + 10 + nContours * 2;
  const instructions = be16(b, p);
  p += 2 + instructions;
  const total = ends[nContours - 1] + 1;
  if (!(total > 0)) return [];
  const flags = [];
  while (flags.length < total && p < b.length) {
    const f = b[p++];
    flags.push(f);
    if (f & 0x08) {
      let repeat = b[p++];
      while (repeat-- > 0 && flags.length < total) flags.push(f);
    }
  }
  const readCoords = (shortBit, sameBit) => {
    const out = [];
    let v = 0;
    for (const f of flags) {
      if (f & shortBit) {
        const d = b[p++];
        v += f & sameBit ? d : -d;
      } else if (!(f & sameBit)) {
        v += s16(b, p);
        p += 2;
      }
      out.push(v);
    }
    return out;
  };
  const xs = readCoords(0x02, 0x10);
  const ys = readCoords(0x04, 0x20);
  const contours = [];
  let start = 0;
  for (const end of ends) {
    const ring = [];
    for (let i = start; i <= end && i < total; i++) ring.push({ x: xs[i], y: ys[i], on: (flags[i] & ON) === 1 });
    if (ring.length) contours.push(ring);
    start = end + 1;
  }
  return contours;
}

function compositeContours(font, at, depth) {
  const b = font._bytes;
  let p = at + 10;
  const out = [];
  for (let guard = 0; guard < 64; guard++) {
    if (p + 4 > b.length) break;
    const flags = be16(b, p);
    const child = be16(b, p + 2);
    p += 4;
    let dx = 0;
    let dy = 0;
    if (flags & ARG_WORDS) {
      const a1 = s16(b, p);
      const a2 = s16(b, p + 2);
      p += 4;
      if (flags & ARGS_XY) { dx = a1; dy = a2; }
    } else {
      const a1 = b[p];
      const a2 = b[p + 1];
      p += 2;
      if (flags & ARGS_XY) {
        dx = a1 > 127 ? a1 - 256 : a1;
        dy = a2 > 127 ? a2 - 256 : a2;
      }
    }
    // Point matching (args are point indices) is rare; the component is placed
    // at its own origin instead of being aligned to a point. Documented limit.
    let a = 1; let bb = 0; let c = 0; let d = 1;
    if (flags & HAVE_SCALE) {
      const s = s16(b, p) / 16384;
      p += 2;
      a = s; d = s;
    } else if (flags & HAVE_X_Y_SCALE) {
      a = s16(b, p) / 16384;
      d = s16(b, p + 2) / 16384;
      p += 4;
    } else if (flags & HAVE_2x2) {
      a = s16(b, p) / 16384;
      bb = s16(b, p + 2) / 16384;
      c = s16(b, p + 4) / 16384;
      d = s16(b, p + 6) / 16384;
      p += 8;
    }
    for (const ring of glyphContours(font, child, depth + 1)) {
      out.push(ring.map((pt) => ({
        x: a * pt.x + c * pt.y + dx,
        y: bb * pt.x + d * pt.y + dy,
        on: pt.on,
      })));
    }
    if (!(flags & MORE)) break;
  }
  return out;
}

// ---------------------------------------------------------------- polylines

/**
 * A contour of on/off-curve points -> a closed polyline in font units.
 * Quadratic segments are subdivided until the chord is within `tolerance` font
 * units of the curve, so the caller controls how many vertices a glyph costs.
 */
export function contourPolyline(ring, tolerance = 1) {
  const n = ring.length;
  if (n < 2) return [];
  let s = 0;
  while (s < n && !ring[s].on) s++;
  if (s === n) {
    // all off-curve: the implied points are the midpoints between them
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      out.push([(a.x + b.x) / 2, (a.y + b.y) / 2]);
    }
    return out;
  }
  const seq = [];
  for (let k = 0; k < n; k++) seq.push(ring[(s + k) % n]);
  const pts = [];
  const push = (x, y) => {
    const last = pts[pts.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-9 && Math.abs(last[1] - y) < 1e-9) return;
    pts.push([x, y]);
  };
  let cur = seq[0];
  push(cur.x, cur.y);
  let i = 1;
  while (i < n) {
    const p = seq[i];
    if (p.on) {
      push(p.x, p.y);
      cur = p;
      i += 1;
      continue;
    }
    const q = i + 1 < n ? seq[i + 1] : seq[0];
    const end = q.on ? q : { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, on: true };
    const steps = quadSteps(cur.x, cur.y, p.x, p.y, end.x, end.y, tolerance);
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const v = 1 - u;
      push(
        v * v * cur.x + 2 * v * u * p.x + u * u * end.x,
        v * v * cur.y + 2 * v * u * p.y + u * u * end.y,
      );
    }
    cur = end;
    i += q.on ? 2 : 1;
  }
  // the closing edge is implicit; drop a duplicate of the first point
  while (pts.length > 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop();
    else break;
  }
  return pts;
}

/** Subdivision count that keeps a quadratic within `tolerance` of its chords. */
function quadSteps(x0, y0, cx, cy, x1, y1, tolerance) {
  const dx = x0 - 2 * cx + x1;
  const dy = y0 - 2 * cy + y1;
  const dev = Math.hypot(dx, dy) / 4; // max deviation of a quadratic from its chord
  if (!(dev > 0)) return 1;
  const tol = Math.max(1e-3, tolerance);
  return Math.min(24, Math.max(1, Math.ceil(Math.sqrt(dev / tol))));
}

// ---------------------------------------------------------------- geometry

/** Shoelace area (positive = clockwise on screen, i.e. y grows downwards). */
/** Shoelace area: positive = clockwise on screen (y grows downwards). */
const signedArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
};

const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; const yi = ring[i][1];
    const xj = ring[j][0]; const yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** Strictly inside: the boundary and the vertices do not count. */
export function pointInPolygonStrict(x, y, ring, eps = 1e-6) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (pointOnSegment(ring[i], ring[j], [x, y], eps)) return false;
  }
  return pointInRing(x, y, ring);
}

function pointOnSegment(a, b, p, eps) {
  const cross = orient(a, b, p);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  if (Math.abs(cross) / len > eps) return false;
  return p[0] >= Math.min(a[0], b[0]) - eps && p[0] <= Math.max(a[0], b[0]) + eps
    && p[1] >= Math.min(a[1], b[1]) - eps && p[1] <= Math.max(a[1], b[1]) + eps;
}

/**
 * Triangulate a glyph outline: `rings` is a list of closed polygons in pixel
 * space (y down), each an outer contour or a hole (TrueType's non-zero winding;
 * holes, islands and overlapping contours all fall out of the same rule).
 *
 * The triangulator is a **scanline** fill (§10.2 WP1.3 allows ear clipping or a
 * scanline): every band between two consecutive vertex `y` values is filled with
 * trapezoids, and the winding number decides which parts of the band are ink.
 * That makes the non-zero rule exact — a hole is a band with winding 0, and two
 * overlapping contours of the same direction are filled once instead of twice —
 * while an ear-clipping pass over a flattened CJK outline can leak through the
 * concavities between strokes.
 *
 * Returns `{ vertices: [x,y,...], indices: [...] }` in the same space. Degenerate
 * rings, zero-height bands, collinear runs and non-finite coordinates are
 * dropped, never passed through: a NaN in the IR would poison both backends.
 */
export function triangulateRings(rings) {
  const clean = [];
  for (const ring of rings || []) {
    const pts = [];
    for (const p of ring || []) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = Number(p[0]); const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const last = pts[pts.length - 1];
      if (last && Math.abs(last[0] - x) < 1e-7 && Math.abs(last[1] - y) < 1e-7) continue;
      pts.push([x, y]);
    }
    while (pts.length > 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7) pts.pop();
      else break;
    }
    if (pts.length < 3) continue;
    if (Math.abs(signedArea(pts)) < 1e-9) continue;
    clean.push(pts);
  }
  if (!clean.length) return { vertices: [], indices: [] };

  // Every y where the outline changes: between two of them the crossings of a
  // band with the edges are a fixed, sorted list, so the fill of a band is one
  // trapezoid per inside span and the whole polygon is exact.
  const ys = [];
  for (const ring of clean) for (const [, y] of ring) ys.push(y);
  ys.sort((a, b) => a - b);
  const levels = [];
  for (const y of ys) if (!levels.length || y - levels[levels.length - 1] > 1e-7) levels.push(y);

  const edges = [];
  for (const ring of clean) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (Math.abs(a[1] - b[1]) < 1e-9) continue; // horizontal: never crosses a band
      edges.push({ id: edges.length, ax: a[0], ay: a[1], bx: b[0], by: b[1] });
    }
  }
  // Bucket every edge into the bands it spans, so a band only looks at the
  // edges that can cross it (a scanline without the scan).
  const bands = new Array(Math.max(0, levels.length - 1));
  for (const e of edges) {
    const lo = Math.min(e.ay, e.by);
    const hi = Math.max(e.ay, e.by);
    for (let b = bandAt(levels, lo); b < bands.length && levels[b] < hi; b++) {
      if (!bands[b]) bands[b] = [];
      bands[b].push(e);
    }
  }
  const crossX = (e, y) => e.ax + ((y - e.ay) * (e.bx - e.ax)) / (e.by - e.ay);

  // Sweep band by band, keeping each inside span alive while its two boundary
  // edges do. One stroke of a glyph is then a handful of quads instead of two
  // triangles per scanline band, which is what keeps the mesh small.
  const spans = new Map();
  const done = [];
  for (let level = 0; level + 1 < levels.length; level++) {
    const y0 = levels[level];
    const y1 = levels[level + 1];
    if (!(y1 - y0 > 1e-9)) continue;
    const active = bands[level];
    const yMid = (y0 + y1) / 2;
    const cuts = [];
    if (active) {
      for (const e of active) {
        const up = e.by > e.ay;
        // Half-open test: a vertex exactly on a band edge counts once.
        const a = up ? e.ay : e.by;
        const b = up ? e.by : e.ay;
        if (!(a <= yMid && yMid < b)) continue;
        cuts.push({ edge: e, x: crossX(e, yMid), dir: up ? 1 : -1 });
      }
    }
    cuts.sort((p, q) => (p.x - q.x) || (p.dir - q.dir));
    const next = new Map();
    let winding = 0;
    let left = null;
    for (const cut of cuts) {
      const before = winding;
      winding += cut.dir;
      if (before === 0 && winding !== 0) left = cut;
      else if (before !== 0 && winding === 0 && left) {
        const key = left.edge.id * edges.length + cut.edge.id;
        const open = spans.get(key);
        if (open) {
          open.bottomY = y1;
          next.set(key, open);
        } else {
          next.set(key, { left: left.edge, right: cut.edge, topY: y0, bottomY: y1 });
        }
        left = null;
      }
    }
    for (const [key, span] of spans) if (!next.has(key)) done.push(span);
    spans.clear();
    for (const [key, span] of next) spans.set(key, span);
  }
  for (const span of spans.values()) done.push(span);

  // One trapezoid per span (two triangles).
  const vertices = [];
  const indices = [];
  const indexOf = new Map();
  const vertexAt = (x, y) => {
    // Round to a micrometre grid so adjacent spans share their corners.
    const key = Math.round(x * 1e4) * 1e7 + Math.round(y * 1e4);
    let i = indexOf.get(key);
    if (i === undefined) {
      i = vertices.length / 2;
      vertices.push(x, y);
      indexOf.set(key, i);
    }
    return i;
  };
  for (const span of done) {
    const ltX = crossX(span.left, span.topY);
    const rtX = crossX(span.right, span.topY);
    const rbX = crossX(span.right, span.bottomY);
    const lbX = crossX(span.left, span.bottomY);
    const wTop = Math.abs(rtX - ltX);
    const wBottom = Math.abs(rbX - lbX);
    if (wTop < 1e-7 && wBottom < 1e-7) continue;
    const lt = vertexAt(ltX, span.topY);
    const rt = vertexAt(rtX, span.topY);
    const rb = vertexAt(rbX, span.bottomY);
    const lb = vertexAt(lbX, span.bottomY);
    if (wTop < 1e-7) indices.push(lb, rb, lt);
    else if (wBottom < 1e-7) indices.push(lt, rt, lb);
    else indices.push(lt, rt, rb, lt, rb, lb);
  }
  return { vertices, indices };
}

/** Index of the band whose [levels[i], levels[i+1]) range contains `y`. */
function bandAt(levels, y) {
  let lo = 0;
  let hi = levels.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (levels[mid] <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

// ---------------------------------------------------------------- meshes

/**
 * Triangulated mesh of one character, placed by `x` / `y`: `y` is the baseline
 * of the line, `x` the pen position — both in quad-local pixels (y down).
 *
 * `opts.cache` (a Map) memoises the glyph *template* (at x = 0, baseline 0), so
 * a repeated character in a repeated frame costs a translate, not a
 * triangulation.
 */
export function glyphMesh(font, char, { size = 16, x = 0, y = 0 } = {}, opts = {}) {
  if (!(size > 0)) return { vertices: [], indices: [] };
  const gid = glyphId(font, char);
  const scale = size / (font.unitsPerEm || 1000);
  // Flattening tolerance: a third of a pixel at the rendered size (in font
  // units). Text is drawn without anti-aliasing coverage from the mesh, so the
  // outline only has to stay inside a pixel; a tighter curve costs vertices in
  // every mesh of every frame.
  const tolerance = Math.max(0.02, 0.3 / scale);
  const cache = opts.cache && typeof opts.cache.get === 'function' ? opts.cache : null;
  const key = `${font.hash}|${gid}|${Math.round(scale * 1e6)}`;
  let template = cache ? cache.get(key) : null;
  if (!template) {
    const rings = [];
    for (const ring of glyphContours(font, gid)) {
      const poly = contourPolyline(ring, tolerance);
      if (poly.length >= 3) rings.push(poly.map(([px, py]) => [px * scale, -py * scale]));
    }
    template = triangulateRings(rings);
    if (cache) cache.set(key, template);
  }
  const vertices = new Array(template.vertices.length);
  for (let i = 0; i < template.vertices.length; i += 2) {
    vertices[i] = template.vertices[i] + x;
    vertices[i + 1] = template.vertices[i + 1] + y;
  }
  return { vertices, indices: template.indices.slice() };
}

/** Advance of one character in pixels (`letterSpacing` is not included). */
export function advanceOf(font, char, size) {
  const info = glyphInfo(font, char);
  const upem = font.unitsPerEm || 1000;
  if (!info) return size * 0.5;
  return (info.advance / upem) * size;
}

/** Vertical metrics in pixels for one em size (`ascender` is above the baseline). */
export function metricsOf(font, size) {
  const upem = font.unitsPerEm || 1000;
  return {
    ascender: (font.ascender / upem) * size,
    descender: (Math.abs(font.descender) / upem) * size,
    lineGap: (font.lineGap / upem) * size,
  };
}

/**
 * The font of one character: the first font of the chain that maps it. A text
 * run mixing scripts (Latin font + CJK, or the reverse) needs this the way a
 * browser's font stack does — a canvas raster silently falls back, so a mesh
 * built from the first font alone would drop glyphs the old picture drew.
 */
export function fontForChar(chain, char) {
  for (const font of chain) if (glyphId(font, char)) return font;
  return null;
}

/**
 * Typeset `text` with `style` — the single typesetting implementation the IR
 * and both backends use (no canvas measuring anywhere).
 *
 * `fonts` is one parsed font or a chain `[primary, ...fallbacks]`; a character
 * the primary does not map comes from the first fallback that does (the same
 * per-character fallback a browser does). A character no font maps is reported
 * in `missing` and the caller keeps the old picture path.
 *
 * `style` = `{ fontSize, lineHeight, letterSpacing, align }`, with the same
 * meaning the IR's `content` carries: `fontSize` is the em size in project
 * pixels, `lineHeight` a multiple of it, `letterSpacing` extra pixels after each
 * character, `align` one of left / center / right inside `width`.
 *
 * Returns `{ lines: [{ baselineY, glyphs: [{ char, x, advance, font }], width }],
 * width, height, fontSize, lineHeight, letterSpacing, align, missing }` in
 * quad-local pixels, origin top-left, y down. Line boxes are `lineHeight *
 * fontSize` tall and the em box (ascender..descender) is centred in its line box
 * — what the preview's canvas `textBaseline = 'middle'` did.
 */
export function layoutText(fonts, text, style = {}) {
  const chain = Array.isArray(fonts) ? fonts.filter(Boolean) : [fonts].filter(Boolean);
  const raw = String(text == null ? '' : text);
  const fontSize = Number(style.fontSize ?? style.size);
  const size = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
  const lineHeight = Number(style.lineHeight) > 0 ? Number(style.lineHeight) : 1.18;
  const letterSpacing = Number(style.letterSpacing) || 0;
  const align = style.align === 'left' || style.align === 'right' ? style.align : 'center';
  const primary = chain[0] || null;
  const { ascender, descender } = primary ? metricsOf(primary, size) : { ascender: size * 0.8, descender: size * 0.2 };
  const lineH = size * lineHeight;
  const rows = raw.split(/\r?\n/);
  const lines = [];
  const missing = [];
  let width = 0;
  for (let i = 0; i < rows.length; i++) {
    const glyphs = [];
    let pen = 0;
    // `Array.from` iterates code points, so an emoji is one glyph, not two.
    for (const char of Array.from(rows[i])) {
      // `'\t'` is a space: the canvas raster never drew a tab either.
      const shown = char === '\t' ? ' ' : char;
      const font = fontForChar(chain, shown);
      if (!font) { missing.push(shown); continue; }
      const advance = advanceOf(font, shown, size);
      glyphs.push({ char: shown, x: pen, advance, font });
      pen += advance + letterSpacing;
    }
    const lineWidth = glyphs.length ? pen - letterSpacing : 0;
    width = Math.max(width, lineWidth);
    const baselineY = lineH * i + (lineH - (ascender + descender)) / 2 + ascender;
    lines.push({ baselineY, glyphs, width: lineWidth });
  }
  const height = lineH * rows.length;
  for (const line of lines) {
    const shift = align === 'left' ? 0 : align === 'right' ? width - line.width : (width - line.width) / 2;
    for (const g of line.glyphs) g.x += shift;
  }
  return { lines, width, height, fontSize: size, lineHeight, letterSpacing, align, missing };
}

/**
 * The whole text as one mesh: `layoutText` + one `glyphMesh` per glyph, merged
 * into a single triangle list.
 *
 * Returns `{ vertices, indices, size: [w, h], missing }` — the body of an IR
 * `meshes` record (§4.4 v4), vertices in quad-local pixels, origin top-left,
 * y down. A non-empty `missing` means some character is in no font of the
 * chain: the caller keeps the old picture path instead of drawing a gap.
 */
export function textMesh(fonts, text, style = {}, opts = {}) {
  const chain = Array.isArray(fonts) ? fonts.filter(Boolean) : [fonts].filter(Boolean);
  const layout = layoutText(chain, text, style);
  const vertices = [];
  const indices = [];
  const glyphOpts = opts.cache ? { cache: opts.cache } : {};
  for (const line of layout.lines) {
    for (const g of line.glyphs) {
      if (g.char === ' ') continue;
      const mesh = glyphMesh(g.font || chain[0], g.char, { size: layout.fontSize, x: g.x, y: line.baselineY }, glyphOpts);
      if (!mesh.indices.length) continue;
      const base = vertices.length / 2;
      for (let i = 0; i < mesh.vertices.length; i++) vertices.push(mesh.vertices[i]);
      for (let i = 0; i < mesh.indices.length; i++) indices.push(mesh.indices[i] + base);
    }
  }
  return { vertices, indices, size: [layout.width, layout.height], missing: layout.missing };
}

// ---------------------------------------------------------------- mesh ids

/**
 * Mesh id of a text style (`h_` + 24 hex chars): a stable hash of exactly the
 * fields that change the geometry (§4.4 v4) — the font's content hash, the
 * text, the font size, letter spacing, line height and the alignment. Colour and
 * opacity are *not* part of it: they change per frame (a fade must not create a
 * mesh per frame) and the IR carries them on the item.
 */
export function textMeshId(fontHashValue, text, style = {}) {
  const parts = [
    fontHashValue,
    String(text == null ? '' : text),
    Number(style.fontSize ?? style.size) || 0,
    Number(style.letterSpacing) || 0,
    Number(style.lineHeight) || 0,
    style.align || 'center',
  ].join('\u0001');
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x1b873593 >>> 0;
  for (let i = 0; i < parts.length; i++) {
    const c = parts.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ Math.imul((c + i) >>> 0, 0x85ebca6b)) >>> 0;
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
  }
  const a = h1.toString(16).padStart(8, '0');
  const b = h2.toString(16).padStart(8, '0');
  const c = (Math.imul(h1 ^ h2, 0x27d4eb2d) >>> 0).toString(16).padStart(8, '0');
  return `h_${a}${b}${c}`;
}
