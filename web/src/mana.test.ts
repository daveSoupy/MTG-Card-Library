import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dotClass, manaDisplay } from './mana.ts';

/**
 * `{3}{W}{W}` is four pairs of braces on a row you are scanning. These are the
 * cases where compressing it to `5 ●●` must not quietly lose something.
 */

/** The shape a row renders: the value, then one class per dot. */
const shown = (cost: string | null, cmc: number) => {
  const { value, dots } = manaDisplay(cost, cmc);
  return { value, dots: dots.map(dotClass) };
};

test('a single coloured pip is its value and one dot', () => {
  assert.deepEqual(shown('{W}', 1), { value: '1', dots: ['W'] });
});

test('generic mana adds to the value without adding a dot', () => {
  assert.deepEqual(shown('{1}{W}', 2), { value: '2', dots: ['W'] });
  assert.deepEqual(shown('{2}', 2), { value: '2', dots: [] });
});

test('a doubled pip keeps both dots', () => {
  // {W}{W} is a harder commitment than {1}{W} at the same value, and a curve
  // is read for exactly that.
  assert.deepEqual(shown('{3}{W}{W}', 5), { value: '5', dots: ['W', 'W'] });
  assert.deepEqual(shown('{2}{R}{R}{R}', 5), { value: '5', dots: ['R', 'R', 'R'] });
});

test('two colours read in the order they are printed', () => {
  assert.deepEqual(shown('{1}{W}{U}', 3), { value: '3', dots: ['W', 'U'] });
});

test('a split card is read from its front face, which is what cmc counts', () => {
  // Bilbo Baggins, Burglar // Take a Glance: cmc 3 is {2}{U}, not both halves.
  // Parsing the whole string would show two dots against a value of three.
  assert.deepEqual(shown('{2}{U} // {U}', 3), { value: '3', dots: ['U'] });
});

test('a hybrid pip is one dot that knows it takes either colour', () => {
  const { dots } = manaDisplay('{U/R}', 1);
  assert.equal(dots.length, 1);
  assert.deepEqual(dots[0], ['U', 'R']);
  assert.equal(dotClass(dots[0]), 'H');
});

test('Phyrexian mana keeps its colour', () => {
  assert.deepEqual(shown('{W/P}', 1), { value: '1', dots: ['W'] });
});

test('an X spell shows the value X resolves to, and keeps X in the tooltip', () => {
  const display = manaDisplay('{X}{U}{U}', 2);
  assert.equal(display.value, '2', 'Scryfall counts X as zero');
  assert.deepEqual(display.dots.map(dotClass), ['U', 'U']);
  // Nothing is lost: the printed cost is one hover away.
  assert.equal(display.title, '{X}{U}{U}');
});

test('a card with no cost renders nothing rather than a zero', () => {
  // A land does not cost 0 — it has no cost, and the cell should stay empty.
  assert.equal(manaDisplay(null, 0).value, null);
  assert.equal(manaDisplay('', 0).value, null);
});

test('the exact printed cost always survives as the tooltip', () => {
  assert.equal(manaDisplay('{3}{W}{W}', 5).title, '{3}{W}{W}');
  assert.equal(manaDisplay('{2}{U} // {U}', 3).title, '{2}{U} // {U}',
    'both faces, even though only the front is drawn');
});

test('a colourless cost has a value and no dots to colour', () => {
  assert.deepEqual(shown('{4}', 4), { value: '4', dots: [] });
  assert.equal(dotClass([]), 'C');
});
