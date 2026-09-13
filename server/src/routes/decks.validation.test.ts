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

// -- ids that pass the schema but point at nothing ----------------------------

test('an unknown formatCode on create is a 400 naming the format, not a 500', async () => {
  const { db, app } = fixture();
  const before = (db.prepare('SELECT COUNT(*) AS n FROM decks').get() as { n: number }).n;

  const response = await app.inject({
    method: 'POST', url: '/api/v1/decks', payload: { name: 'Wrong', formatCode: 'nosuchformat' },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /nosuchformat/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM decks').get() as { n: number }).n, before);

  const ok = await app.inject({
    method: 'POST', url: '/api/v1/decks', payload: { name: 'Right', formatCode: 'commander' },
  });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().deck.formatCode, 'commander');
  await app.close();
  db.close();
});

test('a null formatCode on create is still a format-less deck', async () => {
  const { db, app } = fixture();
  const response = await app.inject({
    method: 'POST', url: '/api/v1/decks', payload: { name: 'Loose', formatCode: null },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().deck.formatCode, null);
  await app.close();
  db.close();
});

test('an unknown oracleId on add is a 404, not a 500', async () => {
  const { db, app, deckId, cardCount } = fixture();

  const response = await app.inject({
    method: 'POST', url: `/api/v1/decks/${deckId}/cards`,
    payload: { oracleId: 'no-such-card', quantity: 1 },
  });

  assert.equal(response.statusCode, 404);
  assert.match(response.json().error, /no-such-card/);
  assert.equal(cardCount(), 0);
  await app.close();
  db.close();
});

test('an unknown formatCode on PATCH is a 400 from the foreign-key backstop', async () => {
  // update() is not checked up front; this is the errorHandler mapping the
  // SQLite constraint failure. It is the belt to create()'s braces.
  const { db, app, deckId } = fixture();

  const response = await app.inject({
    method: 'PATCH', url: `/api/v1/decks/${deckId}`, payload: { formatCode: 'nosuchformat' },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /does not exist/);
  const row = db.prepare('SELECT format_code FROM decks WHERE id = ?').get(deckId) as any;
  assert.equal(row.format_code, 'modern', 'the deck is untouched');
  await app.close();
  db.close();
});

// -- upper bounds --------------------------------------------------------------

test('a slot quantity over 999 is a 400 on add and on edit', async () => {
  const { db, app, deckId, cardCount } = fixture();

  const add = await app.inject({
    method: 'POST', url: `/api/v1/decks/${deckId}/cards`,
    payload: { oracleId: 'bolt', quantity: 1_000_000_000 },
  });
  assert.equal(add.statusCode, 400);
  assert.match(add.json().error, /quantity.*<= 999/);
  assert.equal(cardCount(), 0);

  // A real slot, then an edit that tries to blow it up.
  const ok = await app.inject({
    method: 'POST', url: `/api/v1/decks/${deckId}/cards`, payload: { oracleId: 'bolt', quantity: 4 },
  });
  assert.equal(ok.statusCode, 200);
  const cardId = (db.prepare('SELECT id FROM deck_cards').get() as { id: number }).id;

  const edit = await app.inject({
    method: 'PATCH', url: `/api/v1/decks/${deckId}/cards/${cardId}`, payload: { quantity: 1000 },
  });
  assert.equal(edit.statusCode, 400);
  assert.match(edit.json().error, /quantity/);
  const row = db.prepare('SELECT quantity FROM deck_cards WHERE id = ?').get(cardId) as any;
  assert.equal(row.quantity, 4);

  const atCap = await app.inject({
    method: 'PATCH', url: `/api/v1/decks/${deckId}/cards/${cardId}`, payload: { quantity: 999 },
  });
  assert.equal(atCap.statusCode, 200, 'the cap itself is allowed');
  await app.close();
  db.close();
});

test('a deck name over 200 characters is a 400 on create and rename', async () => {
  const { db, app, deckId } = fixture();
  const long = 'x'.repeat(10_000);

  const create = await app.inject({ method: 'POST', url: '/api/v1/decks', payload: { name: long } });
  assert.equal(create.statusCode, 400);
  assert.match(create.json().error, /name/);

  const rename = await app.inject({
    method: 'PATCH', url: `/api/v1/decks/${deckId}`, payload: { name: long },
  });
  assert.equal(rename.statusCode, 400);
  assert.match(rename.json().error, /name/);
  const row = db.prepare('SELECT name FROM decks WHERE id = ?').get(deckId) as any;
  assert.equal(row.name, 'Burn');

  const exact = await app.inject({
    method: 'POST', url: '/api/v1/decks', payload: { name: 'y'.repeat(200) },
  });
  assert.equal(exact.statusCode, 201, 'the cap itself is allowed');
  await app.close();
  db.close();
});

// -- lower bound on add ---------------------------------------------------------

test('adding zero copies is a 400, not a silent one', async () => {
  const { db, app, deckId, cardCount } = fixture();

  const response = await app.inject({
    method: 'POST', url: `/api/v1/decks/${deckId}/cards`, payload: { oracleId: 'bolt', quantity: 0 },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /quantity.*>= 1/);
  assert.equal(cardCount(), 0);
  await app.close();
  db.close();
});
