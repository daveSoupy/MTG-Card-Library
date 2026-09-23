import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from './store.ts';
import { AlertStore } from '../alerts/store.ts';
import { WantStore, ListNameTakenError, reconcileWants, settleBasicWants } from './wants.ts';
import { setSetting } from '../db/index.ts';
import { pushEntriesToWantList } from './shopping.ts';
import { ALLOCATION_IGNORES_BASICS } from '../decks/allocation.ts';
import { DeckStore } from '../decks/store.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  for (const [oid, name, pid, n] of [['bolt', 'Lightning Bolt', 'p1', '1'], ['goyf', 'Tarmogoyf', 'p2', '2'], ['snap', 'Snapcaster Mage', 'p3', '3']]) {
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

test('reorderItems: a partial payload keeps the omitted rows after it, in their old order', () => {
  const { db, wants } = fixture();
  const a = wants.createList('A');
  const bolt = wants.addItem(a, 'bolt');
  const goyf = wants.addItem(a, 'goyf');
  const snap = wants.addItem(a, 'snap');

  // Only two of the three rows named — the third must not collide with them.
  wants.reorderItems(a, [snap, bolt]);
  assert.deepEqual(wants.get(a)!.items.map((i) => i.id), [snap, bolt, goyf]);
  const orders = db.prepare('SELECT sort_order FROM want_list_items WHERE want_list_id = ? ORDER BY sort_order')
    .all(a).map((r: any) => r.sort_order);
  assert.deepEqual(orders, [0, 1, 2], 'every row renumbered, none sharing a slot');

  // The rows the drag never showed keep their relative order — the client
  // only sends the active ones followed by the fulfilled ones, but even a
  // client that sent only what it displayed leaves the rest as they were.
  wants.reorderItems(a, [goyf]);
  assert.deepEqual(wants.get(a)!.items.map((i) => i.id), [goyf, snap, bolt]);
  db.close();
});

test('reorderItems ignores ids from another list, unknown ids and repeats', () => {
  const { db, wants } = fixture();
  const a = wants.createList('A');
  const b = wants.createList('B');
  const aBolt = wants.addItem(a, 'bolt');
  const aGoyf = wants.addItem(a, 'goyf');
  const bBolt = wants.addItem(b, 'bolt');
  const bGoyf = wants.addItem(b, 'goyf');

  wants.reorderItems(a, [bGoyf, 999999, aGoyf, aGoyf, aBolt]);
  assert.deepEqual(wants.get(a)!.items.map((i) => i.id), [aGoyf, aBolt]);
  assert.deepEqual(wants.get(b)!.items.map((i) => i.id), [bBolt, bGoyf], 'B untouched');
  const bOrders = db.prepare('SELECT id, sort_order FROM want_list_items WHERE want_list_id = ? ORDER BY id')
    .all(b) as Array<{ id: number; sort_order: number }>;
  assert.deepEqual(bOrders.map((r) => r.sort_order), [1, 2], "B's stored order is exactly as addItem left it");
  db.close();
});

test('reorderItems renumbers active and fulfilled rows together', () => {
  const { db, wants } = fixture();
  const a = wants.createList('A');
  const bolt = wants.addItem(a, 'bolt');
  const goyf = wants.addItem(a, 'goyf');
  const snap = wants.addItem(a, 'snap');
  wants.updateItem(bolt, { status: 'fulfilled' });

  // What the client sends after an arrow-key swap of the two active rows:
  // active ids in their new order, then the fulfilled ones as they were.
  wants.reorderItems(a, [snap, goyf, bolt]);
  const items = wants.get(a)!.items;
  assert.deepEqual(items.map((i) => i.id), [snap, goyf, bolt]);
  assert.deepEqual(items.filter((i) => i.status === 'active').map((i) => i.id), [snap, goyf]);
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

test('itemsForOracle finds a card across every list, not just the default', () => {
  const { db, wants } = fixture();
  const def = wants.lists().find((l) => l.is_default)!.id;
  const grails = wants.createList('Grails');

  const defItem = wants.addItem(def, 'bolt');
  const grailsItem = wants.addItem(grails, 'bolt');
  wants.addItem(def, 'goyf'); // a different card — must not show up

  const found = wants.itemsForOracle('bolt');
  assert.deepEqual(
    found.map((f) => f.itemId).sort(),
    [defItem, grailsItem].sort(),
  );
  assert.deepEqual(found.map((f) => f.wantListId).sort(), [def, grails].sort());
  db.close();
});

test('itemsForOracle excludes a removed or fulfilled entry', () => {
  const { db, wants } = fixture();
  const def = wants.lists().find((l) => l.is_default)!.id;
  const item = wants.addItem(def, 'bolt');
  wants.updateItem(item, { status: 'fulfilled' });
  assert.deepEqual(wants.itemsForOracle('bolt'), []);
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

test('deck-driven basic-land wants follow the exemption; one you added yourself stays', () => {
  const { db, wants, alerts } = fixture();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout,is_basic_land)
              VALUES ('plains','Plains','plains',0,'Basic Land — Plains','','normal',1)`).run();

  // Pushed while the exemption was off: "Plains ×19, needed for: Eric".
  setSetting(db, ALLOCATION_IGNORES_BASICS, '0');
  const deckId = new DeckStore(db).create({ name: 'Eric' });
  pushEntriesToWantList(db, deckId, [{ oracleId: 'plains', needed: 19 }]);
  const mine = wants.createList('Foils');
  wants.addItem(mine, 'plains');

  assert.deepEqual(settleBasicWants(db, alerts), [], 'nothing to settle while the exemption is off');

  setSetting(db, ALLOCATION_IGNORES_BASICS, '1');
  const settled = settleBasicWants(db, alerts);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].quantity, 19);

  const statuses = db.prepare(`
    SELECT w.status, EXISTS (SELECT 1 FROM want_list_item_decks d WHERE d.want_list_item_id = w.id) AS from_deck
      FROM want_list_items w WHERE w.oracle_id = 'plains' ORDER BY from_deck`).all();
  assert.deepEqual(statuses, [
    { status: 'active', from_deck: 0 },
    { status: 'fulfilled', from_deck: 1 },
  ]);
  const alert = db.prepare(`SELECT message FROM alerts WHERE kind = 'want_fulfilled'`).get() as { message: string };
  assert.match(alert.message, /basic lands are left out of allocation/);

  // Idempotent: a second pass finds nothing.
  assert.deepEqual(settleBasicWants(db, alerts), []);
  // And reconcileWants for the card settles through the same rule.
  pushEntriesToWantList(db, deckId, [{ oracleId: 'plains', needed: 19 }]);
  assert.equal(reconcileWants(db, alerts, 'plains').length, 1);
  db.close();
});
