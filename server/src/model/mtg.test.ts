import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorMask, canonicalColors, colorsFromMask, parseColors,
  normalizeName, splitCollectorNumber, manaSymbols, expandRarity,
  parseDeckCopyLimit, UNLIMITED_COPIES,
} from './mtg.ts';

test('colour masks use WUBRG bit order', () => {
  assert.equal(colorMask([]), 0);
  assert.equal(colorMask(['W']), 1);
  assert.equal(colorMask(['G']), 16);
  assert.equal(colorMask(['W', 'U', 'B', 'R', 'G']), 31);
  // Atraxa: white, blue, black, green — 1 + 2 + 4 + 16
  assert.equal(colorMask(['G', 'W', 'U', 'B']), 23);
  assert.equal(colorMask(['w', 'u']), 3, 'accepts lowercase');
  assert.equal(colorMask(['X']), 0, 'ignores unknown symbols');
});

test('canonical colours always render in WUBRG order', () => {
  assert.equal(canonicalColors(['U', 'W']), 'WU');
  assert.equal(canonicalColors(['G', 'B', 'W']), 'WBG');
  assert.equal(canonicalColors([]), '');
});

test('colorsFromMask round-trips with colorMask', () => {
  for (const combo of [['W'], ['U', 'R'], ['W', 'U', 'B', 'R', 'G'], []]) {
    assert.equal(colorMask(colorsFromMask(colorMask(combo))), colorMask(combo));
  }
});

test('parseColors understands letters, guild names and colourless', () => {
  assert.deepEqual(parseColors('wu'), ['W', 'U']);
  assert.deepEqual(parseColors('azorius'), ['W', 'U']);
  assert.deepEqual(parseColors('jund'), ['B', 'R', 'G']);
  assert.deepEqual(parseColors('colorless'), []);
  assert.deepEqual(parseColors('c'), []);
  assert.deepEqual(parseColors('WUBRG'), ['W', 'U', 'B', 'R', 'G']);
  assert.deepEqual(parseColors('uw'), ['W', 'U'], 'order-independent');
});

test('normalizeName folds accents and drops punctuation without splitting words', () => {
  assert.equal(normalizeName('Jötun Grunt'), 'jotun grunt');
  assert.equal(normalizeName('JOTUN  GRUNT'), 'jotun grunt');
  // The apostrophe must vanish rather than become a space, so that typing the
  // name without it still matches.
  assert.equal(normalizeName("Jace's Ingenuity"), 'jaces ingenuity');
  assert.equal(normalizeName("Atraxa, Praetors' Voice"), 'atraxa praetors voice');
  assert.equal(normalizeName('Fire // Ice'), 'fire ice');
  assert.equal(normalizeName('Borrowing 100,000 Arrows'), 'borrowing 100000 arrows');
  assert.equal(normalizeName('  spaced   out  '), 'spaced out');
  // Precomposed ligatures expand rather than vanishing, so an old decklist
  // or an OCR read of an older printing still resolves to the modern name.
  assert.equal(normalizeName('Æther Vial'), 'aether vial');
  assert.equal(normalizeName('Lim-Dûl’s Cohort'), 'lim duls cohort');
  assert.equal(normalizeName('Clavileño, First of the Blessed'), 'clavileno first of the blessed');
});

test('collector numbers split for binder-order sorting', () => {
  assert.deepEqual(splitCollectorNumber('12'), { number: 12, suffix: null });
  assert.deepEqual(splitCollectorNumber('100a'), { number: 100, suffix: 'a' });
  assert.deepEqual(splitCollectorNumber('★12'), { number: 12, suffix: '★' });
  assert.deepEqual(splitCollectorNumber('GR1'), { number: 1, suffix: 'GR' });
  assert.deepEqual(splitCollectorNumber('abc'), { number: null, suffix: 'abc' });
  // 9 must sort before 10, which is the whole point of splitting them out.
  const numbers = ['10', '9', '100', '2'].map((n) => splitCollectorNumber(n).number!);
  assert.deepEqual([...numbers].sort((a, b) => a - b), [2, 9, 10, 100]);
});

