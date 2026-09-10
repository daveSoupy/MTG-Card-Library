import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, setSetting } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { TradeListStore } from '../tradelists/store.ts';
import { shoppingList, pushToWantList } from '../collection/shopping.ts';
import { DeckStore } from './store.ts';
import {
  allocationFor, availableFor, RESERVING_STATUSES, SlotOverfilledError,
  ALLOCATION_IGNORES_BASICS, BREWS_RESERVE_COPIES, TRADELIST_REDUCES_AVAILABLE,
} from './allocation.ts';

/**
 * Phase 22 — the four ways `available = owned - allocated` used to lie, and the
 * one module that now answers instead.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

const CARDS = [
  { id: 'o-ring', name: 'Sol Ring', type: 'Artifact', basic: 0 },
  { id: 'o-bolt', name: 'Lightning Bolt', type: 'Instant', basic: 0 },
  { id: 'o-island', name: 'Island', type: 'Basic Land — Island', basic: 1 },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  for (const [index, card] of CARDS.entries()) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,is_basic_land)
                VALUES (?,?,?,1,?,'x','normal',?)`)
      .run(card.id, card.name, card.name.toLowerCase(), card.type, card.basic);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
                VALUES (?,?,'tst',?,2)`).run(`p-${card.id}`, card.id, String(index));
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${card.id}`, card.id);
  }
  const locationId = (db.prepare('SELECT id FROM storage_locations LIMIT 1')
    .get() as { id: number }).id;
  return {
    db,
    decks: new DeckStore(db),
    collection: new CollectionStore(db),
    tradeLists: new TradeListStore(db),
    locationId,
  };
}

/** Puts `quantity` copies of a card on the shelf and returns the lot id. */
function own(
  collection: CollectionStore, locationId: number, oracleId: string, quantity: number,
): number {
  return collection.addLot({ printingId: `p-${oracleId}`, locationId, quantity });
}

const slot = (db: Database.Database, deckId: number, oracleId: string) =>
  db.prepare('SELECT * FROM deck_cards WHERE deck_id = ? AND oracle_id = ?')
    .get(deckId, oracleId) as any;

const cardIn = (decks: DeckStore, deckId: number, oracleId: string) =>
  decks.get(deckId)!.cards.find((c) => c.oracleId === oracleId)!;

// ---------------------------------------------------------------- deck status

test('only a deck in a reserving status consumes copies', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);

  // A format, because the validator skips every rule (over-allocation included)
  // for a deck that has not chosen one.
  const brew = decks.create({ name: '1am idea', formatCode: 'modern' });
  const real = decks.create({ name: 'The one I am building', formatCode: 'modern' });
  decks.addCard(brew, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });
  decks.addCard(real, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });

  // Both decks default to 'brew', so nothing is reserved yet.
  assert.equal(availableFor(db, 'o-ring'), 1);

  decks.update(real, { status: 'assembled' });
  assert.equal(availableFor(db, 'o-ring'), 0, 'the assembled deck holds the copy');

  // ...and from the brew's own point of view, the copy is spoken for.
  assert.equal(cardIn(decks, brew, 'o-ring').availableQuantity, 0);
  // But the assembled deck does not compete with itself.
  assert.equal(cardIn(decks, real, 'o-ring').availableQuantity, 1);

  // The brew is short, the assembled deck is not.
  assert.ok(decks.get(brew)!.validation.issues.some((i) => i.code === 'over_allocated'));
  assert.ok(!decks.get(real)!.validation.issues.some((i) => i.code === 'over_allocated'));
  db.close();
});

test('RESERVING_STATUSES is the whole of the rule, and brews can be added to it', () => {
  const { db, decks, collection, locationId } = fixture();
  assert.deepEqual([...RESERVING_STATUSES], ['building', 'assembled']);

  own(collection, locationId, 'o-ring', 2);
  const brew = decks.create({ name: 'Brew' });
  decks.addCard(brew, 'o-ring', { board: 'main', quantity: 2, fromCollection: 2 });
  assert.equal(availableFor(db, 'o-ring'), 2);

  setSetting(db, BREWS_RESERVE_COPIES, '1');
  assert.equal(availableFor(db, 'o-ring'), 0, 'the escape hatch restores the old behaviour');
  db.close();
});

