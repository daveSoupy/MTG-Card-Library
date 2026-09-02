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
  {
    version: 5,
    description: 'Covering index for artist search',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_print_oracle_artist
        ON card_printings(oracle_id, artist);

      -- Without fresh statistics the planner keeps choosing idx_print_oracle
      -- and the new index goes unused: measured 130ms before ANALYZE and 18ms
      -- after, on the same database with the index present either way.
      ANALYZE;
    `,
  },
  {
    version: 6,
    description: 'Per-card art preference',
    sql: `
      CREATE TABLE IF NOT EXISTS card_art_preferences (
          oracle_id   TEXT PRIMARY KEY REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
          printing_id TEXT NOT NULL     REFERENCES card_printings(id)     ON DELETE CASCADE,
          updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
    `,
  },
  {
    version: 7,
    description: 'Deck covers, tags and snapshots',
    sql: `
      ALTER TABLE decks ADD COLUMN cover_printing_id TEXT REFERENCES card_printings(id) ON DELETE SET NULL;

      CREATE TABLE IF NOT EXISTS deck_tags (
          deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
          tag     TEXT    NOT NULL,
          PRIMARY KEY (deck_id, tag)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_tag_ci ON deck_tags(deck_id, tag COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_deck_tags_tag ON deck_tags(tag COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS deck_snapshots (
          id         INTEGER PRIMARY KEY,
          deck_id    INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          note       TEXT,
          created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_deck_snapshots_deck ON deck_snapshots(deck_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS deck_snapshot_cards (
          snapshot_id    INTEGER NOT NULL REFERENCES deck_snapshots(id) ON DELETE CASCADE,
          oracle_id      TEXT    NOT NULL,
          board          TEXT    NOT NULL,
          quantity       INTEGER NOT NULL,
          quantity_from_collection INTEGER NOT NULL DEFAULT 0,
          category       TEXT,
          commander_role TEXT,
          PRIMARY KEY (snapshot_id, oracle_id, board)
      );
    `,
  },
  {
    version: 8,
    description: 'Index for the legal-anywhere search filter',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_legal_playable ON card_legalities(oracle_id)
          WHERE legality IN ('legal','restricted');

      -- v5 learned this the hard way: the planner keeps its old choice until
      -- the statistics say otherwise, so the index alone changes nothing.
      ANALYZE;
    `,
  },
  {
    version: 9,
    description: 'Per-format commander eligibility',
    sql: `
      ALTER TABLE formats ADD COLUMN commander_kind TEXT NOT NULL DEFAULT 'legendary';

      UPDATE formats SET commander_kind = 'planeswalker'              WHERE code = 'oathbreaker';
      UPDATE formats SET commander_kind = 'legendary_or_planeswalker' WHERE code IN ('brawl','standardbrawl');
      UPDATE formats SET commander_kind = 'uncommon_creature'         WHERE code = 'paupercommander';
    `,
  },
];
