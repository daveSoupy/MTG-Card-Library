import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeck } from './validate.ts';
import { deckStats } from './stats.ts';
import type { Board, DeckCard, FormatRules } from './types.ts';

const MODERN: FormatRules = {
  code: 'modern', displayName: 'Modern',
  minDeckSize: 60, exactDeckSize: null, maxCopies: 4, basicsExempt: true,
  isSingleton: false, sideboardSize: 15, requiresCommander: false, enforcesColorIdentity: false,
};

const COMMANDER: FormatRules = {
  code: 'commander', displayName: 'Commander',
  minDeckSize: null, exactDeckSize: 100, maxCopies: 1, basicsExempt: true,
  isSingleton: true, sideboardSize: 0, requiresCommander: true, enforcesColorIdentity: true,
};

const VINTAGE: FormatRules = { ...MODERN, code: 'vintage', displayName: 'Vintage' };

let nextId = 1;
function card(overrides: Partial<DeckCard> = {}): DeckCard {
  return {
    id: nextId++, oracleId: `o-${nextId}`, name: `Card ${nextId}`,
    board: 'main' as Board, quantity: 1, quantityFromCollection: 0,
    commanderRole: null, category: null, sortOrder: 0,
    cmc: 2, typeLine: 'Creature — Human', manaCost: '{1}{G}',
    colorIdentity: 'G', colorIdentityMask: 16, colorsMask: 16,
    isBasicLand: false, isLegendary: false, canBeCommander: false,
    partnerKind: null, partnerWith: null,
    legality: 'legal', ownedQuantity: 0, availableQuantity: 0,
    printingId: null, setCode: null, rarity: 'common', imageSmall: null, priceUsd: null,
    ...overrides,
  };
}

/** n distinct cards, so copy limits are not tripped by accident. */
const filler = (count: number, overrides: Partial<DeckCard> = {}) =>
  Array.from({ length: count }, () => card(overrides));

const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

test('a legal 60-card Modern deck reports no issues', () => {
  const result = validateDeck(filler(60), MODERN);
  assert.equal(result.mainCount, 60);
  assert.equal(result.isLegal, true);
  assert.deepEqual(result.issues, []);
});

test('minimum deck size is a floor, not an exact target', () => {
  assert.equal(validateDeck(filler(59), MODERN).isLegal, false);
  assert.equal(validateDeck(filler(60), MODERN).isLegal, true);
  // Over the minimum is fine in constructed.
  assert.equal(validateDeck(filler(75), MODERN).isLegal, true);
});

test('Commander must be exactly 100 — over counts as well as under', () => {
  const commander = card({ board: 'command', canBeCommander: true, isLegendary: true });

  const short = validateDeck([commander, ...filler(98)], COMMANDER);
  assert.ok(codes(short.issues).includes('deck_size_exact'));
  assert.match(short.issues[0].message, /1 more needed/);

  const over = validateDeck([commander, ...filler(100)], COMMANDER);
  assert.ok(codes(over.issues).includes('deck_size_exact'));
  assert.match(over.issues[0].message, /1 too many/);

  // 99 in the deck plus the commander in the command zone is exactly 100.
  const exact = validateDeck([commander, ...filler(99)], COMMANDER);
  assert.equal(exact.countedTotal, 100);
  assert.equal(exact.isLegal, true);
});

test('the command zone counts toward the total but the maybeboard never does', () => {
  const commander = card({ board: 'command', canBeCommander: true });
  const result = validateDeck(
    [commander, ...filler(99), ...filler(10, { board: 'maybe' })],
    COMMANDER,
  );
  assert.equal(result.countedTotal, 100);
  assert.equal(result.maybeCount, 10);
  assert.equal(result.isLegal, true);
});

