import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardHolders, ContestedCard, DeckBuildability, WhatIfResult } from './api.ts';
import {
  cardsInScope, contestedFigures, contestedReason, figuresLine, holdersLine, whatIfSentence,
} from './contention.ts';

/**
 * Phase 26's wording. Every figure arrives computed; what is tested is that
 * the sentences say what the numbers say and nothing more — in particular
 * that a claim is never dressed up as a physical location.
 */

const figures = (over: Partial<DeckBuildability> = {}): DeckBuildability => ({
  deckId: 1, buildablePct: 0.96, requiredCards: 50, coveredCards: 48, missingCards: 2,
  costToCompleteUsd: 8, unpricedCount: 0, contestedCount: 1, exemptBasicCards: 0, ...over,
});

const holders = (over: Partial<CardHolders> = {}): CardHolders => ({
  oracleId: 'o1', name: 'Sol Ring', tracked: true, owned: 4, reserved: 2, tradeListed: 0, available: 2,
  decks: [{ deckId: 1, deckName: 'Deck A', status: 'assembled', quantity: 2, reserving: true, homeLocationName: 'Blue Tackle Box' }],
  locations: [{ locationId: 3, name: 'Binder 3', quantity: 2 }, { locationId: 5, name: 'Blue Tackle Box', quantity: 2 }],
  ...over,
});

const contested = (over: Partial<ContestedCard> = {}): ContestedCard => ({
  oracleId: 'o1', name: 'Sol Ring', owned: 1, tradeListed: 0, wanted: 2, held: 1, shortfall: 1,
  unitPriceUsd: 2, overAllocated: false,
  holders: [{ deckId: 1, deckName: 'Atraxa', status: 'assembled', quantity: 1 }],
  shortDecks: [{ deckId: 2, deckName: 'Krenko', status: 'building', required: 1, covered: 0, missing: 1 }],
  ...over,
});

test('the held-by line reads as CLAUDE.md wrote it', () => {
  const line = holdersLine(holders())!;
  assert.deepEqual(line.decks, ['Deck A ×2 (home: Blue Tackle Box)']);
  assert.deepEqual(line.locations, ['Binder 3 ×2', 'Blue Tackle Box ×2']);
  assert.deepEqual(line.figures, ['2 available']);
});

test('a non-reserving deck’s claim is labelled, not listed as holding', () => {
  const line = holdersLine(holders({
    decks: [{ deckId: 9, deckName: 'Idea', status: 'brew', quantity: 1, reserving: false, homeLocationName: null }],
  }))!;
  assert.deepEqual(line.decks, ['Idea ×1, brew']);
});

test('the held-by line says nothing about a card you neither own nor list', () => {
  assert.equal(holdersLine(holders({ owned: 0, decks: [], locations: [] })), null);
});

test('an exempt basic says so instead of an availability figure', () => {
  const line = holdersLine(holders({ tracked: false, available: 0 }))!;
  assert.deepEqual(line.figures, ['basic land — outside allocation']);
});

test('a trade-listed copy is counted out loud', () => {
  const line = holdersLine(holders({ tradeListed: 1, available: 1 }))!;
  assert.deepEqual(line.figures, ['1 available', '1 on a trade list']);
});

test('a contested row says who has it and who is short', () => {
  assert.equal(contestedFigures(contested()), 'owned 1 · wanted 2');
  assert.equal(contestedReason(contested()), 'Atraxa has it; Krenko is short.');
});

test('over-allocation reads as a claim on copies that are gone', () => {
  const card = contested({
    overAllocated: true, owned: 0, held: 1, wanted: 1,
    holders: [{ deckId: 1, deckName: 'Only', status: 'assembled', quantity: 1 }],
    shortDecks: [{ deckId: 1, deckName: 'Only', status: 'assembled', required: 1, covered: 0, missing: 1 }],
  });
  assert.equal(contestedReason(card), 'Decks claim 1 but you own 0.');
});

test('the what-if sentence names what finishes and what merely improves', () => {
  const result: WhatIfResult = {
    deckId: 1, deckName: 'Mono-Red',
    changed: [
      { deckId: 2, deckName: 'Goblins', before: figures({ missingCards: 1, buildablePct: 0.98 }), after: figures({ missingCards: 0, buildablePct: 1 }) },
      { deckId: 3, deckName: 'Slivers', before: figures({ missingCards: 6, buildablePct: 0.88 }), after: figures({ missingCards: 3, buildablePct: 0.94 }) },
    ],
    freedCards: [],
  };
  assert.equal(
    whatIfSentence(result),
    'Breaking up Mono-Red finishes Goblins and moves Slivers from 88% to 94%.',
  );
});

test('a teardown that frees nothing says so in words', () => {
  assert.equal(
    whatIfSentence({ deckId: 1, deckName: 'Lonely', changed: [], freedCards: [] }),
    'Breaking up Lonely would free nothing another deck is waiting for.',
  );
});

test('the confirmation line carries the same three figures as the header', () => {
  assert.equal(figuresLine(figures()), '96% · 2 missing · $8');
  assert.equal(figuresLine(figures({ missingCards: 0, buildablePct: 1 })), '100% · complete');
  assert.equal(figuresLine(figures({ buildablePct: null })), 'empty');
});

test('a deck\'s scope is the fights it holds a copy in or is short in', () => {
  const holder = { deckId: 1, deckName: 'Eric', status: 'building' as const, quantity: 1 };
  const short = {
    deckId: 1, deckName: 'Eric', status: 'building' as const, required: 1, covered: 0, missing: 1,
  };
  const cards = [
    contested({ oracleId: 'holds', holders: [holder], shortDecks: [] }),
    contested({ oracleId: 'short', holders: [], shortDecks: [short] }),
    contested({ oracleId: 'other', holders: [], shortDecks: [] }),
  ];
  assert.deepEqual(cardsInScope(cards, 1).map((c) => c.oracleId), ['holds', 'short']);
  assert.deepEqual(cardsInScope(cards, 99), []);
});
