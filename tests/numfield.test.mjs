import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseValue, formatValue, snapQuantum, gainAt,
} from '../app/renderer/js/numfield.js';

test('numfield: typing partial values never blocks the decimal point', () => {
  // "0." is what the old number input used to eat; the parser must accept it
  assert.equal(parseValue('0.'), 0);
  assert.equal(parseValue('.5'), 0.5);
  assert.equal(parseValue('-'), NaN);
  assert.equal(parseValue(''), NaN);
});

test('numfield: percent and comma input parse to plain numbers', () => {
  assert.equal(parseValue('35%'), 35);
  assert.equal(parseValue(' 12,5 % '), 12.5);
  assert.equal(parseValue('abc'), NaN);
});

test('numfield: display keeps two decimals and the percent unit', () => {
  assert.equal(formatValue(0.35, { scale: 100, unit: '%', step: 0.01 }), '35%');
  assert.equal(formatValue(0.333, { scale: 100, unit: '%', step: 0.01 }), '33.3%');
  assert.equal(formatValue(1, { scale: 100, unit: '%', step: 0.01 }), '100%');
  assert.equal(formatValue(108.0449, { step: 0.1 }), '108.04');
  assert.equal(formatValue(1.5, { step: 0.001 }), '1.5');
  assert.equal(formatValue(Number.NaN, { step: 0.1 }), '');
});

test('numfield: scale round-trips through display text', () => {
  const shown = formatValue(0.5, { scale: 100, unit: '%', step: 0.01 });
  assert.equal(parseValue(shown) / 100, 0.5);
});

test('numfield: crosshair gain goes finer downwards, coarser upwards', () => {
  assert.equal(gainAt(250), 0.0001, 'fully down = finest');
  assert.equal(gainAt(-250), 10000, 'fully up = coarsest');
  assert.ok(gainAt(-100) > gainAt(0));
  assert.ok(gainAt(0) > gainAt(100));
  // mid press point is the geometric middle of the range
  assert.ok(Math.abs(gainAt(0) - 1) < 1e-9);
});

test('numfield: snap grid follows the gear and stops at 0.0001', () => {
  assert.equal(snapQuantum(0.00012), 0.0001);
  assert.equal(snapQuantum(0.05), 0.1);
  assert.equal(snapQuantum(0.6), 1);
  assert.equal(snapQuantum(6), 10);
  assert.equal(snapQuantum(999), 1000);
  assert.equal(snapQuantum(1e9), 10000, 'coarse cap');
  assert.equal(snapQuantum(1e-9), 0.0001, 'fine floor');
  // a fine snap actually produces four display decimals
  assert.equal(formatValue(12.3456, { step: 0.1, digits: 4 }), '12.3456');
});
