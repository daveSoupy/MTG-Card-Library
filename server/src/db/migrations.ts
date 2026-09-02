/**
 * Schema migrations for databases that already hold data.
 *
 * `schema.sql` remains the source of truth for a *fresh* database; these steps
 * only bring an existing one up to the same shape. That means the DDL for a new
 * object is written twice — once in schema.sql and once here — which is the
 * unavoidable cost of migrations. The `migrations.test.ts` equivalence check
 * exists precisely to catch the two drifting apart: it migrates an old database
 * and asserts it ends up byte-identical in structure to a fresh one.
 *
 * Each entry runs when the database's `user_version` is below `version`, in
 * ascending order, and the version is only bumped once every step succeeds.
 */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 3,
    description: 'Saved filter presets',
    sql: `
      CREATE TABLE IF NOT EXISTS filter_presets (
          id          INTEGER PRIMARY KEY,
          name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
          filters     TEXT    NOT NULL,
          query_text  TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
    `,
  },
  {
    version: 4,
    description: 'Commander partner pairing',
    sql: `
      -- SQLite has no "ADD COLUMN IF NOT EXISTS"; the runner is wrapped in a
      -- transaction and only runs for databases below this version, so a plain
      -- ADD COLUMN is safe. Re-runnability is covered by the guard in
      -- bootstrap(), which never replays a migration at or below user_version.
      ALTER TABLE oracle_cards ADD COLUMN partner_kind TEXT;
      ALTER TABLE oracle_cards ADD COLUMN partner_with TEXT;
    `,
  },
];
