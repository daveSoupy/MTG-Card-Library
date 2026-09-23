import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuildabilityRow, DeckBuildability } from './api.ts';
import { money, percent, summarySegments } from './buildability.ts';

const figures = (over: Partial<DeckBuildability> = {}): DeckBuildability => ({
  deckId: 1,
  buildablePct: 0.94,
  requiredCards: 100,
  coveredCards: 94,
  missingCards: 6,
  costToCompleteUsd: 23,
  unpricedCount: 0,
  contestedCount: 0,
  ...over,
});

const row = (over: Partial<BuildabilityRow> = {}): BuildabilityRow => ({
  oracleId: 'o-ring',
  name: 'Sol Ring',
  required: 3,
  owned: 0,
  available: 0,
  tradeListed: 0,
  proxied: 0,
  covered: 0,
  missing: 3,
  unitPriceUsd: 2,
  extendedUsd: 6,
  contested: false,
  holdingDecks: [],
  ...over,
});

test('money drops cents it does not need and keeps the ones it does', () => {
  assert.equal(money(23), '$23');
  assert.equal(money(23.5), '$23.50');
  assert.equal(money(0), '$0');
});

test('a deck that is nearly there never rounds up to finished', () => {
  assert.equal(percent(0.94), '94%');
  assert.equal(percent(1), '100%');
  assert.equal(percent(0.996), '99%', 'a 99.6% deck is a deck you cannot build');
  assert.equal(percent(0), '0%');
});

test('the header strip reads 94% - 6 missing - $23 to finish', () => {
  const segments = summarySegments(figures());
  assert.deepEqual(segments.map((s) => s.text), ['94%', '6 missing', '$23 to finish']);
  assert.deepEqual(segments.map((s) => s.actionable), [false, true, true]);
});

test('a finished deck says so and stops, rather than padding out zeroes', () => {
  const segments = summarySegments(figures({
    buildablePct: 1, coveredCards: 100, missingCards: 0, costToCompleteUsd: 0,
  }));
  assert.deepEqual(segments.map((s) => s.text), ['100%']);
});

test('an empty deck reads empty, not 100% buildable', () => {
  const segments = summarySegments(figures({
    buildablePct: null, requiredCards: 0, coveredCards: 0, missingCards: 0, costToCompleteUsd: 0,
  }));
  assert.deepEqual(segments.map((s) => s.text), ['Empty']);
});

test('unpriced cards ride along with the total instead of vanishing into it', () => {
  const segments = summarySegments(figures({ unpricedCount: 2 }));
  const cost = segments.find((s) => s.key === 'cost')!;
  assert.equal(cost.text, '$23 + 2 unpriced to finish');
  assert.match(cost.title, /the real total is higher/);
});

test('contested only appears when something is actually contested', () => {
  assert.ok(!summarySegments(figures()).some((s) => s.key === 'contested'));
  const segments = summarySegments(figures({ contestedCount: 2 }));
  assert.equal(segments.at(-1)!.text, '2 contested');
});

