import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

import { SCHEMA_PATH } from '../db/index.ts';
import { DeckStore } from '../decks/store.ts';
import { registerDeckRoutes } from './decks.ts';
import { errorHandler } from './errorHandler.ts';

/**
 * Deck routes reject a malformed body before any store method runs, so a bad
 * request can never leave a half-applied edit behind.
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
  registerDeckRoutes(app, new DeckStore(db), db);

  const deckId = Number(
    db.prepare(`INSERT INTO decks (name, format_code) VALUES ('Burn','modern')`).run().lastInsertRowid,
  );
  const cardCount = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM deck_cards').get() as { n: number }).n;

  return { db, app, deckId, cardCount };
}

test('a non-numeric quantity is a 400 and writes nothing', async () => {
  const { db, app, deckId, cardCount } = fixture();

  const response = await app.inject({
    method: 'POST', url: `/api/v1/decks/${deckId}/cards`,
    payload: { oracleId: 'bolt', quantity: 'four' },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /quantity/);
  assert.equal(cardCount(), 0, 'the store never ran');
  await app.close();
  db.close();
});

test('a well-formed add still works', async () => {
  const { db, app, deckId, cardCount } = fixture();

  const response = await app.inject({
    method: 'POST', url: `/api/v1/decks/${deckId}/cards`,
    payload: { oracleId: 'bolt', quantity: 4, board: 'main' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(cardCount(), 1);
  const row = db.prepare('SELECT quantity, board FROM deck_cards').get() as any;
  assert.equal(row.quantity, 4);
  assert.equal(row.board, 'main');
  await app.close();
  db.close();
});

test('a missing required field and a bad enum are both 400', async () => {
  const { db, app, deckId, cardCount } = fixture();

  const noOracle = await app.inject({
    method: 'POST', url: `/api/v1/decks/${deckId}/cards`, payload: { quantity: 1 },
  });
  assert.equal(noOracle.statusCode, 400);
  assert.match(noOracle.json().error, /oracleId/);

  const badBoard = await app.inject({
    method: 'POST', url: `/api/v1/decks/${deckId}/cards`,
    payload: { oracleId: 'bolt', board: 'sideboard' },
  });
  assert.equal(badBoard.statusCode, 400);
  assert.match(badBoard.json().error, /board/);

  const blankName = await app.inject({ method: 'POST', url: '/api/v1/decks', payload: { name: '' } });
  assert.equal(blankName.statusCode, 400);

  assert.equal(cardCount(), 0);
  await app.close();
  db.close();
});

test('a non-integer id in the path is a 400, not a 404', async () => {
  const { db, app } = fixture();

  const response = await app.inject({ method: 'GET', url: '/api/v1/decks/abc' });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /params\/id/);
  await app.close();
  db.close();
});
