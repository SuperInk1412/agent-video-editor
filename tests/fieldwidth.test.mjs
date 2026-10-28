import test from 'node:test';
import assert from 'node:assert/strict';
import {
  widthFor, isWidth, WIDTHS, BUDGET, WIDTH_OVERRIDES,
} from '../app/renderer/js/field-width.js';

// ---------------------------------------------------------------- numbers
test('field width: integer budget hits 5 / 6 / 9 / 10 characters', () => {
  assert.equal(BUDGET.third, 5);
  assert.equal(BUDGET.half, 9);
  // step 1 -> no decimals, so the character count is the integer digits
  assert.equal(widthFor({ type: 'number', value: 12345, step: 1 }), 'third');
  assert.equal(widthFor({ type: 'number', value: 123456, step: 1 }), 'half');
  assert.equal(widthFor({ type: 'number', value: 123456789, step: 1 }), 'half');
  assert.equal(widthFor({ type: 'number', value: 1234567890, step: 1 }), 'full');
});

test('field width: decimals come from the step', () => {
  // 12.5 with 2 decimals + "s" = 6 chars
  assert.equal(widthFor({ type: 'number', value: 12.5, step: 0.01, unit: 's' }), 'half');
  // 1.5 with 1 decimal + "s" = 4 chars
  assert.equal(widthFor({ type: 'number', value: 1.5, step: 0.1, unit: 's' }), 'third');
  // 1234.567 with 3 decimals + "px" = 10 chars
  assert.equal(widthFor({ type: 'number', value: 1234.567, step: 0.001, unit: 'px' }), 'full');
  // very fine steps stop at numfield's four displayed decimals
  assert.equal(widthFor({ type: 'number', value: 1.23456, step: 0.00001, unit: 'm' }), 'half');
});

test('field width: short values stay at one third (字号 120, 缩放 1)', () => {
  assert.equal(widthFor({ type: 'number', value: 120, step: 1, unit: 'px' }), 'third');
  assert.equal(widthFor({ type: 'number', value: 1, step: 0.01 }), 'third');
});

test('field width: unit suffix counts toward the budget', () => {
  assert.equal(widthFor({ type: 'number', value: 120, step: 1, unit: 'px' }), 'third');
  assert.equal(widthFor({ type: 'number', value: 120, step: 1, unit: 'dBm' }), 'half');
  assert.equal(widthFor({ type: 'number', value: 1234, step: 1, unit: 'px' }), 'half');
});

test('field width: percent scales the value and reserves the % sign', () => {
  // 0..1 bounds become 0..100 in the numfield, so "100%" always fits
  assert.equal(widthFor({ type: 'number', value: 1, step: 0.01, min: 0, max: 1, percent: true }), 'third');
  assert.equal(widthFor({ type: 'number', value: 0, step: 0.01, min: 0, max: 1, percent: true }), 'third');
  // 0.001 step -> one shown decimal: "50.0%" = 5 chars, but 3 int digits + .0 + %
  assert.equal(widthFor({ type: 'number', value: 0.5, step: 0.001, min: 0, max: 1, percent: true }), 'half');
});

test('field width: a possible minus sign is budgeted only for signed fields', () => {
  assert.equal(widthFor({ type: 'number', value: -5, step: 1, min: -10, max: 0 }), 'third');
  assert.equal(widthFor({ type: 'number', value: -12345, step: 1, min: -99999, max: 0 }), 'half');
  assert.equal(widthFor({ type: 'number', value: 5, step: 1, min: 0, max: 10 }), 'third');
});

test('field width: bounds drive the integer digits', () => {
  assert.equal(widthFor({ type: 'number', value: 0, step: 1, min: 0, max: 120, unit: 'm' }), 'third');
  assert.equal(widthFor({ type: 'number', value: 0, step: 1, min: 0, max: 50000, unit: 'm' }), 'half');
  assert.equal(widthFor({ type: 'number', value: 0, step: 1, min: 0, max: 999999999 }), 'half');
  assert.equal(widthFor({ type: 'number', value: 0, step: 1, min: 0, max: 9999999999 }), 'full');
});

test('field width: the formatted value (not the raw number) sets the digits', () => {
  // 999999.999 is drawn as 1000000 by the numfield; that carry is budgeted
  assert.equal(widthFor({ type: 'number', value: 999999.999, step: 0.01 }), 'full');
  assert.equal(widthFor({ type: 'number', value: 999998.999, step: 0.01 }), 'half');
});

// ---------------------------------------------------------------- text
test('field width: text length uses the same 5 / 9 thresholds', () => {
  assert.equal(widthFor({ type: 'text', value: '12345' }), 'third');
  assert.equal(widthFor({ type: 'text', value: '123456' }), 'half');
  assert.equal(widthFor({ type: 'text', value: 'a'.repeat(9) }), 'half');
  assert.equal(widthFor({ type: 'text', value: 'a'.repeat(10) }), 'full');
  assert.equal(widthFor({ type: 'text', value: '' }), 'third');
});

test('field width: a placeholder can describe the expected text length', () => {
  assert.equal(widthFor({ type: 'text', value: 'a', placeholder: 'media/xxx' }), 'half');
  assert.equal(widthFor({ type: 'text', value: '', placeholder: 'media/fonts/xxx.ttf 或字体名' }), 'full');
});

test('field width: long paths and text fill the row', () => {
  assert.equal(widthFor({ type: 'text', value: 'media/shots/s1-final-v2.mp4' }), 'full');
  assert.equal(widthFor({ type: 'text', value: 'Microsoft YaHei' }), 'full');
});

// ---------------------------------------------------------------- type defaults
test('field width: control types with intrinsic width span the row', () => {
  for (const type of ['textarea', 'select', 'checkbox', 'read-only', 'readonly', 'ctl-with-btn', 'vector']) {
    assert.equal(widthFor({ type, value: '' }), 'full', type);
  }
  assert.equal(widthFor({ type: 'color', value: '#ffffff' }), 'half');
  assert.equal(widthFor({ type: 'something-new' }), 'full', 'unknown controls stay full');
});

// ---------------------------------------------------------------- overrides
test('field width: explicit overrides beat the value-based choice', () => {
  assert.equal(WIDTH_OVERRIDES['帧率'], 'third');
  // the project fps field is text, but always a short integer
  assert.equal(widthFor({ type: 'text', value: '30', key: '帧率' }), 'third');
  assert.equal(widthFor({ type: 'text', value: 'a'.repeat(20), key: '帧率' }), 'third');
  assert.equal(widthFor({ type: 'text', value: 'a'.repeat(20) }), 'full');
  // explicit per-field widths win over both defaults and the override map
  assert.equal(widthFor({ type: 'color', value: '#fff', w: 'full' }), 'full');
  assert.equal(widthFor({ type: 'textarea', value: 'x', width: 'half' }), 'half');
});

test('field width: width names are validated', () => {
  assert.deepEqual([...WIDTHS], ['third', 'half', 'full']);
  for (const w of WIDTHS) assert.equal(isWidth(w), true, w);
  assert.equal(isWidth('wide'), false);
  assert.equal(widthFor({ type: 'number', value: 1, w: 'wide' }), 'third', 'invalid w is ignored');
});
