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
