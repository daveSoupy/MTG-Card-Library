import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLibrary, shuffle, openingHand, mulligan, bottomCard, drawCard,
  cardsToBottom, summarizeHand, startGame, nextTurn, playLand, castCard, canCast, parseManaCost, summarizeMana,
  type DrawnCard, type GameState } from './playtest.ts';
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
    { oracleId: 'a', name: 'Forest', manaCost: null, cmc: 0, typeLine: 'Basic Land — Forest', printingId: null, imageSmall: null, producedMana: [] },
    { oracleId: 'b', name: 'Bear', manaCost: '{1}{G}', cmc: 2, typeLine: 'Creature — Bear', printingId: null, imageSmall: null, producedMana: [] },
    { oracleId: 'c', name: 'Titan', manaCost: '{4}{G}{G}', cmc: 6, typeLine: 'Creature — Giant', printingId: null, imageSmall: null, producedMana: [] },
  ]);
  assert.equal(summary.lands, 1);
  assert.equal(summary.spells, 2);
  assert.equal(summary.averageManaValue, 4, 'lands are excluded from the average');
});

test('an all-land hand reports no average rather than zero', () => {
  const summary = summarizeHand([
    { oracleId: 'a', name: 'Forest', manaCost: null, cmc: 0, typeLine: 'Land', printingId: null, imageSmall: null, producedMana: [] },
  ]);
  assert.equal(summary.averageManaValue, null);
});

// -- goldfishing ---------------------------------------------------------------

/** A card as it exists in a hand or on a battlefield, distinct from a deck slot. */
const drawn = (over: Partial<DrawnCard> & { name: string }): DrawnCard => ({
  oracleId: over.name, manaCost: null, cmc: 0, typeLine: 'Creature',
  printingId: null, imageSmall: null, producedMana: [], ...over,
});

const forest = () => drawn({ name: 'Forest', typeLine: 'Basic Land — Forest', producedMana: ['G'] });
const island = () => drawn({ name: 'Island', typeLine: 'Basic Land — Island', producedMana: ['U'] });
const breedingPool = () => drawn({ name: 'Breeding Pool', typeLine: 'Land', producedMana: ['G', 'U'] });

function gameWith(battlefield: DrawnCard[], hand: DrawnCard[]): GameState {
  return {
    hand, library: [drawn({ name: 'Top of library' })], mulligans: 0, deckSize: 60,
    turn: 3, battlefield, tapped: [], landPlayedThisTurn: false,
  };
}

test('a mana cost reads into generic and coloured symbols', () => {
  assert.deepEqual(parseManaCost('{1}{G}'), { generic: 1, symbols: [['G']] });
  assert.deepEqual(parseManaCost('{4}{G}{G}'), { generic: 4, symbols: [['G'], ['G']] });
  assert.deepEqual(parseManaCost('{U/R}'), { generic: 0, symbols: [['U', 'R']] });
  assert.deepEqual(parseManaCost('{W/P}'), { generic: 0, symbols: [['W']] }, 'Phyrexian costs its colour');
  assert.deepEqual(parseManaCost('{X}{R}'), { generic: 0, symbols: [['R']] }, 'X is nothing to goldfish');
  assert.deepEqual(parseManaCost('{2}{C}'), { generic: 3, symbols: [] }, 'colourless is generic here');
  assert.deepEqual(parseManaCost(null), { generic: 0, symbols: [] });
});

test('a spell is castable when the lands are there, and not before', () => {
  const bear = drawn({ name: 'Bear', manaCost: '{1}{G}', cmc: 2 });
  assert.equal(canCast(gameWith([forest()], [bear]), 0), false, 'one land is not two mana');
  assert.equal(canCast(gameWith([forest(), forest()], [bear]), 0), true);
  assert.equal(canCast(gameWith([island(), island()], [bear]), 0), false, 'wrong colour');
});

