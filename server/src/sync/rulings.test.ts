import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { writeCardRulings, syncCardRulings, type RulingRecord } from './rulings.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function ruling(oracleId: string, comment: string, publishedAt = '2024-01-01'): RulingRecord {
  return { oracleId, source: 'wotc', publishedAt, comment };
}

test('writeCardRulings drops rulings for oracle ids the card database does not know', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, oracle_text_all)
              VALUES ('o-known', 'Known Card', 'known card', '')`).run();

  const { written, skipped } = writeCardRulings(db, [
    ruling('o-known', 'A known ruling.'),
    ruling('o-unknown', 'An orphan ruling default_cards omits.'),
  ]);

  assert.equal(written, 1);
  assert.equal(skipped, 1);
  const rows = db.prepare('SELECT oracle_id, comment FROM card_rulings').all() as any[];
  assert.deepEqual(rows, [{ oracle_id: 'o-known', comment: 'A known ruling.' }]);
  db.close();
});

test('writeCardRulings replaces the whole table rather than accumulating', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, oracle_text_all)
              VALUES ('o-a', 'A', 'a', '')`).run();

  writeCardRulings(db, [ruling('o-a', 'First sync ruling.')]);
  writeCardRulings(db, [ruling('o-a', 'Second sync ruling.')]);

  const rows = db.prepare('SELECT comment FROM card_rulings').all() as Array<{ comment: string }>;
  assert.deepEqual(rows.map((r) => r.comment), ['Second sync ruling.']);
  db.close();
});

test('syncCardRulings never throws — a card sync must survive the rulings source going away', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('DNS failure, or a 404, or anything else'); }) as typeof fetch;
  try {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const ok = await syncCardRulings(db);
    assert.equal(ok, false);
    assert.equal((db.prepare('SELECT count(*) AS n FROM card_rulings').get() as any).n, 0);
    const log = db.prepare(`SELECT status FROM sync_log WHERE bulk_type = 'rulings'`).get() as any;
    assert.equal(log.status, 'failed');
    db.close();
  } finally {
    globalThis.fetch = original;
  }
});
