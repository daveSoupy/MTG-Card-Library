import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeOf, withType } from './pickerTypes.ts';

test('a chip writes its term and leaves the rest of the query alone', () => {
  assert.equal(withType('', 'creature'), 't:creature');
  assert.equal(withType('c:ur cmc<=2', 'instant'), 't:instant c:ur cmc<=2');
});

test('single-select: choosing another chip swaps the term, choosing none removes it', () => {
  const creatures = withType('lightning', 'creature');
  assert.equal(withType(creatures, 'land'), 't:land lightning');
  assert.equal(withType(creatures, null), 'lightning');
});

test('the term sits after the scope chip term so both stay at the head of the query', () => {
  assert.equal(withType('owned>=1 c:r', 'sorcery'), 'owned>=1 t:sorcery c:r');
  assert.equal(withType('available>=1', 'artifact'), 'available>=1 t:artifact');
});

test('the chip row reads the query back, in either spelling', () => {
  assert.equal(typeOf('t:creature c:r'), 'creature');
  assert.equal(typeOf('type:Land'), 'land');
  assert.equal(typeOf('c:r'), null);
});

test('a hand-typed type the chips do not offer is not a chip and is never rewritten', () => {
  assert.equal(typeOf('t:legendary'), null);
  assert.equal(withType('t:legendary c:r', 'creature'), 't:creature t:legendary c:r');
  assert.equal(withType('t:legendary t:creature', null), 't:legendary');
});
