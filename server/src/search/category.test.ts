import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileQuery } from './query.ts';

/**
 * The `category:` / `cat:` search term, over Phase 7's functional tags.
 *
 * Before this, the only way to filter by category was the structured
 * `?category=` parameter, which nothing but the Template panel's shortfall
 * link ever set — so what the app could do internally was not expressible in
 * the search box.
 */

const sqlFor = (query: string) => compileQuery(query).where.join(' AND ');

test('category: compiles to a card_categories lookup', () => {
  const compiled = compileQuery('category:removal');
  assert.match(compiled.where.join(' '), /card_categories/);
  assert.ok(compiled.params.includes('removal'));
});

test('cat: is the short form, and both ignore case', () => {
  assert.equal(sqlFor('cat:removal'), sqlFor('category:removal'));
  assert.ok(compileQuery('cat:REMOVAL').params.includes('removal'));
});

test('every category the templates count is searchable', () => {
  for (const category of
    ['removal', 'draw', 'ramp', 'recursion', 'protection', 'tutor', 'sweeper', 'counterspell']) {
    assert.match(sqlFor(`cat:${category}`), /card_categories/, category);
  }
});

test('an unknown category matches nothing rather than everything', () => {
  // Same as set:zzz. Dropping the term would return the whole library and
  // read as though the filter had been applied — the worse of the two wrongs.
  const compiled = compileQuery('cat:nonsense');
  assert.match(compiled.where.join(' '), /card_categories/);
  assert.ok(compiled.params.includes('nonsense'));
});

test('it combines with the rest of the syntax rather than replacing it', () => {
  const where = compileQuery('cat:ramp t:creature').where.join(' AND ');
  assert.match(where, /card_categories/);
  assert.match(where, /type_line/i);
});
