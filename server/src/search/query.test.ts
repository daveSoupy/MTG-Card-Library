import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery } from './query.ts';

/**
 * Warnings for syntax the parser cannot honour.
 *
 * The failure these guard against: a term that fails to parse was dropped
 * without a word, so `cmc>>abc t:(` came back as zero results with nothing to
 * say why, while `loc:nowhere` explained itself. Every term that is dropped
 * should reach the UI's warning strip.
 */

test('a numeric term whose value is not a number warns and is dropped, not silently widened', () => {
  const result = compileQuery('cmc>>abc');
  assert.deepEqual(result.where, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Mana value needs a number/);
  assert.match(result.warnings[0], /"cmc>>abc"/, 'quotes the term as typed');
});

test('every numeric key warns the same way', () => {
  for (const query of ['pow:x', 'tou>=big', 'loy:?', 'year<soon', '-mv:abc']) {
    const result = compileQuery(query);
    assert.equal(result.warnings.length, 1, query);
    assert.match(result.warnings[0], /needs a number/, query);
    assert.deepEqual(result.where, [], query);
  }
  // The negation is part of what was typed, so it is part of what is quoted.
  assert.match(compileQuery('-mv:abc').warnings[0], /"-mv:abc"/);
});

test('a well-formed numeric term still compiles with no warning', () => {
  const result = compileQuery('cmc>=3 pow:2');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.where.length, 2);
  assert.deepEqual(result.params, [3, 2]);
});

test('an unknown is: or not: value warns rather than vanishing', () => {
  const result = compileQuery('is:cretaure');
  assert.deepEqual(result.where, []);
  assert.match(result.warnings[0], /"is:" does not know "cretaure"/);
  assert.match(compileQuery('not:foo').warnings[0], /"not:" does not know "foo"/);
  assert.deepEqual(compileQuery('is:creature not:land').warnings, []);
});

test('unbalanced parentheses warn once, whatever else the query says', () => {
  const result = compileQuery('t:(');
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Unbalanced parentheses/);
  assert.equal(compileQuery('(t:creature').warnings.length, 1);
  assert.equal(compileQuery('t:creature)').warnings.length, 1);
  assert.equal(compileQuery(')t:creature(').warnings.length, 1, 'a close before its open');
});

test('balanced or quoted parentheses do not warn', () => {
  assert.deepEqual(compileQuery('(t:creature)').warnings, []);
  assert.deepEqual(compileQuery('o:"(this ability"').warnings, []);
  assert.deepEqual(compileQuery('n:"Fire ("').warnings, []);
});

test('the original report: a malformed query explains every failure', () => {
  const result = compileQuery('cmc>>abc t:(');
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /Mana value/);
  assert.match(result.warnings[1], /parentheses/);
});
