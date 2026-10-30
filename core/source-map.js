// HTML / SVG → native elements: the compile side of R4
// (docs/DESIGN-BACKEND-V2.md §7.1, §7.8.1, §10.2 WP4.1).
//
// `compileHtml(source)` / `compileSvg(source)` turn a registered source
// (`project.sources[]`, the same table code layers use) into three things:
//
//   nodes     the snapshot records of §7.8.1 (`{ id, type, parent, props,
//             tracks }`), keyed by `data-vdm-id` (SVG: `id`); the baseline in
//             `props` is the value at source time t = 0, `tracks` are absolute
//             project seconds;
//   elements  element payloads for `core/ops.js` `addElement` / a patch, each
//             carrying `el.source = { id, node }` (§7.8.2) and the baseline
//             mirrored into the element's own fields;
//   warnings  everything this parser did **not** understand: unsupported tags,
//             CSS properties, selectors, layout modes, transforms, animation
//             features. Nothing is silently pretended to work.
//
// Pure ESM: no DOM, no `node:*`, no filesystem. Two things a real browser would
// measure are injected by the caller (`application/source-service.js`, which
// does have the font files, §7.1 "在 RenderWorkerPool 里加载源"):
//
//   opts.fonts = {
//     families: ['SimHei', …],                     // what the render pipeline resolves
//     metrics: { simhei: { ascent, descent, lineGap } },  // em fractions, for `line-height: normal`
//   }
//   opts.measureText = (text, style) => widthPx    // the same typesetting the IR uses
//
// Without them the compiler estimates (and warns: `font-unverified` /
// `text-measure-fallback`), which keeps the unit tests honest about it.
//
// Supported subset (anything outside warns, never silently drops a picture):
//
//   HTML   html/head/body/main/div/p/h1..h6/span/em/strong/b/i/br/ul/ol/li/a
//   SVG    svg/g, rect/circle/ellipse (drawn), path/polyline/polygon (parsed,
//          reported as not drawable: the element model only has rect + ellipse)
//   CSS    tag / .class / #id / * / descendant / child / comma lists /
//          :nth-child(an+b) | :first-child | :last-child
//   layout block flow, flex (row/column, gap, justify-content, align-items),
//          grid with place-items:center, position relative/absolute with
//          left/top/right/bottom, width/height/min-height, aspect-ratio,
//          padding/margin, box-sizing; `line-height: normal` from the font
//   style  color, background(-color/-image: linear-gradient), font-family/
//          size/weight, line-height, letter-spacing, text-align,
//          text-transform, opacity
//   motion @keyframes + `animation` (duration/delay/timing-function/
//          iteration-count/direction, cubic-bezier → `curve`), only
//          translate / uniform scale / rotate / opacity (the §7.8.1 set)
import { EASE_NAMES } from './time.js';
import { COMPILE_RUNTIMES, isRasterRuntime } from './code-layer.js';
import { SOURCE_DEFAULT_MODES, SOURCE_PATHS } from './source-eval.js';
import { isRecord } from './json.js';

// §7.8.7 R1: the closed path set lives in the evaluation side; 4.1 re-exports it
// instead of growing a second copy.
export { SOURCE_PATHS } from './source-eval.js';

/** Compiler version (goes into `base.json.compiler.version`, §7.8.1). */
export const SOURCE_MAP_VERSION = 1;
/** Runtimes this module compiles; the registry's set lives in core/code-layer.js. */
export { COMPILE_RUNTIMES, isRasterRuntime };
/** Snapshot node id rule (§7.8.1). */
export const NODE_ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** Fallback viewport when the caller does not pass `meta.width/height`. */
const DEFAULT_VIEWPORT = [1920, 1080];
/** Snapshot `props` baseline keys every text node carries (§7.8.1 example). */
const TEXT_PATHS = Object.freeze([
  'style.text', 'style.font', 'style.size', 'style.weight', 'style.color', 'style.align',
  'style.lineHeight', 'style.letterSpacing',
]);
const TRANSFORM_PATHS = Object.freeze([
  'transform.x', 'transform.y', 'transform.scale', 'transform.rotation', 'transform.opacity',
]);

const isNum = (v) => typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
const num = (v, d = 0) => (isNum(v) ? Number(v) : d);
const r3 = (v) => Math.round(Number(v) * 1e3) / 1e3 + 0;
const r6 = (v) => Math.round(Number(v) * 1e6) / 1e6 + 0;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lower = (v) => String(v ?? '').trim().toLowerCase();
const attr = (node, name) => (node?.attrs ? node.attrs[name] : undefined);

// ---------------------------------------------------------------------------
// Warnings: closed-ish vocabulary, deduped by (code, at)
// ---------------------------------------------------------------------------

/**
 * Everything the compiler reports instead of guessing. `at` is
 * `index.html:12` / `style.css:.rule` / `base.json`, so a caller can point at
 * the line that surprised it.
 */
export const WARNING_CODES = Object.freeze([
  'unsupported-tag', 'unsupported-property', 'unsupported-value',
  'unsupported-selector', 'unsupported-pseudo-class', 'unsupported-at-rule',
  'unsupported-layout', 'unsupported-transform', 'unsupported-transform-origin',
  'unsupported-animation', 'unsupported-keyframe-property', 'unsupported-animation-direction',
  'unsupported-text-wrap', 'media-query-ignored', 'script-not-executed',
  'image-unsupported', 'inline-svg-ignored', 'container-node-unsupported',
  'node-id-invalid', 'duplicate-node-id', 'font-unverified', 'text-measure-fallback',
  'background-unsupported', 'background-gradient-approximated', 'background-not-compiled',
  'path-not-drawable', 'polygon-not-drawable', 'smil-animation-ignored',
  'svg-viewbox', 'svg-transform-unsupported', 'empty-node',
]);

class Warnings {
  constructor() {
    this.list = [];
    this.seen = new Set();
  }

  /** Record one `{ code, at, message }`; repeat reports of one spot collapse. */
  add(code, at, message) {
    const key = `${code}\u0000${at}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ code, at, message });
  }

  get length() { return this.list.length; }
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const NAMED_COLORS = Object.freeze({
  transparent: [0, 0, 0, 0],
  black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1], green: [0, 128, 0, 1],
  blue: [0, 0, 255, 1], yellow: [255, 255, 0, 1], orange: [255, 165, 0, 1],
  gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], silver: [192, 192, 192, 1],
  navy: [0, 0, 128, 1], teal: [0, 128, 128, 1], purple: [128, 0, 128, 1],
  pink: [255, 192, 203, 1], lime: [0, 255, 0, 1], cyan: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1], maroon: [128, 0, 0, 1], olive: [128, 128, 0, 1],
});

/** `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()` / a named color. */
export function parseCssColor(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const name = NAMED_COLORS[raw.toLowerCase()];
  if (name) return { r: name[0], g: name[1], b: name[2], a: name[3] };
  if (raw[0] === '#') {
    const hex = raw.slice(1);
    const expand = (h) => (h.length === 1 ? h + h : h);
    if (hex.length === 3 || hex.length === 4) {
      const n = hex.split('').map((c) => parseInt(expand(c), 16));
      if (n.every(Number.isFinite)) return { r: n[0], g: n[1], b: n[2], a: hex.length === 4 ? n[3] / 255 : 1 };
      return null;
    }
    if (hex.length === 6 || hex.length === 8) {
      const n = [];
      for (let i = 0; i < hex.length; i += 2) n.push(parseInt(hex.slice(i, i + 2), 16));
      if (n.every(Number.isFinite)) return { r: n[0], g: n[1], b: n[2], a: hex.length === 8 ? n[3] / 255 : 1 };
    }
    return null;
  }
  const m = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[,/]/).map((s) => s.trim()).filter((s) => s !== '');
    if (parts.length < 3) return null;
    const channel = (s) => (String(s).endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s));
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    const a = parts.length >= 4 ? (String(parts[3]).endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r, g, b, a: clamp(a, 0, 1) };
  }
  return null;
}

/** Opaque `#rrggbb` (alpha is carried by `transform.opacity`, §7.8.1). */
export function formatHex(color) {
  const hex = (v) => Math.round(clamp(num(v, 0), 0, 255)).toString(16).padStart(2, '0');
  return `#${hex(color?.r)}${hex(color?.g)}${hex(color?.b)}`;
}

/** `fg` over `bg` (both `{ r, g, b, a }`), opaque result. */
export function compositeColor(fg, bg) {
  const a = clamp(num(fg?.a, 1), 0, 1);
  const under = bg || { r: 0, g: 0, b: 0, a: 1 };
  const k = a + num(under.a, 1) * (1 - a);
  if (k <= 1e-9) return { r: 0, g: 0, b: 0, a: 1 };
  const mix = (x, y) => (num(x) * a + num(y) * num(under.a, 1) * (1 - a)) / k;
  return { r: mix(fg?.r, under.r), g: mix(fg?.g, under.g), b: mix(fg?.b, under.b), a: 1 };
}

// ---------------------------------------------------------------------------
// Lengths, numbers and calc()/min()/max()/clamp()
// ---------------------------------------------------------------------------

/** Units a length may use; `%` needs a `percent` base in the context. */
const LENGTH_UNITS = new Set(['px', 'vh', 'vw', 'vmin', 'vmax', 'em', 'rem', '%', 'pt', 'cm', 'mm', 'in']);

/** Resolve one `{ value, unit }` against a context. */
function unitToPx(value, unit, ctx = {}) {
  const vw = num(ctx.vw, DEFAULT_VIEWPORT[0]);
  const vh = num(ctx.vh, DEFAULT_VIEWPORT[1]);
  const em = num(ctx.fontSize, 16);
  switch (unit) {
    case '': case 'px': return value;
    case 'vh': return (value / 100) * vh;
    case 'vw': return (value / 100) * vw;
    case 'vmin': return (value / 100) * Math.min(vw, vh);
    case 'vmax': return (value / 100) * Math.max(vw, vh);
    case 'em': return value * em;
    case 'rem': return value * num(ctx.rootFontSize, 16);
    case '%': return ctx.percent === null || ctx.percent === undefined ? null : (value / 100) * num(ctx.percent);
    case 'pt': return value * (96 / 72);
    case 'in': return value * 96;
    case 'cm': return value * (96 / 2.54);
    case 'mm': return value * (96 / 25.4);
    default: return null;
  }
}

function tokenizeValue(text) {
  const out = [];
  const src = String(text ?? '');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === ',') { out.push({ t: ',' }); i += 1; continue; }
    // A leading sign belongs to the number (`-100%`, `calc(1px + -2px)`); a
    // `+`/`-` that follows a value is arithmetic.
    const previous = out[out.length - 1];
    const unary = (ch === '-' || ch === '+')
      && /[\d.]/.test(src[i + 1] ?? '')
      && (!previous || ['+', '-', '*', '/', '(', ','].includes(previous.t));
    if (!unary && '+-*/()'.includes(ch)) { out.push({ t: ch }); i += 1; continue; }
    const rest = src.slice(i);
    const number = rest.match(/^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/i);
    if (number) {
      out.push({ t: 'num', v: Number(number[1]), unit: number[2].toLowerCase() });
      i += number[0].length;
      continue;
    }
    const ident = rest.match(/^-?[a-z_][a-z0-9_-]*/i);
    if (ident) {
      out.push({ t: 'ident', v: ident[0].toLowerCase() });
      i += ident[0].length;
      continue;
    }
    out.push({ t: 'other', v: ch });
    i += 1;
  }
  return out;
}

/**
 * Evaluate a CSS length / number expression: `12px`, `1.7vh`, `38%`,
 * `0.42em`, `calc(0.9s / var(--speed, 1))`-style arithmetic on lengths, and
 * `min()` / `max()` / `clamp()`. Returns null when the expression is outside
 * the subset (the caller warns).
 */
export function evalLength(expr, ctx = {}) {
  const tokens = tokenizeValue(expr);
  if (!tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (t) => (tokens[pos]?.t === t ? tokens[pos++] : null);
  const parsePrimary = () => {
    const tok = peek();
    if (!tok) return null;
    if (tok.t === 'num') { pos += 1; return { value: tok.v, unit: tok.unit }; }
    if (tok.t === '(') { pos += 1; const v = parseSum(); if (!take(')')) return null; return v; }
    if (tok.t === 'ident') {
      pos += 1;
      const name = tok.v;
      if (name === 'min' || name === 'max' || name === 'clamp' || name === 'calc') {
        if (!take('(')) return null;
        const args = [];
        for (;;) {
          const v = parseSum();
          if (v === null) return null;
          args.push(v);
          if (take(',')) continue;
          break;
        }
        if (!take(')')) return null;
        const nums = args.map((a) => unitToPx(a.value, a.unit, ctx));
        if (nums.some((n) => n === null)) return null;
        const value = name === 'clamp'
          ? clamp(nums[1], nums[0], nums[2])
          : name === 'calc' ? nums[0]
            : name === 'min' ? Math.min(...nums) : Math.max(...nums);
        return { value, unit: 'px' };
      }
      // Unit-only identifiers (`0`, `auto`, keyword) are not lengths.
      return { keyword: name, value: 0, unit: '' };
    }
    return null;
  };
  const parseProduct = () => {
    let left = parsePrimary();
    for (;;) {
      const op = peek();
      if (!op || (op.t !== '*' && op.t !== '/')) break;
      pos += 1;
      const right = parsePrimary();
      if (!left || !right) return null;
      if (op.t === '/') {
        if (right.value === 0 || right.unit !== '') return null;
        left = { value: left.value / right.value, unit: left.unit };
      } else if (left.unit === '') {
        left = { value: left.value * right.value, unit: right.unit };
      } else if (right.unit === '') {
        left = { value: left.value * right.value, unit: left.unit };
      } else return null;
    }
    return left;
  };
  const parseSum = () => {
    let left = parseProduct();
    for (;;) {
      const op = peek();
      if (!op || (op.t !== '+' && op.t !== '-')) break;
      pos += 1;
      const right = parseProduct();
      if (!left || !right) return null;
      const a = unitToPx(left.value, left.unit, ctx);
      const b = unitToPx(right.value, right.unit, ctx);
      if (a === null || b === null) return null;
      left = { value: op.t === '+' ? a + b : a - b, unit: 'px' };
    }
    return left;
  };
  let result = parseSum();
  if (!result || pos !== tokens.length) {
    // `auto`, `none`, `fit-content`, … : not a length.
    if (tokens.length === 1 && tokens[0].t === 'ident') return null;
    return null;
  }
  if (result.keyword !== undefined) return null;
  const px = unitToPx(result.value, result.unit, ctx);
  return px === null || !Number.isFinite(px) ? null : px;
}

/** Evaluate a CSS time (`0.9s`, `600ms`, `calc(var(--i) * var(--stagger))`). */
export function evalTime(expr) {
  const text = String(expr ?? '').trim();
  if (!text) return null;
  const direct = text.match(/^(-?(?:\d+\.?\d*|\.\d+))(s|ms)$/i);
  if (direct) return Number(direct[1]) * (direct[2].toLowerCase() === 'ms' ? 0.001 : 1);
  // Calc: evaluate as a plain number after stripping the unit from the sum.
  const tokens = tokenizeValue(text);
  let pos = 0;
  const parsePrimary = () => {
    const tok = tokens[pos];
    if (!tok) return null;
    if (tok.t === 'num') {
      pos += 1;
      const factor = tok.unit === 'ms' ? 0.001 : tok.unit === 's' ? 1 : tok.unit === '' ? 1 : null;
      return factor === null ? null : tok.v * factor;
    }
    if (tok.t === '(') { pos += 1; const v = parseSum(); if (tokens[pos]?.t !== ')') return null; pos += 1; return v; }
    if (tok.t === 'ident' && /^(calc|min|max|clamp)$/.test(tok.v)) {
      pos += 1;
      if (tokens[pos]?.t !== '(') return null;
      pos += 1;
      const args = [];
      for (;;) {
        const value = parseSum();
        if (value === null) return null;
        args.push(value);
        if (tokens[pos]?.t === ',') { pos += 1; continue; }
        break;
      }
      if (tokens[pos]?.t !== ')') return null;
      pos += 1;
      if (args.length === 1) return args[0];
      if (tok.v === 'min') return Math.min(...args);
      if (tok.v === 'max') return Math.max(...args);
      return args.length >= 3 ? clamp(args[1], args[0], args[2]) : args[0];
    }
    return null;
  };
  const parseProduct = () => {
    let left = parsePrimary();
    for (;;) {
      const op = tokens[pos];
      if (!op || (op.t !== '*' && op.t !== '/')) break;
      pos += 1;
      const right = parsePrimary();
      if (left === null || right === null) return null;
      left = op.t === '*' ? left * right : right === 0 ? null : left / right;
    }
    return left;
  };
  const parseSum = () => {
    let left = parseProduct();
    for (;;) {
      const op = tokens[pos];
      if (!op || (op.t !== '+' && op.t !== '-')) break;
      pos += 1;
      const right = parseProduct();
      if (left === null || right === null) return null;
      left = op.t === '+' ? left + right : left - right;
    }
    return left;
  };
  const value = parseSum();
  return pos === tokens.length && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// HTML tokenizer + tree
// ---------------------------------------------------------------------------

export const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['style', 'script', 'title']);
/** Tags the compiler knows how to lay out; anything else is reported. */
const KNOWN_TAGS = new Set([
  'html', 'head', 'body', 'main', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'em', 'strong',
  'b', 'i', 'br', 'ul', 'ol', 'li', 'a', 'style', 'link', 'script', 'title', 'meta', 'img', 'svg',
  'section', 'article', 'header', 'footer', 'nav', 'figure', 'figcaption', 'small', 'code', 'pre', 'hr',
  'label', 'button', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
]);
const INLINE_TAGS = new Set(['span', 'em', 'strong', 'b', 'i', 'a', 'small', 'code', 'label', 'button', 'br', 'img']);

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', middot: '·', mdash: '—' };
    return named[body.toLowerCase()] ?? all;
  });
}