test('copy limits count main and sideboard together', () => {
  const bolt = { oracleId: 'bolt', name: 'Lightning Bolt' };
  // Four maindeck plus one in the sideboard is five copies, not "four and one".
  const result = validateDeck(
    [
      card({ ...bolt, quantity: 4 }),
      card({ ...bolt, quantity: 1, board: 'side' }),
      ...filler(56),
    ],
    MODERN,
  );
  const copyIssues = result.issues.filter((i) => i.code === 'copy_limit');
  assert.equal(copyIssues.length, 1);
  assert.match(copyIssues[0].message, /Only 4 copies of Lightning Bolt/);
  assert.equal(copyIssues[0].cardName, 'Lightning Bolt');
});

test('basic lands are exempt from copy limits in both constructed and singleton', () => {
  const forest = card({ oracleId: 'forest', name: 'Forest', isBasicLand: true, quantity: 24, typeLine: 'Basic Land — Forest' });
  assert.equal(validateDeck([forest, ...filler(36)], MODERN).isLegal, true);

  const commander = card({ board: 'command', canBeCommander: true });
  const singleton = validateDeck(
    [commander, card({ ...forest, quantity: 40 }), ...filler(59)],
    COMMANDER,
  );
  assert.equal(singleton.isLegal, true);
});

test('singleton formats report a singleton violation, not a generic copy limit', () => {
  const commander = card({ board: 'command', canBeCommander: true });
  const result = validateDeck(
    [commander, card({ oracleId: 'sol', name: 'Sol Ring', quantity: 2 }), ...filler(97)],
    COMMANDER,
  );
  const issue = result.issues.find((i) => i.code === 'singleton');
  assert.ok(issue, 'expected a singleton issue');
  assert.match(issue!.message, /only 1 copy of Sol Ring/i);
});

test('restricted cards are capped at 1 even where the format allows 4', () => {
  const ancestral = card({
    oracleId: 'ar', name: 'Ancestral Recall', quantity: 2, legality: 'restricted',
  });
  const result = validateDeck([ancestral, ...filler(58)], VINTAGE);
  const issue = result.issues.find((i) => i.code === 'restricted');
  assert.ok(issue, 'expected a restricted issue');
  assert.match(issue!.message, /only 1 copy allowed, this deck has 2/);

  // A single copy is fine.
  assert.equal(
    validateDeck([card({ ...ancestral, quantity: 1 }), ...filler(59)], VINTAGE).isLegal,
    true,
  );
});

test('banned and not-legal cards are flagged separately', () => {
  const result = validateDeck(
    [
      card({ oracleId: 'b', name: 'Banned Card', legality: 'banned' }),
      card({ oracleId: 'n', name: 'Unknown Card', legality: 'not_legal' }),
      ...filler(58),
    ],
    MODERN,
  );
  const found = codes(result.issues);
  assert.ok(found.includes('banned'));
  assert.ok(found.includes('not_legal'));
  assert.equal(result.isLegal, false);
});

test('a banned card is reported once even when split across boards', () => {
  const banned = { oracleId: 'b', name: 'Banned Card', legality: 'banned' as const };
  const result = validateDeck(
    [card({ ...banned, quantity: 2 }), card({ ...banned, quantity: 1, board: 'side' }), ...filler(57)],
    MODERN,
  );
  assert.equal(result.issues.filter((i) => i.code === 'banned').length, 1);
});

test('sideboard is capped, and formats without one reject any sideboard at all', () => {
  const tooBig = validateDeck([...filler(60), ...filler(16, { board: 'side' })], MODERN);
  assert.ok(codes(tooBig.issues).includes('sideboard_size'));

  const exactly15 = validateDeck([...filler(60), ...filler(15, { board: 'side' })], MODERN);
  assert.equal(exactly15.isLegal, true);

  const commander = card({ board: 'command', canBeCommander: true });
  const edhSide = validateDeck([commander, ...filler(99), card({ board: 'side' })], COMMANDER);
  const issue = edhSide.issues.find((i) => i.code === 'sideboard_size');
  assert.ok(issue);
  assert.match(issue!.message, /does not use a sideboard/);
});

