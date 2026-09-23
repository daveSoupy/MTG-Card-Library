import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceDensity, densityAllowed, DENSITIES_FOR, effectiveDensity, loadDensity, nextDensity,
  savePageDensity, saveGlobalDensity, type Density, type DensityPage,
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

  assert.deepEqual(loadDensity(), { global: 'full', globalChosen: false, overrides: {} });
  saveGlobalDensity('ultra');
  savePageDensity('deck', 'lined');
  savePageDensity('deck', null);
});

test('the topbar cycle only offers what the page being looked at can show', () => {
  // Against DENSITIES_FOR rather than a written-out order: which order the
  // levels sit in is a presentation choice that gets rearranged, and pinning
  // it here would fail the next time it is.
  for (const page of ['browse', 'collection', 'deck'] as DensityPage[]) {
    const options = DENSITIES_FOR[page];
    let level = options[0];
    const lap: Density[] = [];
    for (let i = 0; i < options.length; i += 1) {
      level = nextDensity(level, page);
      lap.push(level);
    }
    // One lap visits every level that page offers, exactly once, in the order
    // they are listed, and lands back where it started.
    assert.deepEqual(lap, [...options.slice(1), options[0]], `${page} cycles its own levels`);
    assert.equal(new Set(lap).size, options.length, `${page} repeats a level`);
  }
  // Four levels on the deck builder, three everywhere else.
  assert.equal(DENSITIES_FOR.browse.length, 3);
  assert.equal(DENSITIES_FOR.deck.length, 4);
});

test('a level the page cannot reach still cycles somewhere it can', () => {
  // Lined-up carried over from the deck builder as the global default: the
  // cycle must not be stuck on a value that is not in Browse's list.
  const next = nextDensity('lined', 'browse');
  assert.ok(densityAllowed(next, 'browse'), `${next} is not one of Browse's levels`);
});

test('a phone starts the deck builder at Compact until a density is chosen', () => {
  const fresh = { global: 'full' as Density, globalChosen: false, overrides: {} };
  assert.equal(effectiveDensity(fresh, 'deck', true), 'compact');
  assert.equal(effectiveDensity(fresh, 'deck', false), 'full', 'a desktop is unchanged');
  assert.equal(effectiveDensity(fresh, 'browse', true), 'full', 'only the deck builder has a phone default');

  // The topbar's choice, or the page's own, wins over the phone default.
  assert.equal(effectiveDensity({ ...fresh, globalChosen: true }, 'deck', true), 'full');
  assert.equal(effectiveDensity({ ...fresh, overrides: { deck: 'ultra' as Density } }, 'deck', true), 'ultra');
});
