import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceDensity, densityAllowed, DENSITIES_FOR, effectiveDensity, loadDensity, nextDensity,
  savePageDensity, saveGlobalDensity, type Density,
} from './density.ts';

/** A localStorage good enough for the storage rules, which is all this tests. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

beforeEach(() => { globalThis.localStorage = fakeStorage(); });

test('Lined-up is the deck builder\'s alone', () => {
  assert.ok(densityAllowed('lined', 'deck'));
  assert.ok(!densityAllowed('lined', 'browse'));
  assert.ok(!densityAllowed('lined', 'collection'));
  // The other three are everywhere.
  for (const level of ['full', 'compact', 'ultra'] as Density[]) {
    for (const page of ['browse', 'collection', 'deck'] as const) {
      assert.ok(densityAllowed(level, page), `${level} on ${page}`);
    }
  }
});

test('a page falls back to Full rather than rendering a cascade it cannot show', () => {
  assert.equal(coerceDensity('lined', 'browse'), 'full');
  assert.equal(coerceDensity('lined', 'deck'), 'lined');
  assert.equal(effectiveDensity({ global: 'lined', overrides: {} }, 'browse'), 'full');
  assert.equal(effectiveDensity({ global: 'lined', overrides: {} }, 'deck'), 'lined');
});

test('a page override wins over the global default, one page at a time', () => {
  const prefs = { global: 'full' as Density, overrides: { collection: 'ultra' as Density } };
  assert.equal(effectiveDensity(prefs, 'collection'), 'ultra');
  assert.equal(effectiveDensity(prefs, 'deck'), 'full');
  assert.equal(effectiveDensity(prefs, 'browse'), 'full');
  // Views with no card grid report the global default and nothing else.
  assert.equal(effectiveDensity(prefs, null), 'full');
});

test('the global default and every page override survive a reload', () => {
  saveGlobalDensity('compact');
  savePageDensity('collection', 'ultra');
  savePageDensity('deck', 'lined');

  const prefs = loadDensity();
  assert.equal(prefs.global, 'compact');
  assert.equal(effectiveDensity(prefs, 'collection'), 'ultra');
  assert.equal(effectiveDensity(prefs, 'deck'), 'lined');
  // Browse never had one of its own, so it follows the default.
  assert.equal(effectiveDensity(prefs, 'browse'), 'compact');
});

test('clearing an override puts the page back on the global default', () => {
  saveGlobalDensity('full');
  savePageDensity('browse', 'ultra');
  assert.equal(effectiveDensity(loadDensity(), 'browse'), 'ultra');

  savePageDensity('browse', null);
  assert.equal(effectiveDensity(loadDensity(), 'browse'), 'full');
});

test('a stored level a page cannot show is ignored on load', () => {
  // Only reachable by hand-editing storage, but it must not put Browse into a
  // cascade layout nothing there renders.
  localStorage.setItem('mtg.density.browse', 'lined');
  assert.equal(loadDensity().overrides.browse, undefined);
  localStorage.setItem('mtg.density', 'nonsense');
  assert.equal(loadDensity().global, 'full');
});

test('nothing here throws when storage does', () => {
  const throwing = {
    getItem: () => { throw new Error('private mode'); },
    setItem: () => { throw new Error('private mode'); },
    removeItem: () => { throw new Error('private mode'); },
  } as unknown as Storage;
  globalThis.localStorage = throwing;

  assert.deepEqual(loadDensity(), { global: 'full', overrides: {} });
  saveGlobalDensity('ultra');
  savePageDensity('deck', 'lined');
  savePageDensity('deck', null);
});

test('the topbar cycle only offers what the page being looked at can show', () => {
  // Four levels on the deck builder, three everywhere else.
  let level: Density = 'full';
  const seen: Density[] = [];
  for (let i = 0; i < 4; i += 1) { level = nextDensity(level, 'deck'); seen.push(level); }
  assert.deepEqual(seen, ['lined', 'compact', 'ultra', 'full']);

  level = 'full';
  const browseSeen: Density[] = [];
  for (let i = 0; i < 3; i += 1) { level = nextDensity(level, 'browse'); browseSeen.push(level); }
  assert.deepEqual(browseSeen, ['compact', 'ultra', 'full']);
  assert.equal(DENSITIES_FOR.browse.length, 3);
  assert.equal(DENSITIES_FOR.deck.length, 4);
});

test('a level the page cannot reach still cycles somewhere it can', () => {
  // Lined-up carried over from the deck builder as the global default: the
  // cycle must not be stuck on a value that is not in Browse's list.
  assert.equal(nextDensity('lined', 'browse'), 'full');
});
