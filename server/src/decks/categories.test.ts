import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryListMatches, formatCategoryList, normalizeCategoryInput, parseCategoryList,
} from './categories.ts';

const labelFor = (category: string) =>
  ({ sweeper: 'Board wipes', ramp: 'Ramp', draw: 'Card draw' })[category] ?? category;

test('a manual category is a list, trimmed and blank-free', () => {
  assert.deepEqual(parseCategoryList(' Ramp , draw ,, protection '), ['Ramp', 'draw', 'protection']);
  assert.deepEqual(parseCategoryList('Ramp'), ['Ramp']);
});

test('no override at all is an empty list, however it is spelled', () => {
  for (const empty of [null, undefined, '', '   ', ',', ' , , ']) {
    assert.deepEqual(parseCategoryList(empty), [], JSON.stringify(empty));
  }
  assert.equal(formatCategoryList([]), null, 'the column stores NULL, not an empty string');
});

test('the same category twice is one category, first spelling winning', () => {
  // Otherwise "Ramp, ramp" offers the same thing twice in the datalist and
  // double-counts nothing useful.
  assert.deepEqual(parseCategoryList('Ramp, ramp, RAMP'), ['Ramp']);
});

test('caps keep an override from becoming a notes field', () => {
  assert.equal(parseCategoryList('a,b,c,d,e,f,g,h').length, 6);
  assert.equal(parseCategoryList('x'.repeat(200))[0].length, 40);
});

test('normalising is stable, so re-saving never looks like an edit', () => {
  // The undo stack compares stored strings; drift here would show as a
  // spurious change on every round trip.
  const once = normalizeCategoryInput(' ramp ,draw');
  assert.equal(once, 'ramp, draw');
  assert.equal(normalizeCategoryInput(once), once);
});

test('a card counts toward every category its override names', () => {
  const both = parseCategoryList('ramp, draw');
  assert.ok(categoryListMatches(both, 'ramp', labelFor));
  assert.ok(categoryListMatches(both, 'draw', labelFor));
  assert.ok(!categoryListMatches(both, 'removal', labelFor));
});

test('an override matches a category by its label as readily as its key', () => {
  // "Board wipes" is what the panel shows; 'sweeper' is what the row is keyed
  // on. Someone typing what they can see should be counted.
  const typed = parseCategoryList('Board wipes');
  assert.ok(categoryListMatches(typed, 'sweeper', labelFor));
  assert.ok(categoryListMatches(parseCategoryList('sweeper'), 'sweeper', labelFor));
});

test('matching ignores case, since the stored value keeps the typed spelling', () => {
  assert.ok(categoryListMatches(parseCategoryList('RAMP'), 'ramp', labelFor));
  assert.ok(categoryListMatches(parseCategoryList('card draw'), 'draw', labelFor));
});
