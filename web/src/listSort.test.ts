import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameMatches, sortListings, sortWants } from './listSort.ts';

const want = (name: string, priority: number, priceUsd: number, addedAt: string) =>
  ({ name, priority, priceUsd, addedAt });

// The server's order is the list's own (drag) order.
const WANTS = [
  want('Mana Crypt', 1, 180, '2026-01-02T00:00:00Z'),
  want('Arcane Signet', 3, 0.5, '2026-03-01T00:00:00Z'),
  want('Unpriced Oddity', 3, 0, '2026-02-01T00:00:00Z'),
  want('Æther Vial', 0, 12, '2026-01-01T00:00:00Z'),
  want('Brainstorm', 1, 12, '2026-04-01T00:00:00Z'),
];
const names = (items: Array<{ name: string }>) => items.map((i) => i.name);

test('wants: your order is the server order, untouched', () => {
  const out = sortWants(WANTS, 'manual');
  assert.deepEqual(names(out), names(WANTS));
  assert.notEqual(out, WANTS, 'a copy, so sorting never mutates the list state');
});

test('wants: priority puts High first and keeps your order within a priority', () => {
  assert.deepEqual(names(sortWants(WANTS, 'priority')),
    ['Arcane Signet', 'Unpriced Oddity', 'Mana Crypt', 'Brainstorm', 'Æther Vial']);
});

test('wants: price is dearest first, ties by name, and an unpriced want goes last', () => {
  assert.deepEqual(names(sortWants(WANTS, 'price')),
    ['Mana Crypt', 'Æther Vial', 'Brainstorm', 'Arcane Signet', 'Unpriced Oddity']);
});

test('wants: name ignores case and accents; recent is newest first', () => {
  assert.deepEqual(names(sortWants(WANTS, 'name')),
    ['Æther Vial', 'Arcane Signet', 'Brainstorm', 'Mana Crypt', 'Unpriced Oddity']);
  assert.deepEqual(names(sortWants(WANTS, 'recent')),
    ['Brainstorm', 'Arcane Signet', 'Unpriced Oddity', 'Mana Crypt', 'Æther Vial']);
});

test('trade lists: ask and market put the dearest first and the missing figure last', () => {
  const rows = [
    { name: 'Bolt', askingPriceUsd: null, marketUsd: 2 },
    { name: 'Goyf', askingPriceUsd: 25, marketUsd: 30 },
    { name: 'Opt', askingPriceUsd: 0.25, marketUsd: null },
    { name: 'Ancestral', askingPriceUsd: 1234.5, marketUsd: 1500 },
  ];
  assert.deepEqual(names(sortListings(rows, 'ask')), ['Ancestral', 'Goyf', 'Opt', 'Bolt']);
  assert.deepEqual(names(sortListings(rows, 'market')), ['Ancestral', 'Goyf', 'Bolt', 'Opt']);
  assert.deepEqual(names(sortListings(rows, 'name')), ['Ancestral', 'Bolt', 'Goyf', 'Opt']);
  assert.deepEqual(names(sortListings(rows, 'manual')), names(rows));
});

test('search matches a substring, whatever the case or accents', () => {
  assert.equal(nameMatches('Æther Vial', 'vial'), true);
  assert.equal(nameMatches('Lim-Dûl the Necromancer', 'lim-dul'), true);
  assert.equal(nameMatches('Brainstorm', '  '), true, 'an empty query matches everything');
  assert.equal(nameMatches('Brainstorm', 'bolt'), false);
});
