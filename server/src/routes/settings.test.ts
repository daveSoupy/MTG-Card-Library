import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

import { SCHEMA_PATH, getSetting } from '../db/index.ts';
import { WELCOME_SEEN, registerSettingsRoutes } from './settings.ts';

/**
 * Phase 17's welcomeSeen flag goes through the settings allowlist like every
 * other setting: it reads false on a fresh library, a PUT persists it under
 * its app_settings key, and "show the walkthrough again" is a PUT of false.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const app = Fastify();
  registerSettingsRoutes(app, db);
  return { db, app };
}

test('welcomeSeen defaults to false and round-trips through the settings route', async () => {
  const { db, app } = fixture();

  const before = await app.inject({ method: 'GET', url: '/api/v1/settings' });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().settings.welcomeSeen, false);

  const seen = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { welcomeSeen: true } });
  assert.equal(seen.statusCode, 200);
  assert.equal(seen.json().settings.welcomeSeen, true);
  assert.equal(getSetting(db, WELCOME_SEEN), '1', 'stored under the registered key, as "1"');

  // The Data page's reset: clear the flag so the welcome shows again.
  const reset = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { welcomeSeen: false } });
  assert.equal(reset.json().settings.welcomeSeen, false);
  assert.equal(getSetting(db, WELCOME_SEEN), '0');

  const bad = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload: { welcomeSeen: 'yes' } });
  assert.equal(bad.statusCode, 400, 'the FLAG schema rejects a non-boolean');

  await app.close();
  db.close();
});
