import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssemblyCompletion, AssemblyRun, AssemblySheet, SheetLine } from './api.ts';
import {
  completionFacts, lineLabel, lineTraits, lineWarning, notFoundNotice, printingLabel,
  progressText, runIntent, runHistoryLabel,
} from './assembly.ts';

/**
 * Phase 25's wording.
 *
 * Every figure these functions render arrives from the server already computed;
 * what is tested here is that none of them says something the sheet did not,
 * and that the two facts a person can be surprised by — that finishing will
 * move real cards, and that an un-ticked line drops a claim — are always said
 * out loud.
 */

const line = (over: Partial<SheetLine> = {}): SheetLine => ({
  id: 1,
  oracleId: 'o1',
  name: 'Sol Ring',
  printingId: 'p1',
  setCode: 'cmr',
  collectorNumber: '261',
  finish: 'nonfoil',
  condition: 'NM',
  language: 'en',
  quantity: 1,
  picked: false,
  unavailable: false,
  notes: null,
  collectionItemId: 9,
  fromLocationId: 2,
  fromLocationName: 'Binder 3',
  toLocationId: 5,
  toLocationName: 'Blue Tackle Box',
  tradeListed: 0,
  unitPriceUsd: null,
  extendedUsd: null,
  ...over,
});

const sheet = (over: Partial<AssemblySheet> = {}): AssemblySheet => ({
  run: {
    id: 1, deckId: 1, kind: 'assemble', status: 'open', movesLots: false,
    sourceRunId: null, startedAt: '2025-03-12T10:00:00Z', completedAt: null, notes: null,
    lineCount: 3, cardCount: 5, pickedCount: 2, notFoundCount: 0, notFound: [],
  },
  deck: {
    id: 1, name: 'Krenko', status: 'brew', homeLocationId: 5,
    homeLocationName: 'Blue Tackle Box',
  },
  groups: [],
  unavailable: [],
  summary: {
    cardsToPull: 5, pickedCards: 2, lineCount: 3, pickedLines: 1,
    unavailableCards: 0, unavailableCostUsd: 0, unpricedCount: 0,
    tradeListedLines: 0, proxiedCards: 0,
  },
  movesLots: false,
  movesLotsBlocked: null,
  alsoPull: [],
  ...over,
});

const completion = (over: Partial<AssemblyCompletion> = {}): AssemblyCompletion => ({
  runId: 1, kind: 'assemble', deckId: 1, deckStatus: 'assembled',
  pulledCards: 5, notFoundCards: 0, proxiedCards: 0,
  stillMissingCards: 0, stillMissingCostUsd: 0, unpricedCount: 0,
  movedLots: false, copiesMoved: 0, tradeListAdjustments: [], problems: [],
  ...over,
});

test('a line reads the way a card is labelled on its bottom edge', () => {
  assert.equal(printingLabel(line()), 'CMR 261');
  assert.equal(lineLabel(line({ quantity: 2 })), '2× Sol Ring (CMR 261)');
  // A card with no printing recorded still has a name worth showing.
  assert.equal(lineLabel(line({ setCode: null, collectorNumber: null })), '1× Sol Ring');
});

test('only traits worth saying out loud are printed', () => {
  // Condition is on the line whenever it is known: the resolver deliberately
  // sends you for the played copy over the mint one, and a sheet that does not
  // say which is which cannot be followed when a binder holds both.
  assert.deepEqual(lineTraits(line()), ['NM']);
  assert.deepEqual(lineTraits(line({ finish: 'foil', condition: 'HP' })), ['foil', 'HP']);
  assert.deepEqual(lineTraits(line({ condition: 'unknown' })), [],
    'ungraded is the absence of a fact, not a fact');
  assert.deepEqual(lineTraits(line({ finish: 'nonfoil' })), ['NM'],
    'nonfoil is the default and goes unsaid');
  assert.deepEqual(lineTraits(line({ language: 'ja' })), ['NM', 'JA']);
});

test('a trade-listed line explains itself rather than showing a bare flag', () => {
  const warning = lineWarning(line({ tradeListed: 2 }));
  assert.match(warning ?? '', /trade list/i);
  assert.match(warning ?? '', /nothing else covers/i);
  assert.equal(lineWarning(line()), null);
});

test('progress counts copies, not lines', () => {
  assert.equal(progressText(sheet()), '2 of 5 pulled');
  assert.equal(progressText(sheet({
    summary: { ...sheet().summary, cardsToPull: 0, pickedCards: 0 },
  })), 'Nothing to pull');
});