test('mana symbols parse out of a cost string', () => {
  assert.deepEqual(manaSymbols('{2}{W}{U}'), ['2', 'W', 'U']);
  assert.deepEqual(manaSymbols('{X}{B/G}{T}'), ['X', 'B/G', 'T']);
  assert.deepEqual(manaSymbols(null), []);
  assert.deepEqual(manaSymbols(''), []);
});

test('rarity shorthand expands', () => {
  assert.equal(expandRarity('m'), 'mythic');
  assert.equal(expandRarity('R'), 'rare');
  assert.equal(expandRarity('uncommon'), 'uncommon');
});

/**
 * Rules text as Scryfall actually publishes it, so the regex is tested against
 * the sentence on the card rather than a paraphrase of it. Every member of the
 * "any number" family says the same thing, which is exactly why detection can
 * be text-based and does not need a maintained list of names.
 */
test('cards allowing any number of copies are detected from their rules text', () => {
  const anyNumber = [
    ['Relentless Rats', 'Relentless Rats gets +1/+1 for each other creature on the battlefield named Relentless Rats.\nA deck can have any number of cards named Relentless Rats.'],
    ['Rat Colony', 'Rat Colony gets +1/+0 for each other Rat you control.\nA deck can have any number of cards named Rat Colony.'],
    ['Shadowborn Apostle', 'A deck can have any number of cards named Shadowborn Apostle.\n{6}, Sacrifice six Creatures named Shadowborn Apostle: Search your library for a Demon creature card, put it onto the battlefield, then shuffle.'],
    ['Persistent Petitioners', '{1}, {T}: Target player mills a card.\nTap four untapped Advisors you control: Target player mills twelve cards.\nA deck can have any number of cards named Persistent Petitioners.'],
    ["Dragon's Approach", "Dragon's Approach deals 3 damage to each opponent. Put Dragon's Approach into its owner's graveyard.\nA deck can have any number of cards named Dragon's Approach."],
    ['Slime Against Humanity', 'A deck can have any number of cards named Slime Against Humanity.'],
    ['Hare Apparent', 'When this creature enters, create a 1/1 white Rabbit creature token for each other creature you control named Hare Apparent.\nA deck can have any number of cards named Hare Apparent.'],
    ['Tempest Hawk', 'Flying\nA deck can have any number of cards named Tempest Hawk.'],
    ['Templar Knight', 'A deck can have any number of cards named Templar Knight.'],
  ];
  for (const [name, text] of anyNumber) {
    assert.equal(parseDeckCopyLimit(text), UNLIMITED_COPIES, name);
  }
});

test('cards with a finite printed cap yield that number', () => {
  assert.equal(
    parseDeckCopyLimit('Amass Orcs 1.\nA deck can have up to nine cards named Nazgûl.'),
    9,
  );
  assert.equal(
    parseDeckCopyLimit('A deck can have up to seven cards named Seven Dwarves.'),
    7,
  );
  // The one card in the family that *tightens* the limit rather than loosening it.
  assert.equal(
    parseDeckCopyLimit('A deck can have only one card named 1996 World Champion.'),
    1,
  );
});

test('cards saying nothing about deck construction fall back to the format', () => {
  assert.equal(parseDeckCopyLimit('Flying, first strike'), null);
  assert.equal(parseDeckCopyLimit(null), null);
  assert.equal(parseDeckCopyLimit(''), null);
  // Mentions both "any number" and "named" but is not a deck-construction clause.
  assert.equal(
    parseDeckCopyLimit('Search your library for any number of cards named Wish and reveal them.'),
    null,
  );
});

test('an unreadable quantity still exempts the card rather than failing it', () => {
  // A future wording we have no word for is definitely an exception; allowing
  // too many beats reporting a card as illegal when it is not.
  assert.equal(
    parseDeckCopyLimit('A deck can have up to seventeen thousand cards named Hypothetical Rat.'),
    UNLIMITED_COPIES,
  );
  // Digits, should Wizards ever print them.
  assert.equal(parseDeckCopyLimit('A deck can have up to 9 cards named Nazgûl.'), 9);
});
