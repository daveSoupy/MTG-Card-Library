import type Database from 'better-sqlite3';
import DatabaseConstructor from 'better-sqlite3';
import { mkdirSync, rmSync, statSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCHEMA_PATH } from '../db/index.ts';

/**
 * Backup and restore.
 *
 * Everything irreplaceable is in one SQLite file, and the card cache inside it
 * re-downloads from Scryfall in about 17 seconds — so a backup is really about
 * the collection, decks and trades.
 */

/**
 * Tables holding the user's own data, in an order that satisfies foreign keys
 * on insert. Card-database tables are deliberately absent: they are a cache,
 * and copying half a million printings would make every backup enormous for no
 * benefit.
 */
export const USER_TABLES = [
  'storage_locations',
  'import_batches',
  'collection_items',
  'collection_disposals',
  'collection_value_snapshots',
  'decks',
  'deck_cards',
  'trades',
  'trade_items',
  'want_lists',
  'want_list_items',
  'want_list_item_decks',
  'trade_lists',
  'trade_list_items',
  'filter_presets',
  'card_art_preferences',
  'alerts',
  'scan_sessions',
  'ocr_corrections',
  'app_settings',
] as const;

/**
 * Writes the user's data to a new database at `destination`.
 *
 * Deliberately *not* `VACUUM INTO`, which copies the whole file: the card cache
 * is 236MB of it against a few hundred KB of actual collection, and that is a
 * download the user would be making over Tailscale from a phone, seven times
 * over on disk. So the destination gets a fresh schema and only the user
 * tables, leaving a backup small enough to keep and to send.
 *
 * The copy reads the live database from a second connection inside one
 * transaction. Under WAL that is a consistent snapshot, and the server keeps
 * serving throughout — which matters on an unattended host.
 */
export function backupTo(db: Database.Database, destination: string): { path: string; bytes: number } {
  rmSync(destination, { force: true });

  // The destination is created and given a schema on its own connection, then
  // closed — schema.sql's DDL is unqualified, so it can only be applied to a
  // connection's own `main`.
  const fresh = new DatabaseConstructor(destination);
  try {
    fresh.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    // Match the running database rather than schema.sql, so a backup taken
    // before a pending migration restores into the version that produced it.
    fresh.pragma(`user_version = ${db.pragma('user_version', { simple: true })}`);
  } finally {
    fresh.close();
  }

  // The copy then runs on the live connection, reading its own tables. One
  // transaction, so the backup is a consistent snapshot, and short enough not
  // to matter now that it carries only user data.
  db.exec(`ATTACH DATABASE '${destination.replace(/'/g, "''")}' AS backup`);
  try {
    // The backup has no card cache, so every collection row copied into it
    // points at a printing that is not there. That is the intended shape of the
    // file — restoreFrom expects it — but it has to get past the constraint on
    // the way in. The pragma is a no-op inside a transaction, hence out here.
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      // schema.sql seeds a default storage location, so the new file is not
      // actually empty; those rows would collide with the ones being copied.
      for (const table of [...USER_TABLES].reverse()) {
        db.prepare(`DELETE FROM backup.${table}`).run();
      }

      for (const table of USER_TABLES) {
        const columns = sharedColumns(db, table);
        if (columns.length === 0) continue;
        const list = columns.map((c) => `"${c}"`).join(', ');
        db.prepare(`INSERT INTO backup.${table} (${list}) SELECT ${list} FROM main.${table}`).run();
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
    db.exec('DETACH DATABASE backup');
  }

  return { path: destination, bytes: statSync(destination).size };
}

/** Backup into a temporary file, for streaming as a download. */
export function backupToTemp(db: Database.Database): { path: string; bytes: number; cleanup: () => void } {
  const dir = join(tmpdir(), 'mtg-library-backup');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `library-${Date.now()}.sqlite`);
  const { bytes } = backupTo(db, path);
  return { path, bytes, cleanup: () => rmSync(path, { force: true }) };
}

export interface RestoreReport {
  restored: Array<{ table: string; rows: number }>;
  skipped: Array<{ table: string; reason: string }>;
  totalRows: number;
  /**
   * Rows referring to cards the local cache does not have yet. Expected when
   * restoring before the first sync; they resolve once it runs.
   */
  pendingCardReferences: number;
}

export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBackupError';
  }
}

/**
 * Replaces the user's data with the contents of a backup file.
 *
 * Copies table by table under one transaction rather than swapping the file on
 * disk: swapping would need the running server to drop and reopen its
 * connection, and a failure half way would leave no database at all. This way a
 * failed restore rolls back and the existing data is untouched.
 *
 * The card cache is left alone — the backup may not contain one, and the live
 * one is already current.
 */
