import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import Fastify from 'fastify';

import { errorHandler } from './errorHandler.ts';
import { TradeNotDraftError, TradeNotFoundError } from '../trades/store.ts';

/**
 * The global handler: a known error class keeps its status and message, an
 * unexpected one tells the client nothing and the log everything.
 */

function appWithLog() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); },
  });
  const app = Fastify({ logger: { level: 'error', stream } });
  app.setErrorHandler(errorHandler);
  return { app, lines };
}

test('an unexpected error returns a bare 500 and logs the stack', async () => {
  const { app, lines } = appWithLog();
  app.get('/boom', async () => {
    throw new Error('connection to the vault reactor lost');
  });

  const response = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'Internal error' });
  assert.doesNotMatch(response.body, /vault reactor|at .*errorHandler\.test/,
    'neither the real message nor a stack frame reaches the client');

  const logged = lines.join('');
  assert.match(logged, /vault reactor/);
  assert.match(logged, /errorHandler\.test\.ts/, 'the stack is in the log');
  await app.close();
});

test('known error classes keep their status and message', async () => {
  const { app } = appWithLog();
  app.get('/draft', async () => { throw new TradeNotDraftError(); });
  app.get('/missing', async () => { throw new TradeNotFoundError(7); });

  const draft = await app.inject({ method: 'GET', url: '/draft' });
  assert.equal(draft.statusCode, 409);
  assert.equal(draft.json().error, 'Only a draft trade can be changed.');

  const missing = await app.inject({ method: 'GET', url: '/missing' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'No trade with id 7.');
  await app.close();
});

test('a body that fails its schema is a 400 naming the field', async () => {
  const { app } = appWithLog();
  let ran = false;
  app.post('/thing', {
    schema: { body: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer' } } } },
  }, async () => { ran = true; return { ok: true }; });

  const response = await app.inject({ method: 'POST', url: '/thing', payload: { quantity: 'four' } });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /^body\/quantity /);
  assert.equal(ran, false, 'the handler never ran');
  await app.close();
});

test('a SQLite foreign-key failure is a 400 with a generic message, never a 500', async () => {
  const { app, lines } = appWithLog();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
           CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));`);
  app.post('/child', async () => {
    db.prepare('INSERT INTO child (parent_id) VALUES (?)').run(999);
    return { ok: true };
  });

  const response = await app.inject({ method: 'POST', url: '/child' });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /does not exist/);
  assert.doesNotMatch(response.body, /FOREIGN KEY/, 'SQLite\'s own wording is not forwarded');
  assert.equal(lines.length, 0, 'a warning, not an error — the error-level log stays quiet');
  await app.close();
  db.close();
});

test('malformed JSON is a 400, not a 500', async () => {
  const { app } = appWithLog();
  app.post('/thing', async () => ({ ok: true }));

  const response = await app.inject({
    method: 'POST', url: '/thing',
    headers: { 'content-type': 'application/json' },
    payload: '{"quantity":',
  });
  assert.equal(response.statusCode, 400);
  assert.notEqual(response.json().error, 'Internal error');
  await app.close();
});
