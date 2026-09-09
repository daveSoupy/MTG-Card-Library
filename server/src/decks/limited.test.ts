import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { DeckStore } from './store.ts';

/**
 * Phase 11's two limited-format rules: draft and sealed decks are never checked
 * for legality (Scryfall publishes none for them), and adding a card to one is
 * an acquisition as well as a deck slot — except for basic lands, which come
 * from the venue's land station rather than out of the packs.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

const CARDS = [
  { id: 'o-bolt', name: 'Lightning Bolt', type: 'Instant', basic: 0 },
  { id: 'o-ghoul', name: 'Vault Ghoul', type: 'Creature — Zombie', basic: 0 },
  { id: 'o-cave', name: 'Evolving Wilds', type: 'Land', basic: 0 },
  { id: 'o-mountain', name: 'Mountain', type: 'Basic Land — Mountain', basic: 1 },
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
                VALUES (?,?,'tst',?,1)`).run(`p-${card.id}`, card.id, String(index));
    // A second printing, so "the printing the client was looking at" is a real
    // choice rather than the only option.
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
                VALUES (?,?,'tst',?,1)`).run(`alt-${card.id}`, card.id, `${index}b`);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${card.id}`, card.id);

    // Every card is "not legal" everywhere the app knows about, which is what a
    // real database looks like from a draft deck's point of view: there is no
    // 'draft' row to find.
    db.prepare(`INSERT INTO card_legalities (oracle_id, format_code, legality)
                VALUES (?, 'commander', 'not_legal')`).run(card.id);
  }
  return { db, decks: new DeckStore(db), collection: new CollectionStore(db) };
}

const lots = (db: Database.Database, oracleId: string) =>
  db.prepare(`SELECT ci.* FROM collection_items ci
              JOIN card_printings p ON p.id = ci.printing_id
              WHERE p.oracle_id = ?`).all(oracleId) as any[];

test('a draft deck validates with no legality errors, whatever it holds', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'FDN Draft', formatCode: 'draft' });
  decks.addCard(id, 'o-bolt', { board: 'main', quantity: 4 });
  decks.addCard(id, 'o-ghoul', { board: 'main', quantity: 3 });

  const validation = decks.get(id)!.validation;
  assert.equal(validation.formatName, 'Draft');
  assert.deepEqual(
    validation.issues.filter((i) => ['banned', 'not_legal'].includes(i.code)),
    [],
    'no card in a draft deck is judged against legality it cannot have',
  );
  // Four copies of one common is legal in limited — the format's copy limit
  // must not be the constructed four-of rule dressed up.
  assert.deepEqual(validation.issues.filter((i) => i.code === 'copy_limit'), []);
  db.close();
});

test('the same cards in a commander deck are still reported as illegal', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'EDH', formatCode: 'commander' });
  decks.addCard(id, 'o-bolt', { board: 'main', quantity: 1 });
  assert.ok(
    decks.get(id)!.validation.issues.some((i) => i.code === 'not_legal'),
    'the skip is limited to limited, not a hole in the legality check',
  );
  db.close();
});

test('adding a card to a draft deck buys it and allocates it', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'FDN Draft', formatCode: 'draft' });
  decks.addCard(id, 'o-ghoul', { board: 'main', quantity: 2 });

  const rows = lots(db, 'o-ghoul');
  assert.equal(rows.length, 1, 'one lot for the copies opened');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].acquisition_kind, 'pull');

  const slot = decks.get(id)!.cards.find((c) => c.oracleId === 'o-ghoul')!;
  assert.equal(slot.quantity, 2);
  assert.equal(slot.quantityFromCollection, 2, 'allocated from the lot just created');
  assert.equal(slot.ownedQuantity, 2);
  db.close();
});

test('basic lands in a draft deck are a slot and nothing more', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'FDN Draft', formatCode: 'draft' });
  decks.addCard(id, 'o-mountain', { board: 'main', quantity: 8 });

  assert.deepEqual(lots(db, 'o-mountain'), [], 'basics come from the land station');
  const slot = decks.get(id)!.cards.find((c) => c.oracleId === 'o-mountain')!;
  assert.equal(slot.quantity, 8);
  assert.equal(slot.quantityFromCollection, 0, 'nothing to allocate from');
  db.close();
});

test('a non-basic land follows the ordinary acquire-and-allocate path', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'FDN Draft', formatCode: 'draft' });
  decks.addCard(id, 'o-cave', { board: 'main', quantity: 1 });
  assert.equal(lots(db, 'o-cave').length, 1, 'only *basic* lands are exempt');
  db.close();
});

test('adding a card to a commander deck creates no collection row', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'EDH', formatCode: 'commander' });
  decks.addCard(id, 'o-ghoul', { board: 'main', quantity: 1 });
  assert.deepEqual(lots(db, 'o-ghoul'), [], 'unchanged behaviour outside limited');
  db.close();
});

test("copies land in the deck's home location when it has one", () => {
  const { db, decks } = fixture();
  const binder = db.prepare(`INSERT INTO storage_locations (name, kind) VALUES ('Draft box','box')`)
    .run().lastInsertRowid;
  const id = decks.create({ name: 'FDN Draft', formatCode: 'draft' });
  db.prepare('UPDATE decks SET home_location_id = ? WHERE id = ?').run(binder, id);

  decks.addCard(id, 'o-ghoul', { board: 'main', quantity: 1 });
  assert.equal(lots(db, 'o-ghoul')[0].location_id, Number(binder));

  // With no home set, the default bucket takes them instead.
  const other = decks.create({ name: 'Sealed pool', formatCode: 'sealed' });
  decks.addCard(other, 'o-bolt', { board: 'main', quantity: 1 });
  const fallback = db.prepare('SELECT id FROM storage_locations WHERE is_default = 1').get() as { id: number };
  assert.equal(lots(db, 'o-bolt')[0].location_id, fallback.id);
  db.close();
});

test('an open cost pool claims the cards a limited deck buys', () => {
  const { db, decks, collection } = fixture();
  const pool = collection.openCostPool({ totalCostUsd: 12, label: 'Draft' });
  const id = decks.create({ name: 'FDN Draft', formatCode: 'draft' });

  decks.addCard(id, 'o-ghoul', { board: 'main', quantity: 2 });
  decks.addCard(id, 'o-bolt', { board: 'side', quantity: 1 });
  // Basics never join the pool, so they cannot dilute what the packs cost.
  decks.addCard(id, 'o-mountain', { board: 'main', quantity: 9 });

  const open = collection.currentCostPool();
  assert.equal(open?.id, pool.id);
  assert.equal(open?.cardCount, 3, 'two Ghouls and a Bolt, no Mountains');
  assert.equal(open?.perCopy, 4, '12 / 3');
  assert.equal(lots(db, 'o-ghoul')[0].acquired_unit_cost, 4);
  db.close();
});

test('the printing the client names is the one bought and the one pinned', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'FDN Draft', formatCode: 'draft' });
  decks.addCard(id, 'o-ghoul', { board: 'main', quantity: 1, printingId: 'alt-o-ghoul' });

  assert.equal(lots(db, 'o-ghoul')[0].printing_id, 'alt-o-ghoul');
  const pinned = db.prepare(
    'SELECT preferred_printing_id AS p FROM deck_cards WHERE deck_id = ? AND oracle_id = ?',
  ).get(id, 'o-ghoul') as { p: string | null };
  assert.equal(pinned.p, 'alt-o-ghoul');
  db.close();
});

test('a stated allocation — an undo or a restore — never buys the cards twice', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'FDN Draft', formatCode: 'draft' });
  decks.addCard(id, 'o-ghoul', { board: 'main', quantity: 1 });
  const card = decks.get(id)!.cards.find((c) => c.oracleId === 'o-ghoul')!;

  // Remove and put back the way the undo stack does, allocation included.
  decks.removeCard(id, card.id);
  decks.addCard(id, 'o-ghoul', { board: 'main', quantity: 1, fromCollection: 1 });

  const rows = lots(db, 'o-ghoul');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 1, 'the copies bought the first time are the same copies');
  db.close();
});
