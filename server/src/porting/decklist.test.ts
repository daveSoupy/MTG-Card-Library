import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecklist, formatDecklist, tcgplayerMassEntryUrl, type ExportCard } from './decklist.ts';

const names = (text: string) => parseDecklist(text).entries.map((e) => `${e.quantity} ${e.name}`);

test('the plain quantity-and-name form parses, with or without the x', () => {
  assert.deepEqual(names('4 Lightning Bolt\n2x Counterspell\n1 Sol Ring'),
    ['4 Lightning Bolt', '2 Counterspell', '1 Sol Ring']);
});

test('set code and collector number are captured, not swallowed into the name', () => {
  const [entry] = parseDecklist('4 Lightning Bolt (M10) 146').entries;
  assert.equal(entry.name, 'Lightning Bolt');
  assert.equal(entry.setCode, 'm10');
  assert.equal(entry.collectorNumber, '146');

  // Brackets are the other common spelling, and the number is optional.
  const [bracketed] = parseDecklist('1 Sol Ring [C21]').entries;
  assert.equal(bracketed.name, 'Sol Ring');
  assert.equal(bracketed.setCode, 'c21');
  assert.equal(bracketed.collectorNumber, null);
});

test('names containing commas and apostrophes survive intact', () => {
  assert.deepEqual(names("1 Atraxa, Praetors' Voice"), ["1 Atraxa, Praetors' Voice"]);
});

test('a split card is not mistaken for a comment', () => {
  // "//" only starts a comment at the start of a line — otherwise every split
  // card would be silently dropped.
  const parsed = parseDecklist('// my deck\n1 Fire // Ice\n1 Wear // Tear');
  assert.deepEqual(parsed.entries.map((e) => e.name), ['Fire // Ice', 'Wear // Tear']);
  assert.equal(parsed.unparsed.length, 0);
});

test('comments and blank leading lines are ignored', () => {
  const parsed = parseDecklist('# a note\n// another\n\n4 Lightning Bolt');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.unparsed.length, 0);
});

test('explicit section headers move cards between boards', () => {
  const parsed = parseDecklist([
    'Deck', '4 Lightning Bolt', '', 'Sideboard', '2 Pyroblast',
  ].join('\n'));
  assert.deepEqual(parsed.entries.map((e) => [e.board, e.name]),
    [['main', 'Lightning Bolt'], ['side', 'Pyroblast']]);
});

test('a Commander header puts cards in the command zone', () => {
  const parsed = parseDecklist('Commander\n1 Atraxa, Praetors’ Voice\n\nDeck\n1 Sol Ring');
  assert.equal(parsed.entries[0].board, 'command');
  assert.equal(parsed.entries[1].board, 'main');
});

test('an inline *CMDR* marker is honoured and stripped from the name', () => {
  const [entry] = parseDecklist('1 Atraxa, Praetors’ Voice *CMDR*').entries;
  assert.equal(entry.board, 'command');
  assert.equal(entry.name, 'Atraxa, Praetors’ Voice', 'the marker must not stay in the name');
});

test('MTGO style: one blank line starts the sideboard', () => {
  const parsed = parseDecklist('4 Lightning Bolt\n20 Mountain\n\n2 Pyroblast');
  assert.deepEqual(parsed.entries.map((e) => e.board), ['main', 'main', 'side']);
});

test('a blank line does not start a sideboard when headers are in use', () => {
  // Otherwise a blank line inside the maindeck would silently split the deck.
  const parsed = parseDecklist('Deck\n4 Lightning Bolt\n\n20 Mountain\n\nSideboard\n2 Pyroblast');
  assert.deepEqual(parsed.entries.map((e) => [e.board, e.name]), [
    ['main', 'Lightning Bolt'], ['main', 'Mountain'], ['side', 'Pyroblast'],
  ]);
});

test('a card whose name starts like a header is still a card', () => {
  // "Deck" alone is a header; "Deckbuilder's Vault" is not.
  const parsed = parseDecklist("1 Commander's Sphere\n1 Sideboard Shuffle");
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((e) => e.board), ['main', 'main']);
});

test('lines that are not entries are reported rather than dropped silently', () => {
  const parsed = parseDecklist('4 Lightning Bolt\nthis is not a card line\n2 Counterspell');
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.unparsed, [{ lineNumber: 2, raw: 'this is not a card line' }]);
});

test('quantity is never zero or negative', () => {
  assert.equal(parseDecklist('0 Lightning Bolt').entries[0].quantity, 1);
});

// -- writing -----------------------------------------------------------------

const cards: ExportCard[] = [
  { quantity: 1, name: 'Atraxa, Praetors’ Voice', setCode: 'cmr', collectorNumber: '3', board: 'command' },
  { quantity: 4, name: 'Lightning Bolt', setCode: 'm10', collectorNumber: '146', board: 'main' },
  { quantity: 2, name: 'Pyroblast', setCode: 'ema', collectorNumber: '129', board: 'side' },
  { quantity: 9, name: 'Idea', setCode: null, collectorNumber: null, board: 'maybe' },
];

