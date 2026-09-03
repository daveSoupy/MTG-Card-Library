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
  {
    version: 10,
    description: 'Oathbreaker signature spells',
    sql: `
      ALTER TABLE formats ADD COLUMN uses_signature_spell INTEGER NOT NULL DEFAULT 0;
      UPDATE formats SET uses_signature_spell = 1 WHERE code = 'oathbreaker';

      -- deck_cards.commander_role needs a fifth value, and SQLite cannot widen
      -- a CHECK in place — the table has to be rebuilt. Safe with foreign keys
      -- on (the runner holds a transaction, so they cannot be turned off):
      -- deck_cards is a child of decks/oracle_cards/card_printings and nothing
      -- references it, so nothing cascades and no reference needs rewriting.
      -- Five views select from deck_cards, directly or through each other, and
      -- SQLite validates them whenever the schema is re-read — dropping the
      -- table underneath them fails the whole migration. Dropped innermost-last
      -- and recreated outermost-last, exactly as they stand at v10.
      DROP VIEW v_trade_list_status;
      DROP VIEW v_deck_shopping_list;
      DROP VIEW v_card_deck_usage;
      DROP VIEW v_card_availability;
      DROP VIEW v_allocated_by_oracle;

      CREATE TABLE deck_cards_new (
          id                      INTEGER PRIMARY KEY,
          deck_id                 INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
          oracle_id               TEXT    NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE RESTRICT,
          board                   TEXT    NOT NULL DEFAULT 'main'
                                      CHECK (board IN ('main','side','command','maybe')),
          quantity                INTEGER NOT NULL CHECK (quantity > 0),
          quantity_from_collection INTEGER NOT NULL DEFAULT 0
                                      CHECK (quantity_from_collection >= 0
                                             AND quantity_from_collection <= quantity),
          preferred_printing_id   TEXT REFERENCES card_printings(id) ON DELETE SET NULL,
          commander_role          TEXT CHECK (commander_role IS NULL OR commander_role IN
                                      ('commander','partner','background','companion','signature_spell')),
          category                TEXT,
          notes                   TEXT,
          sort_order              INTEGER NOT NULL DEFAULT 0,
          created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          UNIQUE (deck_id, oracle_id, board)
      );

      INSERT INTO deck_cards_new
        SELECT id, deck_id, oracle_id, board, quantity, quantity_from_collection,
               preferred_printing_id, commander_role, category, notes, sort_order, created_at
        FROM deck_cards;

      DROP TABLE deck_cards;
      ALTER TABLE deck_cards_new RENAME TO deck_cards;

      CREATE INDEX idx_deckcards_deck   ON deck_cards(deck_id);
      CREATE INDEX idx_deckcards_oracle ON deck_cards(oracle_id);
      CREATE INDEX idx_deckcards_alloc  ON deck_cards(oracle_id) WHERE quantity_from_collection > 0;

      CREATE VIEW v_allocated_by_oracle AS
      SELECT oracle_id, SUM(quantity_from_collection) AS allocated_qty
      FROM deck_cards
      WHERE board IN ('main','side','command')
        AND quantity_from_collection > 0
      GROUP BY oracle_id;

      CREATE VIEW v_card_availability AS
      SELECT o.oracle_id,
             COALESCE(w.owned_qty, 0)                                    AS owned_qty,
             COALESCE(a.allocated_qty, 0)                                AS allocated_qty,
             COALESCE(w.owned_qty, 0) - COALESCE(a.allocated_qty, 0)     AS available_qty,
             COALESCE(w.owned_value_usd, 0.0)                            AS owned_value_usd,
             -- Negative available = decks collectively claim more than you own.
             -- Flagged visually, never blocked.
             (COALESCE(w.owned_qty, 0) < COALESCE(a.allocated_qty, 0))   AS is_over_allocated
      FROM oracle_cards o
      LEFT JOIN v_owned_by_oracle     w ON w.oracle_id = o.oracle_id
      LEFT JOIN v_allocated_by_oracle a ON a.oracle_id = o.oracle_id
      WHERE w.oracle_id IS NOT NULL OR a.oracle_id IS NOT NULL;

      CREATE VIEW v_card_deck_usage AS
      SELECT dc.oracle_id,
             d.id            AS deck_id,
             d.name          AS deck_name,
             dc.board,
             dc.quantity     AS slot_quantity,
             dc.quantity_from_collection AS qty_from_collection,
             d.home_location_id,
             sl.name         AS deck_home_location
      FROM deck_cards dc
      JOIN decks d              ON d.id  = dc.deck_id
      LEFT JOIN storage_locations sl ON sl.id = d.home_location_id
      WHERE dc.quantity_from_collection > 0;

      CREATE VIEW v_deck_shopping_list AS
      SELECT dc.deck_id,
             d.name                                   AS deck_name,
             dc.oracle_id,
             o.name                                   AS card_name,
             dc.board,
             dc.quantity - dc.quantity_from_collection AS qty_to_buy,
             COALESCE(dc.preferred_printing_id, o.default_printing_id) AS price_printing_id,
             COALESCE(pp.price_usd, dp.price_usd)     AS unit_price_usd,
             (dc.quantity - dc.quantity_from_collection)
                 * COALESCE(pp.price_usd, dp.price_usd, 0.0) AS est_cost_usd
      FROM deck_cards dc
      JOIN decks d        ON d.id = dc.deck_id
      JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
      LEFT JOIN card_printings pp ON pp.id = dc.preferred_printing_id
      LEFT JOIN card_printings dp ON dp.id = o.default_printing_id
      WHERE dc.board IN ('main','side','command')
        AND dc.quantity > dc.quantity_from_collection;

      CREATE VIEW v_trade_list_status AS
      SELECT tli.id                   AS trade_list_item_id,
             tli.trade_list_id,
             tli.quantity             AS listed_qty,
             ci.id                    AS collection_item_id,
             ci.quantity              AS owned_qty_this_row,
             p.oracle_id,
             av.available_qty         AS available_qty_overall,
             (tli.quantity > ci.quantity)         AS exceeds_owned,
             (tli.quantity > COALESCE(av.available_qty, 0)) AS conflicts_with_deck_allocation
      FROM trade_list_items tli
      JOIN collection_items ci ON ci.id = tli.collection_item_id
      JOIN card_printings p    ON p.id  = ci.printing_id
      LEFT JOIN v_card_availability av ON av.oracle_id = p.oracle_id;
    `,
  },
  {
    version: 11,
    description: 'Precompute has_uncommon_printing on oracle_cards',
    sql: `
      ALTER TABLE oracle_cards ADD COLUMN has_uncommon_printing INTEGER NOT NULL DEFAULT 0;

      -- Backfill from the printings already synced. The deck read used to run
      -- this as a correlated EXISTS once per card in the deck; as a column it is
      -- a single indexed lookup. The next sync recomputes it anyway, but doing
      -- it here means an existing database is fast without waiting for one.
      UPDATE oracle_cards SET has_uncommon_printing = 1
      WHERE oracle_id IN (
        SELECT DISTINCT oracle_id FROM card_printings WHERE rarity = 'uncommon'
      );

      -- Fresh stats so the planner accounts for the new column.
      ANALYZE;
    `,
  },
];
