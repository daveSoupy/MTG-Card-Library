import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuildabilityRow, DeckCard } from './api.ts';
import { slotAction } from './deckSlot.ts';

/**
 * The chip used to read `1 owned` for a card owned none of, because it printed
 * the deck's *claim* under the word "owned". These are the things it says now,
 * all of them about cards rather than about bookkeeping.
 */

const card = (over: Partial<DeckCard> = {}): DeckCard => ({
  id: 1, oracleId: 'o-1', name: 'Sol Ring', board: 'main', quantity: 1,
  quantityFromCollection: 0, quantityProxied: 0, commanderRole: null, categories: [],
  cmc: 1, typeLine: 'Artifact', manaCost: '{1}', colorIdentity: '',
  isBasicLand: false, canBeCommander: false, category: null, producedMana: [],
  partnerKind: null, legality: null, ownedQuantity: 0, availableQuantity: 0,
  tradeListedQuantity: 0, allocationTracked: true, printingId: null, setCode: null,
  rarity: null, imageSmall: null, priceUsd: null,
  ...over,
});

const row = (over: Partial<BuildabilityRow> = {}): BuildabilityRow => ({
  oracleId: 'o-1', name: 'Sol Ring', required: 1, owned: 0, available: 0,
  tradeListed: 0, proxied: 0, covered: 0, missing: 1,
  unitPriceUsd: 2, extendedUsd: 2, contested: false, holdingDecks: [],
  ...over,
});

test('nothing is shown until the deck figures arrive', () => {
  // Briefly blank beats briefly wrong.
  assert.equal(slotAction(card()), null);
  assert.equal(slotAction(card(), null), null);
});

test('an exempt basic land says only that it is one', () => {
  const action = slotAction(card({ allocationTracked: false, quantity: 38 }))!;
  assert.equal(action.label, 'basic');
  assert.equal(action.kind, 'untracked');
  // No coverage needed: a basic is outside allocation, so it is never waiting
  // on figures.
});

test('a card you do not own says how many to buy', () => {
  const action = slotAction(card({ quantity: 3 }), row({ required: 3, missing: 3 }))!;
  assert.equal(action.label, 'Buy 3');
  assert.equal(action.kind, 'buy');
  assert.match(action.title, /You do not own this one/);
});

test('a partly covered slot counts only the shortfall', () => {
  const action = slotAction(
    card({ quantity: 4 }),
    row({ required: 4, owned: 1, available: 1, covered: 1, missing: 3 }),
  )!;
  assert.equal(action.label, 'Buy 3 of 4');
  assert.match(action.title, /You own 1 copy/);
});

test('a covered slot says so instead of showing a number to decode', () => {
  const single = slotAction(
    card(), row({ required: 1, owned: 1, available: 1, covered: 1, missing: 0 }),
  )!;
  assert.equal(single.label, 'Have it');
  assert.equal(single.kind, 'have');

  const many = slotAction(
    card({ quantity: 4 }),
    row({ required: 4, owned: 4, available: 4, covered: 4, missing: 0 }),
  )!;
  assert.equal(many.label, 'Have all 4');
});

test('a card another deck is holding names that deck, not a price', () => {
  // The one case that is a decision rather than a purchase: the cardboard
  // exists, it is just spoken for.
  const action = slotAction(card(), row({
    owned: 1, available: 0, covered: 0, missing: 1,
    holdingDecks: [{ deckId: 2, deckName: 'Atraxa', status: 'assembled', quantity: 1 }],
  }))!;
  assert.equal(action.label, 'Atraxa has 1');
  assert.equal(action.kind, 'held');
  assert.match(action.title, /Take it back, or buy 1/);
});

test('several holders are all named in the tooltip', () => {
  const action = slotAction(card({ quantity: 3 }), row({
    required: 3, owned: 2, available: 0, covered: 0, missing: 3,
    holdingDecks: [
      { deckId: 2, deckName: 'Atraxa', status: 'assembled', quantity: 2 },
      { deckId: 3, deckName: 'Rakdos', status: 'building', quantity: 1 },
    ],
  }))!;
  assert.equal(action.label, 'Atraxa has 2', 'the biggest holder leads');
  assert.match(action.title, /Atraxa has 2, Rakdos has 1/);
});

test('a copy promised on a trade list is named rather than silently missing', () => {
  const action = slotAction(card(), row({
    owned: 1, available: 0, tradeListed: 1, covered: 0, missing: 1,
  }))!;
  assert.equal(action.label, 'Buy 1');
  assert.match(action.title, /1 promised on a trade list/,
    'otherwise "buy one" on a card in your binder looks like a bug');
});

test('a fully proxied slot needs nothing bought', () => {
  const action = slotAction(
    card({ quantity: 2 }),
    row({ required: 2, owned: 0, available: 0, proxied: 2, covered: 2, missing: 0 }),
  )!;
  assert.equal(action.kind, 'have');
  assert.match(action.title, /Proxied/);
});

test('the claim is never mentioned, whatever it happens to be', () => {
  // The deck's claim on the collection is derived server-side now. A slot that
  // still carries a stale one must not surface it as ownership.
  const action = slotAction(
    card({ quantityFromCollection: 1, ownedQuantity: 0 }),
    row({ owned: 0, missing: 1 }),
  )!;
  assert.equal(action.label, 'Buy 1');
  assert.doesNotMatch(action.label, /owned/);
  assert.doesNotMatch(action.title, /claim/);
});