test('the simple form is bare quantities and names', () => {
  const text = formatDecklist(cards, 'simple');
  assert.match(text, /^1 Atraxa/m);
  assert.match(text, /^4 Lightning Bolt$/m);
  assert.doesNotMatch(text, /M10/, 'no set codes in the simple form');
});

test('the maybeboard is never exported', () => {
  for (const format of ['simple', 'withSet', 'arena', 'mtgo'] as const) {
    assert.doesNotMatch(formatDecklist(cards, format), /Idea/, format);
  }
});

test('withSet adds the printing', () => {
  assert.match(formatDecklist(cards, 'withSet'), /^4 Lightning Bolt \(M10\) 146$/m);
});

test('arena writes its section headers', () => {
  const text = formatDecklist(cards, 'arena');
  assert.match(text, /^Commander$/m);
  assert.match(text, /^Deck$/m);
  assert.match(text, /^Sideboard$/m);
});

test('mtgo separates the sideboard with a blank line and no headers', () => {
  const text = formatDecklist(cards, 'mtgo');
  assert.doesNotMatch(text, /^Sideboard$/m);
  assert.match(text, /\n\n/);
});

test('a card with no printing still exports cleanly in withSet', () => {
  const text = formatDecklist(
    [{ quantity: 1, name: 'Mystery Card', setCode: null, collectorNumber: null, board: 'main' }],
    'withSet',
  );
  assert.equal(text, '1 Mystery Card');
});

test('exporting then re-parsing round-trips every board', () => {
  const text = formatDecklist(cards, 'arena');
  const parsed = parseDecklist(text);
  assert.equal(parsed.unparsed.length, 0);
  assert.deepEqual(
    parsed.entries.map((e) => [e.board, e.quantity, e.name]),
    [['command', 1, 'Atraxa, Praetors’ Voice'], ['main', 4, 'Lightning Bolt'], ['side', 2, 'Pyroblast']],
  );
});

test('the TCGplayer link is built, and long lists are flagged rather than truncated', () => {
  const { url, tooLong } = tcgplayerMassEntryUrl(cards);
  assert.match(url, /massentry/);
  assert.match(decodeURIComponent(url), /4 Lightning Bolt/);
  assert.doesNotMatch(decodeURIComponent(url), /Idea/);
  assert.equal(tooLong, false);

  const huge = Array.from({ length: 900 }, (_, i) => ({
    quantity: 1, name: `A Very Long Card Name Number ${i}`,
    setCode: null, collectorNumber: null, board: 'main' as const,
  }));
  assert.equal(tcgplayerMassEntryUrl(huge).tooLong, true);
});

test('a commander deck survives an export and re-import in every dialect', () => {
  const cards: ExportCard[] = [
    { quantity: 1, name: "Atraxa, Praetors' Voice", setCode: 'cmr', collectorNumber: '1', board: 'command' },
    { quantity: 4, name: 'Lightning Bolt', setCode: 'm10', collectorNumber: '146', board: 'main' },
    { quantity: 2, name: 'Sol Ring', setCode: 'cmr', collectorNumber: '2', board: 'main' },
  ];

  for (const format of ['simple', 'withSet', 'arena', 'mtgo'] as const) {
    const parsed = parseDecklist(formatDecklist(cards, format));
    const total = (board: string) => parsed.entries
      .filter((e) => e.board === board)
      .reduce((sum, e) => sum + e.quantity, 0);

    // Nothing may land in the sideboard: this deck has none. A blank line
    // between the commander and the deck used to send all six copies there.
    assert.equal(total('side'), 0, `${format} put cards in a sideboard`);

    // Only a dialect with a commander header can carry that distinction; in the
    // others the commander is simply another line, which is what a buying list
    // wants anyway. Either way all seven cards come back, and none of them in a
    // sideboard the deck does not have.
    if (format === 'arena') {
      assert.equal(total('command'), 1, 'arena keeps the commander');
      assert.equal(total('main'), 6);
    } else {
      assert.equal(total('main'), 7, `${format} lost cards`);
    }
  }
});

test('a sideboard still round-trips, since that is what the blank line is for', () => {
  const cards: ExportCard[] = [
    { quantity: 4, name: 'Lightning Bolt', setCode: null, collectorNumber: null, board: 'main' },
    { quantity: 2, name: 'Pyroblast', setCode: null, collectorNumber: null, board: 'side' },
  ];
  const parsed = parseDecklist(formatDecklist(cards, 'mtgo'));
  assert.equal(parsed.entries.filter((e) => e.board === 'main')[0].quantity, 4);
  assert.equal(parsed.entries.filter((e) => e.board === 'side')[0].quantity, 2);
});
