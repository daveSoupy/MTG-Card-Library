import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from './store.ts';

/**
 * The undo for tap-to-add: remove one plainly-added copy, without ever eating a
 * lot that carries a purchase price.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('o','Bolt','bolt',1,'Instant','x','normal')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity,price_usd)
              VALUES ('p','o','tst','1','rare',2)`).run();
  const loc = (db.prepare('SELECT id FROM storage_locations LIMIT 1').get() as { id: number }).id;
  return { db, store: new CollectionStore(db), loc };
}

const owned = (db: Database.Database) =>
  (db.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM collection_items').get() as { n: number }).n;

test('decrement takes one copy, then deletes the lot at zero', () => {
  const { db, store, loc } = fixture();
  store.addLot({ printingId: 'p', locationId: loc, quantity: 2, condition: 'NM' });

  assert.equal(store.decrementCopy({ printingId: 'p', locationId: loc, condition: 'NM' }), 1);
  assert.equal(owned(db), 1);
  assert.equal(store.decrementCopy({ printingId: 'p', locationId: loc, condition: 'NM' }), 0);
  assert.equal(owned(db), 0);
  // Nothing left to remove.
  assert.equal(store.decrementCopy({ printingId: 'p', locationId: loc, condition: 'NM' }), null);
  db.close();
});

test('decrement never touches a lot with a known cost', () => {
  const { db, store, loc } = fixture();
  // A purchased lot (has a cost basis) — an undo must not erase that history.
  store.addLot({ printingId: 'p', locationId: loc, quantity: 1, condition: 'NM', acquiredUnitCost: 5 });
  assert.equal(store.decrementCopy({ printingId: 'p', locationId: loc, condition: 'NM' }), null);
  assert.equal(owned(db), 1, 'the priced copy is left alone');
  db.close();
});
