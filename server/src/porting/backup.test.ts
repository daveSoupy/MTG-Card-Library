import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCHEMA_PATH } from '../db/index.ts';
import { backupTo, restoreFrom, InvalidBackupError, USER_TABLES } from './backup.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');
const scratch = () => mkdtempSync(join(tmpdir(), 'mtg-backup-test-'));

/** A database with a little of everything a backup has to carry. */
function seeded(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all, layout)
              VALUES ('o1','Sol Ring','sol ring',1,'Artifact','x','normal')`).run();
  db.prepare(`INSERT INTO card_printings (id, oracle_id, set_code, collector_number, price_usd)
              VALUES ('p1','o1','tst','1',1.5)`).run();
  db.prepare(`UPDATE oracle_cards SET default_printing_id='p1'`).run();

  db.prepare(`INSERT INTO storage_locations (name, kind) VALUES ('Binder 3','binder')`).run();
  db.prepare(`INSERT INTO collection_items (printing_id, location_id, quantity, acquired_unit_cost)
              VALUES ('p1', 2, 3, 2.5)`).run();
  db.prepare(`INSERT INTO decks (name, format_code) VALUES ('Test Deck','commander')`).run();
  db.prepare(`INSERT INTO deck_cards (deck_id, oracle_id, board, quantity, quantity_from_collection)
              VALUES (1,'o1','main',1,1)`).run();
  db.prepare(`INSERT INTO filter_presets (name, filters) VALUES ('Mine','{}')`).run();
  return db;
}

const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test('a backup can be taken while the database is in use, and restores', () => {
  const dir = scratch();
  const path = join(dir, 'backup.sqlite');
  const source = seeded();

  const { bytes } = backupTo(source, path);
  assert.ok(bytes > 0, 'the backup file has content');

  const target = seeded();
  target.exec('DELETE FROM deck_cards; DELETE FROM decks; DELETE FROM collection_items; DELETE FROM filter_presets');
  assert.equal(count(target, 'collection_items'), 0);

  const report = restoreFrom(target, path);
  assert.equal(count(target, 'collection_items'), 1);
  assert.equal(count(target, 'decks'), 1);
  assert.equal(count(target, 'deck_cards'), 1);
  assert.equal(count(target, 'filter_presets'), 1);
  assert.ok(report.totalRows > 0);
  assert.equal(report.pendingCardReferences, 0, 'the cards were already synced');

  const lot = target.prepare('SELECT quantity, acquired_unit_cost FROM collection_items').get() as any;
  assert.equal(lot.quantity, 3);
  assert.equal(lot.acquired_unit_cost, 2.5, 'cost basis survives the round trip');

  source.close(); target.close(); rmSync(dir, { recursive: true, force: true });
});

test('restoring replaces existing data rather than doubling it', () => {
  const dir = scratch();
  const path = join(dir, 'backup.sqlite');
  const source = seeded();
  backupTo(source, path);

  // Restore into a database that already holds the same data.
  const target = seeded();
  assert.equal(count(target, 'collection_items'), 1);
  restoreFrom(target, path);
  assert.equal(count(target, 'collection_items'), 1, 'not 2');
  assert.equal(count(target, 'decks'), 1);

  source.close(); target.close(); rmSync(dir, { recursive: true, force: true });
});

test('the card cache is left alone, since it is not in the backup', () => {
  const dir = scratch();
  const path = join(dir, 'backup.sqlite');
  const source = seeded();
  backupTo(source, path);

  const target = seeded();
  restoreFrom(target, path);
  assert.equal(count(target, 'oracle_cards'), 1, 'cards are still there');
  assert.equal(count(target, 'card_printings'), 1);

  source.close(); target.close(); rmSync(dir, { recursive: true, force: true });
});

test('a file that is not a database is refused', () => {
  const dir = scratch();
  const path = join(dir, 'not-a-db.sqlite');
  writeFileSync(path, 'this is just text');
  const target = seeded();
  assert.throws(() => restoreFrom(target, path), InvalidBackupError);
  target.close(); rmSync(dir, { recursive: true, force: true });
});

test('some other SQLite database is refused', () => {
  const dir = scratch();
  const path = join(dir, 'other.sqlite');
  const other = new Database(path);
  other.exec('CREATE TABLE unrelated (a TEXT)');
  other.close();

  const target = seeded();
  assert.throws(() => restoreFrom(target, path), /not an MTG Library backup/);
  // The refusal must not have emptied anything on the way to failing.
  assert.equal(count(target, 'collection_items'), 1);
  target.close(); rmSync(dir, { recursive: true, force: true });
});

test('a backup from a newer schema is refused rather than half-applied', () => {
  const dir = scratch();
  const path = join(dir, 'future.sqlite');
  const future = new Database(path);
  future.exec(SCHEMA);
  future.pragma('user_version = 999');
  future.close();

  const target = seeded();
  assert.throws(() => restoreFrom(target, path), /newer version/);
  assert.equal(count(target, 'collection_items'), 1, 'existing data untouched');
  target.close(); rmSync(dir, { recursive: true, force: true });
});

test('a backup missing a table restores the rest and says which it skipped', () => {
  const dir = scratch();
  const path = join(dir, 'old.sqlite');
  const old = new Database(path);
  old.exec(SCHEMA);
  old.prepare(`INSERT INTO storage_locations (name, kind) VALUES ('Old Binder','binder')`).run();
  // Simulate a backup predating a table.
  old.exec('DROP TABLE filter_presets');
  old.close();

  const target = seeded();
  const report = restoreFrom(target, path);
  assert.ok(report.skipped.some((s) => s.table === 'filter_presets'));
  assert.ok(report.restored.some((r) => r.table === 'storage_locations'));
  assert.equal(count(target, 'collection_items'), 0, 'the backup had none, so neither does the target');
  target.close(); rmSync(dir, { recursive: true, force: true });
});

test('every user table is real, and no card-cache table is in the list', () => {
  const db = seeded();
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map((r) => r.name),
  );
  for (const table of USER_TABLES) {
    assert.ok(tables.has(table), `${table} should exist in the schema`);
  }
  for (const cache of ['oracle_cards', 'card_printings', 'card_faces', 'card_legalities', 'sets']) {
    assert.ok(!(USER_TABLES as readonly string[]).includes(cache),
      `${cache} is a re-downloadable cache and must not be backed up`);
  }
  db.close();
});

test('restoring onto a machine that has not synced yet still works', () => {
  const dir = scratch();
  const path = join(dir, 'backup.sqlite');
  const source = seeded();
  backupTo(source, path);

  // A brand new install: schema present, card cache empty. Every collection
  // row in the backup points at a printing this database has never seen.
  const target = new Database(':memory:');
  target.exec(SCHEMA);

  const report = restoreFrom(target, path);
  assert.equal(count(target, 'collection_items'), 1, 'the lot is restored anyway');
  assert.ok(report.pendingCardReferences > 0, 'and the dangling card references are reported');

  // Once the cards arrive, the references resolve with no fix-up.
  target.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test')`).run();
  target.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all, layout)
                  VALUES ('o1','Sol Ring','sol ring',1,'Artifact','x','normal')`).run();
  target.prepare(`INSERT INTO card_printings (id, oracle_id, set_code, collector_number, price_usd)
                  VALUES ('p1','o1','tst','1',1.5)`).run();
  assert.equal((target.prepare('PRAGMA foreign_key_check').all()).length, 0);

  source.close(); target.close(); rmSync(dir, { recursive: true, force: true });
});

test('a backup with broken references among its own records is refused', () => {
  const dir = scratch();
  const path = join(dir, 'broken.sqlite');
  const broken = new Database(path);
  broken.exec(SCHEMA);
  broken.pragma('foreign_keys = OFF');
  broken.prepare(`INSERT INTO decks (id, name, format_code) VALUES (1,'Test','commander')`).run();
  // A deck_cards row whose deck does not exist.
  broken.prepare(`INSERT INTO deck_cards (deck_id, oracle_id, board, quantity)
                  VALUES (99,'o1','main',1)`).run();
  broken.close();

  const target = seeded();
  assert.throws(() => restoreFrom(target, path), /internally inconsistent/);
  assert.equal(count(target, 'collection_items'), 1, 'the rollback left existing data intact');
  assert.equal(count(target, 'decks'), 1);
  target.close(); rmSync(dir, { recursive: true, force: true });
});

test('a backup is small, because it leaves the re-downloadable card cache out', () => {
  const dir = scratch();
  const source = seeded();

  // Bulk out the cache the way a real sync does, proportionally.
  const printing = source.prepare(`INSERT INTO card_printings (id, oracle_id, set_code, collector_number)
                                   VALUES (?, 'o1', 'tst', ?)`);
  const oracle = source.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all, layout)
                                 VALUES (?, ?, ?, 1, 'Creature', ?, 'normal')`);
  source.transaction(() => {
    for (let i = 0; i < 3000; i += 1) {
      oracle.run(`bulk-${i}`, `Bulk Card ${i}`, `bulk card ${i}`, 'x'.repeat(300));
      printing.run(`bulk-p-${i}`, String(i + 100));
    }
  })();

  const whole = join(dir, 'whole.sqlite');
  source.prepare('VACUUM INTO ?').run(whole);   // what a naive backup would be
  const { bytes } = backupTo(source, join(dir, 'backup.sqlite'));
  const wholeBytes = statSync(whole).size;

  assert.ok(bytes * 4 < wholeBytes,
    `backup ${bytes} should be far smaller than the full file ${wholeBytes}`);

  source.close(); rmSync(dir, { recursive: true, force: true });
});
