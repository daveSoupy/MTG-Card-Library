import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
/** Walk up out of src/db (or dist/db) to the repository root. */
const repoRoot = join(moduleDir, '..', '..', '..');

export const SCHEMA_PATH = join(repoRoot, 'schema.sql');

/** Schema version this build expects, read from the DDL itself. */
export function schemaVersion(sql: string): number {
  const match = /^PRAGMA user_version = (\d+);/m.exec(sql);
  if (!match) throw new Error('schema.sql has no PRAGMA user_version line');
  return Number.parseInt(match[1], 10);
}

export interface OpenOptions {
  /** Directory holding library.sqlite and the image cache. */
  dataDir: string;
  /** Set false in tests that want a scratch database without image dirs. */
  createImageDir?: boolean;
}

export interface LibraryDatabase {
  db: Database.Database;
  dataDir: string;
  databasePath: string;
  imageDir: string;
  close(): void;
}

/**
 * Opens (creating if needed) the card library database.
 *
 * schema.sql at the repository root is the single source of truth and is
 * executed verbatim on an empty database — there is no second copy of the DDL
 * to drift out of sync with it.
 */
export function openLibrary({ dataDir, createImageDir = true }: OpenOptions): LibraryDatabase {
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, 'library.sqlite');
  const imageDir = join(dataDir, 'images');
  if (createImageDir) mkdirSync(imageDir, { recursive: true });

  const db = new Database(databasePath);
  // WAL lets the sync worker write while HTTP requests keep reading.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // The sync holds long write transactions; readers should wait, not fail.
  db.pragma('busy_timeout = 10000');

  bootstrap(db);

  return {
    db,
    dataDir,
    databasePath,
    imageDir,
    close: () => db.close(),
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(name) as { n: number };
  return row.n > 0;
}

function bootstrap(db: Database.Database): void {
  const sql = readFileSync(SCHEMA_PATH, 'utf8');
  const target = schemaVersion(sql);

  if (!tableExists(db, 'oracle_cards')) {
    db.exec(sql);
    db.pragma(`user_version = ${target}`);
    return;
  }

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < target) migrate(db, current, target);
}

function migrate(db: Database.Database, from: number, to: number): void {
  // No released version predates the current schema, so there is nothing to
  // migrate yet. Each future step goes here guarded by `if (from < N)`, and the
  // version is only bumped once every step has succeeded.
  db.pragma(`user_version = ${to}`);
}

// -- settings -----------------------------------------------------------------

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings(key, value, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

export interface LibraryStatus {
  hasCardData: boolean;
  oracleCards: number;
  printings: number;
  sets: number;
  lastSyncedAt: string | null;
  loadedBulkType: string | null;
  loadedBulkUpdatedAt: string | null;
}

export function libraryStatus(db: Database.Database): LibraryStatus {
  const count = (table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  const oracleCards = count('oracle_cards');
  return {
    hasCardData: oracleCards > 0,
    oracleCards,
    printings: count('card_printings'),
    sets: count('sets'),
    lastSyncedAt: getSetting(db, 'last_bulk_sync_at') || null,
    loadedBulkType: getSetting(db, 'bulk_data_type'),
    loadedBulkUpdatedAt: getSetting(db, 'loaded_bulk_updated_at') || null,
  };
}