test('a disassembled deck keeps its list and lets its cards go', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-bolt', 4);
  const deck = decks.create({ name: 'Burn' });
  decks.addCard(deck, 'o-bolt', { board: 'main', quantity: 4, fromCollection: 4 });
  decks.update(deck, { status: 'assembled' });
  assert.equal(availableFor(db, 'o-bolt'), 0);

  decks.update(deck, { status: 'disassembled' });
  assert.equal(availableFor(db, 'o-bolt'), 4, 'the cards went back');
  assert.equal(decks.get(deck)!.cards.length, 1, 'the list stayed');
  db.close();
});

test('a status round trip leaves every claim byte-identical', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 2);
  own(collection, locationId, 'o-bolt', 1);

  const deck = decks.create({ name: 'Round trip' });
  decks.update(deck, { status: 'assembled' });
  decks.addCard(deck, 'o-ring', { board: 'main', quantity: 2, fromCollection: 2 });
  decks.addCard(deck, 'o-bolt', { board: 'main', quantity: 4, fromCollection: 1 });

  const before = db.prepare(
    'SELECT id, quantity, quantity_from_collection, quantity_proxied FROM deck_cards WHERE deck_id = ? ORDER BY id',
  ).all(deck);

  decks.update(deck, { status: 'brew' });
  decks.update(deck, { status: 'assembled' });

  const after = db.prepare(
    'SELECT id, quantity, quantity_from_collection, quantity_proxied FROM deck_cards WHERE deck_id = ? ORDER BY id',
  ).all(deck);
  assert.deepEqual(after, before, 'status must never rewrite an allocation');
  db.close();
});

test('a status change stamps status_changed_at, and a no-op change does not', () => {
  const { db, decks } = fixture();
  const deck = decks.create({ name: 'Stamped' });
  assert.equal((db.prepare('SELECT status_changed_at AS at FROM decks WHERE id = ?')
    .get(deck) as any).at, null, 'a new deck has never moved');

  decks.update(deck, { status: 'building' });
  const stamped = (db.prepare('SELECT status_changed_at AS at FROM decks WHERE id = ?')
    .get(deck) as any).at;
  assert.ok(stamped, 'a real move is stamped');

  decks.update(deck, { status: 'building', name: 'Renamed' });
  assert.equal((db.prepare('SELECT status_changed_at AS at FROM decks WHERE id = ?')
    .get(deck) as any).at, stamped, 're-asserting the same status is not a move');
  db.close();
});

test('a duplicate starts as a brew, carrying its claims but not its reservation', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  const source = decks.create({ name: 'Original' });
  decks.update(source, { status: 'assembled' });
  decks.addCard(source, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });

  const copy = decks.duplicate(source);
  assert.equal(decks.get(copy)!.status, 'brew');
  assert.equal(slot(db, copy, 'o-ring').quantity_from_collection, 1, 'the claim came across');
  assert.equal(availableFor(db, 'o-ring'), 0, 'and the copy did not double-book it');
  db.close();
});

// ---------------------------------------------------------------- basic lands

test('a Commander deck of basics reports nothing missing and wants nothing', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  const deck = decks.create({ name: 'Islands', formatCode: 'commander' });
  decks.addCard(deck, 'o-island', { board: 'main', quantity: 38 });
  decks.addCard(deck, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });

  const island = cardIn(decks, deck, 'o-island');
  assert.equal(island.allocationTracked, false);
  assert.equal(decks.get(deck)!.stats.needToBuyCount, 0, '38 Islands are not 38 missing cards');

  const list = shoppingList(db, deck)!;
  assert.ok(!list.entries.some((e) => e.oracleId === 'o-island'));
  assert.equal(list.totalCards, 0);

  pushToWantList(db, deck);
  const wanted = db.prepare('SELECT oracle_id FROM want_list_items').all() as any[];
  assert.deepEqual(wanted, [], 'a basic land never lands on a want list');
  db.close();
});

test('basics reserve nothing, so two decks can both play the same Islands', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-island', 10);

  const first = decks.create({ name: 'Deck one', formatCode: 'modern' });
  const second = decks.create({ name: 'Deck two', formatCode: 'modern' });
  for (const deck of [first, second]) {
    decks.update(deck, { status: 'assembled' });
    decks.addCard(deck, 'o-island', { board: 'main', quantity: 8, fromCollection: 8 });
  }

  const allocation = allocationFor(db, 'o-island');
  assert.equal(allocation.tracked, false);
  assert.equal(allocation.reserved, 0);
  assert.equal(allocation.available, 10);
  assert.ok(!decks.get(first)!.validation.issues.some((i) => i.code === 'over_allocated'));

  // Turning the exemption off makes them ordinary cards again, and the 16
  // claims against 10 copies become the shortfall they always were.
  setSetting(db, ALLOCATION_IGNORES_BASICS, '0');
  assert.equal(allocationFor(db, 'o-island').reserved, 16);
  assert.ok(decks.get(first)!.validation.issues.some((i) => i.code === 'over_allocated'));
  db.close();
});

