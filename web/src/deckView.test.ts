import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECK_SORTS, groupByField, groupCards, identityKey,
  type DeckSort, type GroupBy,
} from './deckView.ts';
import type { DeckCard } from './api.ts';

let nextId = 1;
function card(overrides: Partial<DeckCard> = {}): DeckCard {
  return {
    id: nextId++, oracleId: `o-${nextId}`, name: `Card ${nextId}`,
    board: 'main', quantity: 1, quantityFromCollection: 0, commanderRole: null, categories: [],
    cmc: 2, typeLine: 'Creature — Human', manaCost: '{1}{G}', colorIdentity: 'G',
    isBasicLand: false, canBeCommander: false, legality: 'legal',
    category: null, producedMana: [], partnerKind: null,
    ownedQuantity: 0, availableQuantity: 0,
    printingId: null, setCode: null, rarity: 'common', imageSmall: null, priceUsd: null,
    ...overrides,
  };
}

const labels = (groups: { label: string }[]) => groups.map((g) => g.label);
const namesIn = (groups: { label: string; cards: DeckCard[] }[], label: string) =>
  groups.find((g) => g.label === label)?.cards.map((c) => c.name) ?? [];

test('type sort follows decklist order, not alphabetical order', () => {
  const groups = groupCards([
    card({ typeLine: 'Land' }),
    card({ typeLine: 'Instant' }),
    card({ typeLine: 'Creature — Elf' }),
    card({ typeLine: 'Artifact' }),
  ], 'type');
  assert.deepEqual(labels(groups), ['Creature', 'Instant', 'Artifact', 'Land']);
});

test('an artifact creature files under Creature', () => {
  const groups = groupCards([card({ typeLine: 'Artifact Creature — Golem', name: 'Golem' })], 'type');
  assert.deepEqual(labels(groups), ['Creature']);
});

test('unknown types fall into Other, at the end', () => {
  const groups = groupCards([
    card({ typeLine: 'Creature — Bear', name: 'Bear' }),
    card({ typeLine: 'Conspiracy', name: 'Odd One' }),
  ], 'type');
  assert.deepEqual(labels(groups), ['Creature', 'Other']);
});

test('within a type group, cards run up the curve then alphabetically', () => {
  const groups = groupCards([
    card({ name: 'Zeta', cmc: 1 }),
    card({ name: 'Alpha', cmc: 3 }),
    card({ name: 'Beta', cmc: 1 }),
  ], 'type');
  assert.deepEqual(namesIn(groups, 'Creature'), ['Beta', 'Zeta', 'Alpha']);
});

test('mana sort buckets everything from 7 upward together', () => {
  const groups = groupCards([
    card({ cmc: 0 }), card({ cmc: 1 }), card({ cmc: 7 }), card({ cmc: 12 }),
  ], 'mana');
  assert.deepEqual(labels(groups), ['0 mana', '1 mana', '7+ mana']);
  assert.equal(groups.at(-1)!.count, 2, 'the 7 and the 12 share a bucket');
});

test('mana groups are ordered numerically, not as strings', () => {
  const groups = groupCards(
    [card({ cmc: 10 }), card({ cmc: 2 }), card({ cmc: 1 })],
    'mana',
  );
  // A string sort would put "10 mana" before "2 mana".
  assert.deepEqual(labels(groups), ['1 mana', '2 mana', '7+ mana']);
});

test('colour sort uses WUBRG order, then multicolour, then colourless', () => {
  const groups = groupCards([
    card({ colorIdentity: '' }),
    card({ colorIdentity: 'G' }),
    card({ colorIdentity: 'W' }),
    card({ colorIdentity: 'WU' }),
    card({ colorIdentity: 'U' }),
  ], 'color');
  assert.deepEqual(labels(groups), ['White', 'Blue', 'Green', 'Multicolour', 'Colourless']);
});

test('every gold card shares one Multicolour group', () => {
  const groups = groupCards([
    card({ colorIdentity: 'WU' }),
    card({ colorIdentity: 'BRG' }),
  ], 'color');
  assert.deepEqual(labels(groups), ['Multicolour']);
  assert.equal(groups[0].count, 2);
});