test('the sheet always says whether finishing it will move real cards', () => {
  assert.match(runIntent(sheet()), /checklist only/i);
  assert.match(runIntent(sheet({ movesLots: true })), /moves every ticked copy into Blue Tackle Box/);

  const putAway = sheet({ movesLots: true });
  putAway.run.kind = 'disassemble';
  assert.match(runIntent(putAway), /back where it came from/i);
});

test('the completion summary leaves out its noughts', () => {
  const facts = completionFacts(completion());
  assert.deepEqual(facts.map((fact) => fact.key), ['pulled']);
  assert.equal(facts[0].text, '5 cards pulled');
});

test('cards not found are reported as such, not as a claim given up', () => {
  const facts = completionFacts(completion({ pulledCards: 4, notFoundCards: 1 }));
  const notFound = facts.find((fact) => fact.key === 'notFound')!;
  assert.match(notFound.text, /not found where the sheet said/);
  assert.equal(notFound.tone, 'warn');
});

test('an unknown price is never folded into the cost to finish', () => {
  const facts = completionFacts(completion({
    stillMissingCards: 3, stillMissingCostUsd: 12, unpricedCount: 2,
  }));
  const missing = facts.find((fact) => fact.key === 'missing')!;
  assert.match(missing.text, /\$12/);
  assert.match(missing.text, /2 unpriced/, 'the unpriced count travels with the total');
});

test('a settled trade list is named, not merely counted', () => {
  const facts = completionFacts(completion({
    movedLots: true,
    copiesMoved: 1,
    tradeListAdjustments: [
      { listName: 'Binder Sale', cardName: 'Sol Ring', quantity: 1, removed: true },
      { listName: 'Bulk', cardName: 'Llanowar Elves', quantity: 2, removed: false },
    ],
  }));
  const texts = facts.map((fact) => fact.text);
  assert.ok(texts.some((text) => /Sol Ring removed from trade list “Binder Sale”/.test(text)));
  assert.ok(texts.some((text) => /Llanowar Elves on “Bulk” reduced by 2/.test(text)));
});

const run = (over: Partial<AssemblyRun> = {}): AssemblyRun => ({
  id: 3, deckId: 1, kind: 'assemble', status: 'completed', movesLots: false,
  sourceRunId: null, startedAt: '2025-03-12T10:00:00Z',
  completedAt: '2025-03-12T11:00:00Z', notes: null,
  lineCount: 12, cardCount: 14, pickedCount: 13,
  notFoundCount: 1, notFound: [{ oracleId: 'o9', name: 'Sol Ring', quantity: 1 }],
  ...over,
});

test('history says what a run did, including what it could not find', () => {
  assert.match(runHistoryLabel(run()), /Assembled — 13 of 14 cards, 1 not found/);
  assert.match(
    runHistoryLabel(run({ pickedCount: 14, notFoundCount: 0, notFound: [] })),
    /Assembled — 14 of 14 cards$/,
    'a clean pull does not carry an empty shortfall',
  );
});

test('the not-found notice names the cards and reads from the run, not the claim', () => {
  const notice = notFoundNotice([run()], 'assembled')!;
  assert.equal(notice.text, '1 not found on last pull');
  assert.match(notice.title, /1× Sol Ring/);
  assert.match(notice.title, /still counts them as yours/);
  assert.equal(notice.run.id, 3);
});

test('the notice is silent once the pull is no longer what is on the table', () => {
  assert.equal(notFoundNotice([run()], 'brew'), null, 'a deck that is not assembled');
  assert.equal(notFoundNotice([run()], 'disassembled'), null);
  assert.equal(notFoundNotice([run({ notFoundCount: 0, notFound: [] })], 'assembled'), null,
    'a clean pull');
  assert.equal(notFoundNotice([], 'assembled'), null, 'no runs at all');

  // Newest first: a later put-away means that pull is history, even though the
  // deck could have been re-marked assembled by hand since.
  const putAway = run({ id: 4, kind: 'disassemble', notFoundCount: 0, notFound: [] });
  assert.equal(notFoundNotice([putAway, run()], 'assembled'), null);

  // But an open or cancelled run after it does not: the completed assemble is
  // still the latest thing that actually happened to the cards.
  const abandoned = run({ id: 5, status: 'cancelled', notFoundCount: 0, notFound: [] });
  assert.equal(notFoundNotice([abandoned, run()], 'assembled')?.run.id, 3);
});