// -------------------------------------------------------------------- proxies

test('a proxied copy satisfies a slot without being owned or bought', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-bolt', 1);

  const deck = decks.create({ name: 'Proxy pile' });
  decks.update(deck, { status: 'building' });
  decks.addCard(deck, 'o-bolt', { board: 'main', quantity: 4, fromCollection: 1 });
  const cardId = slot(db, deck, 'o-bolt').id;
  decks.setProxied(deck, cardId, 2);

  const card = cardIn(decks, deck, 'o-bolt');
  assert.equal(card.quantityFromCollection, 1);
  assert.equal(card.quantityProxied, 2);
  assert.equal(decks.get(deck)!.stats.needToBuyCount, 1, '4 - 1 owned - 2 proxied');
  assert.equal(decks.get(deck)!.stats.proxiedCount, 2);

  const list = shoppingList(db, deck)!;
  assert.equal(list.entries.find((e) => e.oracleId === 'o-bolt')!.needed, 1);

  // A proxy is not a claim on the collection: the one real copy is still the
  // only one reserved.
  assert.equal(allocationFor(db, 'o-bolt').reserved, 1);
  db.close();
});

test('claiming and proxying more copies than the slot holds is refused, not clamped', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-bolt', 4);
  const deck = decks.create({ name: 'Overfilled' });
  decks.addCard(deck, 'o-bolt', { board: 'main', quantity: 4, fromCollection: 3 });
  const cardId = slot(db, deck, 'o-bolt').id;

  assert.throws(() => decks.setProxied(deck, cardId, 2), SlotOverfilledError);
  assert.equal(slot(db, deck, 'o-bolt').quantity_proxied, 0, 'the failed write changed nothing');

  // Both fields at once, so a swap is judged as one move rather than two.
  decks.setSlotAllocation(deck, cardId, { fromCollection: 2, proxied: 2 });
  assert.equal(slot(db, deck, 'o-bolt').quantity_from_collection, 2);
  assert.equal(slot(db, deck, 'o-bolt').quantity_proxied, 2);
  db.close();
});

test('shrinking a slot clamps both halves, keeping real copies ahead of proxies', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-bolt', 4);
  const deck = decks.create({ name: 'Shrinking' });
  decks.addCard(deck, 'o-bolt', { board: 'main', quantity: 4, fromCollection: 2 });
  const cardId = slot(db, deck, 'o-bolt').id;
  decks.setProxied(deck, cardId, 2);

  decks.setQuantity(deck, cardId, 3);
  const row = slot(db, deck, 'o-bolt');
  assert.equal(row.quantity_from_collection, 2);
  assert.equal(row.quantity_proxied, 1);

  decks.setQuantity(deck, cardId, 1);
  const smaller = slot(db, deck, 'o-bolt');
  assert.equal(smaller.quantity_from_collection, 1);
  assert.equal(smaller.quantity_proxied, 0);
  db.close();
});

// ----------------------------------------------------------------- trade list

test('a copy on a trade list is not a copy you can build with', () => {
  const { db, collection, tradeLists, locationId } = fixture();
  const lot = own(collection, locationId, 'o-ring', 2);
  const list = tradeLists.lists().find((l: any) => l.is_default)!.id;
  tradeLists.addItem(list, lot, { quantity: 1 });

  const withList = allocationFor(db, 'o-ring');
  assert.equal(withList.owned, 2);
  assert.equal(withList.tradeListed, 1);
  assert.equal(withList.available, 1);

  setSetting(db, TRADELIST_REDUCES_AVAILABLE, '0');
  assert.equal(allocationFor(db, 'o-ring').available, 2, 'off, it is only a badge');
  assert.equal(allocationFor(db, 'o-ring').tradeListed, 1, 'still reported either way');

  setSetting(db, TRADELIST_REDUCES_AVAILABLE, '1');
  tradeLists.removeItem(tradeLists.get(list)!.items[0].id);
  assert.equal(allocationFor(db, 'o-ring').available, 2, 'and it comes back when delisted');
  db.close();
});