test('two coloured pips need two sources of that colour, not one dual counted twice', () => {
  // The case a greedy matcher gets wrong: the dual pays one pip, and there is
  // nothing left to pay the other.
  const titan = drawn({ name: 'Titan', manaCost: '{G}{G}', cmc: 2 });
  assert.equal(canCast(gameWith([breedingPool(), island()], [titan]), 0), false);
  assert.equal(canCast(gameWith([breedingPool(), forest()], [titan]), 0), true);
});

test('a dual is spent on the pip that needs it', () => {
  // {G}{U} with a Forest and a Breeding Pool: the Forest must take green and
  // the dual must take blue. Assigning the dual to green first fails.
  const spell = drawn({ name: 'Charm', manaCost: '{G}{U}', cmc: 2 });
  assert.equal(canCast(gameWith([forest(), breedingPool()], [spell]), 0), true);
});

test('hybrid can be paid by either half', () => {
  const spell = drawn({ name: 'Hybrid', manaCost: '{U/R}', cmc: 1 });
  assert.equal(canCast(gameWith([island()], [spell]), 0), true);
  assert.equal(canCast(gameWith([forest()], [spell]), 0), false);
});

test('generic mana is paid by whatever is left over', () => {
  const spell = drawn({ name: 'Big', manaCost: '{3}{G}', cmc: 4 });
  assert.equal(canCast(gameWith([forest(), island(), island()], [spell]), 0), false, 'three sources, four mana');
  assert.equal(canCast(gameWith([forest(), island(), island(), island()], [spell]), 0), true);
});

test('mana rocks count as sources, not just lands', () => {
  const solRing = drawn({ name: 'Sol Ring', typeLine: 'Artifact', producedMana: ['C'] });
  const spell = drawn({ name: 'Thing', manaCost: '{2}', cmc: 2 });
  assert.equal(canCast(gameWith([solRing, forest()], [spell]), 0), true);
});

test('casting taps what it used, so the mana cannot be spent twice', () => {
  const bear = drawn({ name: 'Bear', manaCost: '{1}{G}', cmc: 2 });
  const other = drawn({ name: 'Other', manaCost: '{G}', cmc: 1 });
  let state = gameWith([forest(), forest()], [bear, other]);

  state = castCard(state, 0);
  assert.equal(state.battlefield.length, 3, 'the bear resolved');
  assert.equal(state.tapped.length, 2, 'both lands are spent');
  assert.equal(canCast(state, 0), false, 'nothing left for the second spell');
});

test('one land per turn, and the next turn untaps and draws', () => {
  let state = gameWith([], [forest(), forest()]);
  state = playLand(state, 0);
  assert.equal(state.battlefield.length, 1);
  state = playLand(state, 0);
  assert.equal(state.battlefield.length, 1, 'the second land drop is refused');

  const handBefore = state.hand.length;
  state = { ...state, tapped: [0] };
  state = nextTurn(state);
  assert.equal(state.turn, 4);
  assert.deepEqual(state.tapped, [], 'untapped');
  assert.equal(state.landPlayedThisTurn, false);
  assert.equal(state.hand.length, handBefore + 1, 'drew for turn');
});

test('a land cannot be cast and a spell cannot be played as a land', () => {
  const state = gameWith([forest(), forest()], [forest(), drawn({ name: 'Bear', manaCost: '{1}{G}' })]);
  assert.equal(castCard(state, 0), state, 'lands are played, not cast');
  assert.equal(playLand(state, 1), state, 'a bear is not a land');
});

test('the mana summary reports what is left and in which colours', () => {
  let state = gameWith([forest(), island(), breedingPool()], [drawn({ name: 'Bear', manaCost: '{G}' })]);
  assert.deepEqual(summarizeMana(state), { total: 3, available: 3, colors: ['G', 'U'] });
  state = castCard(state, 0);
  assert.equal(summarizeMana(state).available, 2, 'one source is spent');
});