export function restoreFrom(db: Database.Database, backupPath: string): RestoreReport {
  // Opening is lazy — better-sqlite3 does not touch the file header until the
  // first statement runs, so a text file constructs fine and only fails below.
  // Everything up to the last check therefore has to translate SQLite's errors,
  // since picking the wrong file is the likeliest way to arrive here.
  let source: Database.Database;
  try {
    source = new DatabaseConstructor(backupPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new InvalidBackupError('That file could not be opened as a database.');
  }

  try {
    const marker = source.prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'collection_items'`,
    ).get() as { n: number };
    if (marker.n === 0) {
      throw new InvalidBackupError('That database is not an MTG Library backup.');
    }

    const sourceVersion = source.pragma('user_version', { simple: true }) as number;
    const targetVersion = db.pragma('user_version', { simple: true }) as number;
    if (sourceVersion > targetVersion) {
      throw new InvalidBackupError(
        `That backup is from a newer version of the app (schema v${sourceVersion}, this is v${targetVersion}). Update before restoring it.`,
      );
    }
    source.close();
  } catch (error) {
    try { source.close(); } catch { /* already closed */ }
    if (error instanceof InvalidBackupError) throw error;
    throw new InvalidBackupError('That file is not a database.');
  }

  const report: RestoreReport = { restored: [], skipped: [], totalRows: 0, pendingCardReferences: 0 };

  db.exec(`ATTACH DATABASE '${backupPath.replace(/'/g, "''")}' AS backup`);
  try {
    // Foreign keys are off for the swap so tables can be emptied and refilled
    // in any order; they are checked again at the end, before committing.
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      for (const table of [...USER_TABLES].reverse()) {
        db.prepare(`DELETE FROM main.${table}`).run();
      }

      for (const table of USER_TABLES) {
        const exists = db.prepare(
          `SELECT count(*) AS n FROM backup.sqlite_master WHERE type='table' AND name = ?`,
        ).get(table) as { n: number };
        if (exists.n === 0) {
          // An older backup simply predates this table.
          report.skipped.push({ table, reason: 'not present in the backup' });
          continue;
        }

        // Column-wise, so a backup missing a column added later still restores.
        const columns = sharedColumns(db, table);
        if (columns.length === 0) {
          report.skipped.push({ table, reason: 'no columns in common' });
          continue;
        }
        const list = columns.map((c) => `"${c}"`).join(', ');
        const result = db.prepare(
          `INSERT INTO main.${table} (${list}) SELECT ${list} FROM backup.${table}`,
        ).run();
        report.restored.push({ table, rows: result.changes });
        report.totalRows += result.changes;
      }

      // Two very different kinds of violation come out of this check.
      //
      // A reference into the card cache is expected: the backup does not carry
      // the cache, so restoring onto a machine that has not synced yet leaves
      // every collection row pointing at a printing that is not there. Those
      // are Scryfall's own ids and resolve themselves after a sync, so
      // refusing the restore would break the one case backups exist for.
      //
      // A reference between two user tables is a genuinely corrupt backup, and
      // that does abort — rolling the whole transaction back.
      const userTables = new Set<string>(USER_TABLES);
      const violations = db.prepare('PRAGMA main.foreign_key_check').all() as Array<{ parent: string }>;
      const corrupt = violations.filter((row) => userTables.has(row.parent));
      report.pendingCardReferences = violations.length - corrupt.length;

      if (corrupt.length > 0) {
        throw new InvalidBackupError(
          `That backup is internally inconsistent (${corrupt.length} broken references between its own records); nothing was changed.`,
        );
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
    db.exec('DETACH DATABASE backup');
  }

  return report;
}

/**
 * Columns present in both the live table and the backup's copy of it, so a
 * backup taken before a column was added still restores.
 *
 * The second argument to `pragma_table_info` selects the schema. Writing
 * `backup.pragma_table_info(...)` instead looks equivalent and is not — it
 * silently returns *main's* columns, with no error to notice.
 */
function sharedColumns(db: Database.Database, table: string): string[] {
  const columnsIn = (schema: string) =>
    (db.prepare('SELECT name FROM pragma_table_info(?, ?)').all(table, schema) as Array<{ name: string }>)
      .map((row) => row.name);

  const backup = new Set(columnsIn('backup'));
  return columnsIn('main').filter((name) => backup.has(name));
}

/** Removes all but the newest `keep` backups in a directory. */
export function pruneBackups(directory: string, keep: number): string[] {
  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith('.sqlite'));
  } catch {
    return [];
  }

  const sorted = files
    .map((name) => ({ name, time: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  const removed: string[] = [];
  for (const file of sorted.slice(keep)) {
    unlinkSync(join(directory, file.name));
    removed.push(file.name);
  }
  return removed;
}
