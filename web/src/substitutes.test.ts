import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Board, Deck, DeckCard, SubstituteCandidate, SubstitutesResult } from './api.ts';
import {
  availableBadge, emptyNotice, hasSwappableSlot, reasonLine, sourceNotice, swapPlan,
} from './substitutes.ts';
import { canSwap, slotAction } from './deckSlot.ts';

/**
 * Accepting a substitute is two ordinary edits, and the arithmetic of which
 * slot moves by how much is the only thing the client adds. These pin it.
 */

const slot = (id: number, oracleId: string, quantity: number, board: Board = 'main'): DeckCard =>
  ({ id, oracleId, quantity, board, name: oracleId } as DeckCard);

const deck = (...cards: DeckCard[]): Deck => ({ id: 1, cards } as unknown as Deck);

test('a 4-of you own 3 of comes down to 3, and one copy of the substitute goes in', () => {
  const plan = swapPlan(deck(slot(10, 'doom', 4)), 'doom', 1);
  assert.deepEqual(plan.steps, [{ cardId: 10, board: 'main', from: 4, to: 3 }]);
  assert.deepEqual(plan.add, { board: 'main', quantity: 1 });
});

test('a slot entirely missing is removed, not reduced to zero', () => {
  const plan = swapPlan(deck(slot(10, 'doom', 1)), 'doom', 1);
  assert.deepEqual(plan.steps, [{ cardId: 10, board: 'main', from: 1, to: 0 }]);
  assert.deepEqual(plan.add, { board: 'main', quantity: 1 });
});

test('missing spread over two boards takes from the board asked about first', () => {
  const d = deck(slot(10, 'doom', 2, 'main'), slot(11, 'doom', 2, 'side'));
  const plan = swapPlan(d, 'doom', 3, 'side');
  assert.deepEqual(plan.steps, [
    { cardId: 11, board: 'side', from: 2, to: 0 },
    { cardId: 10, board: 'main', from: 2, to: 1 },
  ]);
  assert.deepEqual(plan.add, { board: 'side', quantity: 3 });
});

test('the maybeboard is never touched', () => {
  const d = deck(slot(10, 'doom', 1, 'main'), slot(11, 'doom', 3, 'maybe'));
  const plan = swapPlan(d, 'doom', 4);
  assert.deepEqual(plan.steps, [{ cardId: 10, board: 'main', from: 1, to: 0 }]);
  assert.equal(plan.add.quantity, 1);
});

test('the command zone is never touched either — a commander is the deck', () => {
  const d = deck(slot(10, 'osgir', 1, 'command'), slot(11, 'osgir', 1, 'main'));
  const plan = swapPlan(d, 'osgir', 2);
  assert.deepEqual(plan.steps, [{ cardId: 11, board: 'main', from: 1, to: 0 }]);
  assert.equal(hasSwappableSlot(d, 'osgir'), true);
  assert.equal(hasSwappableSlot(deck(slot(10, 'osgir', 1, 'command')), 'osgir'), false);
  assert.equal(hasSwappableSlot(deck(slot(10, 'x', 1, 'maybe')), 'x'), false);
});

test('with no figures, the whole card is swapped', () => {
  for (const missing of [undefined, null, 0]) {
    const plan = swapPlan(deck(slot(10, 'doom', 3)), 'doom', missing);
    assert.deepEqual(plan.steps, [{ cardId: 10, board: 'main', from: 3, to: 0 }]);
    assert.equal(plan.add.quantity, 3);
  }
});

test('missing can never exceed what is in the deck', () => {
  const plan = swapPlan(deck(slot(10, 'doom', 2)), 'doom', 9);
  assert.deepEqual(plan.steps, [{ cardId: 10, board: 'main', from: 2, to: 0 }]);
  assert.equal(plan.add.quantity, 2);
});

test('a want whose deck no longer lists the card adds one copy to the main deck', () => {
  const plan = swapPlan(deck(slot(10, 'other', 1)), 'doom', 1);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.add, { board: 'main', quantity: 1 });
});

// -- copy ----------------------------------------------------------------------------

const result = (over: Partial<SubstitutesResult> = {}): SubstitutesResult => ({
  target: { oracleId: 'doom', name: 'Doom Blade', cmc: 2, typeLine: 'Instant', primaryType: 'Instant', categories: [] },
  context: { deckId: 1, deckName: 'Dimir', formatCode: 'modern', colorIdentity: 'UB' },
  categorySource: null,
  candidates: [],
  poolSize: 0,
  ...over,
});

test('the source notice is silent for tagger data and says so otherwise', () => {
  assert.equal(sourceNotice(result({ categorySource: 'tagger' })), null);
  assert.match(sourceNotice(result({ categorySource: 'heuristic' }))!, /guessed from rules text/);
  assert.equal(sourceNotice(result({ categorySource: null })), 'Matching on type and cost only.');
});

test('the empty state says why', () => {
  assert.equal(emptyNotice(result()), 'You own nothing free that fits Dimir.');
  assert.equal(
    emptyNotice(result({ context: { deckId: null, deckName: null, formatCode: null, colorIdentity: null } })),
    'You own nothing free that could stand in.',
  );
  const removal = result({
    poolSize: 12,
    target: {
      oracleId: 'doom', name: 'Doom Blade', cmc: 2, typeLine: 'Instant', primaryType: 'Instant',
      categories: [{ category: 'removal', label: 'Removal', source: 'tagger' }],
    },
  });
  assert.equal(emptyNotice(removal), 'Nothing you own fills this role (removal).');
  assert.equal(emptyNotice(result({ poolSize: 12 })), 'Nothing you own is another instant like this.');
});

test('the reason line is the server\'s phrases joined, and the badge counts free copies', () => {
  const candidate = {
    reasons: ['Removal', 'Instant', 'CMC 3', '2 available in Binder 3'], available: 2,
  } as SubstituteCandidate;
  assert.equal(reasonLine(candidate), 'Removal · Instant · CMC 3 · 2 available in Binder 3');
  assert.equal(availableBadge(candidate), '2 free');
});

// -- the chip ----------------------------------------------------------------------

test('only a Buy or held chip opens the sheet', () => {
  const card = { allocationTracked: true, quantity: 1 } as DeckCard;
  const row = (over: object) => ({
    required: 1, owned: 0, available: 0, tradeListed: 0, proxied: 0, covered: 0, missing: 1,
    holdingDecks: [], ...over,
  }) as any;
  assert.equal(canSwap(slotAction(card, row({}))), true, 'buy');
  assert.equal(canSwap(slotAction(card, row({ owned: 1, holdingDecks: [{ deckName: 'A', quantity: 1 }] }))), true, 'held');
  assert.equal(canSwap(slotAction(card, row({ covered: 1, missing: 0, owned: 1 }))), false, 'have');
  assert.equal(canSwap(slotAction({ allocationTracked: false } as DeckCard)), false, 'basic');
  assert.equal(canSwap(null), false, 'still loading');
});
