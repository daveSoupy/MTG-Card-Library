import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePickerColors } from './pickerColors.ts';

test('no picks falls back to the commander identity', () => {
  assert.deepEqual(effectivePickerColors([], ['W', 'U', 'C']), ['W', 'U', 'C']);
  assert.equal(effectivePickerColors([], null), undefined);
});

test('without an identity the picks stand on their own', () => {
  assert.deepEqual(effectivePickerColors(['B'], null), ['B']);
});

test('picks are intersected with the identity', () => {
  assert.deepEqual(effectivePickerColors(['B', 'R'], ['W', 'U', 'B', 'G', 'C']), ['B']);
});

test('an entirely off-identity pick keeps the identity rather than offering illegal cards', () => {
  assert.deepEqual(effectivePickerColors(['R'], ['W', 'U', 'C']), ['W', 'U', 'C']);
});
