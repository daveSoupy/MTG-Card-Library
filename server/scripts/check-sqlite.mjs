#!/usr/bin/env node
// Verifies that the SQLite build behind better-sqlite3 has everything schema.sql
// needs. Worth re-running after `npm rebuild` on a new host — better-sqlite3 is a
// native module, and a rebuild against a different SQLite can quietly lose FTS5.
//
//   node server/scripts/check-sqlite.mjs

import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = join(tmpdir(), `mtg-sqlite-check-${process.pid}.sqlite`);
const cleanup = () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(scratch + suffix); } catch {}
  }
};

let failures = 0;
const check = (label, fn) => {
  try {
    const result = fn();
    // exec() returns the Database for chaining; only scalars are worth showing.
    const detail = typeof result === 'object' || result === undefined ? '' : `   ${result}`;
    console.log(`  ${label.padEnd(30)} ok${detail}`);
  } catch (error) {
    console.log(`  ${label.padEnd(30)} FAILED   ${error.message}`);
    failures += 1;
  }
};

const memory = new Database(':memory:');
console.log('SQLite capabilities');
console.log(`  ${'version'.padEnd(30)}      ${memory.prepare('SELECT sqlite_version() v').get().v}`);

// Each of these is load-bearing for schema.sql.
check('FTS5', () => memory.exec('CREATE VIRTUAL TABLE t1 USING fts5(a)'));
check('FTS5 trigram tokenizer', () => memory.exec("CREATE VIRTUAL TABLE t2 USING fts5(a, tokenize='trigram')"));
check('unicode61 remove_diacritics', () => memory.exec("CREATE VIRTUAL TABLE t3 USING fts5(a, tokenize='unicode61 remove_diacritics 2')"));
check('JSON functions', () => memory.prepare(`SELECT json_extract('{"a":42}','$.a') v`).get().v);
check('WITHOUT ROWID', () => memory.exec('CREATE TABLE t4(a TEXT, b TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID'));
check('partial unique index', () => memory.exec('CREATE TABLE t5(a INT, b INT); CREATE UNIQUE INDEX i5 ON t5(a) WHERE b=1'));
check('foreign keys enforced', () => {
  memory.pragma('foreign_keys = ON');
  return memory.pragma('foreign_keys', { simple: true }) === 1 ? 'on' : 'OFF';
});
memory.close();

if (failures > 0) {
  console.error(`\n${failures} capability check(s) failed — schema.sql will not load.`);
  console.error('Try `npm rebuild better-sqlite3 --build-from-source`, or fall back to node:sqlite.');
  process.exit(1);
}

console.log('\nSchema load');
cleanup();
const db = new Database(scratch);
try {
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));

  const byType = db.prepare(`
    SELECT type, count(*) AS n FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type`).all();
  for (const { type, n } of byType) console.log(`  ${type.padEnd(30)} ${n}`);

  // FTS5 creates shadow tables; the interesting number is the real ones.
  const baseTables = db.prepare(`
    SELECT count(*) AS n FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('card_search', 'card_name_trgm')
      AND name NOT LIKE 'card_search_%' AND name NOT LIKE 'card_name_trgm_%'`).get().n;

  console.log(`  ${'base tables (excluding FTS)'.padEnd(30)} ${baseTables}`);
  console.log(`  ${'user_version'.padEnd(30)} ${db.pragma('user_version', { simple: true })}`);
  console.log(`  ${'seeded formats'.padEnd(30)} ${db.prepare('SELECT count(*) AS n FROM formats').get().n}`);
  console.log(`  ${'default storage location'.padEnd(30)} ${db.prepare('SELECT name FROM storage_locations WHERE is_default = 1').get()?.name ?? 'MISSING'}`);

  console.log('\nAll checks passed.');
} finally {
  db.close();
  cleanup();
}
