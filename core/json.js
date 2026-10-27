// Input boundaries shared by Node and the browser. Never traverse prototypes.
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

const invalid = (message) => { throw Object.assign(new Error(message), { code: 'OP_INVALID' }); };
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function pathParts(value) {
  if (typeof value !== 'string' || !value || value.length > 512) invalid('invalid property path');
  const parts = value.split('.');
  if (parts.length > 32 || parts.some((key) => !key || FORBIDDEN.has(key))) invalid(`unsafe property path: ${value}`);
  return parts;
}

/** Validate the entire input before applying any operation, including nested batches. */
export function assertSafeData(value, { maxDepth = 48, maxNodes = 200000 } = {}) {
  let nodes = 0;
  const visiting = new Set();
  const visit = (item, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) invalid('input is too large or deeply nested');
    if (item == null || ['string', 'boolean', 'undefined'].includes(typeof item)) return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid('input numbers must be finite');
      return;
    }
    if (typeof item !== 'object') invalid('input must contain JSON values');
    if (visiting.has(item)) invalid('input must not contain cycles');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) invalid('input must contain plain objects');
    visiting.add(item);
    for (const [key, entry] of Object.entries(item)) {
      if (FORBIDDEN.has(key)) invalid(`unsafe property: ${key}`);
      visit(entry, depth + 1);
    }
    visiting.delete(item);
  };
  visit(value, 0);
}
