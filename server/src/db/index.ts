import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from './migrations.ts';

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
  instanceId(db);

  return {
    db,
    dataDir,
    databasePath,
    imageDir,
    close: () => {
      // Refreshes the query planner's statistics from what this session
      // touched, cheaply — the full ANALYZE after a sync covers the rest.
      db.pragma('optimize');
      db.close();
    },
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
  const pending = MIGRATIONS
    .filter((m) => m.version > from && m.version <= to)
    .sort((a, b) => a.version - b.version);

  // Refuse to record a version whose work does not exist.
  //
  // Without this the runner would happily bump user_version to schema.sql's
  // target having applied nothing, and the database would then claim a shape
  // it does not have — permanently, because the version it now reports stops
  // the real migration ever running. That is not hypothetical: bumping
  // schema.sql's PRAGMA before writing the matching migration entry is the
  // natural order to edit the two files in, and doing exactly that marked a
  // live database as v22 while it still carried the column v22 removes.
  //
  // Migration versions in this file are contiguous, so there is no legitimate
  // "nothing to do for this version" case to allow through. Throwing leaves
  // the database untouched and readable at its old version, which is the
  // recoverable failure; silently mislabelling it is not.
  if (pending.length === 0) {
    throw new Error(
      `schema.sql is at v${to} but no migration exists above v${from}. `
      + 'Add the migration before bumping PRAGMA user_version.',
    );
  }

  // One transaction for the whole run: a half-migrated database with a bumped
  // version would be worse than one that simply refuses to start.
  db.transaction(() => {
    for (const migration of pending) db.exec(migration.sql);
    db.pragma(`user_version = ${to}`);
  })();

  // Compact, once, after a migration has actually run.
  //
  // This is not housekeeping — without it some migrations deliver nothing.
  // SQLite's ALTER TABLE ... DROP COLUMN rewrites each row but leaves the
  // freed bytes as slack inside their existing pages, so dropping a 60MB
  // column moved this library's file size by zero. A VACUUM rebuilds the file
  // and hands the space back to the filesystem: measured on the real 451MB
  // library, the drop alone left it at 451MB and the VACUUM took it to 373MB
  // in 2.7 seconds.
  //
  // Outside the transaction above because VACUUM cannot run inside one, and
  // after the version bump because the migration is already durable by then —
  // so this is pure recovery of space and nothing depends on it. It needs
  // temporary room for a second copy of the database, which a small disk may
  // not have, and that is the expected failure rather than a broken one: the
  // database is correct either way, so a throw here must not stop the server
  // starting. The pages stay free for SQLite to reuse regardless.
  try {
    db.exec('VACUUM');
  } catch {
    // Out of disk, or a reader holding the file open. Harmless — the schema
    // is already migrated and the free pages are still reusable.
  }
}

// -- prepared statement cache --------------------------------------------------

/**
 * One compiled statement per (database, SQL) pair.
 *
 * better-sqlite3 keeps no statement cache of its own, so every `db.prepare()`
 * is a real parse and code generation pass. That is invisible until you count
 * the calls: `getSetting` below is reached three times by every
 * `allocationSettings()`, which itself runs on every search — so on every
 * keystroke — and inside every claim reconcile and every buildability gather.
 *
 * Keyed by database through a WeakMap rather than held in a module constant,
 * because a Statement belongs to the connection that compiled it and the tests
 * open a fresh in-memory database per case. The WeakMap lets those be
 * collected with their statements instead of pinning every test database in
 * memory for the life of the process.
 *
 * Only safe because nothing in this codebase calls `.iterate()`: a cached
 * statement cannot be re-entered while a previous iteration is still open.
 * `.get()`, `.all()` and `.run()` all complete before they return, so reuse is
 * fine. If you add an `.iterate()` call, prepare that one statement yourself.
 */
const statementCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function prepared(db: Database.Database, sql: string): Database.Statement {
  let forDb = statementCache.get(db);
  if (!forDb) {
    forDb = new Map();
    statementCache.set(db, forDb);
  }
  let statement = forDb.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    forDb.set(sql, statement);
  }
  return statement;
}

// -- settings -----------------------------------------------------------------

const GET_SETTING_SQL = 'SELECT value FROM app_settings WHERE key = ?';
const SET_SETTING_SQL =
  `INSERT INTO app_settings(key, value, updated_at)
   VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

export function getSetting(db: Database.Database, key: string): string | null {
  const row = prepared(db, GET_SETTING_SQL).get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  prepared(db, SET_SETTING_SQL).run(key, value);
}

// -- instance identity (Phase 33) ---------------------------------------------

/**
 * The `app_settings` key holding this library's identity. Written straight
 * through `setSetting` rather than the settings route, whose allowlists gate
 * what the *route* accepts — this key is never accepted there and is not
 * user-editable.
 */
export const INSTANCE_ID = 'instance_id';

/**
 * A UUID that identifies this library to a phone that paired with it, stable
 * across restarts and address changes. Minted on first open; a fresh data
 * directory gets a fresh one.
 *
 * Get-or-create rather than create-once-at-open, because a restore replaces
 * `app_settings` wholesale (`porting/backup.ts`): a backup from before this
 * phase carries no id, and the instance endpoint must not answer with none
 * until the next restart. A backup from after it carries the id with it —
 * deliberately, so a library moved to a new machine is still the library the
 * phone paired with.
 */
export function instanceId(db: Database.Database): string {
  const existing = getSetting(db, INSTANCE_ID);
  if (existing) return existing;
  const id = randomUUID();
  setSetting(db, INSTANCE_ID, id);
  return id;
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
