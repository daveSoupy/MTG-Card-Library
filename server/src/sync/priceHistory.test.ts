import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { recordPriceHistory } from './runSync.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function seed() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test')`).run();

  const oracle = db.prepare(`
    INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all, layout)
    VALUES (?,?,?,1,'Artifact','x','normal')`);
  const printing = db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number, price_usd, price_usd_foil)
    VALUES (?,?, 'tst', ?, ?, ?)`);

  // Three cards: one owned, one want-listed, one neither.
  for (const [i, name] of ['Owned', 'Wanted', 'Ignored'].entries()) {
    oracle.run(`o-${i}`, name, name.toLowerCase());
    printing.run(`p-${i}`, `o-${i}`, String(i), 10 + i, 20 + i);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${i}`, `o-${i}`);
  }

  db.prepare(`INSERT INTO collection_items (printing_id, location_id, quantity) VALUES ('p-0', 1, 1)`).run();
  db.prepare(`INSERT INTO want_list_items (want_list_id, oracle_id, quantity) VALUES (1, 'o-1', 1)`).run();
  return db;
}

const rows = (db: Database.Database) =>
  db.prepare('SELECT printing_id, finish, price_usd FROM printing_price_history ORDER BY printing_id, finish')
    .all() as Array<{ printing_id: string; finish: string; price_usd: number }>;

test('only owned and wanted cards get price points', () => {
  const db = seed();
  const written = recordPriceHistory(db);
  const tracked = new Set(rows(db).map((r) => r.printing_id));

  assert.ok(tracked.has('p-0'), 'the owned card is tracked');
  assert.ok(tracked.has('p-1'), 'the want-listed card is tracked');
  assert.ok(!tracked.has('p-2'), 'a card that is neither owned nor wanted is not tracked');
  assert.equal(written, rows(db).length);
  db.close();
});

test('each finish is charted as its own series', () => {
  const db = seed();
  recordPriceHistory(db);
  const finishes = rows(db).filter((r) => r.printing_id === 'p-0').map((r) => r.finish).sort();
  assert.deepEqual(finishes, ['foil', 'nonfoil'], 'etched is null here so it is skipped');
  db.close();
});

test('a second sync with unchanged prices writes nothing', () => {
  const db = seed();
  const first = recordPriceHistory(db);
  assert.ok(first > 0);

  // This is the whole point of the design: a quiet week must cost no rows.
  const second = recordPriceHistory(db);
  assert.equal(second, 0, 'unchanged prices must not produce new points');
  db.close();
});

test('a price change is recorded, and the same day is updated rather than duplicated', () => {
  const db = seed();
  recordPriceHistory(db);
  const before = rows(db).find((r) => r.printing_id === 'p-0' && r.finish === 'nonfoil')!;
  assert.equal(before.price_usd, 10);

  db.prepare(`UPDATE card_printings SET price_usd = 12.5 WHERE id = 'p-0'`).run();
  const written = recordPriceHistory(db);
  assert.ok(written > 0, 'a moved price is recorded');

  const after = rows(db).filter((r) => r.printing_id === 'p-0' && r.finish === 'nonfoil');
  assert.equal(after.length, 1, 'two syncs on one day update the point rather than duplicating it');
  assert.equal(after[0].price_usd, 12.5);
  db.close();
});

test('a null price is skipped rather than stored as zero', () => {
  const db = seed();
  db.prepare(`UPDATE card_printings SET price_usd = NULL WHERE id = 'p-0'`).run();
  recordPriceHistory(db);
  const nonfoil = rows(db).filter((r) => r.printing_id === 'p-0' && r.finish === 'nonfoil');
  assert.equal(nonfoil.length, 0, 'an unpriced card must not chart as free');
  db.close();
});

test('want-list fulfilment stops a card being tracked', () => {
  const db = seed();
  recordPriceHistory(db);
  assert.ok(rows(db).some((r) => r.printing_id === 'p-1'));

  db.prepare(`UPDATE want_list_items SET status = 'fulfilled'`).run();
  db.prepare(`UPDATE card_printings SET price_usd = 99 WHERE id = 'p-1'`).run();
  recordPriceHistory(db);

  const points = rows(db).filter((r) => r.printing_id === 'p-1' && r.finish === 'nonfoil');
  assert.equal(points[0].price_usd, 11, 'no new point once the want is fulfilled');
  db.close();
});
