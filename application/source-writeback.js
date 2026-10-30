// Source write-back, text side (docs/DESIGN-BACKEND-V2.md §7.8.3, WP4.3).
//
// §7.8.3 makes `writeBack` async "because it edits the DOM in the sandbox and
// reads the text back". This repo compiles HTML without a DOM — `core/source-map.js`
// is pure ESM (§7.8.6 #1) — so the same job is done on the text with the
// compiler's own tokenizer: find the one element that carries the node id
// (`data-vdm-id` for HTML, `id` for SVG), splice exactly the span that changes,
// and hand the whole new text back. "Edit the DOM, read the file" and "splice
// the span, keep the rest byte-identical" are the same operation here, and the
// formatting of the source file survives (the §7.4 diff stays reviewable).
//
// What this module answers is only "what would the new file text be"; every
// reason (closed enum), every node-type rule and the transaction belong to
// `application/source-service.js::writeBack`. Two failure shapes come back:
//
//   { ok: false, code: 'missing' }     the text no longer carries that node id
//   { ok: false, code: 'unwritable' }  ambiguous / no text content / no <img>
//
// `code` is local to this file; the service maps it onto the frozen reasons.
import { tokenizeHtml, splitDeclarations, parseDeclaration, decodeEntities, VOID_TAGS } from '../core/source-map.js';

/** CSS property of each writable style path (§7.4 "改颜色、字号、字体、字距、行高"). */
export const CSS_PROPERTIES = Object.freeze({
  'style.color': 'color',
  'style.size': 'font-size',
  'style.font': 'font-family',
  'style.weight': 'font-weight',
  'style.letterSpacing': 'letter-spacing',
  'style.lineHeight': 'line-height',
});

/**
 * §7.8.3's writable subset: the §7.4 rows that say "write back to the source".
 * Everything else — `transform.*`, `pivot.*`, effects, crop — is the editor
 * layer's, and `writeBack` reports `path-editor-only` without looking at the
 * source at all. `style.align` is not in the subset: text alignment is layout,
 * not one of the §7.4 "行内样式" rows.
 */
export const WRITEBACK_PATHS = Object.freeze([
  'style.text',
  'style.color',
  'style.size',
  'style.font',
  'style.weight',
  'style.letterSpacing',
  'style.lineHeight',
  'src',
]);

const WRITABLE = new Set(WRITEBACK_PATHS);
const TEXT_PATHS = new Set(WRITEBACK_PATHS.filter((path) => path.startsWith('style.') && path !== 'src'));

/** true for a §7.8.3 writable path. */
export const isWriteBackPath = (path) => WRITABLE.has(String(path));

/** The node type a writable path needs (`null` = any). */
export function nodeTypeForPath(path) {
  if (path === 'src') return 'image';
  if (TEXT_PATHS.has(String(path))) return 'text';
  return null;
}

/** Attribute that carries a node id: HTML `data-vdm-id`, SVG `id` (§7.1). */
export const NODE_ID_ATTRIBUTE = Object.freeze({ html: 'data-vdm-id', svg: 'id' });

// ---------------------------------------------------------------------------
// Finding the element
// ---------------------------------------------------------------------------

/**
 * Every element in `text` that carries `nodeId` (§7.1: `data-vdm-id` /
 * `id`). The compiler refuses duplicates (`duplicate-node-id`) and compiles
 * only the first one; write-back refuses too, because editing the wrong one of
 * two "same" nodes is worse than degrading to the editor layer (§7.4 "有歧义").
 */
export function findNodes({ text, nodeId, runtime = 'html' }) {
  const src = String(text ?? '');
  const id = String(nodeId ?? '').trim();
  if (!id) return [];
  const attribute = NODE_ID_ATTRIBUTE[runtime] || NODE_ID_ATTRIBUTE.html;
  const out = [];
  const tokens = tokenizeHtml(src);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'open') continue;
    if (String(token.attrs?.[attribute] ?? '').trim() !== id) continue;
    out.push({ token, ...elementSpan(tokens, index) });
  }
  return out;
}

/** Where an element starts/ends and what is inside it, from its open token. */
function elementSpan(tokens, index) {
  const token = tokens[index];
  let depth = 0;
  let children = 0;
  let close = null;
  for (let i = index; i < tokens.length; i += 1) {
    const next = tokens[i];
    if (next.type === 'open') {
      if (i > index) children += 1;
      if (!VOID_TAGS.has(next.name)) depth += 1;
      continue;
    }
    if (next.type !== 'close' || VOID_TAGS.has(next.name)) continue;
    depth -= 1;
    if (depth > 0) continue;
    // Balanced tags: the close that returns us to zero is this element's own.
    if (next.name === token.name) close = next;
    break;
  }
  return {
    tag: token.name,
    selfClosing: !!token.selfClosing || VOID_TAGS.has(token.name),
    openStart: token.start,
    openEnd: token.end,
    closeStart: close ? close.start : null,
    closeEnd: close ? close.end : null,
    children,
  };
}

