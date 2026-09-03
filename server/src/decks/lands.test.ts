import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { setSetting } from '../db/index.ts';
import { DeckStore, AUTO_MAINTAIN_LANDS } from './store.ts';
import { planBasics, recommendedLandTotal, type BasicLand } from './lands.ts';
import type { DeckCard, FormatRules } from './types.ts';

/**
 * Recommending a basic-land base.
 *
 * Two layers: the pure planner (planBasics / recommendedLandTotal), tested with
 * hand-built cards, and the store methods that resolve real basics and apply the
 * plan, tested against the schema.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

// -- pure planner --------------------------------------------------------------

const card = (over: Partial<DeckCard>): DeckCard => ({
  id: 0, oracleId: 'x', name: 'x', board: 'main', quantity: 1, quantityFromCollection: 0,
  commanderRole: null, category: null, sortOrder: 0, cmc: 0, typeLine: 'Creature',
  manaCost: null, colorIdentity: '', colorIdentityMask: 0, colorsMask: 0, isBasicLand: false,
  isLegendary: false, canBeCommander: false, hasUncommonPrinting: false, producedMana: [],
  partnerKind: null, partnerWith: null, legality: null, ownedQuantity: 0, availableQuantity: 0,
  printingId: null, setCode: null, rarity: null, imageSmall: null, priceUsd: null, ...over,
});

const BASICS: BasicLand[] = [
  { color: 'W', oracleId: 'plains' }, { color: 'U', oracleId: 'island' },
  { color: 'B', oracleId: 'swamp' }, { color: 'R', oracleId: 'mountain' },
  { color: 'G', oracleId: 'forest' }, { color: 'C', oracleId: 'wastes' },
];

const rules = (over: Partial<FormatRules>): FormatRules => ({
  code: 'modern', displayName: 'Modern', minDeckSize: 60, exactDeckSize: null, maxCopies: 4,
  basicsExempt: true, isSingleton: false, sideboardSize: 15, requiresCommander: false,
  enforcesColorIdentity: false, commanderKind: 'legendary', usesSignatureSpell: false, ...over,
});

const desiredFor = (targets: ReturnType<typeof planBasics>, oracleId: string) =>
  targets.find((t) => t.oracleId === oracleId)?.desired ?? 0;

test('recommended land total follows the format size', () => {
  assert.equal(recommendedLandTotal(rules({}), []), 24);                          // 60 * 0.4
  assert.equal(recommendedLandTotal(rules({ exactDeckSize: 100 }), []), 37);      // 100 * 0.37
});

test('a mono-red deck is planned all Mountains', () => {
  const deck = [card({ manaCost: '{R}{R}', quantity: 10 })];
  const targets = planBasics(deck, rules({}), BASICS);
  assert.equal(desiredFor(targets, 'mountain'), 24);
  for (const other of ['plains', 'island', 'swamp', 'forest', 'wastes']) {
    assert.equal(desiredFor(targets, other), 0);
  }
});

test('an even four-colour deck splits by pip share', () => {
  const deck = [
    card({ manaCost: '{W}' }), card({ manaCost: '{U}' }),
    card({ manaCost: '{B}' }), card({ manaCost: '{G}' }),
  ];
  const targets = planBasics(deck, rules({}), BASICS);
  // 24 across four equal colours: 6 each, and none of the untouched colours.
  for (const oracleId of ['plains', 'island', 'swamp', 'forest']) {
    assert.equal(desiredFor(targets, oracleId), 6);
  }
  assert.equal(desiredFor(targets, 'mountain'), 0);
  const total = targets.reduce((n, t) => n + t.desired, 0);
  assert.equal(total, 24);
});

test('non-basic lands already in the deck shrink the basic budget', () => {
  const spells = card({ manaCost: '{R}', quantity: 10 });
  const shock = card({ oracleId: 'shock', typeLine: 'Land', producedMana: ['B', 'R'], quantity: 4 });
  const targets = planBasics([spells, shock], rules({}), BASICS);
  // 24 target minus 4 non-basic lands leaves 20 basics.
  assert.equal(desiredFor(targets, 'mountain'), 20);
});

test('a deck already at the land count is planned no basics', () => {
  const spells = card({ manaCost: '{R}', quantity: 10 });
  const manyLands = card({ oracleId: 'cave', typeLine: 'Land', producedMana: ['R'], quantity: 30 });
  const targets = planBasics([spells, manyLands], rules({}), BASICS);
  assert.equal(targets.reduce((n, t) => n + t.desired, 0), 0);
});

test('a colourless deck is planned Wastes', () => {
  const deck = [card({ manaCost: '{4}', quantity: 10, colorIdentity: '' })];
  const targets = planBasics(deck, rules({}), BASICS);
  assert.equal(desiredFor(targets, 'wastes'), 24);
});

// -- store integration ---------------------------------------------------------

interface Fixture {
  id: string; name: string; type: string; cost?: string | null;
  produced?: string[]; basic?: boolean;
}

const CARDS: Fixture[] = [
  { id: 'plains', name: 'Plains', type: 'Basic Land — Plains', produced: ['W'], basic: true },
  { id: 'island', name: 'Island', type: 'Basic Land — Island', produced: ['U'], basic: true },
  { id: 'swamp', name: 'Swamp', type: 'Basic Land — Swamp', produced: ['B'], basic: true },
  { id: 'mountain', name: 'Mountain', type: 'Basic Land — Mountain', produced: ['R'], basic: true },
  { id: 'forest', name: 'Forest', type: 'Basic Land — Forest', produced: ['G'], basic: true },
  { id: 'wastes', name: 'Wastes', type: 'Basic Land', produced: ['C'], basic: true },
  { id: 'shock', name: 'Blood Crypt', type: 'Land', produced: ['B', 'R'] },
  { id: 'goblin', name: 'Goblin Guide', type: 'Creature — Goblin', cost: '{R}' },
  { id: 'bolt', name: 'Lightning Bolt', type: 'Instant', cost: '{R}' },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  CARDS.forEach((c, i) => {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,mana_cost,produced_mana,is_basic_land)
                VALUES (?,?,?,1,?,'x','normal',?,?,?)`)
      .run(c.id, c.name, c.name.toLowerCase(), c.type, c.cost ?? null,
           c.produced ? JSON.stringify(c.produced) : null, c.basic ? 1 : 0);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity)
                VALUES (?,?,'tst',?,'common')`).run(`p-${i}`, c.id, String(i));
    db.prepare('UPDATE oracle_cards SET default_printing_id=? WHERE oracle_id=?').run(`p-${i}`, c.id);
  });
  return { db, decks: new DeckStore(db) };
}

const quantityOf = (decks: DeckStore, id: number, oracleId: string) =>
  decks.get(id)!.cards.find((c) => c.oracleId === oracleId && c.board === 'main')?.quantity ?? 0;

test('the button fills a mono-red deck with Mountains', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Burn', formatCode: 'modern' });
  decks.addCard(id, 'goblin', { board: 'main', quantity: 20 });
  decks.applyRecommendedLands(id);
  assert.equal(quantityOf(decks, id, 'mountain'), 24);
  db.close();
});

test('the button is additive and counts non-basic lands', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Rakdos', formatCode: 'modern' });
  decks.addCard(id, 'bolt', { board: 'main', quantity: 20 });
  decks.addCard(id, 'shock', { board: 'main', quantity: 4 });
  decks.applyRecommendedLands(id);
  // 24 target, 4 already non-basic, so 20 Mountains.
  assert.equal(quantityOf(decks, id, 'mountain'), 20);
  db.close();
});

test('auto-maintain does nothing while off', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Burn', formatCode: 'modern' });
  decks.addCard(id, 'goblin', { board: 'main', quantity: 20 });
  decks.autoMaintainLands(id, 'goblin');
  assert.equal(quantityOf(decks, id, 'mountain'), 0);
  db.close();
});

test('auto-maintain tops up and then trims when a dual arrives', () => {
  const { db, decks } = fixture();
  setSetting(db, AUTO_MAINTAIN_LANDS, '1');
  const id = decks.create({ name: 'Burn', formatCode: 'modern' });

  decks.addCard(id, 'goblin', { board: 'main', quantity: 20 });
  decks.autoMaintainLands(id, 'goblin');
  assert.equal(quantityOf(decks, id, 'mountain'), 24);

  // A non-basic land arrives; the basics give way, capped at the same total.
  decks.addCard(id, 'shock', { board: 'main', quantity: 4 });
  decks.autoMaintainLands(id, 'shock');
  assert.equal(quantityOf(decks, id, 'mountain'), 20);
  db.close();
});

test('auto-maintain leaves a near-empty deck alone', () => {
  const { db, decks } = fixture();
  setSetting(db, AUTO_MAINTAIN_LANDS, '1');
  const id = decks.create({ name: 'Seedling', formatCode: 'modern' });
  decks.addCard(id, 'goblin', { board: 'main', quantity: 3 });
  decks.autoMaintainLands(id, 'goblin');
  assert.equal(quantityOf(decks, id, 'mountain'), 0);
  db.close();
});

test('auto-maintain ignores a basic-land edit', () => {
  const { db, decks } = fixture();
  setSetting(db, AUTO_MAINTAIN_LANDS, '1');
  const id = decks.create({ name: 'Burn', formatCode: 'modern' });
  decks.addCard(id, 'goblin', { board: 'main', quantity: 20 });
  // Editing a basic must not trigger a rebalance that overrides the hand-set count.
  decks.addCard(id, 'mountain', { board: 'main', quantity: 5 });
  decks.autoMaintainLands(id, 'mountain');
  assert.equal(quantityOf(decks, id, 'mountain'), 5);
  db.close();
});
