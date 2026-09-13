import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from './store.ts';
import { lotKey, type LotIdentity } from '../decks/assembly.ts';

/**
 * addLot's merge predicate agrees with assembly's `lotKey`: two adds land in
 * one row exactly when every identity column matches, and provenance — who
 * the copies came from, how, and any note — is part of that identity. Merging
 * across it would silently drop the note and misattribute the copy, and the
 * fold could never be undone.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('o','Sol Ring','sol ring',1,'Artifact','x','normal')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity,price_usd)
              VALUES ('p','o','tst','1','uncommon',2)`).run();
  const loc = (db.prepare('SELECT id FROM storage_locations LIMIT 1').get() as { id: number }).id;
  return { db, store: new CollectionStore(db), loc };
}

interface Row {
  id: number; quantity: number; printing_id: string; finish: string; condition: string;
  language: string; price_override: number | null; is_signed: number; is_altered: number;
  notes: string | null; acquired_at: string | null; acquired_unit_cost: number | null;
  acquisition_kind: string; acquired_from: string | null; acquired_trade_id: number | null;
  import_batch_id: number | null;
}

const lots = (db: Database.Database): Row[] =>
  db.prepare('SELECT * FROM collection_items ORDER BY id').all() as Row[];

/** The same mapping assembly's private `identityOf` performs, for the contract check. */
function identityOf(row: Row): LotIdentity {
  return {
    printingId: row.printing_id, finish: row.finish as any, condition: row.condition as any,
    language: row.language, priceOverride: row.price_override, isSigned: row.is_signed,
    isAltered: row.is_altered, notes: row.notes, acquiredAt: row.acquired_at,
    acquiredUnitCost: row.acquired_unit_cost, acquisitionKind: row.acquisition_kind,
    acquiredFrom: row.acquired_from, acquiredTradeId: row.acquired_trade_id,
    importBatchId: row.import_batch_id,
  };
}

const base = (loc: number) => ({
  printingId: 'p', locationId: loc, quantity: 1, acquiredUnitCost: 1,
  acquisitionKind: 'purchase' as const, acquiredFrom: 'Bob', notes: null,
});

test('identical provenance still merges into one lot', () => {
  const { db, store, loc } = fixture();
  const a = store.addLot(base(loc));
  const b = store.addLot(base(loc));
  assert.equal(a, b);
  assert.equal(lots(db).length, 1);
  assert.equal(lots(db)[0].quantity, 2);
  db.close();
});

test('a different acquired_from is a new lot, and neither side loses its provenance', () => {
  const { db, store, loc } = fixture();
  store.addLot(base(loc));
  store.addLot({ ...base(loc), acquiredFrom: 'Alice', notes: 'signed' });
  const rows = lots(db);
  assert.equal(rows.length, 2, 'Alice\'s copy did not fold into Bob\'s lot');
  assert.deepEqual(rows.map((r) => [r.acquired_from, r.notes, r.quantity]),
    [['Bob', null, 1], ['Alice', 'signed', 1]]);
  db.close();
});

test('a different note alone is a new lot', () => {
  const { db, store, loc } = fixture();
  store.addLot(base(loc));
  store.addLot({ ...base(loc), notes: 'signed' });
  assert.equal(lots(db).length, 2);
  db.close();
});

test('a different acquisition kind alone is a new lot', () => {
  const { db, store, loc } = fixture();
  store.addLot(base(loc));
  store.addLot({ ...base(loc), acquisitionKind: 'trade' });
  assert.equal(lots(db).length, 2);
  db.close();
});

test('a lot marked signed or altered does not absorb a plain add', () => {
  const { db, store, loc } = fixture();
  const signed = store.addLot(base(loc));
  db.prepare('UPDATE collection_items SET is_signed = 1 WHERE id = ?').run(signed);
  store.addLot(base(loc));
  const rows = lots(db);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.is_signed, r.quantity]), [[1, 1], [0, 1]]);
  db.close();
});

test('a pool add still merges within its batch while the cost moves', () => {
  // The one deliberate relaxation: 'box' adds skip the cost predicate because
  // the pool re-split owns the per-copy cost. Provenance is still matched.
  const { db, store, loc } = fixture();
  const pool = store.openCostPool({ totalCostUsd: 10 });
  const add = (notes: string | null) => store.addLot({
    printingId: 'p', locationId: loc, quantity: 1, acquisitionKind: 'pull',
    importBatchId: pool.id, costMethod: 'box', notes,
  });
  add(null); add(null);
  assert.equal(lots(db).length, 1, 'two plain pulls merged');
  add('foil-stamped');
  assert.equal(lots(db).length, 2, 'a noted pull is its own lot');
  db.close();
});

test('addLot never leaves two rows at one location sharing a lotKey', () => {
  // The contract with assembly: `lotKey` is the definition of "the same lot",
  // so any two rows addLot leaves behind must differ under it — otherwise a
  // move's return leg could find two candidates for one snapshot key.
  const { db, store, loc } = fixture();
  const variants = [
    base(loc),
    { ...base(loc), acquiredFrom: 'Alice' },
    { ...base(loc), notes: 'signed' },
    { ...base(loc), acquisitionKind: 'gift' as const },
    { ...base(loc), acquiredUnitCost: 5 },
    { ...base(loc), acquiredAt: '2026-01-01' },
    { ...base(loc), priceOverride: 40 },
  ];
  for (const v of variants) { store.addLot(v); store.addLot(v); }
  const rows = lots(db);
  assert.equal(rows.length, variants.length, 'each variant merged with its twin and nothing else');
  assert.ok(rows.every((r) => r.quantity === 2));
  const keys = rows.map((r) => lotKey(identityOf(r)));
  assert.equal(new Set(keys).size, keys.length, 'every surviving row has a distinct lotKey');
  db.close();
});