test('rarity sort runs mythic down to common', () => {
  const groups = groupCards([
    card({ rarity: 'common' }), card({ rarity: 'mythic' }),
    card({ rarity: 'uncommon' }), card({ rarity: 'rare' }),
  ], 'rarity');
  assert.deepEqual(labels(groups), ['Mythic', 'Rare', 'Uncommon', 'Common']);
});

test('name and price sorts present one continuous run, not headings', () => {
  const cards = [card({ name: 'Beta' }), card({ name: 'Alpha' })];
  for (const sort of ['name', 'price'] as DeckSort[]) {
    assert.equal(groupCards(cards, sort).length, 1, `${sort} should be a single group`);
  }
  assert.deepEqual(namesIn(groupCards(cards, 'name'), 'All cards'), ['Alpha', 'Beta']);
});

test('price sorts high to low and puts unpriced cards last', () => {
  const groups = groupCards([
    card({ name: 'Cheap', priceUsd: 0.25 }),
    card({ name: 'Unpriced', priceUsd: null }),
    card({ name: 'Pricey', priceUsd: 40 }),
  ], 'price');
  assert.deepEqual(namesIn(groups, 'All cards'), ['Pricey', 'Cheap', 'Unpriced']);
});

test('group counts total copies rather than distinct cards', () => {
  const groups = groupCards([
    card({ quantity: 4, typeLine: 'Instant' }),
    card({ quantity: 2, typeLine: 'Instant' }),
  ], 'type');
  assert.equal(groups[0].count, 6);
  assert.equal(groups[0].cards.length, 2);
});

test('every sort handles an empty deck and keeps every card', () => {
  const deck = [
    card({ typeLine: 'Land', colorIdentity: '', rarity: 'common', cmc: 0 }),
    card({ typeLine: 'Creature — Elf', colorIdentity: 'G', rarity: 'rare', cmc: 3 }),
    card({ typeLine: 'Instant', colorIdentity: 'WU', rarity: 'mythic', cmc: 2, priceUsd: 5 }),
  ];
  for (const { value } of DECK_SORTS) {
    assert.deepEqual(groupCards([], value), [], `${value} on an empty deck`);
    const total = groupCards(deck, value).flatMap((g) => g.cards).length;
    assert.equal(total, deck.length, `${value} must not drop or duplicate cards`);
  }
});

// -------------------------------------------------- Phase 10: shared grouping

test('type-alpha reads a type group alphabetically where type reads up the curve', () => {
  const deck = [
    card({ name: 'Zeta', cmc: 1 }),
    card({ name: 'Alpha', cmc: 3 }),
    card({ name: 'Beta', cmc: 1 }),
  ];
  assert.deepEqual(namesIn(groupCards(deck, 'type'), 'Creature'), ['Beta', 'Zeta', 'Alpha']);
  assert.deepEqual(namesIn(groupCards(deck, 'type-alpha'), 'Creature'), ['Alpha', 'Beta', 'Zeta']);
  // Same groups either way — only the order inside them differs.
  assert.deepEqual(
    labels(groupCards(deck, 'type')),
    labels(groupCards(deck, 'type-alpha')),
  );
});

test('the colour tint keys off the same buckets the colour grouping does', () => {
  assert.equal(identityKey('G'), 'G');
  assert.equal(identityKey('WU'), 'M');
  assert.equal(identityKey(''), 'C');
  assert.equal(identityKey(null), 'C');
});

test('groupByField works on a browse hit, which has no quantity of its own', () => {
  const hit = {
    name: 'Lightning Bolt', typeLine: 'Instant', cmc: 1,
    colorIdentity: 'R', colors: 'R', rarity: 'common', setCode: 'lea', setName: 'Alpha',
  };
  const groups = groupByField([hit, { ...hit, name: 'Shock' }], 'type');
  assert.deepEqual(labels(groups), ['Instant']);
  // One copy per row, since a search result stands for exactly one card.
  assert.equal(groups[0].count, 2);
});

