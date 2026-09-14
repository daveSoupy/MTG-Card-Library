import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROUTE, formatRoute, parseRoute, type Route } from './router.ts';

test('every route round-trips through the URL', () => {
  const routes: Route[] = [
    { name: 'collection' },
    { name: 'collection', tab: 'wants' },
    { name: 'collection', tab: 'tradelists' },
    { name: 'decks' },
    { name: 'deck', id: 12 },
    { name: 'browse' },
    { name: 'browse', q: 't:creature c:rg cmc<=3' },
    { name: 'trades' },
    { name: 'trades', id: 7 },
    { name: 'games' },
    { name: 'data' },
  ];
  for (const route of routes) {
    const url = new URL(formatRoute(route), 'http://x');
    assert.deepEqual(parseRoute(url.pathname, url.search), route, formatRoute(route));
  }
});

test('the paths read the way the spec lists them', () => {
  assert.equal(formatRoute({ name: 'collection' }), '/collection');
  assert.equal(formatRoute({ name: 'collection', tab: 'wants' }), '/collection/wants');
  assert.equal(formatRoute({ name: 'decks' }), '/decks');
  assert.equal(formatRoute({ name: 'deck', id: 12 }), '/decks/12');
  assert.equal(formatRoute({ name: 'browse' }), '/browse');
  assert.equal(formatRoute({ name: 'browse', q: 'bolt' }), '/browse?q=bolt');
  assert.equal(formatRoute({ name: 'trades' }), '/trades');
  assert.equal(formatRoute({ name: 'trades', id: 7 }), '/trades/7');
  assert.equal(formatRoute({ name: 'games' }), '/games');
  assert.equal(formatRoute({ name: 'data' }), '/data');
});

test('a browse query is escaped on the way out and unescaped on the way in', () => {
  const q = 'o:"draw a card" cmc<=2 & c:u';
  const url = formatRoute({ name: 'browse', q });
  assert.ok(!url.includes('"'), url);
  assert.ok(!url.includes(' '), url);
  const parsed = new URL(url, 'http://x');
  assert.deepEqual(parseRoute(parsed.pathname, parsed.search), { name: 'browse', q });
});

test('an empty query is the same route as no query', () => {
  assert.equal(formatRoute({ name: 'browse', q: '' }), '/browse');
  assert.deepEqual(parseRoute('/browse', '?q='), { name: 'browse' });
  assert.deepEqual(parseRoute('/browse', ''), { name: 'browse' });
});

test('the root and anything unrecognised land on Collection', () => {
  assert.deepEqual(parseRoute('/'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute(''), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/nope'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/collection/nope'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/decks/12/extra'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/browse/extra'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/games/1'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/data/1'), DEFAULT_ROUTE);
});

test('an id has to be a positive integer to be a link', () => {
  assert.deepEqual(parseRoute('/decks/abc'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/decks/0'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/decks/-3'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/decks/1.5'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/trades/99999999999999999999'), DEFAULT_ROUTE);
  assert.deepEqual(parseRoute('/decks/007'), { name: 'deck', id: 7 });
});

test('trailing slashes and doubled slashes are tolerated', () => {
  assert.deepEqual(parseRoute('/decks/'), { name: 'decks' });
  assert.deepEqual(parseRoute('/decks//12'), { name: 'deck', id: 12 });
  assert.deepEqual(parseRoute('/collection/wants/'), { name: 'collection', tab: 'wants' });
});

test('a search string on a route that has no query is ignored', () => {
  assert.deepEqual(parseRoute('/decks', '?q=bolt'), { name: 'decks' });
  assert.deepEqual(parseRoute('/decks/3', '?utm=whatever'), { name: 'deck', id: 3 });
});
