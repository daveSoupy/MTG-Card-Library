import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { registerCollectionRoutes } from './collection.ts';
import { errorHandler } from './errorHandler.ts';

/**
 * Collection routes: the CHECK lists the columns enforce are enforced again at
 * the edge, so a bad finish or a negative price never reaches SQLite.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                oracle_text_all,layout) VALUES ('bolt','Lightning Bolt','lightning bolt',1,
                'Instant','x','normal')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity)
              VALUES ('p-bolt','bolt','tst','1','common')`).run();

  const app = Fastify();
  app.setErrorHandler(errorHandler);
  registerCollectionRoutes(app, db, new CollectionStore(db));

  const location = (db.prepare(`SELECT id FROM storage_locations ORDER BY id LIMIT 1`)
    .get() as { id: number }).id;
  const lots = () => (db.prepare('SELECT COUNT(*) AS n FROM collection_items').get() as { n: number }).n;
  return { db, app, location, lots };
}

test('a finish outside the CHECK list is a 400 and adds nothing', async () => {
  const { db, app, location, lots } = fixture();

  const response = await app.inject({
    method: 'POST', url: '/api/v1/collection/items',
    payload: { printingId: 'p-bolt', locationId: location, quantity: 1, finish: 'shiny' },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /finish/);
  assert.equal(lots(), 0);
  await app.close();
  db.close();
});

test('a negative price and a missing locationId are both 400', async () => {
  const { db, app, location, lots } = fixture();

  const negative = await app.inject({
    method: 'POST', url: '/api/v1/collection/items',
    payload: { printingId: 'p-bolt', locationId: location, acquiredUnitCost: -5 },
  });
  assert.equal(negative.statusCode, 400);
  assert.match(negative.json().error, /acquiredUnitCost/);

  const noLocation = await app.inject({
    method: 'POST', url: '/api/v1/collection/items', payload: { printingId: 'p-bolt' },
  });
  assert.equal(noLocation.statusCode, 400);
  assert.match(noLocation.json().error, /locationId/);

  assert.equal(lots(), 0);
  await app.close();
  db.close();
});

// -- upper bounds ----------------------------------------------------------------

test('a lot quantity over 9999 is a 400 on add and on edit; 9999 itself is fine', async () => {
  const { db, app, location, lots } = fixture();

  const tooMany = await app.inject({
    method: 'POST', url: '/api/v1/collection/items',
    payload: { printingId: 'p-bolt', locationId: location, quantity: 10_000 },
  });
  assert.equal(tooMany.statusCode, 400);
  assert.match(tooMany.json().error, /quantity.*<= 9999/);
  assert.equal(lots(), 0);

  // A collection lot may legitimately be far larger than any deck slot.
  const bulk = await app.inject({
    method: 'POST', url: '/api/v1/collection/items',
    payload: { printingId: 'p-bolt', locationId: location, quantity: 2000 },
  });
  assert.equal(bulk.statusCode, 201);
  const lotId = bulk.json().id;

  const edit = await app.inject({
    method: 'PATCH', url: `/api/v1/collection/items/${lotId}`, payload: { quantity: 1_000_000 },
  });
  assert.equal(edit.statusCode, 400);
  assert.match(edit.json().error, /quantity/);
  const row = db.prepare('SELECT quantity FROM collection_items WHERE id = ?').get(lotId) as any;
  assert.equal(row.quantity, 2000);

  const atCap = await app.inject({
    method: 'PATCH', url: `/api/v1/collection/items/${lotId}`, payload: { quantity: 9999 },
  });
  assert.equal(atCap.statusCode, 200);
  await app.close();
  db.close();
});

test('a location name over 200 characters is a 400', async () => {
  const { db, app, location } = fixture();
  const long = 'x'.repeat(10_000);

  const create = await app.inject({ method: 'POST', url: '/api/v1/locations', payload: { name: long } });
  assert.equal(create.statusCode, 400);
  assert.match(create.json().error, /name/);

  const rename = await app.inject({
    method: 'PATCH', url: `/api/v1/locations/${location}`, payload: { name: long },
  });
  assert.equal(rename.statusCode, 400);
  assert.match(rename.json().error, /name/);
  await app.close();
  db.close();
});

// -- deleting a location -------------------------------------------------------

test('deleting a location that does not exist is a 404', async () => {
  const { db, app } = fixture();

  const response = await app.inject({ method: 'DELETE', url: '/api/v1/locations/999' });

  assert.equal(response.statusCode, 404);
  assert.match(response.json().error, /location/i);
  await app.close();
  db.close();
});

test('deleting a location still holding cards is a 409; an empty one is a 200', async () => {
  const { db, app, location } = fixture();
  const spare = Number(db.prepare(
    `INSERT INTO storage_locations (name, kind) VALUES ('Spare', 'box')`,
  ).run().lastInsertRowid);
  db.prepare(`INSERT INTO collection_items (printing_id, location_id, quantity)
              VALUES ('p-bolt', ?, 3)`).run(spare);

  const inUse = await app.inject({ method: 'DELETE', url: `/api/v1/locations/${spare}` });
  assert.equal(inUse.statusCode, 409);
  assert.equal(inUse.json().cardCount, 3);
  assert.ok(db.prepare('SELECT 1 FROM storage_locations WHERE id = ?').get(spare), 'still there');

  // Moving its contents first is the documented way through.
  const moved = await app.inject({
    method: 'DELETE', url: `/api/v1/locations/${spare}?moveTo=${location}`,
  });
  assert.equal(moved.statusCode, 200);
  assert.equal(db.prepare('SELECT 1 FROM storage_locations WHERE id = ?').get(spare), undefined);
  const row = db.prepare('SELECT location_id FROM collection_items').get() as any;
  assert.equal(row.location_id, location, 'the cards went to the other location');
  await app.close();
  db.close();
});

test('moving a location\'s contents to a location that does not exist is a 400, not a 500', async () => {
  // Nothing checks moveTo up front; this is the errorHandler catching the
  // foreign-key failure and the transaction rolling the move back.
  const { db, app } = fixture();
  const spare = Number(db.prepare(
    `INSERT INTO storage_locations (name, kind) VALUES ('Spare', 'box')`,
  ).run().lastInsertRowid);
  db.prepare(`INSERT INTO collection_items (printing_id, location_id, quantity)
              VALUES ('p-bolt', ?, 3)`).run(spare);

  const response = await app.inject({
    method: 'DELETE', url: `/api/v1/locations/${spare}?moveTo=999`,
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /does not exist/);
  const row = db.prepare('SELECT location_id FROM collection_items').get() as any;
  assert.equal(row.location_id, spare, 'the cards stayed put');
  await app.close();
  db.close();
});

test('a location delete can be undone: its lots, its name and kind, and its deck homes', async () => {
  const { db, app, location } = fixture();
  const binder = Number(db.prepare(
    `INSERT INTO storage_locations (name, kind, notes, sort_order) VALUES ('Binder 2', 'binder', 'blue', 4)`,
  ).run().lastInsertRowid);
  const lot = (quantity: number, at: number) => Number(db.prepare(
    `INSERT INTO collection_items (printing_id, location_id, quantity) VALUES ('p-bolt', ?, ?)`,
  ).run(at, quantity).lastInsertRowid);
  const moved = [lot(3, binder), lot(1, binder)];
  const stayed = lot(2, location);
  const deck = Number(db.prepare(
    `INSERT INTO decks (name, home_location_id) VALUES ('Burn', ?)`,
  ).run(binder).lastInsertRowid);

  const impact = await app.inject({ method: 'GET', url: `/api/v1/locations/${binder}/impact` });
  assert.deepEqual(impact.json(), { cards: 4, lots: 2, homeOf: [{ id: deck, name: 'Burn' }] });

  const deleted = await app.inject({
    method: 'DELETE', url: `/api/v1/locations/${binder}?moveTo=${location}`,
  });
  assert.equal(deleted.statusCode, 200);
  const { restore } = deleted.json();
  assert.deepEqual(restore.lotIds, moved);
  assert.deepEqual(restore.references, { 'decks.home_location_id': [deck] });
  const home = () => (db.prepare('SELECT home_location_id AS h FROM decks WHERE id = ?').get(deck) as any).h;
  assert.equal(home(), null, 'the delete cleared the home');

  const undone = await app.inject({
    method: 'POST', url: '/api/v1/locations/restore', payload: { restore },
  });
  assert.equal(undone.statusCode, 200);
  assert.equal(undone.json().id, binder, 'the old id was free, so it comes back under it');
  const back = db.prepare('SELECT name, kind, notes, sort_order FROM storage_locations WHERE id = ?')
    .get(binder) as any;
  assert.deepEqual({ ...back }, { name: 'Binder 2', kind: 'binder', notes: 'blue', sort_order: 4 });
  const where = (id: number) => (db.prepare('SELECT location_id AS l FROM collection_items WHERE id = ?')
    .get(id) as any).l;
  assert.deepEqual(moved.map(where), [binder, binder]);
  assert.equal(where(stayed), location, 'a lot that was already there stays');
  assert.equal(home(), binder);

  // A second restore of the same record is refused rather than doubling up.
  const again = await app.inject({
    method: 'POST', url: '/api/v1/locations/restore', payload: { restore },
  });
  assert.equal(again.statusCode, 409);
  await app.close();
  db.close();
});

test('a restore record can only touch the listed reference columns', async () => {
  const { db, app, location } = fixture();
  const lot = Number(db.prepare(
    `INSERT INTO collection_items (printing_id, location_id, quantity) VALUES ('p-bolt', ?, 3)`,
  ).run(location).lastInsertRowid);
  const response = await app.inject({
    method: 'POST', url: '/api/v1/locations/restore',
    payload: { restore: {
      location: { id: 50, name: 'X', kind: 'box', notes: null, isArchived: 0, sortOrder: 0, createdAt: 'now' },
      movedTo: null, lotIds: [], references: { 'collection_items.quantity': [lot] },
    } },
  });
  // The schema strips the unknown key, and the store only walks its own list.
  assert.equal(response.statusCode, 200);
  assert.equal((db.prepare('SELECT quantity FROM collection_items WHERE id = ?').get(lot) as any).quantity, 3);
  await app.close();
  db.close();
});

test('a well-formed lot still lands, nulls and all', async () => {
  const { db, app, location } = fixture();

  const response = await app.inject({
    method: 'POST', url: '/api/v1/collection/items',
    payload: {
      printingId: 'p-bolt', locationId: location, quantity: 2,
      finish: 'foil', condition: 'NM', acquiredUnitCost: 2.5,
      acquiredAt: '2026-09-08', priceOverride: null, notes: null,
    },
  });

  assert.equal(response.statusCode, 201);
  const row = db.prepare(`SELECT quantity, finish, condition, acquired_unit_cost AS cost,
                                 acquired_at AS at FROM collection_items`).get() as any;
  assert.deepEqual(
    [row.quantity, row.finish, row.condition, row.cost, row.at],
    [2, 'foil', 'NM', 2.5, '2026-09-08'],
  );
  await app.close();
  db.close();
});
