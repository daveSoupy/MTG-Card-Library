import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLibrary, shuffle, openingHand, mulligan, bottomCard, drawCard,
  cardsToBottom, summarizeHand,
} from './playtest.ts';
import type { DeckCard } from './api.ts';

let nextId = 1;
function card(overrides: Partial<DeckCard> = {}): DeckCard {
  return {
    id: nextId++, oracleId: `o-${nextId}`, name: `Card ${nextId}`,
    board: 'main', quantity: 1, quantityFromCollection: 0, commanderRole: null,
    cmc: 2, typeLine: 'Creature — Human', manaCost: '{1}{G}', colorIdentity: 'G',
    isBasicLand: false, canBeCommander: false, legality: 'legal',
    category: null, producedMana: [], partnerKind: null,
    ownedQuantity: 0, availableQuantity: 0,
    printingId: null, setCode: null, rarity: 'common', imageSmall: null, priceUsd: null,
    ...overrides,
  };
}

/** Deterministic "random" so shuffles are reproducible in tests. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test('the library holds one entry per physical copy', () => {
  const library = buildLibrary([card({ quantity: 4 }), card({ quantity: 1 })]);
  assert.equal(library.length, 5);
});

test('only the maindeck is drawn from', () => {
  const library = buildLibrary([
    card({ quantity: 10, board: 'main' }),
    card({ quantity: 15, board: 'side' }),
    card({ quantity: 1, board: 'command' }),
    card({ quantity: 5, board: 'maybe' }),
  ]);
  assert.equal(library.length, 10, 'sideboard, commander and maybeboard are not in the library');
});

test('shuffle keeps every card exactly once', () => {
  const items = Array.from({ length: 60 }, (_, i) => i);
  const shuffled = shuffle(items, seeded(7));
  assert.equal(shuffled.length, 60);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), items, 'no card gained or lost');
  assert.notDeepEqual(shuffled, items, 'and the order actually changed');
});

test('shuffle does not mutate its input', () => {
  const items = [1, 2, 3, 4, 5];
  shuffle(items, seeded(3));
  assert.deepEqual(items, [1, 2, 3, 4, 5]);
});

test('an opening hand is seven cards and the rest stay in the library', () => {
  const deck = [card({ quantity: 60 })];
  const state = openingHand(deck, seeded(1));
  assert.equal(state.hand.length, 7);
  assert.equal(state.library.length, 53);
  assert.equal(state.deckSize, 60);
  assert.equal(state.mulligans, 0);
});

test('a deck smaller than seven cards does not throw', () => {
  const state = openingHand([card({ quantity: 3 })], seeded(1));
  assert.equal(state.hand.length, 3);
  assert.equal(state.library.length, 0);
});

test('a London mulligan draws a fresh seven and asks for one more to be bottomed', () => {
  const deck = [card({ quantity: 60 })];
  let state = openingHand(deck, seeded(2));
  assert.equal(cardsToBottom(state), 0);

  state = mulligan(deck, state, seeded(3));
  assert.equal(state.hand.length, 7, 'London always draws seven');
  assert.equal(state.mulligans, 1);
  assert.equal(cardsToBottom(state), 1, 'one card must go to the bottom');

  state = mulligan(deck, state, seeded(4));
  assert.equal(state.mulligans, 2);
  assert.equal(cardsToBottom(state), 2);
});

test('bottoming a card moves it to the end of the library', () => {
  const deck = [card({ quantity: 60 })];
  const state = mulligan(deck, openingHand(deck, seeded(5)), seeded(6));
  const target = state.hand[2];

  const after = bottomCard(state, 2);
  assert.equal(after.hand.length, 6);
  assert.equal(cardsToBottom(after), 0, 'the mulligan requirement is now met');
  assert.equal(after.library.at(-1), target, 'the card went to the bottom');
  assert.equal(after.library.length, state.library.length + 1);
});

test('bottoming an index that does not exist changes nothing', () => {
  const state = openingHand([card({ quantity: 20 })], seeded(8));
  assert.equal(bottomCard(state, 99), state);
});

test('drawing moves the top card into hand, and an empty library is safe', () => {
  let state = openingHand([card({ quantity: 8 })], seeded(9));
  assert.equal(state.library.length, 1);

  state = drawCard(state);
  assert.equal(state.hand.length, 8);
  assert.equal(state.library.length, 0);

  assert.equal(drawCard(state), state, 'drawing from an empty library is a no-op');
});

test('a hand summary separates lands from spells', () => {
  const summary = summarizeHand([
    { oracleId: 'a', name: 'Forest', manaCost: null, cmc: 0, typeLine: 'Basic Land — Forest', printingId: null, imageSmall: null },
    { oracleId: 'b', name: 'Bear', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Bear', printingId: null, imageSmall: null },
    { oracleId: 'c', name: 'Titan', manaCost: '{4}{G}{G}', cmc: 6, typeLine: 'Creature — Giant', printingId: null, imageSmall: null },
  ]);
  assert.equal(summary.lands, 1);
  assert.equal(summary.spells, 2);
  assert.equal(summary.averageManaValue, 4, 'lands are excluded from the average');
});

test('an all-land hand reports no average rather than zero', () => {
  const summary = summarizeHand([
    { oracleId: 'a', name: 'Forest', manaCost: null, cmc: 0, typeLine: 'Land', printingId: null, imageSmall: null },
  ]);
  assert.equal(summary.averageManaValue, null);
});