test('available floors at zero rather than going negative', () => {
  const { db, decks, collection, tradeLists, locationId } = fixture();
  const lot = own(collection, locationId, 'o-ring', 1);
  const list = tradeLists.lists().find((l: any) => l.is_default)!.id;
  tradeLists.addItem(list, lot, { quantity: 1 });

  const deck = decks.create({ name: 'Wants it too' });
  decks.addCard(deck, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });
  decks.update(deck, { status: 'assembled' });

  const allocation = allocationFor(db, 'o-ring');
  assert.equal(allocation.available, 0, 'owned 1 - reserved 1 - listed 1 is 0, never -1');
  assert.equal(allocation.reserved, 1);
  assert.equal(allocation.tradeListed, 1);
  db.close();
});

// ------------------------------------------------------------------ locations

test('a lot in an archived location is off the shelf until the location comes back', () => {
  const { db, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 3);
  assert.equal(allocationFor(db, 'o-ring').owned, 3);

  db.prepare('UPDATE storage_locations SET is_archived = 1 WHERE id = ?').run(locationId);
  assert.equal(allocationFor(db, 'o-ring').owned, 0);
  assert.equal(allocationFor(db, 'o-ring').available, 0);

  db.prepare('UPDATE storage_locations SET is_archived = 0 WHERE id = ?').run(locationId);
  assert.equal(allocationFor(db, 'o-ring').owned, 3, 'unarchiving brings it back');
  db.close();
});

// ------------------------------------------------------------------ migration

test('every existing deck upgrades to assembled, and the numbers do not move', async () => {
  const { MIGRATIONS } = await import('../db/migrations.ts');
  const v18 = MIGRATIONS.find((m) => m.version === 18)!;
  assert.ok(v18, 'expected a v18 migration');

  const db = new Database(':memory:');
  db.exec(SCHEMA);
  // Rewind to just before v18: the columns are what the migration adds.
  db.exec('DROP VIEW IF EXISTS v_card_deck_usage');
  db.exec('DROP INDEX IF EXISTS idx_decks_status');
  db.exec('ALTER TABLE decks DROP COLUMN status_changed_at');
  db.exec('ALTER TABLE decks DROP COLUMN status');
  db.exec('ALTER TABLE deck_cards DROP COLUMN quantity_proxied');
  db.exec('ALTER TABLE deck_snapshot_cards DROP COLUMN quantity_proxied');
  db.pragma('user_version = 17');

  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                oracle_text_all,layout) VALUES ('o-ring','Sol Ring','sol ring',1,'Artifact','x','normal')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
              VALUES ('p-o-ring','o-ring','tst','1',2)`).run();
  const locationId = (db.prepare('SELECT id FROM storage_locations LIMIT 1')
    .get() as { id: number }).id;
  db.prepare(`INSERT INTO collection_items (printing_id, location_id, quantity)
              VALUES ('p-o-ring', ?, 3)`).run(locationId);
  for (const name of ['One', 'Two', 'Three']) {
    const deck = db.prepare('INSERT INTO decks (name) VALUES (?)').run(name);
    db.prepare(`INSERT INTO deck_cards (deck_id, oracle_id, board, quantity, quantity_from_collection)
                VALUES (?, 'o-ring', 'main', 1, 1)`).run(Number(deck.lastInsertRowid));
  }

  // The pre-migration answer, by the old rule: 3 owned - 3 claimed.
  const before = 3 - (db.prepare(
    `SELECT SUM(quantity_from_collection) AS n FROM deck_cards WHERE board IN ('main','side','command')`,
  ).get() as { n: number }).n;

  db.exec(v18.sql);
  db.pragma('user_version = 18');

  const decks = db.prepare('SELECT status, status_changed_at FROM decks').all() as any[];
  assert.equal(decks.length, 3);
  assert.ok(decks.every((d) => d.status === 'assembled'), 'every existing deck still reserves');
  assert.ok(decks.every((d) => d.status_changed_at), 'and is stamped rather than left NULL');

  // The trade-list rule is the one setting that intentionally changes numbers,
  // so it is held off for the comparison.
  setSetting(db, TRADELIST_REDUCES_AVAILABLE, '0');
  assert.equal(availableFor(db, 'o-ring'), before, 'the upgrade moved no number');
  db.close();
});