test('a Commander deck without a commander is an error', () => {
  const result = validateDeck(filler(100), COMMANDER);
  assert.ok(codes(result.issues).includes('missing_commander'));
});

test('a card that cannot be a commander is rejected in the command zone', () => {
  const result = validateDeck(
    [card({ name: 'Grizzly Bears', board: 'command', canBeCommander: false }), ...filler(99)],
    COMMANDER,
  );
  const issue = result.issues.find((i) => i.code === 'missing_commander');
  assert.ok(issue);
  assert.match(issue!.message, /cannot be a commander/);
});

test('two commanders are allowed here; three are not', () => {
  const cmdr = () => card({ board: 'command', canBeCommander: true });
  // Partner validation itself is Phase 3; two is not an error at this stage.
  const two = validateDeck([cmdr(), cmdr(), ...filler(98)], COMMANDER);
  assert.equal(two.issues.filter((i) => i.code === 'too_many_commanders').length, 0);

  const three = validateDeck([cmdr(), cmdr(), cmdr(), ...filler(97)], COMMANDER);
  assert.ok(codes(three.issues).includes('too_many_commanders'));
});

test('over-allocation warns but never makes a deck illegal', () => {
  const result = validateDeck(
    [
      card({ name: 'Sol Ring', quantity: 1, quantityFromCollection: 1, availableQuantity: 0 }),
      ...filler(59),
    ],
    MODERN,
  );
  const issue = result.issues.find((i) => i.code === 'over_allocated');
  assert.ok(issue, 'expected an over-allocation warning');
  assert.equal(issue!.severity, 'warning');
  assert.match(issue!.message, /Other decks are using the rest/);
  // CLAUDE.md is explicit: flag it, do not block it.
  assert.equal(result.isLegal, true);
});

test('a deck with no format is not checked, only noted', () => {
  const result = validateDeck(filler(7), null);
  assert.equal(result.isLegal, true);
  assert.deepEqual(codes(result.issues), ['no_format']);
  assert.equal(result.formatCode, null);
});

// ---------------------------------------------------------------- stats

test('mana curve counts cards by mana value and excludes lands', () => {
  const stats = deckStats([
    card({ cmc: 1, quantity: 4 }),
    card({ cmc: 3, quantity: 2 }),
    card({ cmc: 9, quantity: 1 }),
    card({ cmc: 0, quantity: 24, typeLine: 'Basic Land — Forest', isBasicLand: true }),
  ]);

  const bucket = (cmc: number) => stats.manaCurve.find((b) => b.cmc === cmc)!.count;
  assert.equal(bucket(1), 4);
  assert.equal(bucket(3), 2);
  assert.equal(bucket(7), 1, 'a 9-drop lands in the 7+ bucket');
  assert.equal(bucket(0), 0, 'lands are not on the curve');
  assert.equal(stats.manaCurve.at(-1)!.label, '7+');

  // 4 one-drops + 2 three-drops + 1 nine-drop = 19 mana over 7 spells.
  assert.equal(stats.averageManaValue, 2.71);
  assert.equal(stats.totalCards, 31);
});

test('colour distribution counts a gold card under each of its colours', () => {
  const stats = deckStats([
    card({ colorIdentityMask: 1, quantity: 2 }),        // W
    card({ colorIdentityMask: 1 | 2, quantity: 3 }),    // WU
    card({ colorIdentityMask: 0, quantity: 5 }),        // colourless
  ]);
  const count = (name: string) => stats.colorDistribution.find((c) => c.color === name)?.count ?? 0;
  assert.equal(count('White'), 5);
  assert.equal(count('Blue'), 3);
  assert.equal(count('Colourless'), 5);
  assert.equal(stats.colorIdentity, 'WU');
});