// ---------------------------------------------------------------------------
// Writing one value
// ---------------------------------------------------------------------------

/**
 * The new file text for one write-back, or `{ ok: false, code, message }`.
 * `code` is `'missing'` (the text has no such node) or `'unwritable'`
 * (ambiguous, no text content, not an `<img>` — the §7.4 "write-back fails"
 * cases the service reports as `node-unwritable`).
 */
export function writeNodeValue({ text, nodeId, runtime = 'html', path, value }) {
  const src = String(text ?? '');
  const at = String(path ?? '');
  const hits = findNodes({ text: src, nodeId, runtime });
  if (!hits.length) {
    return { ok: false, code: 'missing', message: `源文本里没有节点 ${JSON.stringify(String(nodeId ?? ''))}（源改过但没重新编译？）` };
  }
  if (hits.length > 1) {
    return { ok: false, code: 'unwritable', message: `节点 ${nodeId} 在源文本里出现了 ${hits.length} 次：不去猜改哪一个（§7.4 "有歧义"）` };
  }
  const node = hits[0];
  if (at === 'style.text') {
    if (node.selfClosing || node.closeStart === null) {
      return { ok: false, code: 'unwritable', message: `<${node.tag}> 没有文本内容（空元素 / 没闭合），写不回文字` };
    }
    if (node.children > 0) {
      return { ok: false, code: 'unwritable', message: `<${node.tag}> 里有子元素：只写回纯文本节点（编译子集也只收叶子节点）` };
    }
    return spliceInner(src, node, escapeText(value));
  }
  if (at === 'src') {
    if (node.tag !== 'img') {
      return { ok: false, code: 'unwritable', message: `<${node.tag}> 没有 src 属性可写，只有 <img> 能写回 src` };
    }
    return setAttribute(src, node, 'src', String(value));
  }
  const property = CSS_PROPERTIES[at];
  if (!property) return { ok: false, code: 'unwritable', message: `${at} 不在 §7.4 的写回子集里` };
  return setStyleDeclaration(src, node, property, formatCssValue(at, value));
}

/** Replace everything between the open tag and its close tag. */
function spliceInner(text, node, inner) {
  const current = text.slice(node.openEnd, node.closeStart);
  if (current === inner) return { ok: true, changed: false, text };
  return { ok: true, changed: true, text: `${text.slice(0, node.openEnd)}${inner}${text.slice(node.closeStart)}` };
}

// ---------------------------------------------------------------------------
// Inline styles (§7.4 "写回该节点的行内样式")
// ---------------------------------------------------------------------------

/**
 * Set one CSS declaration in the element's `style` attribute, keeping the other
 * declarations and their order. A node without an inline `style` gets one: the
 * `style` attribute outranks every selector in the compiler's cascade
 * (`core/source-map.js::computeStyle` gives it specificity 9/9/9), so the new
 * value really is the value the next compile reads (§7.8.3 "写行内样式").
 */
export function setStyleDeclaration(text, node, property, value) {
  const tagText = text.slice(node.openStart, node.openEnd);
  const span = attributeSpan(tagText, 'style');
  if (span) {
    // Entities are decoded before the declarations are re-emitted: `&quot;`
    // contains a `;` that would otherwise split a declaration in two.
    const current = span.valueStart >= 0 ? decodeEntities(tagText.slice(span.valueStart, span.valueEnd)) : '';
    const next = upsertDeclaration(current, property, value);
    if (span.valueStart >= 0 && escapeAttribute(next) === tagText.slice(span.valueStart, span.valueEnd)) {
      return { ok: true, changed: false, text };
    }
    return spliceValue(text, node, span, 'style', escapeAttribute(next));
  }
  return insertAttribute(text, node, 'style', escapeAttribute(`${property}: ${value}`));
}

/** `prop: value; …` with one declaration replaced or appended. */
export function upsertDeclaration(source, property, value) {
  const parts = splitDeclarations(String(source ?? ''));
  const out = [];
  let replaced = false;
  for (const part of parts) {
    const parsed = parseDeclaration(part);
    if (parsed && parsed.prop === property) {
      out.push(`${property}: ${value}`);
      replaced = true;
      continue;
    }
    out.push(part.trim());
  }
  if (!replaced) out.push(`${property}: ${value}`);
  return out.join('; ');
}

