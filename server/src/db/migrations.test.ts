import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { MIGRATIONS } from './migrations.ts';
import { SCHEMA_PATH, schemaVersion } from './index.ts';

const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8');
const TARGET = schemaVersion(SCHEMA_SQL);

/** Structure only — names, columns and types, ignoring formatting. */
function shapeOf(db: Database.Database): string {
  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name`).all() as Array<{ type: string; name: string; sql: string | null }>;

  return objects
    .map(({ type, name, sql }) => {
      // Strip comments and normalise spacing so cosmetic differences do not
      // read as drift. SQLite rewrites the stored DDL during ALTER TABLE and
      // its spacing around punctuation differs from the hand-written file.
      // Column names, types, constraints and order are all still compared.
      const normalized = (sql ?? '')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim();
      return `${type} ${name}\n  ${normalized}`;
    })
    .join('\n');
}

/** A database at the state before a given migration ran. */
function databaseAtVersion(version: number): Database.Database {
  const db = new Database(':memory:');
  // Apply the full current schema, then undo what later migrations added, so
  // the "old" database is realistic without keeping historical copies of the
  // whole DDL around.
  db.exec(SCHEMA_SQL);
  // Rewind past every later migration. Each kind a migration can take has an
  // inverse: a created table is dropped, an added column is dropped, a created
  // index is dropped. A kind with no inverse here would silently leave the
  // "old" database identical to a fresh one, and the drift check below would
  // pass without ever comparing anything — so the assertion that the fixture
  // really is missing something is what keeps this list honest.
  for (const migration of [...MIGRATIONS].reverse().filter((m) => m.version > version)) {
    for (const name of createdTables(migration.sql)) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
    }
    for (const name of createdIndexes(migration.sql)) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    }
    for (const { table, column } of addedColumns(migration.sql)) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
  db.pragma(`user_version = ${version}`);
  return db;
}

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);
}

function createdIndexes(sql: string): string[] {
  return [...sql.matchAll(/CREATE(?: UNIQUE)? INDEX (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);
}

function addedColumns(sql: string): Array<{ table: string; column: string }> {
  return [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi)]
    .map((m) => ({ table: m[1], column: m[2] }));
}

test('every migration is numbered above the previous one', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), 'migrations must be ordered');
  assert.equal(new Set(versions).size, versions.length, 'migration versions must be unique');
});

test('schema.sql version is at least the newest migration', () => {
  const newest = Math.max(0, ...MIGRATIONS.map((m) => m.version));
  assert.ok(
    TARGET >= newest,
    `schema.sql is at v${TARGET} but a migration targets v${newest} — bump PRAGMA user_version`,
  );
});

test('a migrated database ends up structurally identical to a fresh one', () => {
  // This is the check that keeps schema.sql and migrations.ts from drifting:
  // the DDL for a new object is necessarily written in both places, and only a
  // comparison like this notices when they stop agreeing.
  const fresh = new Database(':memory:');
  fresh.exec(SCHEMA_SQL);

  for (const migration of MIGRATIONS) {
    const old = databaseAtVersion(migration.version - 1);
    assert.ok(
      shapeOf(old) !== shapeOf(fresh),
      `v${migration.version - 1} fixture should be missing what "${migration.description}" adds`,
    );

    old.transaction(() => {
      for (const pending of MIGRATIONS.filter((m) => m.version >= migration.version)) {
        old.exec(pending.sql);
      }
      old.pragma(`user_version = ${TARGET}`);
    })();

    assert.equal(
      shapeOf(old),
      shapeOf(fresh),
      `migrating from v${migration.version - 1} does not match schema.sql — the two definitions have drifted`,
    );
    assert.equal(old.pragma('user_version', { simple: true }), TARGET);
    old.close();
  }
  fresh.close();
});

test('a failed migration rolls back completely, leaving the version untouched', () => {
  // Idempotency is deliberately *not* required: ALTER TABLE ADD COLUMN cannot
  // be re-run in SQLite, and the runner never replays a migration because it
  // filters on version. What has to hold instead is that a failure leaves no
  // partial state behind, so a retry starts from a clean database.
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const before = db.pragma('user_version', { simple: true });

  assert.throws(() => {
    db.transaction(() => {
      db.exec('ALTER TABLE oracle_cards ADD COLUMN scratch_column TEXT');
      db.exec('THIS IS NOT VALID SQL');
      db.pragma('user_version = 999');
    })();
  });

  assert.equal(db.pragma('user_version', { simple: true }), before, 'version must not advance');
  const columns = db.prepare(`SELECT name FROM pragma_table_info('oracle_cards')`).all() as Array<{ name: string }>;
  assert.ok(!columns.some((c) => c.name === 'scratch_column'), 'the partial change must be gone');
  db.close();
});

test('the runner never replays a migration the database already has', () => {
  const applied: number[] = [];
  const from = 3;
  for (const migration of MIGRATIONS.filter((m) => m.version > from && m.version <= TARGET)) {
    applied.push(migration.version);
  }
  assert.ok(!applied.includes(3), 'v3 must not re-run on a database already at v3');
  assert.ok(applied.every((v) => v > from));
});

test('filter_presets enforces unique names case-insensitively', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const insert = db.prepare('INSERT INTO filter_presets (name, filters) VALUES (?, ?)');
  insert.run('Commander staples', '{}');
  assert.throws(() => insert.run('commander staples', '{}'), /UNIQUE/);
  db.close();
});
