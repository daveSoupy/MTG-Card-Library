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
      // Collapse whitespace and strip comments so cosmetic differences between
      // schema.sql and a migration do not read as drift.
      const normalized = (sql ?? '')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
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
  for (const migration of MIGRATIONS.filter((m) => m.version > version)) {
    for (const name of createdObjects(migration.sql)) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
    }
  }
  db.pragma(`user_version = ${version}`);
  return db;
}

function createdObjects(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);
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

test('migrations are idempotent, so a retried run cannot fail', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  for (const migration of MIGRATIONS) {
    assert.doesNotThrow(() => db.exec(migration.sql), `${migration.description} is not re-runnable`);
  }
  db.close();
});

test('filter_presets enforces unique names case-insensitively', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const insert = db.prepare('INSERT INTO filter_presets (name, filters) VALUES (?, ?)');
  insert.run('Commander staples', '{}');
  assert.throws(() => insert.run('commander staples', '{}'), /UNIQUE/);
  db.close();
});
