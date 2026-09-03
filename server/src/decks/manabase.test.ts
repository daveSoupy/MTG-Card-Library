import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseManaBase, countPips } from './manabase.ts';
import type { DeckCard } from './types.ts';

let nextId = 1;
function card(overrides: Partial<DeckCard> = {}): DeckCard {
  return {
    id: nextId++, oracleId: `o-${nextId}`, name: `Card ${nextId}`,
    board: 'main', quantity: 1, quantityFromCollection: 0, commanderRole: null,
    category: null, sortOrder: 0, cmc: 2, typeLine: 'Creature — Human',
    manaCost: null, colorIdentity: '', colorIdentityMask: 0, colorsMask: 0,
    isBasicLand: false, isLegendary: false, canBeCommander: false,
    producedMana: [], partnerKind: null, partnerWith: null,
    legality: 'legal', ownedQuantity: 0, availableQuantity: 0,
    printingId: null, setCode: null, rarity: 'common', imageSmall: null, priceUsd: null,
    ...overrides,
  };
}

const forest = (n: number) =>
  card({ name: 'Forest', typeLine: 'Basic Land — Forest', producedMana: ['G'], quantity: n });

test('pips count coloured symbols and ignore generic, X and colourless', () => {
  assert.deepEqual(countPips('{2}{G}{G}'), { G: 2 });
  assert.deepEqual(countPips('{X}{R}'), { R: 1 });
  assert.deepEqual(countPips('{4}'), {});
  assert.deepEqual(countPips('{C}{C}'), {});
  assert.deepEqual(countPips(null), {});
});

test('hybrid pips count for both halves, since either colour pays them', () => {
  assert.deepEqual(countPips('{W/U}'), { W: 1, U: 1 });
  // Phyrexian and monocoloured hybrid want just their one colour.
  assert.deepEqual(countPips('{W/P}'), { W: 1 });
  assert.deepEqual(countPips('{2/R}'), { R: 1 });
});

test('demand and supply are counted per copy', () => {
  const result = analyseManaBase([
    card({ manaCost: '{G}{G}', quantity: 4 }),   // 8 green pips
    forest(10),                                  // 10 green sources
  ]);
  const green = result.requirements.find((r) => r.color === 'G')!;
  assert.equal(green.pips, 8);
  assert.equal(green.sources, 10);
  assert.equal(result.landCount, 10);
});

test('a colour with far fewer sources than pips is flagged', () => {
  const result = analyseManaBase([
    ...Array.from({ length: 10 }, () => card({ manaCost: '{R}{R}' })),  // 20 red pips
    card({ manaCost: '{G}' }),                                          // 1 green pip
    forest(20),                                                         // all green sources
  ]);
  const red = result.requirements.find((r) => r.color === 'R')!;
  const green = result.requirements.find((r) => r.color === 'G')!;
  assert.equal(red.sources, 0);
  assert.equal(red.isShort, true, 'red demands most of the pips and has no sources');
  assert.equal(green.isShort, false, 'green is oversupplied, not short');
});

test('a balanced deck flags nothing', () => {
  const result = analyseManaBase([
    ...Array.from({ length: 5 }, () => card({ manaCost: '{R}' })),
    ...Array.from({ length: 5 }, () => card({ manaCost: '{G}' })),
    card({ name: 'Mountain', typeLine: 'Basic Land — Mountain', producedMana: ['R'], quantity: 10 }),
    forest(10),
  ]);
  assert.ok(result.requirements.every((r) => !r.isShort));
});

test('a colour with only a pip or two is not flagged on thin evidence', () => {
  const result = analyseManaBase([
    card({ manaCost: '{U}' }),                                      // a single splash pip
    ...Array.from({ length: 20 }, () => card({ manaCost: '{G}' })),
    forest(20),
  ]);
  const blue = result.requirements.find((r) => r.color === 'U')!;
  assert.equal(blue.isShort, false, 'one pip is not enough to call a colour short');
});

test('non-land sources are counted and reported separately', () => {
  const result = analyseManaBase([
    forest(5),
    card({ name: 'Birds of Paradise', producedMana: ['W', 'U', 'B', 'R', 'G'], quantity: 1 }),
    card({ name: 'Sol Ring', typeLine: 'Artifact', producedMana: ['C'], quantity: 1 }),
  ]);
  assert.equal(result.landCount, 5);
  assert.equal(result.nonLandSources, 2, 'the bird and the ring');
  assert.equal(result.colorlessSources, 1, 'Sol Ring makes no coloured mana');
  assert.equal(result.requirements.find((r) => r.color === 'W')!.sources, 1, 'the bird taps for white');
});

test('sideboard and maybeboard are excluded from both sides', () => {
  const result = analyseManaBase([
    card({ manaCost: '{G}', board: 'main' }),
    card({ manaCost: '{R}{R}{R}', board: 'side' }),
    forest(1),
    card({ name: 'Mountain', typeLine: 'Basic Land', producedMana: ['R'], board: 'maybe', quantity: 9 }),
  ]);
  assert.equal(result.totalPips, 1, 'only the maindeck green pip counts');
  assert.equal(result.landCount, 1, 'the maybeboard mountains are not in the deck');
});

test('the command zone counts, since a commander is always castable', () => {
  const result = analyseManaBase([
    card({ manaCost: '{W}{U}{B}{G}', board: 'command' }),
    forest(1),
  ]);
  assert.equal(result.totalPips, 4);
});

test('an empty deck produces no requirements rather than throwing', () => {
  const result = analyseManaBase([]);
  assert.deepEqual(result.requirements, []);
  assert.equal(result.totalPips, 0);
});