/** §7.8.1 rounding (3 decimals) for the numbers a style attribute takes. */
function r3(value) {
  const number = Number(value);
  return Math.round(number * 1000) / 1000 + 0;
}

/** `style.*` value → the CSS text of §7.4's rows. */
export function formatCssValue(path, value) {
  if (path === 'style.size' || path === 'style.letterSpacing') return `${r3(value)}px`;
  if (path === 'style.weight' || path === 'style.lineHeight') return String(r3(value));
  if (path === 'style.font') {
    const family = String(value);
    return /^[A-Za-z][A-Za-z0-9_-]*$/.test(family) ? family : `"${family.replace(/"/g, '\\"')}"`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Attributes (`src`)
// ---------------------------------------------------------------------------

/** Replace an attribute value, or add the attribute to the open tag. */
function setAttribute(text, node, name, value) {
  const tagText = text.slice(node.openStart, node.openEnd);
  const span = attributeSpan(tagText, name);
  if (span) {
    const current = span.valueStart >= 0 ? decodeEntities(tagText.slice(span.valueStart, span.valueEnd)) : null;
    if (current === value) return { ok: true, changed: false, text };
    return spliceValue(text, node, span, name, escapeAttribute(value));
  }
  return insertAttribute(text, node, name, escapeAttribute(value));
}

/**
 * Write `name="value"` where the attribute already is: only the value text
 * changes (quotes and the neighbours of the tag are left alone), and a bare
 * `name` attribute gets its `="value"` inserted. The caller has escaped `value`.
 */
function spliceValue(text, node, span, name, value) {
  if (span.valueStart >= 0) {
    const start = node.openStart + span.valueStart;
    const end = node.openStart + span.valueEnd;
    return { ok: true, changed: true, text: `${text.slice(0, start)}${value}${text.slice(end)}` };
  }
  const at = node.openStart + span.nameEnd;
  return { ok: true, changed: true, text: `${text.slice(0, at)}="${value}"${text.slice(at)}` };
}

function insertAttribute(text, node, name, value) {
  const tagText = text.slice(node.openStart, node.openEnd);
  const at = tagText.lastIndexOf('>');
  const cut = at < 0 ? tagText.length : tagText[at - 1] === '/' ? at - 1 : at;
  const attribute = ` ${name}="${value}"`;
  const start = node.openStart + cut;
  return { ok: true, changed: true, text: `${text.slice(0, start)}${attribute}${text.slice(start)}` };
}

/**
 * Span of one attribute inside a single tag's text, honouring quoted and bare
 * values. `nameEnd` always points past the attribute name; `valueStart` /
 * `valueEnd` are -1 for a bare attribute and -1/-1 when the attribute is absent
 * (`null`).
 */
export function attributeSpan(tagText, name) {
  const wanted = String(name).toLowerCase();
  let i = 1;
  while (i < tagText.length && !/[\s/>]/.test(tagText[i])) i += 1; // skip `<tag`
  for (;;) {
    while (i < tagText.length && /\s/.test(tagText[i])) i += 1;
    if (i >= tagText.length) return null;
    if (tagText[i] === '>') return null;
    if (tagText[i] === '/') { i += 1; continue; }
    const nameStart = i;
    while (i < tagText.length && !/[\s=/>]/.test(tagText[i])) i += 1;
    const nameEnd = i;
    const attribute = tagText.slice(nameStart, nameEnd).toLowerCase();
    let valueStart = -1;
    let valueEnd = -1;
    let cursor = nameEnd;
    while (cursor < tagText.length && /\s/.test(tagText[cursor])) cursor += 1;
    if (tagText[cursor] === '=') {
      cursor += 1;
      while (cursor < tagText.length && /\s/.test(tagText[cursor])) cursor += 1;
      const quote = tagText[cursor];
      if (quote === '"' || quote === "'") {
        const end = tagText.indexOf(quote, cursor + 1);
        valueStart = cursor + 1;
        valueEnd = end < 0 ? tagText.length : end;
        i = end < 0 ? tagText.length : end + 1;
      } else {
        valueStart = cursor;
        while (cursor < tagText.length && !/[\s>]/.test(tagText[cursor])) cursor += 1;
        valueEnd = cursor;
        i = cursor;
      }
    }
    if (attribute === wanted) return { nameStart, nameEnd, valueStart, valueEnd };
  }
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}
