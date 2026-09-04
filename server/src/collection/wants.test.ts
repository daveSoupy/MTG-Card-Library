import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from './store.ts';
import { AlertStore } from '../alerts/store.ts';
import { WantStore, ListNameTakenError, reconcileWants } from './wants.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  for (const [oid, name, pid, n] of [['bolt', 'Lightning Bolt', 'p1', '1'], ['goyf', 'Tarmogoyf', 'p2', '2']]) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
                VALUES (?,?,?,1,'Instant','x','normal')`).run(oid, name, name.toLowerCase());
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity,price_usd)
                VALUES (?,?,'tst',?,'rare',5)`).run(pid, oid, n);
    db.prepare('UPDATE oracle_cards SET default_printing_id=? WHERE oracle_id=?').run(pid, oid);
  }
  return { db, wants: new WantStore(db), collection: new CollectionStore(db), alerts: new AlertStore(db) };
}

test('named lists: create, rename, delete, and refuse duplicate names', () => {
  const { db, wants } = fixture();
  const grails = wants.createList('Grails');
  assert.throws(() => wants.createList('Grails'), ListNameTakenError);
  wants.renameList(grails, 'Grail Cards');
  assert.ok(wants.lists().some((l) => l.name === 'Grail Cards'));
  wants.deleteList(grails);
  assert.equal(wants.lists().some((l) => l.name === 'Grail Cards'), false);
  // The seeded default list cannot be deleted.
  const def = wants.lists().find((l) => l.is_default)!;
  assert.throws(() => wants.deleteList(def.id));
  db.close();
});

test('each list keeps its own item order', () => {
  const { db, wants } = fixture();
  const a = wants.createList('A');
  const b = wants.createList('B');
  const a1 = wants.addItem(a, 'bolt');
  const a2 = wants.addItem(a, 'goyf');
  wants.addItem(b, 'bolt');
  wants.addItem(b, 'goyf');

  wants.reorderItems(a, [a2, a1]); // goyf first in A only
  const orderA = wants.get(a)!.items.map((i) => i.oracleId);
  const orderB = wants.get(b)!.items.map((i) => i.oracleId);
  assert.deepEqual(orderA, ['goyf', 'bolt']);
  assert.deepEqual(orderB, ['bolt', 'goyf'], 'B keeps its own independent order');
  db.close();
});

test('editing an item sets target price and priority', () => {
  const { db, wants } = fixture();
  const def = wants.lists().find((l) => l.is_default)!.id;
  const item = wants.addItem(def, 'goyf', { quantity: 1 });
  wants.updateItem(item, { targetPriceUsd: 12.5, priority: 3, notes: 'foil please' });
  const got = wants.get(def)!.items.find((i) => i.id === item)!;
  assert.equal(got.targetPriceUsd, 12.5);
  assert.equal(got.priority, 3);
  db.close();
});

test('reconcileWants marks a want fulfilled once the collection covers it', () => {
  const { db, wants, collection, alerts } = fixture();
  const def = wants.lists().find((l) => l.is_default)!.id;
  wants.addItem(def, 'goyf', { quantity: 2 });
  const loc = (db.prepare('SELECT id FROM storage_locations LIMIT 1').get() as { id: number }).id;

  collection.addLot({ printingId: 'p2', locationId: loc, quantity: 1 });
  assert.equal(reconcileWants(db, alerts, 'goyf').length, 0, 'one copy is not enough');

  collection.addLot({ printingId: 'p2', locationId: loc, quantity: 1 });
  const fulfilled = reconcileWants(db, alerts, 'goyf');
  assert.equal(fulfilled.length, 1);
  assert.equal(wants.get(def)!.items.find((i) => i.oracleId === 'goyf')!.status, 'fulfilled');
  db.close();
});
