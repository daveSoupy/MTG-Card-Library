import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, formatBytes, money, percent } from './format.ts';

test('formatBytes scales through the units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(940 * 1024), '940 KB');
  assert.equal(formatBytes(3.4 * 1024 * 1024), '3.4 MB');
  assert.equal(formatBytes(41 * 1024 ** 3), '41 GB');
});

test('formatBytes handles junk without throwing', () => {
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

test('percent is safe when nothing is referenced', () => {
  assert.equal(percent(0, 0), 0);
  assert.equal(percent(3, 4), 75);
  assert.equal(percent(4, 4), 100);
});

test('money separates thousands and keeps two decimals', () => {
  assert.equal(money(72043.89), '$72,043.89');
  assert.equal(money(0), '$0.00');
  assert.equal(money(5), '$5.00');
  assert.equal(money(1234567.5), '$1,234,567.50');
});

test('money says — for a missing price', () => {
  assert.equal(money(null), '—');
  assert.equal(money(undefined), '—');
  assert.equal(money(Number.NaN), '—');
});

test('money puts the sign before the dollar', () => {
  assert.equal(money(-2372.28), '-$2,372.28');
});

test('money can drop zero cents', () => {
  assert.equal(money(23, { wholeDollars: true }), '$23');
  assert.equal(money(1200, { wholeDollars: true }), '$1,200');
  assert.equal(money(23.5, { wholeDollars: true }), '$23.50');
});

test('count separates thousands', () => {
  assert.equal(count(14068), '14,068');
  assert.equal(count(0), '0');
  assert.equal(count(-4896), '-4,896');
  assert.equal(count(null), '—');
});