test('stats split owned from need-to-buy', () => {
  const stats = deckStats([
    card({ quantity: 4, quantityFromCollection: 3, priceUsd: 2 }),
    card({ quantity: 2, quantityFromCollection: 0, priceUsd: 0.5 }),
  ]);
  assert.equal(stats.ownedCount, 3);
  assert.equal(stats.needToBuyCount, 3);
  assert.equal(stats.estimatedValueUsd, 9);
});

test('type distribution groups an artifact creature under Creature', () => {
  const stats = deckStats([
    card({ typeLine: 'Artifact Creature — Golem', quantity: 2 }),
    card({ typeLine: 'Instant', quantity: 4 }),
    card({ typeLine: 'Basic Land — Island', quantity: 20 }),
  ]);
  const count = (type: string) => stats.typeDistribution.find((t) => t.type === type)?.count ?? 0;
  assert.equal(count('Creature'), 2);
  assert.equal(count('Instant'), 4);
  assert.equal(count('Land'), 20);
});

// ------------------------------------------------- colour identity (903.4)

/** Kenrith: a mono-white card whose rules text gives it a WUBRG identity. */
const KENRITH = { name: 'Kenrith, the Returned King', colorsMask: 1, colorIdentityMask: 31, colorIdentity: 'WUBRG' };
/** Atraxa: WUBG. */
const ATRAXA = { name: "Atraxa, Praetors' Voice", colorsMask: 23, colorIdentityMask: 23, colorIdentity: 'WUBG' };

const commanderOf = (overrides: Partial<DeckCard>) =>
  card({ board: 'command', canBeCommander: true, isLegendary: true, ...overrides });

test('cards outside the commander colour identity are errors', () => {
  const result = validateDeck([
    commanderOf(ATRAXA),
    card({ name: 'Lightning Bolt', colorIdentityMask: 8, colorIdentity: 'R' }),  // red
    ...filler(98, { colorIdentityMask: 16 }),                                    // green, fits
  ], COMMANDER);

  const issue = result.issues.find((i) => i.code === 'color_identity');
  assert.ok(issue, 'a red card under a WUBG commander must be flagged');
  assert.match(issue!.message, /needs R/);
  assert.match(issue!.message, /allows WUBG/);
  assert.equal(issue!.cardName, 'Lightning Bolt');
  assert.equal(result.commanderIdentity, 'WUBG');
});

test('identity comes from rules text, not just the commander’s colours', () => {
  // Kenrith is a white card, so a colours-based check would reject red cards.
  // His identity is WUBRG, so everything fits.
  const result = validateDeck([
    commanderOf(KENRITH),
    card({ name: 'Lightning Bolt', colorIdentityMask: 8 }),
    card({ name: 'Counterspell', colorIdentityMask: 2 }),
    ...filler(97, { colorIdentityMask: 4 }),
  ], COMMANDER);

  assert.equal(result.issues.filter((i) => i.code === 'color_identity').length, 0);
  assert.equal(result.commanderIdentity, 'WUBRG');
});

test('colourless cards fit inside any commander identity', () => {
  const result = validateDeck([
    commanderOf({ ...ATRAXA }),
    card({ name: 'Sol Ring', colorIdentityMask: 0 }),
    ...filler(98, { colorIdentityMask: 0 }),
  ], COMMANDER);
  assert.equal(result.issues.filter((i) => i.code === 'color_identity').length, 0);
});

test('two commanders combine their identities', () => {
  const result = validateDeck([
    commanderOf({ name: 'Tymna', colorIdentityMask: 1, partnerKind: 'partner' }),   // W
    commanderOf({ name: 'Thrasios', colorIdentityMask: 2, partnerKind: 'partner' }), // U
    card({ name: 'Azorius Charm', colorIdentityMask: 3 }),                           // WU — fits
    ...filler(97, { colorIdentityMask: 1 }),
  ], COMMANDER);
  assert.equal(result.commanderIdentity, 'WU');
  assert.equal(result.issues.filter((i) => i.code === 'color_identity').length, 0);
});