/**
 * Tokenize HTML into open/close/text/comment tokens with line numbers and the
 * `start` / `end` offsets of each token in the original text (write-back, §7.8.3,
 * splices those spans; the compiler itself does not need them).
 */
export function tokenizeHtml(text) {
  const src = String(text ?? '');
  const out = [];
  let i = 0;
  let line = 1;
  const advance = (to) => {
    for (let k = i; k < to && k < src.length; k++) if (src[k] === '\n') line += 1;
    i = to;
  };
  while (i < src.length) {
    const at = src.indexOf('<', i);
    if (at < 0) {
      out.push({ type: 'text', raw: decodeEntities(src.slice(i)), line, start: i, end: src.length });
      break;
    }
    if (at > i) {
      out.push({ type: 'text', raw: decodeEntities(src.slice(i, at)), line, start: i, end: at });
      advance(at);
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end < 0 ? src.length : end + 3;
      out.push({ type: 'comment', raw: src.slice(i, stop), line, start: i, end: stop });
      advance(stop);
      continue;
    }
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
      const end = src.indexOf('>', i);
      const stop = end < 0 ? src.length : end + 1;
      out.push({ type: 'doctype', raw: src.slice(i, stop), line, start: i, end: stop });
      advance(stop);
      continue;
    }
    const tagMatch = src.slice(i).match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:_-]*)/);
    if (!tagMatch) {
      out.push({ type: 'text', raw: '<', line, start: i, end: i + 1 });
      advance(i + 1);
      continue;
    }
    const closing = tagMatch[1] === '/';
    const name = tagMatch[2].toLowerCase();
    const startLine = line;
    let cursor = i + tagMatch[0].length;
    const attrs = {};
    let selfClosing = false;
    // Attributes, honouring quoted values and `/` before `>`.
    for (;;) {
      while (cursor < src.length && /\s/.test(src[cursor])) cursor += 1;
      if (cursor >= src.length) break;
      if (src[cursor] === '>') { cursor += 1; break; }
      if (src[cursor] === '/' && src[cursor + 1] === '>') { selfClosing = true; cursor += 2; break; }
      const nameMatch = src.slice(cursor).match(/^([^\s=/>]+)/);
      if (!nameMatch) { cursor += 1; continue; }
      const attrName = nameMatch[1].toLowerCase();
      cursor += nameMatch[0].length;
      while (cursor < src.length && /\s/.test(src[cursor])) cursor += 1;
      let value = '';
      if (src[cursor] === '=') {
        cursor += 1;
        while (cursor < src.length && /\s/.test(src[cursor])) cursor += 1;
        const quote = src[cursor];
        if (quote === '"' || quote === "'") {
          const end = src.indexOf(quote, cursor + 1);
          const stop = end < 0 ? src.length : end;
          value = decodeEntities(src.slice(cursor + 1, stop));
          cursor = end < 0 ? src.length : end + 1;
        } else {
          const bare = src.slice(cursor).match(/^[^\s>]+/);
          value = decodeEntities(bare ? bare[0] : '');
          cursor += bare ? bare[0].length : 0;
        }
      }
      if (!Object.hasOwn(attrs, attrName)) attrs[attrName] = value;
    }
    // Advance `line` over the tag body so later tokens keep real line numbers.
    for (let k = i; k < cursor && k < src.length; k++) if (src[k] === '\n') line += 1;
    // Tag span in the original text: write-back (§7.8.3) splices exactly the
    // element it found instead of re-serialising the whole file.
    const tagStart = i;
    i = cursor;
    out.push({ type: closing ? 'close' : 'open', name, attrs, selfClosing, line: startLine, start: tagStart, end: cursor });
    if (!closing && RAW_TEXT_TAGS.has(name)) {
      const re = new RegExp(`</\\s*${name}\\s*>`, 'i');
      const rest = src.slice(i);
      const match = rest.match(re);
      const body = match ? rest.slice(0, match.index) : rest;
      if (body) {
        const holder = name === 'title' ? decodeEntities(body) : body;
        out.push({ type: 'text', raw: holder, line, start: i, end: i + body.length });
        for (let k = 0; k < body.length; k++) if (body[k] === '\n') line += 1;
      }
      if (match) {
        const closeStart = i + match.index;
        i = closeStart + match[0].length;
        out.push({ type: 'close', name, attrs: {}, line, start: closeStart, end: i });
      } else i = src.length;
    }
  }
  return out;
}

/**
 * Parse HTML text into `{ document, warnings }`: a tolerant element tree
 * (`{ type: 'element', tag, attrs, children, parent, line }`) plus text nodes.
 */
export function parseHtml(text, { at = 'source.html', warnings = new Warnings() } = {}) {
  const root = { type: 'element', tag: '#root', attrs: {}, children: [], parent: null, line: 1, anonymous: true };
  let current = root;
  for (const token of tokenizeHtml(text)) {
    if (token.type === 'text') {
      if (!token.raw) continue;
      current.children.push({ type: 'text', text: token.raw, parent: current, line: token.line });
      continue;
    }
    if (token.type !== 'open' && token.type !== 'close') continue;
    if (token.type === 'close') {
      // Close the nearest matching ancestor; a stray close is ignored.
      let node = current;
      while (node && node !== root && node.tag !== token.name) node = node.parent;
      if (node && node !== root) current = node.parent;
      continue;
    }
    const node = { type: 'element', tag: token.name, attrs: { ...token.attrs }, children: [], parent: current, line: token.line };
    current.children.push(node);
    if (!KNOWN_TAGS.has(token.name)) {
      warnings.add('unsupported-tag', `${at}:${token.line}`, `<${token.name}> 不在编译子集里，按块级容器处理（样式与布局可能不准）`);
    }
    if (token.name === 'script') {
      warnings.add('script-not-executed', `${at}:${token.line}`, '<script> 不执行：脚本生成的 DOM 不进编译结果（模块需把节点写进静态 HTML，或走代码图层）');
    }
    if (!VOID_TAGS.has(token.name) && !token.selfClosing) current = node;
  }
  return { root, warnings: warnings.list };
}

// ---------------------------------------------------------------------------
// CSS parser
// ---------------------------------------------------------------------------

/** Split a declaration block on `;` while respecting quotes and parens. */
export function splitDeclarations(body) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out.filter((part) => part.trim() !== '');
}

