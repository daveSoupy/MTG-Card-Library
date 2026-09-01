import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorMask, canonicalColors, colorsFromMask, parseColors,
  normalizeName, splitCollectorNumber, manaSymbols, expandRarity,
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
