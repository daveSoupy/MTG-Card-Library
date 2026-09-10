import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeOf, withScope } from './searchScope.ts';

test('a chip adds its term and leaves the rest of the query alone', () => {
  assert.equal(withScope('c:ur t:instant cmc<=2', 'available'),
    'available>=1 c:ur t:instant cmc<=2');
  assert.equal(withScope('', 'owned'), 'owned>=1');
});

test('switching chips swaps the term rather than stacking them', () => {
  const owned = withScope('t:creature', 'owned');
  assert.equal(withScope(owned, 'available'), 'available>=1 t:creature');
  assert.equal(withScope(owned, 'all'), 't:creature');
});

test('the chip row reads the query back, and available wins over owned', () => {
  assert.equal(scopeOf('t:creature'), 'all');
  assert.equal(scopeOf('owned>=1 t:creature'), 'owned');
  assert.equal(scopeOf('owned t:creature'), 'owned');
  assert.equal(scopeOf('available>=1'), 'available');
  assert.equal(scopeOf('owned>=1 available>=1'), 'available');
});

test('a hand-typed count is not a chip and is never rewritten', () => {
  // The chips own exactly `owned` / `owned>=1`. `owned>=2` is the user being
  // more specific than a chip can be; clobbering it would lose their query.
  assert.equal(scopeOf('owned>=2'), 'all');
  assert.equal(withScope('owned>=2', 'all'), 'owned>=2');
  assert.equal(withScope('owned>=2 c:r', 'available'), 'available>=1 owned>=2 c:r');
});

test('a chip only ever adds a term, so it can only narrow', () => {
  for (const query of ['', 'bolt', 'c:ur t:instant', 'loc:"Blue Tackle Box"']) {
    for (const scope of ['owned', 'available'] as const) {
      const next = withScope(query, scope);
      // Everything that was in the query is still in it.
      for (const token of query.split(/\s+/).filter(Boolean)) {
        assert.ok(next.includes(token), `${scope} on "${query}" dropped ${token}`);
      }
    }
  }
});

test('turning a chip off is a clean round trip', () => {
  const original = 'c:ur t:instant cmc<=2';
  assert.equal(withScope(withScope(original, 'owned'), 'all'), original);
});
