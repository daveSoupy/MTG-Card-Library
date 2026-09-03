import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, percent } from './format.ts';

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