test('the maybeboard is exempt from the identity rule', () => {
  const result = validateDeck([
    commanderOf(ATRAXA),
    card({ name: 'Off-colour idea', colorIdentityMask: 8, board: 'maybe' }),
    ...filler(99, { colorIdentityMask: 16 }),
  ], COMMANDER);
  assert.equal(result.issues.filter((i) => i.code === 'color_identity').length, 0);
});

test('formats that do not enforce identity ignore the rule entirely', () => {
  const result = validateDeck(
    [card({ colorIdentityMask: 8 }), ...filler(59, { colorIdentityMask: 1 })],
    MODERN,
  );
  assert.equal(result.commanderIdentity, null);
  assert.equal(result.issues.filter((i) => i.code === 'color_identity').length, 0);
});

// ------------------------------------------------------- partner pairing

const pairOf = (a: Partial<DeckCard>, b: Partial<DeckCard>) =>
  validateDeck([commanderOf(a), commanderOf(b), ...filler(98)], COMMANDER)
    .issues.filter((i) => i.code === 'invalid_pairing');

test('two plain Partner cards may pair', () => {
  assert.equal(pairOf({ partnerKind: 'partner' }, { partnerKind: 'partner' }).length, 0);
});

test('"Partner with" pairs only with the card it names', () => {
  const brallin = { name: 'Brallin, Skyshark Rider', partnerKind: 'partner_with', partnerWith: 'shabraz, the skyshark' };
  const shabraz = { name: 'Shabraz, the Skyshark', partnerKind: 'partner_with', partnerWith: 'brallin, skyshark rider' };
  const other = { name: 'Alphinaud Leveilleur', partnerKind: 'partner_with', partnerWith: 'alisaie leveilleur' };

  assert.equal(pairOf(brallin, shabraz).length, 0, 'the named pair is legal');
  // The bug a single boolean would cause: any two named-partner cards pairing.
  assert.equal(pairOf(brallin, other).length, 1, 'unrelated named partners must not pair');
});

test('a Background pairs only with a card that chooses one', () => {
  const wilson = { name: 'Wilson, Refined Grizzly', partnerKind: 'choose_background' };
  const background = { name: 'Raised by Giants', partnerKind: 'background' };

  assert.equal(pairOf(wilson, background).length, 0);
  assert.equal(pairOf(background, wilson).length, 0, 'order must not matter');
  assert.equal(pairOf({ partnerKind: 'partner' }, background).length, 1,
    'plain Partner cannot take a Background');
});

test('Friends forever and Doctor’s companion pair on their own terms', () => {
  assert.equal(pairOf({ partnerKind: 'friends_forever' }, { partnerKind: 'friends_forever' }).length, 0);

  const companion = { name: 'Ace, Fearless Rebel', partnerKind: 'doctors_companion' };
  const doctor = { name: 'The Fourth Doctor', typeLine: 'Legendary Creature — Time Lord Doctor' };
  assert.equal(pairOf(companion, doctor).length, 0);
  assert.equal(pairOf(companion, { name: 'Not a Doctor', typeLine: 'Legendary Creature — Human' }).length, 1);
});

test('the four pairing mechanics do not interchange', () => {
  assert.equal(pairOf({ partnerKind: 'partner' }, { partnerKind: 'friends_forever' }).length, 1);
  assert.equal(pairOf({ partnerKind: 'doctors_companion' }, { partnerKind: 'partner' }).length, 1);
  assert.equal(pairOf({ partnerKind: null }, { partnerKind: null }).length, 1);
});

test('a single commander needs no pairing at all', () => {
  const result = validateDeck([commanderOf({ partnerKind: null }), ...filler(99)], COMMANDER);
  assert.equal(result.issues.filter((i) => i.code === 'invalid_pairing').length, 0);
});
