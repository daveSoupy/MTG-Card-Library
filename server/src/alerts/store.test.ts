import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { AlertStore } from './store.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return { db, alerts: new AlertStore(db) };
}

test('getByDedupeKey reads the row a re-raise would otherwise blindly overwrite', () => {
  const { db, alerts } = fixture();
  assert.equal(alerts.getByDedupeKey('x'), null);
  alerts.raise({ kind: 'sync_failed', dedupeKey: 'x', title: 'Sync failed' });
  const row = alerts.getByDedupeKey('x');
  assert.equal(row?.title, 'Sync failed');
  assert.equal(row?.state, 'active');
  db.close();
});

test('resolveByKey clears the payload — a future raise under the same key starts fresh', () => {
  const { db, alerts } = fixture();
  alerts.raise({ kind: 'sync_failed', dedupeKey: 'x', title: 'Sync failed', payload: { n: 1 } });
  alerts.resolveByKey('x');
  const row = alerts.getByDedupeKey('x');
  assert.equal(row?.state, 'resolved');
  assert.equal(row?.payload, null);
  db.close();
});

test('acknowledgeAll marks every active alert seen, and can be scoped to one kind', () => {
  const { db, alerts } = fixture();
  const a = alerts.raise({ kind: 'sync_failed', title: 'A' });
  const b = alerts.raise({ kind: 'price_target', title: 'B' });
  const changed = alerts.acknowledgeAll('sync_failed');
  assert.equal(changed, 1);
  assert.equal(alerts.list().find((r) => r.id === a)?.state, 'acknowledged');
  assert.equal(alerts.list().find((r) => r.id === b)?.state, 'active');
  db.close();
});

test('resolveAll clears active and acknowledged alerts alike, leaving resolved ones alone', () => {
  const { db, alerts } = fixture();
  const a = alerts.raise({ kind: 'sync_failed', title: 'A' });
  const b = alerts.raise({ kind: 'sync_failed', title: 'B' });
  alerts.acknowledge(b);
  const changed = alerts.resolveAll();
  assert.equal(changed, 2);
  assert.equal(alerts.list().find((r) => r.id === a)?.state, 'resolved');
  assert.equal(alerts.list().find((r) => r.id === b)?.state, 'resolved');
  db.close();
});

test('acknowledgeAll and resolveAll with no matching alerts change nothing', () => {
  const { db, alerts } = fixture();
  assert.equal(alerts.acknowledgeAll(), 0);
  assert.equal(alerts.resolveAll('price_target'), 0);
  db.close();
});