/** One `prop: value` pair, or null. `important` is stripped (the whole sheet is author-level). */
export function parseDeclaration(text) {
  const cleaned = String(text ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const at = cleaned.indexOf(':');
  if (at < 0) return null;
  const prop = cleaned.slice(0, at).trim().toLowerCase();
  if (!prop) return null;
  let value = cleaned.slice(at + 1).trim();
  let important = false;
  if (/!important$/i.test(value)) { important = true; value = value.replace(/!important$/i, '').trim(); }
  return { prop, value, important };
}

/** `prop: value; …` (a `style` attribute) → `{ prop: value }`. */
export function parseStyleAttribute(text) {
  const out = {};
  if (!text) return out;
  for (const decl of splitDeclarations(String(text))) {
    const parsed = parseDeclaration(decl);
    if (parsed) out[parsed.prop] = parsed.value;
  }
  return out;
}

const atRuleWarnings = new Set(['media-query-ignored', 'unsupported-at-rule', 'unsupported-keyframe-property']);

/**
 * Parse a stylesheet into `{ rules, keyframes, warnings }`.
 * `@media` blocks are skipped (one warning); `@keyframes` are kept.
 */
export function parseStylesheet(text, { at = 'source.css', warnings = new Warnings() } = {}) {
  const rules = [];
  const keyframes = new Map();
  const src = String(text ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  let order = 0;
  const readBlock = (from) => {
    const open = src.indexOf('{', from);
    if (open < 0) return { header: src.slice(from).trim(), body: '', end: src.length };
    let depth = 0;
    let k = open;
    for (; k < src.length; k++) {
      if (src[k] === '{') depth += 1;
      else if (src[k] === '}') { depth -= 1; if (depth === 0) { k += 1; break; } }
    }
    return { header: src.slice(from, open).trim(), body: src.slice(open + 1, Math.max(open + 1, k - 1)), end: k };
  };
  while (i < src.length) {
    while (i < src.length && /[\s;]/.test(src[i])) i += 1;
    if (i >= src.length) break;
    if (src[i] === '@') {
      const head = src.slice(i).match(/^@([A-Za-z-]+)/);
      const name = head ? head[1].toLowerCase() : '';
      if (name === 'keyframes' || name === '-webkit-keyframes') {
        const block = readBlock(i);
        const frameName = block.header.replace(/^@[-A-Za-z]*keyframes\s+/i, '').trim().replace(/^["']|["']$/g, '');
        const frames = [];
        let j = 0;
        while (j < block.body.length) {
          while (j < block.body.length && /\s/.test(block.body[j])) j += 1;
          const open = block.body.indexOf('{', j);
          if (open < 0) break;
          const selector = block.body.slice(j, open).trim();
          let depth = 0;
          let k = open;
          for (; k < block.body.length; k++) {
            if (block.body[k] === '{') depth += 1;
            else if (block.body[k] === '}') { depth -= 1; if (depth === 0) { k += 1; break; } }
          }
          const body = block.body.slice(open + 1, Math.max(open + 1, k - 1));
          const decls = {};
          for (const part of splitDeclarations(body)) {
            const parsed = parseDeclaration(part);
            if (parsed) decls[parsed.prop] = parsed.value;
          }
          for (const keyText of selector.split(',')) {
            const percent = keyframePercent(keyText.trim());
            if (percent === null) {
              warnings.add('unsupported-keyframe-property', `${at}@keyframes ${frameName}`, `关键帧选择器 ${JSON.stringify(keyText.trim())} 不能理解`);
              continue;
            }
            frames.push({ percent, decls, at: `${at}@keyframes ${frameName}` });
          }
          j = k;
        }
        keyframes.set(frameName, frames);
        i = block.end;
        continue;
      }
      const block = readBlock(i);
      const isMedia = name === 'media';
      if (isMedia) {
        warnings.add('media-query-ignored', `${at}@media`, '@media 整块跳过：编译只按无媒体条件的那一份样式布局');
      } else {
        warnings.add('unsupported-at-rule', `${at}@${name}`, `@${name} 不在编译子集里，整块跳过`);
      }
      i = block.end;
      continue;
    }
    const block = readBlock(i);
    const selectorText = block.header;
    const decls = {};
    for (const part of splitDeclarations(block.body)) {
      const parsed = parseDeclaration(part);
      if (parsed) decls[parsed.prop] = parsed.value;
    }
    if (selectorText && Object.keys(decls).length) {
      const selectors = parseSelectorList(selectorText, { at, warnings });
      if (selectors.length) rules.push({ selectors, decls, order: order++, at: `${at} ${selectorText}` });
    }
    i = block.end;
  }
  return { rules, keyframes, warnings: warnings.list };
}

function keyframePercent(text) {
  const value = lower(text);
  if (value === 'from') return 0;
  if (value === 'to') return 100;
  const m = value.match(/^(-?\d+\.?\d*)%$/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** One compound selector: tag / id / classes / pseudo-classes. */
function parseCompound(text, { at, warnings }) {
  let rest = text.trim();
  if (!rest) return null;
  const compound = { tag: null, id: null, classes: [], pseudos: [], universal: false };
  let match = rest.match(/^([A-Za-z][A-Za-z0-9-]*|\*)/);
  if (match) {
    compound.universal = match[1] === '*';
    compound.tag = compound.universal ? null : match[1].toLowerCase();
    rest = rest.slice(match[0].length);
  }
  for (;;) {
    if (!rest) break;
    match = rest.match(/^#([A-Za-z_][A-Za-z0-9_-]*)/);
    if (match) { compound.id = match[1]; rest = rest.slice(match[0].length); continue; }
    match = rest.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)/);
    if (match) { compound.classes.push(match[1]); rest = rest.slice(match[0].length); continue; }
    match = rest.match(/^::?([A-Za-z-]+)(\(([^)]*)\))?/);
    if (match) {
      const name = match[1].toLowerCase();
      const arg = match[3];
      if (['first-child', 'last-child'].includes(name)) compound.pseudos.push({ name });
      else if (name === 'nth-child' && arg !== undefined) {
        const pattern = parseNth(arg);
        if (pattern) compound.pseudos.push({ name, pattern });
        else return null;
      } else {
        warnings?.add('unsupported-pseudo-class', at, `伪类 :${name} 不在编译子集里`);
        return null;
      }
      rest = rest.slice(match[0].length);
      continue;
    }
    return null;
  }
  if (!compound.universal && !compound.tag && !compound.id && !compound.classes.length && !compound.pseudos.length) return null;
  return compound;
}

/** `an+b` (odd / even / 2n+1 / -n+2). */
function parseNth(text) {
  const value = lower(text).replace(/\s+/g, '');
  if (value === 'odd') return [2, 1];
  if (value === 'even') return [2, 0];
  const m = value.match(/^([+-]?\d*)n([+-]\d+)?$/);
  if (m) {
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    return [a, Number(m[2] ?? 0)];
  }
  if (/^[+-]?\d+$/.test(value)) return [0, Number(value)];
  return null;
}

/** One complex selector: compound + combinators (' ' descendant, '>' child). */
/** One compound selector: everything up to a top-level space or '>' (arguments keep their spaces). */
function readCompound(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '	')) return text.slice(0, i);
  }
  return text;
}

export function parseSelector(text, { at = 'source.css', warnings = null } = {}) {
  let rest = String(text ?? '').trim();
  if (!rest) return null;
  const compounds = [];
  const combinators = [];
  let pending = ' ';
  for (;;) {
    rest = rest.trim();
    if (!rest) break;
    if (rest.startsWith('>')) { pending = '>'; rest = rest.slice(1).trim(); continue; }
    const compoundText = readCompound(rest);
    const compound = parseCompound(compoundText, { at, warnings });
    if (!compound) return null;
    compounds.push(compound);
    combinators.push(pending);
    pending = ' ';
    rest = rest.slice(compoundText.length);
  }
  if (!compounds.length) return null;
  const specificity = compounds.reduce((acc, c) => [acc[0] + (c.id ? 1 : 0), acc[1] + c.classes.length + c.pseudos.length, acc[2] + (c.tag ? 1 : 0)], [0, 0, 0]);
  return { compounds, combinators, specificity };
}

/** A comma list; unsupported entries are dropped with one warning each. */
export function parseSelectorList(text, { at = 'source.css', warnings = null } = {}) {
  const out = [];
  for (const part of String(text).split(',')) {
    const selector = parseSelector(part, { at, warnings });
    if (selector) out.push(selector);
    else if (part.trim()) warnings?.add('unsupported-selector', at, `选择器 ${JSON.stringify(part.trim())} 不在编译子集里`);
  }
  return out;
}

function elementSiblings(node) {
  return (node.parent?.children || []).filter((child) => child.type === 'element');
}

function matchesCompound(compound, node) {
  if (!node || node.type !== 'element') return false;
  if (compound.tag && node.tag !== compound.tag) return false;
  if (compound.id && attr(node, 'id') !== compound.id) return false;
  if (compound.classes.length) {
    const classes = String(attr(node, 'class') ?? '').split(/\s+/).filter(Boolean);
    for (const name of compound.classes) if (!classes.includes(name)) return false;
  }
  if (compound.pseudos.length) {
    const siblings = elementSiblings(node);
    const index = siblings.indexOf(node) + 1;
    for (const pseudo of compound.pseudos) {
      if (pseudo.name === 'first-child' && index !== 1) return false;
      if (pseudo.name === 'last-child' && index !== siblings.length) return false;
      if (pseudo.name === 'nth-child' && pseudo.pattern) {
        const [a, b] = pseudo.pattern;
        if (a === 0) { if (index !== b) return false; continue; }
        const n = (index - b) / a;
        if (!Number.isInteger(n) || n < 0) return false;
      }
    }
  }
  return true;
}

/** Does `node` match this complex selector? */
export function matchesSelector(selector, node) {
  const { compounds, combinators } = selector;
  const walk = (current, index) => {
    if (!matchesCompound(compounds[index], current)) return false;
    if (index === 0) return true;
    const combinator = combinators[index];
    if (combinator === '>') return walk(current.parent, index - 1);
    let parent = current.parent;
    while (parent) {
      if (walk(parent, index - 1)) return true;
      parent = parent.parent;
    }
    return false;
  };
  return walk(node, compounds.length - 1);
}

/** Specificity comparison `[ids, classes, tags]`. */
export function compareSpecificity(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ---------------------------------------------------------------------------
// Computed style
// ---------------------------------------------------------------------------

/** Properties the compiler reads. Anything else warns (unless benign). */
const SUPPORTED_PROPERTIES = new Set([
  'display', 'position', 'left', 'top', 'right', 'bottom', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'aspect-ratio', 'box-sizing', 'margin', 'margin-top', 'margin-right',
  'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'gap', 'row-gap', 'column-gap', 'flex-direction', 'justify-content', 'align-items',
  'place-items', 'grid-template-columns', 'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'text-align', 'text-transform', 'color', 'background', 'background-color',
  'background-image', 'opacity', 'transform', 'transform-origin', 'animation', 'animation-name',
  'animation-duration', 'animation-delay', 'animation-timing-function', 'animation-iteration-count',
  'animation-fill-mode', 'animation-direction', 'animation-play-state', 'transition',
]);
/** Recognised but irrelevant to the compiled picture: no warning. */
const IGNORED_PROPERTIES = new Set([
  'overflow', 'overflow-x', 'overflow-y', 'z-index', 'list-style', 'list-style-type', 'list-style-position',
  'text-decoration', 'text-decoration-line', 'cursor', 'user-select', 'pointer-events', 'visibility',
  'box-shadow', 'text-shadow', 'outline', 'border', 'border-width', 'border-color', 'border-style',
  'border-radius', 'will-change', 'contain', 'isolation', 'mix-blend-mode', 'filter', 'backdrop-filter',
  'object-fit', 'object-position', 'white-space', 'word-break', 'line-clamp', 'direction', 'unicode-bidi',
  'font-style', 'font-variant', 'text-rendering', 'font-feature-settings', 'font-stretch',
  'grid-template-rows', 'grid-auto-flow', 'align-content', 'justify-items', 'flex-wrap', 'flex', 'flex-grow',
  'flex-shrink', 'flex-basis', 'align-self', 'justify-self', 'order', 'vertical-align', 'float', 'clear',
  'inset', 'margin-block', 'margin-inline', 'padding-block', 'padding-inline', 'width-min', 'translate',
  'scale', 'rotate', 'position-x', '-webkit-font-smoothing', 'appearance', 'tap-highlight-color',
]);

const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'text-align', 'text-transform', 'direction', 'visibility']);

/** Substitute `var(--name, fallback)` from the element's custom properties. */
export function substituteVars(value, custom, depth = 0) {
  if (typeof value !== 'string' || !value.includes('var(') || depth > 8) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let k = at + 4;
    let depth2 = 1;
    for (; k < value.length && depth2 > 0; k++) {
      if (value[k] === '(') depth2 += 1;
      else if (value[k] === ')') depth2 -= 1;
    }
    const body = value.slice(at + 4, k - 1);
    const comma = body.indexOf(',');
    const name = (comma < 0 ? body : body.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : body.slice(comma + 1).trim();
    const found = Object.hasOwn(custom, name) ? custom[name] : fallback;
    out += found === undefined ? '' : substituteVars(found, custom, depth + 1);
    i = k;
  }
  return out;
}

/**
 * A `margin` / `padding` shorthand → four sides. Each side is a number of px or
 * `{ percent }` — a percentage resolves against the containing block's *width*
 * (§css-box-3), which the layout knows and the cascade does not.
 */
function expandBoxShorthand(value, ctx) {
  const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [0, 0, 0, 0];
  const px = parts.map((part) => {
    const percent = String(part).trim().match(/^(-?(?:\d+\.?\d*|\.\d+))%$/);
    if (percent) return { percent: Number(percent[1]) / 100 };
    const resolved = evalLength(part, ctx);
    return resolved === null ? 0 : resolved;
  });
  const [a, b = a, c = a, d = b] = px;
  return [a, b, c, d];
}

/** Resolve one side array against a containing width → `{ t, r, b, l }`. */
function resolveSides(sides, base) {
  const one = (side) => (side && typeof side === 'object' ? (Number.isFinite(base) ? side.percent * base : 0) : num(side));
  const [t, r, b, l] = Array.isArray(sides) ? sides : [0, 0, 0, 0];
  return { t: one(t), r: one(r), b: one(b), l: one(l) };
}

const FONT_WEIGHTS = { normal: 400, bold: 700, bolder: 700, lighter: 300 };