test('a count function covers sources that name their quantity differently', () => {
  const lot = { name: 'Sol Ring', typeLine: 'Artifact', cmc: 1, colorIdentity: '', ownedQuantity: 4 };
  const groups = groupByField([lot], 'type', (c) => c.ownedQuantity);
  assert.equal(groups[0].count, 4);
});

test('grouping leaves the order the server sorted rows into alone', () => {
  const base = { typeLine: 'Creature — Elf', cmc: 2, colorIdentity: 'G' };
  const rows = [{ ...base, name: 'Zeta' }, { ...base, name: 'Alpha' }, { ...base, name: 'Mu' }];
  // Re-sorting here would silently override the Sort By the user picked in
  // the same panel.
  assert.deepEqual(
    groupByField(rows, 'type')[0].cards.map((c) => c.name),
    ['Zeta', 'Alpha', 'Mu'],
  );
});

test('subtype takes the first subtype off the type line', () => {
  const rows = [
    { name: 'Wizard', typeLine: 'Creature — Human Wizard', cmc: 2, colorIdentity: 'U' },
    { name: 'Forest', typeLine: 'Basic Land — Forest', cmc: 0, colorIdentity: 'G' },
    { name: 'Bolt', typeLine: 'Instant', cmc: 1, colorIdentity: 'R' },
  ];
  // Subtype-less cards collect at the end rather than under a blank heading.
  assert.deepEqual(labels(groupByField(rows, 'subtype')), ['Forest', 'Human', 'No subtype']);
});

test('set grouping labels by set name and falls back to the code', () => {
  const rows = [
    { name: 'A', typeLine: 'Instant', cmc: 1, colorIdentity: '', setCode: 'lea', setName: 'Alpha' },
    { name: 'B', typeLine: 'Instant', cmc: 1, colorIdentity: '', setCode: 'mh3', setName: null },
    { name: 'C', typeLine: 'Instant', cmc: 1, colorIdentity: '', setCode: null },
  ];
  assert.deepEqual(labels(groupByField(rows, 'set')), ['Alpha', 'MH3', 'No set']);
});

test('Colour falls back to colour identity where a source has no colors field', () => {
  // A collection row carries only its identity; a browse hit carries both, and
  // the two genuinely differ for a card like Kozilek's Return.
  const lot = { name: 'Lot', typeLine: 'Instant', cmc: 1, colorIdentity: 'R' };
  const hit = { ...lot, name: 'Hit', colors: '' };
  assert.deepEqual(labels(groupByField([lot], 'color')), ['Red']);
  assert.deepEqual(labels(groupByField([hit], 'color')), ['Colourless']);
  assert.deepEqual(labels(groupByField([hit], 'colorIdentity')), ['Red']);
});

test('grouping by nothing is one unheaded run, whatever the source', () => {
  const rows = [{ name: 'A', typeLine: 'Instant', cmc: 1, colorIdentity: '' }];
  const groups = groupByField(rows, 'none');
  assert.equal(groups.length, 1);
  // The 'all' key is what every grid keys "no heading" off.
  assert.equal(groups[0].key, 'all');
});

test('every universal grouping keeps every card', () => {
  const rows = [
    { name: 'A', typeLine: 'Creature — Elf', cmc: 2, colorIdentity: 'G', colors: 'G', rarity: 'rare', setCode: 'lea' },
    { name: 'B', typeLine: 'Land', cmc: 0, colorIdentity: '', colors: '', rarity: null, setCode: null },
    { name: 'C', typeLine: 'Instant', cmc: 9, colorIdentity: 'WU', colors: 'WU', rarity: 'mythic', setCode: 'mh3' },
  ];
  const every: GroupBy[] =
    ['none', 'type', 'subtype', 'rarity', 'color', 'colorIdentity', 'mana', 'set'];
  for (const by of every) {
    assert.deepEqual(groupByField([], by), [], `${by} on nothing`);
    const total = groupByField(rows, by).flatMap((g) => g.cards).length;
    assert.equal(total, rows.length, `${by} must not drop or duplicate cards`);
  }
});
