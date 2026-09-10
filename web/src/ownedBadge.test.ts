import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckBadge, ownedBadge } from './ownedBadge.ts';
import type { CardSummary } from './api.ts';

const card = (fields: Partial<CardSummary>): CardSummary => ({
  oracleId: 'o1', name: 'Sol Ring', manaCost: '{1}', cmc: 1, typeLine: 'Artifact',
  power: null, toughness: null, loyalty: null, colors: '', colorIdentity: '',
  rarity: 'uncommon', setCode: 'tst', setName: 'Test', collectorNumber: '1',
  imageSmall: null, imageNormal: null, priceUsd: 1, priceUsdFoil: null,
  printingId: 'p1', ownedQuantity: 0, printingCount: 1, ...fields,
});

test('a card you do not own gets no badge', () => {
  assert.equal(ownedBadge(card({ ownedQuantity: 0 })), null);
});

test('all copies free reads as one number', () => {
  const badge = ownedBadge(card({ ownedQuantity: 4, availableQuantity: 4 }));
  assert.equal(badge?.text, '4');
  assert.match(badge!.title, /all free/);
});

test('a claimed copy splits the badge and says who has it', () => {
  const badge = ownedBadge(card({
    ownedQuantity: 4, availableQuantity: 1, reservedQuantity: 2, tradeListedQuantity: 1,
  }));
  assert.equal(badge?.text, '1/4');
  assert.match(badge!.title, /2 in decks/);
  assert.match(badge!.title, /1 on a trade list/);
});

test('a card outside allocation gets no badge rather than a wrong one', () => {
  // 38 Islands are not 38 anything — a basic land while the exemption is on has
  // no reservation and no shortfall, so there is no honest number to show.
  assert.equal(ownedBadge(card({ ownedQuantity: 38, allocationTracked: false })), null);
});

test('an older row with no allocation fields still shows what it owns', () => {
  const badge = ownedBadge(card({ ownedQuantity: 2 }));
  assert.equal(badge?.text, '2');
});

test('the deck badge names the decks', () => {
  const badge = deckBadge(card({ deckCount: 2, deckNames: ['Atraxa', 'Rakdos, Lord of Riots'] }));
  assert.equal(badge?.text, '2');
  assert.equal(badge?.title, 'In Atraxa, Rakdos, Lord of Riots');
  assert.equal(deckBadge(card({ deckCount: 0 })), null);
});