/** Numeric font weight, or null when the value is not one we read. */
function fontWeightOf(value) {
  if (value === undefined) return null;
  const text = lower(value);
  if (Object.hasOwn(FONT_WEIGHTS, text)) return FONT_WEIGHTS[text];
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** `animation` shorthand / longhands → a list of animation records. */
function animationsOf(decls, custom, at, warnings) {
  const read = (name, dflt = '') => {
    const raw = decls[name];
    return raw === undefined ? dflt : substituteVars(raw, custom);
  };
  const list = [];
  const shorthand = read('animation');
  if (shorthand && lower(shorthand) !== 'none') {
    for (const item of splitCommaList(shorthand)) {
      const record = parseAnimationShorthand(item, at, warnings);
      if (record) list.push(record);
    }
  }
  // Longhands apply to the whole list; a shorthand per item is the common case.
  if (!list.length) {
    const names = splitCommaList(read('animation-name'));
    for (const name of names) {
      if (!name || lower(name) === 'none') continue;
      const record = {
        name: name.trim().replace(/^["']|["']$/g, ''),
        duration: null, delay: null, timing: null, iterations: null, fill: null, direction: null,
      };
      const one = (prop) => {
        const raw = read(`animation-${prop}`);
        return raw ? splitCommaList(raw)[0] : null;
      };
      record.duration = one('duration');
      record.delay = one('delay');
      record.timing = one('timing-function');
      record.iterations = one('iteration-count');
      record.fill = one('fill-mode');
      record.direction = one('direction');
      list.push(record);
    }
  }
  return list.map((record) => finaliseAnimation(record, at, warnings));
}

/** Split on top-level commas. */
export function splitCommaList(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < String(text ?? '').length; i++) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(String(text ?? '').slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const EASING_CUBICS = Object.freeze({
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
});

function parseAnimationShorthand(text, at, warnings) {
  const record = { duration: null, delay: null, timing: null, iterations: null, fill: null, direction: null, name: null };
  const times = [];
  for (const part of splitTopLevelWhitespace(String(text).trim())) {
    if (!part) continue;
    if (/^-?(?:\d+\.?\d*|\.\d+)(ms|s)$/i.test(part) || /^(calc|min|max|clamp)\(/i.test(part)) { times.push(part); continue; }
    const value = lower(part);
    if (['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'].includes(value) || /^(cubic-bezier|steps|linear)\(/i.test(part)) {
      record.timing = part; continue;
    }
    if (value === 'infinite' || /^\d+\.?\d*$/.test(value)) { record.iterations = part; continue; }
    if (['none', 'forwards', 'backwards', 'both'].includes(value)) { record.fill = part; continue; }
    if (['normal', 'reverse', 'alternate', 'alternate-reverse'].includes(value)) { record.direction = part; continue; }
    if (['running', 'paused'].includes(value)) continue;
    record.name = part.replace(/^["']|["']$/g, '');
  }
  if (times.length) record.duration = times[0];
  if (times.length > 1) record.delay = times[1];
  return record;
}

function finaliseAnimation(record, at, warnings) {
  const duration = evalTime(record.duration ?? '0s');
  const delay = evalTime(record.delay ?? '0s');
  const iterations = lower(record.iterations ?? '1');
  const direction = lower(record.direction ?? 'normal');
  const fill = lower(record.fill ?? 'none');
  const out = {
    name: record.name || null,
    duration: duration === null ? 0 : Math.max(0, duration),
    delay: delay === null ? 0 : delay,
    timing: record.timing || 'ease',
    iterations: 1,
    direction,
    fill,
  };
  if (iterations === 'infinite') {
    warnings.add('unsupported-animation', at, 'animation-iteration-count: infinite 不能翻译成有限关键帧，按一次处理');
  } else {
    const n = Number(iterations);
    out.iterations = Number.isFinite(n) && n > 0 ? Math.min(1000, n) : 1;
  }
  if (direction !== 'normal' && direction !== 'reverse') {
    warnings.add('unsupported-animation-direction', at, `animation-direction: ${direction} 不在编译子集里，按 normal 处理`);
    out.direction = 'normal';
  }
  if (record.name === null) out.name = null;
  return out;
}

/**
 * Cubic-bezier → `curve: [[u, v], …]` for `sampleTrack` (§7.8.1: 3–9 points,
 * increasing u, sampled by `core/curves.js::sampleCurvePoints`).
 */
export function cubicBezierCurve([x1, y1, x2, y2], samples = 9) {
  const bezier = (a, b, t) => {
    const mt = 1 - t;
    return 3 * mt * mt * t * a + 3 * mt * t * t * b + t * t * t;
  };
  const out = [];
  // Sample at even *parametric* steps, not even u: a snappy cubic-bezier
  // (e.g. `0.16, 1, 0.3, 1`) changes a lot in the first few percent of x, so
  // even-u sampling would lose its shoulder — and §7.8.1 caps the point count.
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    out.push([r3(bezier(x1, x2, t)), r3(bezier(y1, y2, t))]);
  }
  // u must be strictly increasing for the piecewise-linear sampler; t → x(t)
  // is monotonic for control points inside [0, 1], so only rounding can tie.
  out[0][0] = 0;
  out[out.length - 1][0] = 1;
  for (let i = 1; i < out.length; i++) {
    if (!(out[i][0] > out[i - 1][0])) out[i][0] = r3(Math.min(1, out[i - 1][0] + 0.001));
  }
  return out;
}

/** Timing function → `{ ease }` or `{ curve }` (§7.8.1). */
export function timingOf(text, at, warnings) {
  const value = String(text ?? '').trim();
  const name = lower(value);
  if (name === 'linear') return { ease: 'linear' };
  if (EASE_NAMES.includes(name)) return { ease: name };
  if (Object.hasOwn(EASING_CUBICS, name)) return { curve: cubicBezierCurve(EASING_CUBICS[name]) };
  const cubic = name.match(/^cubic-bezier\(([^)]+)\)$/);
  if (cubic) {
    const nums = cubic[1].split(',').map((n) => Number(n.trim()));
    if (nums.length === 4 && nums.every(Number.isFinite) && nums[0] >= 0 && nums[0] <= 1 && nums[2] >= 0 && nums[2] <= 1) {
      return { curve: cubicBezierCurve(nums) };
    }
    warnings.add('unsupported-animation', at, `cubic-bezier(${cubic[1]}) 的控制点越界，按 easeInOut 处理`);
    return { ease: 'easeInOut' };
  }
  if (/^steps\(/i.test(name)) {
    warnings.add('unsupported-animation', at, `${value} 不在编译子集里（没有阶跃缓动），按 easeInOut 处理`);
    return { ease: 'easeInOut' };
  }
  warnings.add('unsupported-animation', at, `timing-function ${JSON.stringify(value)} 不认识，按 easeInOut 处理`);
  return { ease: 'easeInOut' };
}

/**
 * Computed style of one element: declaration cascade (specificity, then source
 * order), inherited values, `var()` substitution, and the handful of values the
 * layout/typesetting needs resolved to numbers.
 */
function computeStyle(node, parent, ctx) {
  const { rules, at, warnings } = ctx;
  const decls = [];
  const inherited = parent?.custom ? { ...parent.custom } : {};
  for (const rule of rules) {
    if (!rule.selectors.some((selector) => matchesSelector(selector, node))) continue;
    for (const [prop, value] of Object.entries(rule.decls)) {
      const specificity = rule.selectors.reduce((best, selector) => (compareSpecificity(selector.specificity, best) > 0 ? selector.specificity : best), [0, 0, 0]);
      decls.push({ prop, value, specificity, order: rule.order, at: rule.at });
    }
  }
  // The `style` attribute: specificity above every selector, order last.
  for (const [prop, value] of Object.entries(parseStyleAttribute(attr(node, 'style')))) {
    decls.push({ prop, value, specificity: [9, 9, 9], order: Number.MAX_SAFE_INTEGER, at: `${at}:${node.line} style` });
  }
  decls.sort((a, b) => compareSpecificity(a.specificity, b.specificity) || (a.order - b.order));
  const raw = {};
  const custom = { ...inherited };
  for (const decl of decls) {
    if (!SUPPORTED_PROPERTIES.has(decl.prop) && !IGNORED_PROPERTIES.has(decl.prop) && !decl.prop.startsWith('--')) {
      warnings.add('unsupported-property', `${decl.at}`, `CSS 属性 ${decl.prop} 不在编译子集里，忽略（值 ${JSON.stringify(String(decl.value).slice(0, 60))}）`);
    }
    if (decl.prop.startsWith('--')) { custom[decl.prop] = decl.value; continue; }
    raw[decl.prop] = decl.value;
  }
  const value = (prop, dflt = undefined) => {
    const own = raw[prop];
    if (own !== undefined) return substituteVars(own, custom);
    if (INHERITED.has(prop)) {
      const inheritedValue = parent ? parent[`__${prop}`] : undefined;
      if (inheritedValue !== undefined) return inheritedValue;
    }
    return dflt;
  };
  const at_ = `${at}:${node.line}`;
  const px = (prop, { percent = null } = {}) => {
    const v = value(prop);
    if (v === undefined || lower(v) === 'auto') return null;
    return evalLength(v, ctx.length(percent));
  };
  const display = lower(value('display', 'block')) || 'block';
  const boxSizing = lower(value('box-sizing', 'content-box')) === 'border-box' ? 'border-box' : 'content-box';
  const fontSize = px('font-size') ?? 16;
  const ctxForText = ctx.length(null, fontSize);
  const lineHeightRaw = value('line-height');
  let lineHeight = null; // multiplier; computed per node from `normal` when needed
  let lineHeightPx = null;
  if (lineHeightRaw !== undefined) {
    const text = lower(lineHeightRaw);
    if (text === 'normal') { lineHeight = null; }
    else if (/^[0-9.]+$/.test(text)) lineHeight = Number(text);
    else {
      const resolved = evalLength(lineHeightRaw, ctxForText);
      if (resolved !== null) lineHeightPx = resolved;
      else { warnings.add('unsupported-value', at_, `line-height: ${lineHeightRaw} 不认识`); }
    }
  }
  const letterSpacingRaw = value('letter-spacing', '0');
  let letterSpacing = 0;
  if (lower(letterSpacingRaw) !== 'normal') {
    const resolved = evalLength(letterSpacingRaw, ctxForText);
    if (resolved === null) warnings.add('unsupported-value', at_, `letter-spacing: ${letterSpacingRaw} 不认识`);
    else letterSpacing = resolved;
  }
  const opacityRaw = value('opacity', '1');
  const opacity = clamp(num(opacityRaw, 1), 0, 1);
  const alignRaw = lower(value('text-align', 'start'));
  const align = ['left', 'start'].includes(alignRaw) ? 'left'
    : ['right', 'end'].includes(alignRaw) ? 'right'
      : alignRaw === 'center' ? 'center' : 'left';
  if (alignRaw === 'justify') warnings.add('unsupported-value', at_, 'text-align: justify 按 left 处理');
  const transformValue = value('transform', 'none');
  const transformOrigin = value('transform-origin', '50% 50%');
  const background = backgroundOf(value('background-image'), value('background'), value('background-color'), ctxForText, at_, warnings);
  const style = {
    node, raw, custom,
    display, position: lower(value('position', 'static')) || 'static',
    boxSizing,
    width: px('width'), height: px('height'),
    minWidth: px('min-width'), minHeight: px('min-height'),
    maxWidth: px('max-width'), maxHeight: px('max-height'),
    aspectRatio: aspectRatioOf(value('aspect-ratio')),
    margin: expandBoxShorthand(value('margin', '0'), ctxForText) || { t: 0, r: 0, b: 0, l: 0 },
    padding: expandBoxShorthand(value('padding', '0'), ctxForText) || { t: 0, r: 0, b: 0, l: 0 },
    gap: gapOf(value('gap', value('row-gap', '0')), ctxForText),
    flexDirection: lower(value('flex-direction', 'row')),
    justifyContent: lower(value('justify-content', 'flex-start')),
    alignItems: lower(value('align-items', 'stretch')),
    placeItems: lower(value('place-items', '')),
    fontFamily: fontChainOf(value('font-family')),
    // The family the render pipeline can actually load (a browser would pick
    // its own fallback from the same chain; the compiler resolves it once here
    // so layout and typesetting share one answer).
    resolvedFont: resolveFontFamily(fontChainOf(value('font-family')), ctx.fonts, at_, warnings),
    fontSize,
    fontWeight: fontWeightOf(value('font-weight')) ?? 400,
    lineHeight, lineHeightPx,
    letterSpacing,
    align,
    textTransform: lower(value('text-transform', 'none')) || 'none',
    color: parseCssColor(value('color', 'inherit')) || parent?.color || { r: 255, g: 255, b: 255, a: 1 },
    background,
    opacity,
    transform: transformValue,
    transformOrigin,
    animations: animationsOf(raw, custom, at_, warnings),
    left: px('left'), top: px('top'), right: px('right'), bottom: px('bottom'),
  };
  // `__<prop>` mirrors the inherited raw value for children.
  for (const prop of INHERITED) style[`__${prop}`] = raw[prop] !== undefined ? substituteVars(raw[prop], custom) : parent?.[`__${prop}`];
  return style;
}

function aspectRatioOf(text) {
  if (text === undefined) return null;
  const m = String(text).trim().match(/^([0-9.]+)\s*\/\s*([0-9.]+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  const single = Number(text);
  return Number.isFinite(single) && single > 0 ? single : null;
}

function gapOf(value, ctx) {
  const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { row: 0, column: 0 };
  const row = evalLength(parts[0], ctx) ?? 0;
  const column = parts.length > 1 ? evalLength(parts[1], ctx) ?? row : row;
  return { row, column };
}

function fontChainOf(value) {
  if (!value) return [];
  return splitCommaList(value).map((part) => part.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

/** `background` / `background-color` / `background-image` → colors + gradients. */
function backgroundOf(imageValue, shorthand, colorValue, ctx, at, warnings) {
  const out = { color: null, gradients: [] };
  const colour = parseCssColor(colorValue ?? '') || null;
  out.color = colour;
  const sources = [];
  if (imageValue && lower(imageValue) !== 'none') sources.push(...splitCommaList(imageValue).map((v) => ({ kind: 'image', text: v })));
  if (shorthand) {
    for (const part of splitCommaList(shorthand)) {
      const text = part.trim();
      if (!text) continue;
      if (/^(repeating-)?(linear|radial|conic)-gradient\(/i.test(text)) sources.push({ kind: 'gradient', text });
      else if (/^url\(/i.test(text)) sources.push({ kind: 'url', text });
      else if (/^-?(?:[a-z]+|#[0-9a-f]+|rgba?\(|hsla?\()/i.test(text) && !/^(top|bottom|left|right|center|no-repeat|repeat|cover|contain|fixed|scroll|padding-box|border-box|content-box|auto|0|100%)/i.test(text)) {
        const parsed = parseCssColor(text);
        if (parsed) out.color = parsed;
      }
    }
  }
  for (const source of sources) {
    if (source.kind === 'url') {
      warnings.add('background-unsupported', at, `background-image: ${source.text.slice(0, 60)} 不在编译子集里（图片背景需要栅格化）`);
      continue;
    }
    if (source.kind === 'image') {
      warnings.add('background-unsupported', at, `background-image: ${source.text.slice(0, 60)} 不在编译子集里`);
      continue;
    }
    const gradient = parseLinearGradient(source.text, ctx, at, warnings);
    if (gradient) out.gradients.push(gradient);
    else warnings.add('background-unsupported', at, `${source.text.slice(0, 80)} 只是线性渐变的子集（角度/to side + 颜色停靠点）`);
  }
  return out;
}

/** `linear-gradient(<angle|to side>, <color> [<pos>], …)` → geometry + stops. */
export function parseLinearGradient(text, ctx, at, warnings) {
  const m = String(text).match(/^linear-gradient\(([\s\S]*)\)$/i);
  if (!m) return null;
  const parts = splitCommaList(m[1]);
  if (parts.length < 2) return null;
  let angle = 180;
  let index = 0;
  const head = lower(parts[0]);
  const deg = head.match(/^(-?[0-9.]+)deg$/);
  if (deg) { angle = Number(deg[1]); index = 1; } else if (/^to\s+/.test(head)) {
    const side = head.replace(/^to\s+/, '').trim();
    angle = { top: 0, right: 90, bottom: 180, left: 270,
      'top right': 45, 'right top': 45, 'bottom right': 135, 'right bottom': 135,
      'bottom left': 225, 'left bottom': 225, 'top left': 315, 'left top': 315 }[side] ?? null;
    if (angle === null) { warnings.add('unsupported-value', at, `渐变方向 ${JSON.stringify(parts[0])} 不认识`); return null; }
    index = 1;
  }
  const stops = [];
  for (const part of parts.slice(index)) {
    const stop = String(part).trim();
    const colourMatch = stop.match(/^(#[0-9a-zA-Z]+|rgba?\([^)]*\)|[a-z]+)(.*)$/i);
    if (!colourMatch) return null;
    const color = parseCssColor(colourMatch[1]);
    if (!color) return null;
    const posText = colourMatch[2].trim();
    let position = null;
    if (posText) {
      // A stop position is a fraction of the gradient line (or a px length).
      const percentMatch = String(posText).match(/^(-?(?:\d+\.?\d*|\.\d+))%$/);
      if (percentMatch) position = clamp(Number(percentMatch[1]) / 100, 0, 1);
      else {
        const posPx = evalLength(posText, ctx);
        if (posPx === null) return null;
        position = null; // a px stop still needs the line length; reported below
        warnings.add('unsupported-value', at, `渐变的 px 停靠点 ${JSON.stringify(posText)} 不在编译子集里（只用 %）`);
        return null;
      }
    }
    stops.push({ color, position });
  }
  if (!stops.length) return null;
  // CSS fills in the missing positions (§css-images-3): first 0, last 1, the
  // rest evenly between their known neighbours.
  if (stops[0].position === null) stops[0].position = 0;
  if (stops[stops.length - 1].position === null) stops[stops.length - 1].position = 1;
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].position !== null) continue;
    let next = i;
    while (next < stops.length && stops[next].position === null) next += 1;
    const from = stops[i - 1].position;
    const to = next < stops.length ? stops[next].position : 1;
    const steps = next - i + 1;
    for (let k = i; k < next; k++) stops[k].position = from + ((to - from) * (k - i + 1)) / steps;
    i = next;
  }
  // Monotonic positions (a later smaller stop is clamped, like CSS).
  for (let i = 1; i < stops.length; i++) if (stops[i].position < stops[i - 1].position) stops[i].position = stops[i - 1].position;
  return { angle, stops };
}

/** Color of a gradient at fraction `u` (premultiplied interpolation, like CSS). */
export function gradientColorAt(gradient, u) {
  const stops = gradient.stops;
  const t = clamp(u, 0, 1);
  if (t <= stops[0].position) return { ...stops[0].color };
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t > b.position && i < stops.length - 1) continue;
    const span = b.position - a.position;
    const k = span <= 1e-9 ? 1 : (t - a.position) / span;
    const weight = clamp(k, 0, 1);
    const pa = [a.color.r * a.color.a, a.color.g * a.color.a, a.color.b * a.color.a, a.color.a];
    const pb = [b.color.r * b.color.a, b.color.g * b.color.a, b.color.b * b.color.a, b.color.a];
    const mix = pa.map((v, index) => v + (pb[index] - v) * weight);
    const alpha = mix[3];
    if (alpha <= 1e-9) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: mix[0] / alpha, g: mix[1] / alpha, b: mix[2] / alpha, a: alpha };
  }
  return { ...stops[stops.length - 1].color };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Length context for a transform: viewport units + the element's own em. */
const CONTEXT = (ctx, fontSize = null) => ({
  vw: ctx.vw, vh: ctx.vh, rootFontSize: ctx.rootFontSize,
  fontSize: Number.isFinite(fontSize) ? fontSize : 16,
});

/** Line box height of a style (`line-height: normal` from injected metrics). */
function lineBoxOf(style, ctx) {
  if (style.lineHeightPx !== null) return style.lineHeightPx;
  if (style.lineHeight !== null) return style.lineHeight * style.fontSize;
  const family = lower(style.resolvedFont || style.fontFamily[0] || ctx.defaultFont);
  const metrics = ctx.fonts?.metrics?.[family] || ctx.fonts?.metrics?.[lower(ctx.defaultFont)];
  if (metrics && Number.isFinite(metrics.ascent)) {
    // `metrics` are positive em fractions (ascender / descender / lineGap). A
    // browser rounds each font metric to whole pixels before summing the line
    // box (Skia integer metrics at scale 1), so a 22 px line box means
    // round(asc·size) + round(desc·size) + round(gap·size); matching that
    // rounding keeps the compiled flex column on the same rows.
    const px = (value) => Math.round(Math.abs(num(value, 0)) * style.fontSize);
    return px(metrics.ascent) + px(metrics.descent) + px(metrics.lineGap);
  }
  ctx.warnings.add('font-unverified', `${style.node && ctx.at}:${style.node?.line}`,
    'line-height: normal 没有字体度量可算，按 1.2em 估算（传 opts.fonts.metrics 可精确）');
  return 1.2 * style.fontSize;
}

/** Direct text of an element (`<br>` → newline), whitespace collapsed. */
function directText(node) {
  let out = '';
  for (const child of node.children || []) {
    if (child.type === 'text') out += child.text;
    else if (child.type === 'element' && child.tag === 'br') out += '\n';
  }
  return out.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function applyTextTransform(text, transform) {
  if (!text) return text;
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  if (transform === 'capitalize') return text.replace(/(^|\s)(\S)/g, (m, space, ch) => space + ch.toUpperCase());
  return text;
}

/** Typeset one text block: lines, their widths, and the CSS box it needs. */
function typesetText(node, style, ctx) {
  const text = applyTextTransform(directText(node), style.textTransform);
  if (!text) return null;
  const lines = text.split('\n');
  const lineHeight = lineBoxOf(style, ctx);
  let width = 0;
  let cssWidth = 0;
  for (const line of lines) {
    const measured = ctx.measure(line, { ...style, font: style.resolvedFont });
    width = Math.max(width, measured);
    cssWidth = Math.max(cssWidth, measured + (line ? style.letterSpacing : 0));
  }
  return { text, lines, width, cssWidth, lineHeight, height: lineHeight * lines.length };
}

/** Pick the first CSS family the render pipeline can actually resolve. */
export function resolveFontFamily(chain, fonts, at, warnings) {
  const available = Array.isArray(fonts?.families) ? fonts.families : null;
  const chain1 = (Array.isArray(chain) ? chain : []);
  /** First family of `names` the pipeline has, case-insensitively. */
  const find = (names) => names
    .map((name) => available.find((candidate) => lower(candidate) === lower(name)))
    .find(Boolean) || null;
  if (!available || !available.length) {
    const family = chain1.find((name) => !GENERIC_FAMILIES.has(lower(name))) || 'SimHei';
    warnings.add('font-unverified', at, `没有可用的字体清单，按 CSS 的第一个家族 ${JSON.stringify(family)} 编译（渲染管线可能找不到它）`);
    return family;
  }
  for (const family of chain1) {
    const key = lower(family);
    if (GENERIC_FAMILIES.has(key)) {
      // A generic family means "the platform's sans / mono / serif": map it to
      // the pipeline's own default for that class, like a browser would.
      const mapped = find(GENERIC_DEFAULTS[key] || []);
      if (mapped) return mapped;
      continue;
    }
    const hit = find([family]);
    if (hit) return hit;
  }
  const fallback = available.includes('SimHei') ? 'SimHei' : available[0];
  if (chain1.length) warnings.add('font-unverified', at, `CSS 字体链 ${JSON.stringify(chain1.join(', '))} 一个都不在渲染管线里，回退 ${JSON.stringify(fallback)}`);
  return fallback;
}

/** Generic families have no file of their own; they map to the pipeline's default of that class. */
const GENERIC_DEFAULTS = Object.freeze({
  monospace: ['Consolas', 'Courier New', 'Cascadia Mono'],
  'ui-monospace': ['Consolas', 'Cascadia Mono', 'Courier New'],
  'sans-serif': ['Microsoft YaHei', 'Segoe UI', 'Arial'],
  'ui-sans-serif': ['Segoe UI', 'Microsoft YaHei', 'Arial'],
  'system-ui': ['Segoe UI', 'Microsoft YaHei', 'Arial'],
  serif: ['SimSun', 'Times New Roman'],
  'ui-serif': ['SimSun', 'Times New Roman'],
  'ui-rounded': ['Microsoft YaHei', 'Segoe UI'],
});

/** Families with no font file behind them (the preview resolves families, not CSS generics). */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', 'inherit', 'initial', 'unset',
]);

/** Split on top-level whitespace (inside `calc(…)` / quoted strings it stays one token). */
export function splitTopLevelWhitespace(text) {
  const out = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of String(text ?? '')) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') { depth += 1; current += ch; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); current += ch; continue; }
    if (depth === 0 && /\s/.test(ch)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * The box tree the layout produces: every element node → `{ x, y, w, h }`
 * (border box, viewport pixels) plus its content box and typeset text.
 */
function layoutTree(rootNode, styles, ctx) {
  const boxes = new Map();
  const viewport = { width: ctx.vw, height: ctx.vh };

  /** A `%` length against a known base (the containing block), else null. */
  const percentOf = (rawText, base) => {
    const text = String(rawText ?? '').trim();
    const m = text.match(/^(-?(?:\d+\.?\d*|\.\d+))%$/);
    if (!m || base === null || base === undefined || !Number.isFinite(base)) return null;
    return (Number(m[1]) / 100) * base;
  };
  const minHeightOf = (style, cbHeight) => {
    if (style.minHeight !== null) return style.minHeight;
    return percentOf(style.raw['min-height'], cbHeight);
  };

  /**
   * Children of one block / flex / grid container, positioned in the parent's
   * content box. Returns the content height.
   */
  const placeChildren = (node, style, contentX, contentY, contentW, contentH) => {
    /** Move a laid-out box and keep its content box in sync (typesetting reads it). */
    const move = (box, x, y) => {
      if (!box) return;
      const dx = (Number.isFinite(x) ? x : box.x) - box.x;
      const dy = (Number.isFinite(y) ? y : box.y) - box.y;
      box.x += dx; box.y += dy; box.contentX += dx; box.contentY += dy;
    };
    const items = (node.children || []).filter((child) => child.type === 'element'
      && styles.get(child) && styles.get(child).display !== 'none' && !isHeadTag(child.tag));
    const flow = items.filter((child) => styles.get(child).position !== 'absolute');
    const absolute = items.filter((child) => styles.get(child).position === 'absolute');
    let height = 0;
    if (flow.length) {
      if (style.display === 'flex' || style.display === 'inline-flex') {
        const column = style.flexDirection.startsWith('column');
        const gap = column ? style.gap.row : style.gap.column;
        const sizes = flow.map((child) => layoutBlock(child, contentX, contentY, contentW, contentH));
        if (column) {
          const total = sizes.reduce((sum, size) => sum + size.h, 0) + gap * Math.max(0, sizes.length - 1);
          let cursor = contentY;
          if (contentH !== null && contentH > 0) {
            if (style.justifyContent === 'center') cursor += Math.max(0, (contentH - total) / 2);
            else if (style.justifyContent === 'flex-end' || style.justifyContent === 'end') cursor += Math.max(0, contentH - total);
          }
          for (let i = 0; i < flow.length; i++) {
            const box = boxes.get(flow[i]);
            move(box, box.x, cursor);
            cursor += sizes[i].h + gap;
          }
          height = total;
        } else {
          let cursorX = contentX;
          let maxH = 0;
          for (let i = 0; i < flow.length; i++) {
            const box = boxes.get(flow[i]);
            move(box, cursorX, box.y);
            cursorX += sizes[i].w + gap;
            maxH = Math.max(maxH, sizes[i].h);
          }
          height = maxH;
          if (style.alignItems === 'center' && contentH !== null) {
            for (const child of flow) {
              const box = boxes.get(child);
              move(box, box.x, contentY + Math.max(0, (contentH - box.h) / 2));
            }
          }
        }
      } else if (style.display === 'grid' || style.display === 'inline-grid') {
        const place = style.placeItems || '';
        if (flow.length === 1 && place.includes('center')) {
          const size = layoutBlock(flow[0], contentX, contentY, contentW, contentH);
          const box = boxes.get(flow[0]);
          move(box, contentX + Math.max(0, (contentW - size.w) / 2),
            contentY + (contentH !== null ? Math.max(0, (contentH - size.h) / 2) : 0));
          height = contentH !== null ? contentH : size.h;
        } else {
          if (flow.length > 1 || !place.includes('center')) {
            ctx.warnings.add('unsupported-layout', `${ctx.at}:${node.line}`,
              'grid 容器只支持「单子元素 + place-items: center」，其余按块级流排版');
          }
          let cursorY = contentY;
          for (const child of flow) {
            const size = layoutBlock(child, contentX, cursorY, contentW, contentH);
            const box = boxes.get(child);
            move(box, contentX, cursorY);
            cursorY += size.h;
          }
          height = cursorY - contentY;
        }
      } else {
        let cursorY = contentY;
        for (const child of flow) {
          const size = layoutBlock(child, contentX, cursorY, contentW, contentH);
          const box = boxes.get(child);
          move(box, contentX, cursorY);
          cursorY += size.h;
        }
        height = cursorY - contentY;
      }
    }
    // Out-of-flow children last: they need the containing block's size.
    for (const child of absolute) {
      const childStyle = styles.get(child);
      const width = childStyle.width !== null ? childStyle.width : contentW;
      const x = childStyle.left !== null ? contentX + childStyle.left
        : childStyle.right !== null ? contentX + contentW - childStyle.right - width : contentX;
      const y = childStyle.top !== null ? contentY + childStyle.top
        : childStyle.bottom !== null ? contentY + (contentH ?? 0) - childStyle.bottom - (childStyle.height ?? 0) : contentY;
      layoutBlock(child, x, y, width, contentH);
    }
    return height;
  };

  /** Lay out one block-level box (or flex/grid container); returns its size. */
  function layoutBlock(node, x, y, availableWidth, cbHeight) {
    const style = styles.get(node);
    if (!style) return { w: 0, h: 0 };
    const borderBox = style.boxSizing === 'border-box';
    // % margins / padding resolve against the containing block's width.
    const padding = resolveSides(style.padding, availableWidth);
    let totalW;
    if (style.width !== null) totalW = borderBox ? style.width : style.width + padding.l + padding.r;
    else {
      const percent = percentOf(style.raw.width, availableWidth);
      totalW = percent !== null ? (borderBox ? percent : percent + padding.l + padding.r) : availableWidth;
    }
    const contentW = Math.max(0, totalW - padding.l - padding.r);
    const contentX = x + padding.l;
    const contentY = y + padding.t;
    const minHeight = minHeightOf(style, cbHeight);
    let knownH = null;
    if (style.height !== null) knownH = borderBox ? style.height : style.height + padding.t + padding.b;
    else {
      const percent = percentOf(style.raw.height, cbHeight);
      if (percent !== null) knownH = borderBox ? percent : percent + padding.t + padding.b;
      else if (style.aspectRatio) knownH = totalW / style.aspectRatio;
    }
    if (knownH !== null && minHeight !== null) knownH = Math.max(knownH, minHeight);
    const elementChildren = (node.children || []).filter((child) => child.type === 'element'
      && styles.get(child) && styles.get(child).display !== 'none' && !isHeadTag(child.tag));
    const text = elementChildren.length ? null : typesetText(node, style, ctx);
    let contentH = 0;
    if (text) {
      if (text.cssWidth > contentW + 0.5) {
        ctx.warnings.add('unsupported-text-wrap', `${ctx.at}:${node.line}`, '文本换行不在编译子集里（按单行排版，位置会偏）');
      }
      contentH = text.height;
    } else if (elementChildren.length) {
      contentH = placeChildren(node, style, contentX, contentY, contentW,
        knownH === null ? null : Math.max(0, knownH - padding.t - padding.b));
    }
    let totalH = knownH !== null ? knownH : contentH + padding.t + padding.b;
    if (minHeight !== null) totalH = Math.max(totalH, minHeight);
    if (style.maxHeight !== null) totalH = Math.min(totalH, style.maxHeight);
    boxes.set(node, {
      x, y, w: totalW, h: Math.max(0, totalH),
      contentX, contentY, contentW,
      contentH: Math.max(0, totalH - padding.t - padding.b),
      padding, style, text,
    });
    return { w: totalW, h: Math.max(0, totalH) };
  }

  layoutBlock(rootNode, 0, 0, viewport.width, viewport.height);
  return boxes;
}

function isHeadTag(tag) {
  return tag === 'head' || tag === 'title' || tag === 'meta' || tag === 'link' || tag === 'style' || tag === 'script';
}

// ---------------------------------------------------------------------------
// CSS transforms → element x / y / scale / rotation
// ---------------------------------------------------------------------------

/**
 * Parse a `transform` list into a 2D affine matrix (canvas convention:
 * `p → (a·x + c·y + e, b·x + d·y + f)`), or null when an entry is outside the
 * subset. Percentages resolve against `box` (the element's own box).
 */
export function parseTransformList(text, box, ctx) {
  const value = lower(text);
  if (!value || value === 'none') return { matrix: [1, 0, 0, 1, 0, 0], warnings: [] };
  const warnings = [];
  const functions = [];
  const re = /([a-z0-9]+)\(([^()]*)\)/gi;
  let match;
  while ((match = re.exec(String(text)))) functions.push({ name: match[1].toLowerCase(), args: splitCommaList(match[2]) });
  if (!functions.length) return null;
  let matrix = [1, 0, 0, 1, 0, 0];
  const multiply = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  // `box.fontSize` is the element's own font size, so `0.5em` resolves like CSS.
  const length = (token, base) => evalLength(token, { ...CONTEXT(ctx, box.fontSize), percent: base });
  for (const fn of functions) {
    const args = fn.args.map((a) => a.trim()).filter(Boolean);
    if (fn.name === 'translate') {
      const tx = length(args[0] ?? '0', box.w);
      const ty = length(args[1] ?? '0', box.h);
      if (tx === null || ty === null) { warnings.push(`translate(${args.join(', ')})`); continue; }
      matrix = multiply(matrix, [1, 0, 0, 1, tx, ty]);
    } else if (fn.name === 'translatex' || fn.name === 'translatey') {
      const tx = fn.name === 'translatex' ? length(args[0] ?? '0', box.w) : 0;
      const ty = fn.name === 'translatey' ? length(args[0] ?? '0', box.h) : 0;
      if (tx === null || ty === null) { warnings.push(`${fn.name}(${args.join(', ')})`); continue; }
      matrix = multiply(matrix, [1, 0, 0, 1, tx, ty]);
    } else if (fn.name === 'scale') {
      const sx = args.length > 1 ? Number(args[0]) : Number(args[0] ?? 1);
      const sy = args.length > 1 ? Number(args[1]) : sx;
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) { warnings.push(`scale(${args.join(', ')})`); continue; }
      if (Math.abs(sx - sy) > 1e-9) warnings.push(`非等比 scale(${sx}, ${sy})`);
      matrix = multiply(matrix, [sx, 0, 0, sy, 0, 0]);
    } else if (fn.name === 'scalex' || fn.name === 'scaley') {
      const s = Number(args[0] ?? 1);
      if (!Number.isFinite(s)) { warnings.push(`${fn.name}(${args.join(', ')})`); continue; }
      warnings.push(`非等比 ${fn.name}(${s})`);
      matrix = multiply(matrix, fn.name === 'scalex' ? [s, 0, 0, 1, 0, 0] : [1, 0, 0, s, 0, 0]);
    } else if (fn.name === 'rotate' || fn.name === 'rotatez') {
      const deg = parseAngle(args[0] ?? '0');
      if (deg === null) { warnings.push(`rotate(${args.join(', ')})`); continue; }
      const rad = (deg * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      matrix = multiply(matrix, [c, s, -s, c, 0, 0]);
    } else {
      warnings.push(`${fn.name}()`);
    }
  }
  return { matrix, warnings };
}

function parseAngle(text) {
  const value = String(text ?? '').trim().toLowerCase();
  const m = value.match(/^(-?[0-9.]+)(deg|rad|turn|grad)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'rad': return (n * 180) / Math.PI;
    case 'turn': return n * 360;
    case 'grad': return n * 0.9;
    default: return n;
  }
}

/**
 * Decompose a 2D affine into the element model: translation, uniform scale and
 * in-plane rotation (§7.8.1 `transform.*`, element space; CSS `rotate(θ)` is
 * clockwise, the element's `transform.rotation` is counter-clockwise, §7.8.1
 * "符号差异由 4.1 换算").
 */
export function decomposeMatrix(matrix) {
  const [a, b, c, d, e, f] = matrix;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  const uniform = Math.abs(sx - sy) <= Math.max(1e-6, 1e-4 * Math.max(sx, sy));
  const screenAngle = (Math.atan2(b, a) * 180) / Math.PI;
  return { x: e, y: f, scale: uniform ? sx : (sx + sy) / 2, rotation: -screenAngle, uniform };
}

// ---------------------------------------------------------------------------
// Animation → snapshot tracks
// ---------------------------------------------------------------------------

/**
 * The tracks one node's CSS animations produce: `path → [{ t, value, timing }]`.
 * Only the §7.8.1 path set is emitted; anything else is a warning.
 */
function animationTracks(node, style, boxRect, ctx) {
  const out = new Map();
  if (!style.animations.length) return out;
  // `em` lengths inside `transform` resolve against the element's font size.
  const box = { ...boxRect, fontSize: style.fontSize };
  const identity = { x: 0, y: 0, scale: 1, rotation: 0 };
  // Baseline components: the static transform outside the animation.
  const staticTransform = parseTransformList(style.transform, box, ctx);
  const base = staticTransform ? decomposeMatrix(staticTransform.matrix) : { ...identity, uniform: true };
  for (const animation of style.animations) {
    if (!animation.name) continue;
    const frames = ctx.keyframes.get(animation.name);
    if (!frames || !frames.length) {
      ctx.warnings.add('unsupported-animation', `${ctx.at}:${node.line}`, `@keyframes ${animation.name} 不存在，动画忽略`);
      continue;
    }
    const at = `${ctx.at}:${node.line} @keyframes ${animation.name}`;
    const timing = timingOf(animation.timing, at, ctx.warnings);
    const ordered = frames.slice().sort((a, b) => a.percent - b.percent);
    if (ordered[0].percent > 0) ordered.unshift({ percent: 0, decls: { ...ordered[0].decls }, at });
    if (ordered[ordered.length - 1].percent < 100) ordered.push({ percent: 100, decls: { ...ordered[ordered.length - 1].decls }, at });
    // Which source paths does this animation drive?
    const paths = new Set();
    let hasTransform = false;
    for (const frame of ordered) {
      for (const prop of Object.keys(frame.decls)) {
        const name = prop.trim().toLowerCase();
        if (name === 'opacity') paths.add('transform.opacity');
        else if (name === 'transform') { hasTransform = true; }
        else if (name === 'color') paths.add('style.color');
        else if (name === 'background' || name === 'background-color' || name === 'width' || name === 'height'
          || name === 'letter-spacing' || name === 'font-size' || name === 'filter' || name === 'left' || name === 'top'
          || name === 'translate' || name === 'scale' || name === 'rotate') {
          ctx.warnings.add('unsupported-keyframe-property', `${frame.at}:${name}`, `关键帧里的 ${name} 不在源轨道子集里（§7.8.1），忽略`);
        } else {
          ctx.warnings.add('unsupported-keyframe-property', `${frame.at}:${name}`, `关键帧里的 ${name} 不认识，忽略`);
        }
      }
    }
    // Animation records that only animate transform still need the transform paths.
    for (const frame of ordered) {
      const value = frame.decls.transform;
      if (value === undefined) continue;
      const parsed = parseTransformList(value, box, ctx);
      if (!parsed) {
        ctx.warnings.add('unsupported-transform', frame.at, `transform: ${String(value).slice(0, 80)} 不在编译子集里`);
        continue;
      }
      for (const warning of parsed.warnings) ctx.warnings.add('unsupported-transform', frame.at, `${warning} 不在编译子集里（只支持平移 / 等比缩放 / 平面旋转）`);
    }
    if (hasTransform) for (const path of TRANSFORM_PATHS.slice(0, 4)) paths.add(path);
    if (!paths.size) continue;
    // Per iteration, per frame: the value of every driven path at that time.
    const iterations = Math.max(1, animation.iterations);
    const reversed = animation.direction === 'reverse';
    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const frame of ordered) {
        const percent = reversed ? 100 - frame.percent : frame.percent;
        const t = animation.delay + iteration * animation.duration + (percent / 100) * animation.duration;
        const decls = frame.decls;
        if (paths.has('transform.opacity')) {
          const value = decls.opacity === undefined
            ? (hasTransform ? null : null)
            : clamp(num(substituteVars(decls.opacity, style.custom), 1), 0, 1);
          if (value !== null) pushTrack(out, 'transform.opacity', t, value, timing);
        }
        if (paths.has('style.color') && decls.color !== undefined) {
          const colour = parseCssColor(substituteVars(decls.color, style.custom));
          if (colour) pushTrack(out, 'style.color', t, formatHex(colour), timing);
        }
        if (hasTransform) {
          const components = transformComponentsOf(decls.transform, box, base, ctx, frame.at);
          pushTrack(out, 'transform.x', t, components.x, timing);
          pushTrack(out, 'transform.y', t, components.y, timing);
          pushTrack(out, 'transform.scale', t, components.scale, timing);
          pushTrack(out, 'transform.rotation', t, components.rotation, timing);
        }
      }
    }
  }
  // Sort + one key per (path, t), the §7.8.1 rule.
  for (const [path, keys] of out) {
    keys.sort((a, b) => a.t - b.t);
    const deduped = [];
    for (const key of keys) {
      const last = deduped[deduped.length - 1];
      if (last && Math.abs(last.t - key.t) < 1e-6) {
        // Two iterations meet here: the previous one's last value and this
        // one's first value share a time. Keep both (the earlier one a
        // millisecond before) so a repeated animation keeps its peak.
        if (last.value !== key.value) { last.t = r3(Math.max(0, key.t - 0.001)); deduped.push(key); }
        else deduped[deduped.length - 1] = key;
        continue;
      }
      deduped.push(key);
    }
    out.set(path, deduped);
  }
  return out;
}

function pushTrack(map, path, t, value, timing) {
  if (!Number.isFinite(t) || !Number.isFinite(value)) return;
  if (!map.has(path)) map.set(path, []);
  map.get(path).push({ t: Math.max(0, r3(t)), value: r3(value), timing });
}

/**
 * One keyframe's `transform` → element components. A keyframe that animates
 * `transform` replaces the static transform, so missing functions are identity.
 */
function transformComponentsOf(value, box, base, ctx, at) {
  // `box.fontSize` travels with the box (see animationTracks).
  if (value === undefined) return { x: 0, y: 0, scale: 1, rotation: 0 };
  const parsed = parseTransformList(value, box, ctx);
  if (!parsed) {
    ctx.warnings.add('unsupported-transform', at, `transform: ${String(value).slice(0, 80)} 不在编译子集里`);
    return { x: 0, y: 0, scale: 1, rotation: 0 };
  }
  const decomposed = decomposeMatrix(parsed.matrix);
  if (!decomposed.uniform) {
    ctx.warnings.add('unsupported-transform', at, '非等比缩放不进源轨道（§7.8.1），按平均比例近似');
  }
  return decomposed;
}

// ---------------------------------------------------------------------------
// Compile: HTML
// ---------------------------------------------------------------------------

/**
 * Compile a registered HTML source into snapshot nodes + element payloads.
 *
 * @param {{ id?: string, manifest?: object, files?: object, entry?: string }} source
 * @param {object} [opts]
 *   width / height   viewport in project pixels (defaults from the manifest-less 1920×1080)
 *   duration         element duration (project duration)
 *   z0               first `el.z`
 *   params           manifest parameter values for the CSS variables of the stage
 *   fonts            `{ families, metrics }` for family resolution + `line-height: normal`
 *   measureText      `(text, style) => widthPx` (the IR's own typesetting)
 *   backgroundBands  approximate a page `linear-gradient` with solid bands (default true)
 * @returns {{ nodes, elements, warnings }}
 */
export function compileHtml(source, opts = {}) {
  const warnings = new Warnings();
  const files = isRecord(source?.files) ? source.files : {};
  const manifest = isRecord(source?.manifest) ? source.manifest : {};
  const sourceId = String(source?.id ?? manifest.id ?? '');
  const entry = String(source?.entry ?? manifest.entry ?? 'index.html');
  const [vw, vh] = viewportOf(opts);
  const at = entry;
  const ctx = {
    vw, vh, rootFontSize: 16, at,
    warnings,
    keyframes: new Map(),
    rules: [],
    fonts: opts.fonts || null,
    defaultFont: opts.fonts?.families?.[0] || 'SimHei',
    measure: measurer(opts.measureText, warnings, at),
    length: (percent, fontSize = 16) => ({ vw, vh, fontSize, percent, rootFontSize: 16 }),
    availHeight: () => Number.NaN,
    contentWidthHint: null,
  };
  const entryText = files[entry];
  if (typeof entryText !== 'string') {
    throw Object.assign(new Error(`源 ${sourceId} 的入口 ${entry} 不在 files 里`), { code: 'INVALID_ARGUMENT' });
  }
  // <style> blocks and <link rel=stylesheet> files, in document order.
  const { root } = parseHtml(entryText, { at, warnings });
  const styleTexts = [];
  walk(root, (node) => {
    if (node.tag !== 'style' && node.tag !== 'link') return;
    if (node.tag === 'style') {
      styleTexts.push({ text: directText(node), at: `${at}:${node.line} <style>` });
      return;
    }
    const rel = lower(attr(node, 'rel'));
    if (rel !== 'stylesheet') return;
    const href = String(attr(node, 'href') ?? '');
    const file = resolveSourceFile(entry, href);
    if (!file || typeof files[file] !== 'string') {
      warnings.add('background-unsupported', `${at}:${node.line}`, `<link href="${href}"> 不在源文件里，样式表跳过`);
      return;
    }
    styleTexts.push({ text: files[file], at: `${file}` });
  });
  for (const sheet of styleTexts) {
    const parsed = parseStylesheet(sheet.text, { at: sheet.at, warnings });
    ctx.rules.push(...parsed.rules.map((rule, index) => ({ ...rule, order: index })));
    for (const [name, frames] of parsed.keyframes) ctx.keyframes.set(name, frames);
  }
  // Page-level CSS variables (the fixtures put them on .stage as inline style).
  const params = isRecord(opts.params) ? opts.params : {};
  const paramVars = {};
  for (const [name, value] of Object.entries(params)) if (name.startsWith('--')) paramVars[name] = String(value);

  const styles = new Map();
  const styleOf = (node) => {
    const cached = styles.get(node);
    if (cached) return cached;
    const baseStyle = computeStyle(node, node.parent ? styleOf(node.parent) : null, ctx);
    // `:root`-level parameter overrides (manifest params → CSS variables).
    if (node.tag === 'html' || node.tag === 'body') Object.assign(baseStyle.custom, paramVars);
    styles.set(node, baseStyle);
    return baseStyle;
  };
  styleOf(root);
  walk(root, (node) => { if (node !== root) styleOf(node); });
  const boxes = layoutTree(root, styles, ctx);
  const center = [vw / 2, vh / 2];
  const z0 = Number.isFinite(opts.z0) ? opts.z0 : 1;
  const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 10;
  const elements = [];
  const nodes = [];
  const takenIds = new Set();
  let z = z0;
  const bands = opts.backgroundBands === false ? 0 : compileBackgroundBands(root, styles, boxes, ctx, { vw, vh, center, z0, sourceId, duration, warnings, elements });
  z = z0 + (bands > 0 ? 1 : 0);

  // Nodes in document order: the z of a later sibling wins, like paint order.
  walk(root, (node) => {
    const nodeId = attr(node, 'data-vdm-id');
    if (nodeId === undefined || nodeId === '') return;
    const id = String(nodeId).trim();
    const box = boxes.get(node);
    const style = styles.get(node);
    if (!box || !style) return;
    if (!NODE_ID_RE.test(id)) {
      warnings.add('node-id-invalid', `${at}:${node.line}`, `data-vdm-id="${id}" 不匹配 ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$，跳过`);
      return;
    }
    if (takenIds.has(id)) {
      warnings.add('duplicate-node-id', `${at}:${node.line}`, `data-vdm-id="${id}" 重复，只编译第一个`);
      return;
    }
    if (style.display === 'none') return;
    const elementChildren = (node.children || []).filter((child) => child.type === 'element' && styles.get(child)?.display !== 'none' && !isHeadTag(child.tag));
    if (elementChildren.length) {
      warnings.add('container-node-unsupported', `${at}:${node.line}`, `节点 ${id} 有子元素，只编译叶子节点（容器整体栅格化还不支持）`);
      return;
    }
    if (node.tag === 'img') {
      warnings.add('image-unsupported', `${at}:${node.line}`, `节点 ${id} 是 <img>：源内文件/data URL 还不能进媒体（§7.1 需要栅格化），跳过`);
      return;
    }
    const text = typesetText(node, style, ctx);
    const boxRect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const compiled = text
      ? compileTextNode({ node, id, style, box, boxRect, text, ctx, center, duration, sourceId, at })
      : compileBoxNode({ node, id, style, box, boxRect, ctx, center, duration, sourceId, at });
    if (!compiled) return;
    takenIds.add(id);
    elements.push({ ...compiled.element, z: z++ });
    nodes.push(compiled.snapshot);
  });
  if (!nodes.length) {
    warnings.add('empty-node', at, '这个源没有可编译的节点：给要编译的元素加 data-vdm-id，并确认它不是容器/图片');
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result = { source: sourceId, runtime: 'html', entry, width: vw, height: vh, nodes, elements, warnings: warnings.list };
  if (opts.diagnostics === true) {
    // Opt-in box dump (tests / `--debug`): what the mini layout engine decided.
    result.boxes = [];
    walk(root, (node) => {
      const box = boxes.get(node);
      if (!box || node === root) return;
      result.boxes.push({
        tag: node.tag,
        vdm: String(attr(node, 'data-vdm-id') ?? ''),
        x: r3(box.x), y: r3(box.y), w: r3(box.w), h: r3(box.h),
        lineHeight: box.text ? r3(box.text.lineHeight) : null,
        textWidth: box.text ? r3(box.text.width) : null,
      });
    });
  }
  return result;
}

function viewportOf(opts) {
  const width = Number(opts.width) > 0 ? Math.round(Number(opts.width)) : DEFAULT_VIEWPORT[0];
  const height = Number(opts.height) > 0 ? Math.round(Number(opts.height)) : DEFAULT_VIEWPORT[1];
  return [width, height];
}

function measurer(measureText, warnings, at) {
  if (typeof measureText === 'function') return measureText;
  warnings.add('text-measure-fallback', at, '没有传 opts.measureText：文字宽度按 0.6em / 1em（CJK）估算，位置会偏');
  return (text, style) => {
    let width = 0;
    for (const ch of String(text ?? '')) {
      const cjk = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch);
      width += (cjk ? 1 : 0.6) * style.fontSize;
    }
    const count = Array.from(String(text ?? '')).length;
    return width + Math.max(0, count - 1) * style.letterSpacing;
  };
}

/** Resolve an `<a href>`-style relative path against the entry file's directory. */
export function resolveSourceFile(entry, href) {
  const clean = String(href ?? '').split(/[?#]/)[0].trim();
  if (!clean || /^[a-z][a-z\d+.-]*:/i.test(clean) || clean.startsWith('/')) return null;
  const dir = String(entry).includes('/') ? String(entry).slice(0, String(entry).lastIndexOf('/')) : '';
  const parts = `${dir}/${clean}`.split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) if (child.type === 'element') walk(child, visit);
}

/** A text node: one `text` element, positioned so the glyphs land where CSS put them. */
function compileTextNode({ node, id, style, box, boxRect, text, ctx, center, duration, sourceId, at }) {
  const family = style.resolvedFont;
  const tracks = animationTracks(node, style, boxRect, ctx);
  // Baseline = the value at t = 0 (§7.8.1), i.e. the clamped first key.
  const baseline = (path, fallback) => {
    const keys = tracks.get(path);
    if (!keys || !keys.length) return fallback;
    if (keys[0].t >= 0) return keys[0].value;
    return keys[0].value;
  };
  const staticTransform = parseTransformList(style.transform, { ...boxRect, fontSize: style.fontSize }, ctx);
  const components = staticTransform ? decomposeMatrix(staticTransform.matrix) : { x: 0, y: 0, scale: 1, rotation: 0 };
  if (staticTransform) {
    for (const warning of staticTransform.warnings) {
      ctx.warnings.add('unsupported-transform', `${at}:${node.line}`, `${warning} 不在编译子集里（只支持平移 / 等比缩放 / 平面旋转）`);
    }
  }
  // Where the *text* starts inside the CSS box (text-align) and how wide it is
  // in CSS terms (a trailing letter-spacing is part of the inline box).
  const alignStart = style.align === 'left'
    ? box.contentX
    : style.align === 'right' ? box.contentX + box.contentW - text.cssWidth
      : box.contentX + (box.contentW - text.cssWidth) / 2;
  const originShift = transformOriginShift(style.transformOrigin, boxRect, ctx, `${at}:${node.line}`);
  const layoutX = alignStart + text.width / 2 - center[0];
  const layoutY = box.y + (box.h - text.height) / 2 + text.height / 2 - center[1];
  // The snapshot's `transform.x/y` are the element's position in project
  // pixels (§7.8.1), not the CSS translate alone: the animated translation is
  // relative to the laid-out box, so the layout offset is added to every key.
  shiftTrack(tracks, 'transform.x', layoutX);
  shiftTrack(tracks, 'transform.y', layoutY);
  const x0 = layoutX + components.x + originShift.x;
  const y0 = layoutY + components.y + originShift.y;
  const baselineOf = (path, fallback) => {
    const value = baseline(path, fallback);
    return value;
  };
  const color = style.color;
  // A translucent text colour becomes element opacity (§7.8.1 keeps alpha out of
  // `style.color`); it multiplies whatever the opacity track says.
  const alpha = clamp(num(color.a, 1), 0, 1);
  const opacityTrack = tracks.get('transform.opacity');
  if (opacityTrack) for (const key of opacityTrack) key.value = r3(key.value * alpha);
  const props = {
    'style.text': text.text,
    'style.font': family,
    'style.size': r3(style.fontSize),
    'style.weight': r3(style.fontWeight),
    'style.color': formatHex(color),
    'style.align': style.align,
    'style.lineHeight': r3(text.lineHeight / style.fontSize),
    'style.letterSpacing': r3(style.letterSpacing),
    'transform.x': r3(baselineOf('transform.x', x0)),
    'transform.y': r3(baselineOf('transform.y', y0)),
    'transform.scale': r3(baselineOf('transform.scale', components.scale)),
    'transform.rotation': r3(baselineOf('transform.rotation', components.rotation)),
    'transform.opacity': r3(baselineOf('transform.opacity', alpha)),
  };
  const snapshot = snapshotRecord(id, 'text', nearestAncestorId(node), props, tracks, ctx);
  const mode = zeroBaselineModes(props, tracks);
  const element = {
    id: elementIdFor(sourceId, id),
    name: id,
    type: 'text',
    start: 0,
    duration,
    transform: {
      x: props['transform.x'], y: props['transform.y'], scale: props['transform.scale'],
      rotation: props['transform.rotation'], opacity: props['transform.opacity'],
    },
    style: {
      text: props['style.text'], font: props['style.font'], size: props['style.size'],
      weight: props['style.weight'], color: props['style.color'], align: props['style.align'],
      lineHeight: props['style.lineHeight'], letterSpacing: props['style.letterSpacing'],
    },
    source: { id: sourceId, node: id },
  };
  if (Object.keys(mode).length) element.sourceMode = mode;
  return { element, snapshot };
}

/** A solid / shape node: fill and box are element fields, position is a source path. */
function compileBoxNode({ node, id, style, box, boxRect, ctx, center, duration, sourceId, at }) {
  const background = style.background;
  if (background.gradients.length) {
    ctx.warnings.add('background-unsupported', `${at}:${node.line}`, `节点 ${id} 的背景是渐变：渐变只在页面背景上按实心带近似，节点内部不支持`);
  }
  const fillColor = background.color;
  if (!fillColor || fillColor.a <= 1e-6) {
    if (node.tag === 'hr') return null;
    ctx.warnings.add('empty-node', `${at}:${node.line}`, `节点 ${id} 既没有文字也没有背景色，编译成空元素没有意义，跳过`);
    return null;
  }
  const tracks = animationTracks(node, style, boxRect, ctx);
  const staticTransform = parseTransformList(style.transform, { ...boxRect, fontSize: style.fontSize }, ctx);
  const components = staticTransform ? decomposeMatrix(staticTransform.matrix) : { x: 0, y: 0, scale: 1, rotation: 0 };
  const originShift = transformOriginShift(style.transformOrigin, boxRect, ctx, `${at}:${node.line}`);
  const layoutX = box.x + box.w / 2 - center[0];
  const layoutY = box.y + box.h / 2 - center[1];
  shiftTrack(tracks, 'transform.x', layoutX);
  shiftTrack(tracks, 'transform.y', layoutY);
  const baseline = (path, fallback) => {
    const keys = tracks.get(path);
    return keys && keys.length ? keys[0].value : fallback;
  };
  const alpha = clamp(num(fillColor.a, 1), 0, 1);
  const opacityTrack = tracks.get('transform.opacity');
  if (opacityTrack) for (const key of opacityTrack) key.value = r3(key.value * alpha);
  const props = {
    'transform.x': r3(baseline('transform.x', layoutX + components.x + originShift.x)),
    'transform.y': r3(baseline('transform.y', layoutY + components.y + originShift.y)),
    'transform.scale': r3(baseline('transform.scale', components.scale)),
    'transform.rotation': r3(baseline('transform.rotation', components.rotation)),
    'transform.opacity': r3(baseline('transform.opacity', alpha)),
  };
  const isEllipse = /^(circle|ellipse)$/i.test(node.tag);
  const snapshot = snapshotRecord(id, 'solid', nearestAncestorId(node), props, tracks, ctx);
  const element = {
    id: elementIdFor(sourceId, id),
    name: id,
    type: isEllipse ? 'shape' : 'solid',
    start: 0,
    duration,
    transform: {
      x: props['transform.x'], y: props['transform.y'], scale: props['transform.scale'],
      rotation: props['transform.rotation'], opacity: props['transform.opacity'],
    },
    style: {
      w: r3(box.w),
      h: r3(box.h),
      fill: formatHex(fillColor),
      radius: 0,
      ...(isEllipse ? { shape: 'ellipse' } : {}),
    },
    source: { id: sourceId, node: id },
  };
  const mode = zeroBaselineModes(props, tracks);
  if (Object.keys(mode).length) element.sourceMode = mode;
  return { element, snapshot };
}

/**
 * §7.8.2: a zero baseline under the default `mul` mode degrades to `override`,
 * which would drop the animation. `add` on the same zero baseline reproduces
 * the CSS value exactly (`local + (src - 0)` with the element mirroring 0), so
 * the compiler records that one deviation explicitly instead of losing motion.
 */
function zeroBaselineModes(props, tracks) {
  const out = {};
  for (const [path, keys] of tracks) {
    if (!keys.length) continue;
    if (SOURCE_DEFAULT_MODES[path] === 'mul' && Math.abs(num(props[path], 0)) < 1e-9) out[path] = 'add';
  }
  return out;
}

/** `transform-origin` → the offset the element model (centre origin) needs. */
function transformOriginShift(text, boxRect, ctx, at) {
  const raw = String(text ?? '50% 50%').trim().split(/\s+/);
  const axis = (token, size, dflt) => {
    if (token === undefined) return size * dflt;
    const value = lower(token);
    if (value === 'left' || value === 'top') return 0;
    if (value === 'right' || value === 'bottom') return size;
    if (value === 'center') return size / 2;
    const px = evalLength(token, { ...CONTEXT(ctx), percent: size });
    return px === null ? size * dflt : px;
  };
  const ox = axis(raw[0], boxRect.w, 0.5);
  const oy = axis(raw[1], boxRect.h, 0.5);
  const dx = boxRect.w / 2 - ox;
  const dy = boxRect.h / 2 - oy;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: 0, y: 0 };
  // The scale happens about the origin, so the centre must move by (1-s)·d.
  // The compiler does not know `s` here; the caller only needs the *static*
  // offset, and the animated case is reported instead of silently wrong.
  if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
    ctx.warnings.add('unsupported-transform-origin', at,
      `transform-origin ${JSON.stringify(text)} 不是中心：元素模型以中心为原点，缩放/旋转会偏（平移不受影响）`);
  }
  return { x: 0, y: 0 };
}

/** The snapshot node record of §7.8.1 (keys exactly `id/type/parent/props/tracks`). */
function snapshotRecord(id, type, parent, props, tracks, ctx) {
  const keys = [];
  for (const [path, list] of [...tracks.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!SOURCE_PATHS.includes(path)) continue;
    if (!Object.hasOwn(props, path)) {
      // A track without a baseline is an invalid snapshot (§7.8.1); drop it.
      ctx.warnings.add('unsupported-keyframe-property', ctx.at, `轨道 ${path} 没有基线，丢弃`);
      continue;
    }
    for (const key of list) {
      const out = { t: r3(key.t), path, value: key.value };
      const timing = key.timing;
      if (timing?.curve) out.curve = timing.curve;
      if (timing?.ease) out.ease = timing.ease;
      keys.push(out);
    }
  }
  const sorted = keys.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.t - b.t));
  return { id, type, parent: parent || null, props, tracks: sorted };
}

function nearestAncestorId(node) {
  let parent = node.parent;
  while (parent) {
    const id = attr(parent, 'data-vdm-id');
    if (id && String(id).trim()) return String(id).trim();
    parent = parent.parent;
  }
  return null;
}

/** Stable element id for a source node; `addElement` only needs project uniqueness. */
export function elementIdFor(sourceId, nodeId) {
  const clean = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `src_${clean(sourceId)}_${clean(nodeId)}`;
}

/**
 * Page backgrounds: every element whose box covers most of the viewport paints
 * what the browser shows behind the nodes. Solid colours become one `solid`;
 * a `linear-gradient` becomes `bands` solid strips perpendicular to the
 * gradient line (the element model has no gradient fill — reported as
 * `background-gradient-approximated`).
 */
function compileBackgroundBands(root, styles, boxes, ctx, { vw, vh, center, z0, sourceId, duration, warnings, elements }) {
  let below = { r: 0, g: 0, b: 0, a: 1 };
  let emitted = 0;
  const area = vw * vh;
  walk(root, (node) => {
    if (node.tag === '#root' || isHeadTag(node.tag)) return;
    const style = styles.get(node);
    const box = boxes.get(node);
    if (!style || !box) return;
    const { color, gradients } = style.background;
    const covers = (box.w * box.h) / area >= 0.5;
    if (!covers) {
      // A marked node compiles into its own element; it is not a page background.
      if (!String(attr(node, 'data-vdm-id') ?? '').trim() && ((color && color.a > 0.01) || gradients.length)) {
        warnings.add('background-not-compiled', `${ctx.at}:${node.line}`,
          `<${node.tag}> 有背景但没覆盖画面，不是编译节点（加 data-vdm-id 才会编译成元素）`);
      }
      return;
    }
    if (color && color.a > 0.01) {
      const solid = compositeColor(color, below);
      below = solid;
      elements.push({
        id: `srcbg_${elementIdFor(sourceId, `bg_${emitted}`)}`,
        name: `background ${node.tag}`,
        type: 'solid',
        start: 0,
        duration,
        z: z0,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        style: { w: vw, h: vh, fill: formatHex(solid), radius: 0 },
      });
      emitted += 1;
    }
    for (const gradient of gradients) {
      if (gradient.kind === 'radial') continue;
      const bands = backgroundBandsFor(gradient, box, below, { vw, vh, center, ctx });
      if (!bands) continue;
      for (const band of bands) {
        elements.push({
          id: `srcbg_${elementIdFor(sourceId, `bg_${emitted}`)}`,
          name: `background ${node.tag} band`,
          type: 'solid',
          start: 0,
          duration,
          z: z0,
          transform: { x: band.x, y: band.y, scale: 1, rotation: band.rotation, opacity: 1 },
          style: { w: band.w, h: band.h, fill: band.fill, radius: 0 },
        });
        emitted += 1;
      }
      warnings.add('background-gradient-approximated', `${ctx.at}:${node.line}`,
        `<${node.tag}> 的 linear-gradient 用 ${bands.length} 条实心带近似（元素模型没有渐变填充；每条带取带内中点颜色，误差 ≤ 1/255 量级）`);
      // The last band's color is the gradient's end state.
      below = compositeColor(gradientColorAt(gradient, 1), below);
    }
  });
  return emitted;
}

function backgroundBandsFor(gradient, box, below, { vw, vh, center, ctx }) {
  const rad = (Number(gradient.angle) * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const lengthInPx = Math.abs(box.w * ux) + Math.abs(box.h * uy);
  if (!(lengthInPx > 1e-6)) return null;
  // Largest channel jump between neighbouring stops decides how many bands.
  let maxDelta = 0;
  for (const stop of gradient.stops) maxDelta = Math.max(maxDelta, Math.max(stop.color.r, stop.color.g, stop.color.b) * (stop.color.a ?? 1));
  const bands = clamp(Math.ceil(maxDelta / 1.5), 8, 64);
  const step = lengthInPx / bands;
  const span = Math.hypot(box.w, box.h) + 2;
  // Gradient line: through the box centre, ±length/2 along the direction.
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const screenAngle = (Math.atan2(uy, ux) * 180) / Math.PI;
  const rotation = -screenAngle;
  const out = [];
  for (let i = 0; i < bands; i++) {
    const p = (i + 0.5) * step;
    const color = gradientColorAt(gradient, (i + 0.5) / bands);
    const opaque = compositeColor(color, below);
    const offset = p - lengthInPx / 2;
    out.push({
      x: r3(cx + ux * offset - center[0]),
      y: r3(cy + uy * offset - center[1]),
      w: r3(span),
      h: r3(step + 2),
      rotation: r3(rotation),
      fill: formatHex(opaque),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compile: SVG
// ---------------------------------------------------------------------------

/**
 * Parse an SVG `d` attribute into absolute segments (M/L/H/V/C/Q/Z plus the
 * relative forms). Exported for tests and for a future rasteriser; `compileSvg`
 * uses it only to report that the element model cannot draw it.
 */
export function parseSvgPath(d) {
  const tokens = String(d ?? '').match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/g) || [];
  const segments = [];
  const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let i = 0;
  let cmd = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl = null;
  const numbers = (count) => {
    if (i + count > tokens.length) return null;
    const out = tokens.slice(i, i + count).map(Number);
    if (out.some((n) => !Number.isFinite(n))) return null;
    i += count;
    return out;
  };
  const track = (px, py) => {
    bbox.minX = Math.min(bbox.minX, px); bbox.minY = Math.min(bbox.minY, py);
    bbox.maxX = Math.max(bbox.maxX, px); bbox.maxY = Math.max(bbox.maxY, py);
  };
  for (;;) {
    if (i >= tokens.length) break;
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(tokens[i])) { cmd = tokens[i]; i += 1; }
    else if (cmd === null) return { segments, bbox: null, error: 'path 必须以命令开头' };
    const relative = cmd === cmd.toLowerCase();
    const kind = cmd.toUpperCase();
    const base = relative ? { x, y } : { x: 0, y: 0 };
    if (kind === 'Z') {
      segments.push({ cmd: 'Z', points: [], to: [startX, startY] });
      x = startX; y = startY;
      lastControl = null;
      cmd = null;
      continue;
    }
    if (kind === 'M' || kind === 'L' || kind === 'T') {
      const nums = numbers(2);
      if (!nums) return { segments, bbox: null, error: `命令 ${cmd} 缺少坐标` };
      x = base.x + nums[0]; y = base.y + nums[1];
      if (kind === 'M') {
        startX = x; startY = y;
        segments.push({ cmd: 'M', points: [[x, y]], to: [x, y] });
        // Extra pairs after a moveto are implicit linetos (SVG spec).
        cmd = relative ? 'l' : 'L';
      } else {
        if (kind === 'T') {
          if (!lastControl) segments.push({ cmd: 'Q', points: [[x, y], [x, y]], to: [x, y] });
          else {
            const cx = 2 * x - lastControl[0];
            const cy = 2 * y - lastControl[1];
            segments.push({ cmd: 'Q', points: [[cx, cy], [x, y]], to: [x, y] });
            lastControl = null;
          }
        } else segments.push({ cmd: 'L', points: [[x, y]], to: [x, y] });
      }
      track(x, y);
      continue;
    }
    if (kind === 'H' || kind === 'V') {
      const nums = numbers(1);
      if (!nums) return { segments, bbox: null, error: `命令 ${cmd} 缺少坐标` };
      if (kind === 'H') x = (relative ? x : 0) + nums[0];
      else y = (relative ? y : 0) + nums[0];
      segments.push({ cmd: 'L', points: [[x, y]], to: [x, y] });
      track(x, y);
      continue;
    }
    if (kind === 'C' || kind === 'S' || kind === 'Q') {
      const count = kind === 'Q' ? 4 : 6;
      const nums = numbers(count);
      if (!nums) return { segments, bbox: null, error: `命令 ${cmd} 缺少坐标` };
      const points = [];
      for (let k = 0; k < nums.length; k += 2) points.push([base.x + nums[k], base.y + nums[k + 1]]);
      lastControl = points[0];
      x = points[points.length - 1][0];
      y = points[points.length - 1][1];
      segments.push({ cmd: kind, points, to: [x, y] });
      track(x, y);
      continue;
    }
    return { segments, bbox: null, error: `命令 ${cmd} 不在解析子集里` };
  }
  const clean = Number.isFinite(bbox.minX) ? bbox : null;
  const closed = segments.some((segment) => segment.cmd === 'Z');
  return { segments, bbox: clean, closed };
}

/**
 * Compile an SVG document: `rect` / `circle` / `ellipse` map onto the element
 * model's two shapes; `path` / `polyline` / `polygon` are parsed but reported
 * as not drawable (the renderer only knows rect + ellipse).
 */
export function compileSvg(source, opts = {}) {
  const warnings = new Warnings();
  const files = isRecord(source?.files) ? source.files : {};
  const manifest = isRecord(source?.manifest) ? source.manifest : {};
  const sourceId = String(source?.id ?? manifest.id ?? '');
  const entry = String(source?.entry ?? manifest.entry ?? 'index.svg');
  const at = entry;
  const [vw, vh] = viewportOf(opts);
  const text = files[entry];
  if (typeof text !== 'string') {
    throw Object.assign(new Error(`源 ${sourceId} 的入口 ${entry} 不在 files 里`), { code: 'INVALID_ARGUMENT' });
  }
  const { root } = parseHtml(text, { at, warnings });
  const svg = findFirst(root, (node) => node.tag === 'svg');
  if (!svg) throw Object.assign(new Error(`${entry} 里没有 <svg>`), { code: 'INVALID_ARGUMENT' });
  const width = Number(attr(svg, 'width')) || vw;
  const height = Number(attr(svg, 'height')) || vh;
  const viewBox = String(attr(svg, 'viewbox') ?? attr(svg, 'viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  if (viewBox.length === 4 && viewBox.every(Number.isFinite)) {
    const [minX, minY, boxW, boxH] = viewBox;
    const sx = width / boxW;
    const sy = height / boxH;
    if (Math.abs(sx - sy) > 1e-6) {
      warnings.add('svg-viewbox', at, `viewBox 的 x/y 比例不同（${sx.toFixed(4)} vs ${sy.toFixed(4)}），按 x 方向等比缩放`);
    }
    scale = sx;
    offsetX = -minX * scale;
    offsetY = -minY * scale;
  } else if (String(attr(svg, 'viewbox') ?? '').trim()) {
    warnings.add('svg-viewbox', at, 'viewBox 不是 "minX minY width height"，按 1:1 处理');
  }
  const z0 = Number.isFinite(opts.z0) ? opts.z0 : 1;
  const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 10;
  const center = [vw / 2, vh / 2];
  const elements = [];
  const nodes = [];
  const taken = new Set();
  let z = z0;

  const flatten = (node, inherited) => {
    const transform = inherited;
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      const local = svgTransformOf(child, at, warnings);
      const matrix = composeSvgTransform(transform, local);
      if (child.tag === 'g') { flatten(child, matrix); continue; }
      const id = String(attr(child, 'id') ?? '').trim();
      if (id && !NODE_ID_RE.test(id)) {
        warnings.add('node-id-invalid', `${at}:${child.line}`, `id="${id}" 不匹配 ^[A-Za-z_][A-Za-z0-9_.-]{0,63}$，跳过`);
        continue;
      }
      const shape = svgShapeOf(child, at, warnings);
      if (!shape) continue;
      if (!id) {
        warnings.add('empty-node', `${at}:${child.line}`, `<${child.tag}> 没有 id（SVG 用 id 当节点 id），跳过`);
        continue;
      }
      if (taken.has(id)) {
        warnings.add('duplicate-node-id', `${at}:${child.line}`, `id="${id}" 重复，只编译第一个`);
        continue;
      }
      taken.add(id);
      const mapped = applySvgMatrix(matrix, shape, scale, offsetX, offsetY);
      if (!mapped) continue;
      const props = {
        'transform.x': r3(mapped.cx - center[0]),
        'transform.y': r3(mapped.cy - center[1]),
        'transform.scale': 1,
        'transform.rotation': 0,
        'transform.opacity': r3(clamp(shape.opacity, 0, 1)),
      };
      nodes.push({
        id, type: shape.type === 'ellipse' ? 'shape' : 'solid', parent: null, props, tracks: [],
      });
      elements.push({
        id: elementIdFor(sourceId, id),
        name: id,
        type: shape.type === 'ellipse' ? 'shape' : 'solid',
        start: 0,
        duration,
        z: z++,
        transform: { x: props['transform.x'], y: props['transform.y'], scale: 1, rotation: 0, opacity: props['transform.opacity'] },
        style: {
          w: r3(mapped.w), h: r3(mapped.h), fill: formatHex(shape.fill), radius: r3(mapped.radius),
          ...(shape.type === 'ellipse' ? { shape: 'ellipse' } : {}),
        },
        source: { id: sourceId, node: id },
      });
    }
  };
  flatten(svg, [1, 0, 0, 1, 0, 0]);
  if (!nodes.length) warnings.add('empty-node', at, '这个 SVG 没有可编译的图形：给 rect/circle/ellipse 加 id');
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { source: sourceId, runtime: 'svg', entry, width: vw, height: vh, nodes, elements, warnings: warnings.list };
}

function findFirst(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const hit = child.type === 'element' ? findFirst(child, predicate) : null;
    if (hit) return hit;
  }
  return null;
}

function svgStyleOf(node) {
  const out = {};
  for (const [prop, value] of Object.entries(parseStyleAttribute(attr(node, 'style')))) out[prop] = value;
  return out;
}

function svgNumber(node, name, dflt = 0) {
  const raw = attr(node, name);
  if (raw === undefined || raw === '') return dflt;
  const value = evalLength(raw, {});
  return value === null ? dflt : value;
}

function svgShapeOf(node, at, warnings) {
  const tag = node.tag;
  const decls = svgStyleOf(node);
  const fillText = decls.fill ?? attr(node, 'fill') ?? '#000000';
  const fill = parseCssColor(fillText) || parseCssColor('#000000');
  if (lower(fillText) === 'none') return null;
  const opacity = clamp(num(decls.opacity ?? attr(node, 'opacity'), 1), 0, 1);
  const base = { fill, opacity };
  if (tag === 'rect') {
    const w = svgNumber(node, 'width');
    const h = svgNumber(node, 'height');
    if (!(w > 0 && h > 0)) return null;
    return { type: 'rect', x: svgNumber(node, 'x'), y: svgNumber(node, 'y'), w, h, radius: Math.max(0, svgNumber(node, 'rx')), ...base };
  }
  if (tag === 'circle') {
    const r = svgNumber(node, 'r');
    if (!(r > 0)) return null;
    return { type: 'ellipse', x: svgNumber(node, 'cx') - r, y: svgNumber(node, 'cy') - r, w: r * 2, h: r * 2, radius: 0, ...base };
  }
  if (tag === 'ellipse') {
    const rx = svgNumber(node, 'rx');
    const ry = svgNumber(node, 'ry');
    if (!(rx > 0 && ry > 0)) return null;
    return { type: 'ellipse', x: svgNumber(node, 'cx') - rx, y: svgNumber(node, 'cy') - ry, w: rx * 2, h: ry * 2, radius: 0, ...base };
  }
  if (tag === 'path') {
    const parsed = parseSvgPath(attr(node, 'd'));
    warnings.add('path-not-drawable', `${at}:${node.line}`,
      `<path> 能解析（${parsed.segments.length} 段${parsed.bbox ? `，bbox ${parsed.bbox.minX.toFixed(1)}×${parsed.bbox.minY.toFixed(1)}` : ''}）但元素模型只有矩形/椭圆，路径要栅格化（未实现）`);
    return null;
  }
  if (tag === 'polygon' || tag === 'polyline') {
    warnings.add('polygon-not-drawable', `${at}:${node.line}`, `<${tag}> 不在可绘制子集里（元素模型只有矩形/椭圆），要栅格化（未实现）`);
    return null;
  }
  if (tag === 'line') {
    warnings.add('polygon-not-drawable', `${at}:${node.line}`, '<line> 不在可绘制子集里，跳过');
    return null;
  }
  return null;
}

/** `transform="translate(…) scale(…) rotate(…)"` on an SVG node. */
function svgTransformOf(node, at, warnings) {
  const raw = attr(node, 'transform');
  if (!raw) return [1, 0, 0, 1, 0, 0];
  let matrix = [1, 0, 0, 1, 0, 0];
  const re = /([a-zA-Z]+)\(([^)]*)\)/g;
  let match;
  const multiply = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase();
    const args = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (name === 'translate') matrix = multiply(matrix, [1, 0, 0, 1, args[0] || 0, args[1] || 0]);
    else if (name === 'scale') matrix = multiply(matrix, [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0]);
    else if (name === 'rotate') {
      const rad = ((args[0] || 0) * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      matrix = multiply(matrix, [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
    } else {
      warnings.add('svg-transform-unsupported', at, `SVG transform ${name}() 不在编译子集里（只支持 translate/scale/rotate）`);
    }
  }
  return matrix;
}

function composeSvgTransform(parent, local) {
  const [a, b, c, d, e, f] = parent;
  const [a2, b2, c2, d2, e2, f2] = local;
  return [
    a * a2 + c * b2, b * a2 + d * b2,
    a * c2 + c * d2, b * c2 + d * d2,
    a * e2 + c * f2 + e, b * e2 + d * f2 + f,
  ];
}

/** Map a shape to screen pixels through the viewBox scale + accumulated matrix. */
function applySvgMatrix(matrix, shape, scale, offsetX, offsetY) {
  const [a, b, c, d, e, f] = matrix;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  if (!(sx > 0) || !(sy > 0)) return null;
  if (Math.abs(sx - sy) > 1e-4 * Math.max(sx, sy)) {
    // A non-uniform SVG transform would need a sheared quad; the element model
    // has no way to express it, so the shape is reported, not faked.
    return null;
  }
  const s = sx * scale;
  const cx = (a * (shape.x + shape.w / 2) + c * (shape.y + shape.h / 2) + e) * scale + offsetX;
  const cy = (b * (shape.x + shape.w / 2) + d * (shape.y + shape.h / 2) + f) * scale + offsetY;
  return { cx, cy, w: shape.w * s, h: shape.h * s, radius: (shape.radius || 0) * s };
}

/** Add the element's layout offset to every key of one translation track. */
function shiftTrack(tracks, path, offset) {
  const keys = tracks.get(path);
  if (!keys || !Number.isFinite(offset)) return;
  for (const key of keys) key.value = r3(key.value + offset);
}
