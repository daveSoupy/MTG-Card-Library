import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from './store.ts';

/**
 * Cost-basis assumptions at add time: each method resolves to the right
 * per-copy acquired_unit_cost, a box pool splits a lump sum evenly, and a
 * typed-in cost always wins over the method.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('o','Bolt','bolt',1,'Instant','x','normal')`).run();
  // Priced printing (nonfoil $2, foil $9) and a printing with no price at all.
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity,price_usd,price_usd_foil)
              VALUES ('priced','o','tst','1','rare',2,9)`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity,price_usd,price_usd_foil)
              VALUES ('unpriced','o','tst','2','rare',NULL,NULL)`).run();
  const loc = (db.prepare('SELECT id FROM storage_locations LIMIT 1').get() as { id: number }).id;
  return { db, store: new CollectionStore(db), loc };
}

const costOf = (db: Database.Database, id: number) =>
  (db.prepare('SELECT acquired_unit_cost AS c FROM collection_items WHERE id = ?').get(id) as { c: number | null }).c;

test('free records a zero cost basis', () => {
  const { db, store, loc } = fixture();
  const id = store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, costMethod: 'free' });
  assert.equal(costOf(db, id), 0);
  db.close();
});

test('unknown records no cost basis', () => {
  const { db, store, loc } = fixture();
  const id = store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, costMethod: 'unknown' });
  assert.equal(costOf(db, id), null);
  db.close();
});

test('fixed records the configured amount', () => {
  const { db, store, loc } = fixture();
  const id = store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, costMethod: 'fixed', fixedAmount: 0.5 });
  assert.equal(costOf(db, id), 0.5);
  db.close();
});

test('market snapshots the printing price, finish-aware', () => {
  const { db, store, loc } = fixture();
  const plain = store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, finish: 'nonfoil', costMethod: 'market' });
  const foil = store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, finish: 'foil', costMethod: 'market' });
  assert.equal(costOf(db, plain), 2);
  assert.equal(costOf(db, foil), 9);
  db.close();
});

test('market falls back to unknown when the printing has no price', () => {
  const { db, store, loc } = fixture();
  const id = store.addLot({ printingId: 'unpriced', locationId: loc, quantity: 1, costMethod: 'market' });
  assert.equal(costOf(db, id), null);
  db.close();
});

test('an explicit cost overrides the method', () => {
  const { db, store, loc } = fixture();
  const id = store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, costMethod: 'market', acquiredUnitCost: 0 });
  assert.equal(costOf(db, id), 0, 'the typed-in 0 wins over market $2');
  db.close();
});

test('a box pool splits its total evenly and re-splits as copies are added', () => {
  const { db, store, loc } = fixture();
  const batchId = store.openCostPool({ totalCostUsd: 120 });

  // First card in the box: whole total on the one copy.
  const a = store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, costMethod: 'box', importBatchId: batchId });
  assert.equal(costOf(db, a), 120);

  // Add three more copies of a different printing: 120 / 4 = 30 each, everywhere.
  const b = store.addLot({ printingId: 'unpriced', locationId: loc, quantity: 3, costMethod: 'box', importBatchId: batchId });
  assert.equal(costOf(db, a), 30);
  assert.equal(costOf(db, b), 30);

  // Total cost basis across the pool equals the lump sum.
  const total = (db.prepare(
    'SELECT ROUND(SUM(quantity * acquired_unit_cost), 2) AS t FROM collection_items WHERE import_batch_id = ?',
  ).get(batchId) as { t: number }).t;
  assert.equal(total, 120);
  db.close();
});

test('box adds of the same card merge into one lot despite the moving cost', () => {
  const { db, store, loc } = fixture();
  const batchId = store.openCostPool({ totalCostUsd: 10 });
  store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, finish: 'nonfoil', condition: 'NM', costMethod: 'box', importBatchId: batchId });
  store.addLot({ printingId: 'priced', locationId: loc, quantity: 1, finish: 'nonfoil', condition: 'NM', costMethod: 'box', importBatchId: batchId });
  const rows = db.prepare('SELECT quantity, acquired_unit_cost AS c FROM collection_items WHERE import_batch_id = ?').all(batchId) as Array<{ quantity: number; c: number }>;
  assert.equal(rows.length, 1, 'the two taps merged');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].c, 5, '10 / 2 copies');
  db.close();
});
