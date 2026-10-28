// Content-aware widths for inspector property rows (docs/DESIGN.md §1.4).
//
// The property grid has 8 tracks: a 72px label, six flexible control tracks and
// a 20px keyframe column. A row asks for 2 (1/3), 3 (1/2) or 6 (full) control
// tracks. This module decides which one from the field's type and current
// value: numbers get a character budget derived from their step/bounds/unit,
// text inputs use their length, and textareas / selects / checkboxes /
// read-only rows / vectors / control+button rows always fill the row.
//
// The decision is made once per build. There is no DOM measuring, no
// maxlength and no `field-sizing: content`: those keep re-laying out while the
// user types and push the ◆ column around.
//
// Pure ES module (no DOM), importable from Node tests.

import { formatValue } from './numfield.js';

export const WIDTHS = Object.freeze(['third', 'half', 'full']);

// Character budget boundaries: <= 5 -> 1/3, <= 9 -> 1/2, more -> full.
export const BUDGET = Object.freeze({ third: 5, half: 9 });

// Widths that do not follow from the value, keyed by the row key (its label).
// fps is edited as text but is always a short integer, so keep it narrow.
export const WIDTH_OVERRIDES = Object.freeze({
  '帧率': 'third',
});

/** True for the width names the inspector grid understands. */
export function isWidth(w) {
  return WIDTHS.includes(w);
}

// These controls never look good squeezed: they carry variable-length text or
// several sub-controls that need the whole row.
const FULL_TYPES = new Set([
  'textarea', 'select', 'checkbox', 'read-only', 'readonly', 'ctl-with-btn', 'vector',
]);

const MAX_DECIMALS = 4;

const decimalsOf = (n) => {
  const s = String(n);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(MAX_DECIMALS, s.length - dot - 1);
};

/**
 * Decimals the numfield will use for this step. Percent fields show a scaled
 * value (0.35 -> "35%"), so a step of 0.01 becomes a display step of 1 and
 * needs no decimals.
 */
function decimalsFor(step, percent) {
  const d = decimalsOf(Math.abs(Number(step)) || 0.01);
  return percent ? Math.max(0, d - 2) : d;
}

function integerDigits(n) {
  const x = Math.abs(Number(n));
  return Number.isFinite(x) ? String(Math.trunc(x)).length : 0;
}

/** Integer digits of the text numfield draws for `value` (0 when empty). */
function displayedIntegerDigits(value, { step, unit, percent }) {
  const text = formatValue(value, {
    scale: percent ? 100 : 1,
    unit: percent ? '%' : (unit ?? ''),
    step,
  });
  const m = /^-?(\d+)/.exec(text);
  return m ? m[1].length : 0;
}

/** 1 when a minus sign has to fit, 0 for non-negative fields. */
function signFor(value, min) {
  const lo = Number(min);
  if (Number.isFinite(lo)) return lo < 0 ? 1 : 0;
  return Number(value) < 0 ? 1 : 0;
}

function numberWidth({ value, step = 0.01, min, max, unit, percent = false }) {
  const scale = percent ? 100 : 1;
  const decimals = decimalsFor(step, percent);
  // The current value is formatted exactly like the numfield (reusing
  // formatValue keeps the budget in sync with what is actually drawn). Bounds
  // matter too: a field that can reach 100% needs room for three digits even
  // while it currently reads 0%.
  const intDigits = Math.max(
    1,
    displayedIntegerDigits(value, { step, unit, percent }),
    integerDigits(Number(min) * scale),
    integerDigits(Number(max) * scale),
  );
  const chars = signFor(value, min)
    + intDigits
    + (decimals ? 1 + decimals : 0)
    + (percent ? 1 : String(unit ?? '').length);
  return chars <= BUDGET.third ? 'third' : chars <= BUDGET.half ? 'half' : 'full';
}

function textWidth({ value, placeholder }) {
  const chars = Math.max(String(value ?? '').length, String(placeholder ?? '').length);
  return chars <= BUDGET.third ? 'third' : chars <= BUDGET.half ? 'half' : 'full';
}

/**
 * Pick the grid width for one inspector field.
 *
 * @param {object} field
 * @param {'number'|'text'|'color'|'select'|'textarea'|'checkbox'|'read-only'|'ctl-with-btn'|'vector'} [field.type='number']
 * @param {*} [field.value] current value (numbers are formatted like the numfield)
 * @param {number} [field.step=0.01] numfield step, decides display decimals
 * @param {number} [field.min]
 * @param {number} [field.max]
 * @param {string} [field.unit] suffix drawn inside the number box
 * @param {boolean} [field.percent] percent field (value is 0..1, drawn 0..100%)
 * @param {string} [field.placeholder] text inputs: expected length when empty
 * @param {string} [field.key] row key for WIDTH_OVERRIDES (the label)
 * @param {'third'|'half'|'full'} [field.w] explicit override
 * @returns {'third'|'half'|'full'}
 */
export function widthFor(field = {}) {
  const {
    type = 'number', value, step = 0.01, min, max, unit, percent = false,
    placeholder, key, label, width, w,
  } = field;
  const explicit = isWidth(w) ? w : isWidth(width) ? width : null;
  if (explicit) return explicit;
  const override = WIDTH_OVERRIDES[key ?? label];
  if (isWidth(override)) return override;
  if (type === 'color') return 'half';
  if (FULL_TYPES.has(type)) return 'full';
  if (type === 'text') return textWidth({ value, placeholder });
  if (type === 'number') return numberWidth({ value, step, min, max, unit, percent });
  return 'full';
}
