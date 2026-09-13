import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

import { SCHEMA_PATH, getSetting } from '../db/index.ts';
import { DeckStore } from '../decks/store.ts';
import { registerDeckRoutes } from './decks.ts';
import { registerSettingsRoutes } from './settings.ts';
import { registerSubstituteRoutes } from './substitutes.ts';
import { errorHandler } from './errorHandler.ts';

/**
 * Phase 27's two endpoints, and the setting that sizes them. The engine has
 * its own tests; these prove the URL reaches it, a bad URL is a 4xx, and the
 * substitutes route coexists with the `/cards/:cardId` routes beside it.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  for (const [index, [id, name, text]] of [
    ['doom', 'Doom Blade', 'Destroy target nonblack creature.'],
    ['murder', 'Murder', 'Destroy target creature.'],
  ].entries()) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,
                  layout,color_identity_mask) VALUES (?,?,?,2,'Instant',?,'normal',4)`)
      .run(id, name, name.toLowerCase(), text);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number) VALUES (?,?,'tst',?)`)
      .run(`p-${id}`, id, String(index + 1));
    db.prepare(`INSERT INTO card_legalities (oracle_id, format_code, legality) VALUES (?,'modern','legal')`).run(id);
  }
  const binder = Number(db.prepare(
    "INSERT INTO storage_locations (name, kind, sort_order) VALUES ('Binder','binder',1)").run().lastInsertRowid);
  db.prepare('INSERT INTO collection_items (printing_id, location_id, quantity) VALUES (?,?,1)').run('p-murder', binder);

  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const decks = new DeckStore(db);
  registerDeckRoutes(app, decks, db);
  registerSubstituteRoutes(app, db);
  registerSettingsRoutes(app, db);

  const deckId = decks.create({ name: 'Burn', formatCode: 'modern', description: null });
  decks.addCard(deckId, 'doom', { board: 'main', quantity: 1 });
  return { db, app, deckId };
}

test('GET /decks/:id/cards/:oracleId/substitutes answers in the deck\'s context', async () => {
  const { app, deckId } = fixture();
  const response = await app.inject({ method: 'GET', url: `/api/v1/decks/${deckId}/cards/doom/substitutes` });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.context.deckId, deckId);
  assert.equal(body.context.formatCode, 'modern');
  assert.equal(body.categorySource, 'heuristic', 'no tagger rows in this fixture');
  assert.deepEqual(body.candidates.map((c: any) => c.name), ['Murder']);
  assert.deepEqual(body.candidates[0].reasons, ['Removal (heuristic)', 'Instant', 'CMC 2', '1 available in Binder']);
});

test('GET /substitutes?oracleId= works without a deck, and deckId is optional', async () => {
  const { app, deckId } = fixture();
  const bare = await app.inject({ method: 'GET', url: '/api/v1/substitutes?oracleId=doom' });
  assert.equal(bare.statusCode, 200);
  assert.equal(bare.json().context.deckId, null);

  const scoped = await app.inject({ method: 'GET', url: `/api/v1/substitutes?oracleId=doom&deckId=${deckId}` });
  assert.equal(scoped.json().context.deckId, deckId);

  const missing = await app.inject({ method: 'GET', url: '/api/v1/substitutes' });
  assert.equal(missing.statusCode, 400);
});

test('unknown card and unknown deck are 404s', async () => {
  const { app, deckId } = fixture();
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/decks/${deckId}/cards/nope/substitutes` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/decks/999/cards/doom/substitutes' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/substitutes?oracleId=doom&deckId=999' })).statusCode, 404);
});

test('the substitutes route does not shadow PATCH/DELETE /cards/:cardId', async () => {
  const { app, deckId, db } = fixture();
  const cardId = (db.prepare('SELECT id FROM deck_cards WHERE deck_id = ?').get(deckId) as { id: number }).id;
  const patched = await app.inject({
    method: 'PATCH', url: `/api/v1/decks/${deckId}/cards/${cardId}`, payload: { quantity: 2 },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().deck.cards[0].quantity, 2);
});

test('substituteSuggestionCount is a registered number setting', async () => {
  const { app, db } = fixture();
  const before = await app.inject({ method: 'GET', url: '/api/v1/settings' });
  assert.equal(before.json().settings.substituteSuggestionCount, 6);

  const put = await app.inject({
    method: 'PUT', url: '/api/v1/settings', payload: { substituteSuggestionCount: 8 },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().settings.substituteSuggestionCount, 8);
  assert.equal(getSetting(db, 'substitute_suggestion_count'), '8');
});
