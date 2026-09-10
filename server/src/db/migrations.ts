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
      --
      -- IF EXISTS since v18: three of these five no longer exist in schema.sql,
      -- and the migration-equivalence fixture rewinds by dropping what a later
      -- migration created — so this step can now meet a database where v18's
      -- views have already been taken away.
      DROP VIEW IF EXISTS v_trade_list_status;
      DROP VIEW IF EXISTS v_deck_shopping_list;
      DROP VIEW IF EXISTS v_card_deck_usage;
      DROP VIEW IF EXISTS v_card_availability;
      DROP VIEW IF EXISTS v_allocated_by_oracle;

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
  {
    version: 12,
    description: 'Cost-pool columns on import_batches for the box-split cost method',
    sql: `
      -- A cost pool: a lump sum (e.g. a booster box) spread across the lots
      -- that reference the batch. NULL on ordinary import batches, which keep
      -- behaving exactly as before.
      ALTER TABLE import_batches ADD COLUMN total_cost_usd REAL;
      ALTER TABLE import_batches ADD COLUMN split_method TEXT;
    `,
  },
  {
    version: 13,
    description: 'Deck-building templates (Phase 7)',
    sql: `
      CREATE TABLE IF NOT EXISTS card_categories (
          oracle_id  TEXT NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
          category   TEXT NOT NULL,
          PRIMARY KEY (oracle_id, category)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_cardcat_category ON card_categories(category);

      CREATE TABLE IF NOT EXISTS deck_templates (
          id           INTEGER PRIMARY KEY,
          name         TEXT NOT NULL,
          format_code  TEXT REFERENCES formats(code) ON DELETE SET NULL,
          archetype    TEXT,
          description  TEXT,
          is_builtin   INTEGER NOT NULL DEFAULT 0,
          sort_order   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS deck_template_targets (
          template_id  INTEGER NOT NULL REFERENCES deck_templates(id) ON DELETE CASCADE,
          category     TEXT NOT NULL,
          ideal        INTEGER NOT NULL,
          min_count    INTEGER,
          max_count    INTEGER,
          note         TEXT,
          sort_order   INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (template_id, category)
      );

      ALTER TABLE decks ADD COLUMN template_id INTEGER REFERENCES deck_templates(id) ON DELETE SET NULL;

      INSERT INTO deck_templates (id, name, format_code, archetype, description, is_builtin, sort_order) VALUES
          (1, 'Commander — General',    'commander', NULL,       'The widely-cited Command Zone shape for a 100-card singleton deck.', 1, 10),
          (2, 'Commander — High Power', 'commander', NULL,       'Fewer lands, more ramp and tutors — built to close the game fast.',   1, 20),
          (3, '60-Card Aggro',          NULL,        'aggro',    'A fast, creature-heavy shell for 60-card constructed formats.',       1, 30),
          (4, '60-Card Midrange',       NULL,        'midrange', 'A balanced 60-card shell: card advantage backed by removal.',         1, 40),
          (5, '60-Card Control',        NULL,        'control',  'Few creatures, lots of answers, closing the game later.',             1, 50),
          (6, 'Limited 40-Card',        NULL,        'limited',  'The standard draft/sealed deck shape.',                                1, 60);

      INSERT INTO deck_template_targets (template_id, category, ideal, sort_order) VALUES
          (1, 'lands',        38, 0),
          (1, 'ramp',         10, 1),
          (1, 'draw',         10, 2),
          (1, 'removal',       5, 3),
          (1, 'sweeper',       3, 4),

          (2, 'lands',        35, 0),
          (2, 'ramp',         14, 1),
          (2, 'tutor',         8, 2),
          (2, 'draw',          8, 3),
          (2, 'removal',       6, 4),
          (2, 'sweeper',       2, 5),

          (3, 'lands',        22, 0),
          (3, 'creatures',    26, 1),
          (3, 'removal',       8, 2),

          (4, 'lands',        24, 0),
          (4, 'creatures',    20, 1),
          (4, 'removal',      12, 2),
          (4, 'draw',          4, 3),

          (5, 'lands',        26, 0),
          (5, 'creatures',     4, 1),
          (5, 'removal',      12, 2),
          (5, 'counterspell',  8, 3),
          (5, 'draw',          8, 4),

          (6, 'lands',        17, 0),
          (6, 'creatures',    15, 1);
    `,
  },
  {
    version: 14,
    description: 'Card rulings (Phase 8)',
    sql: `
      CREATE TABLE IF NOT EXISTS card_rulings (
          id            INTEGER PRIMARY KEY,
          oracle_id     TEXT NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
          source        TEXT NOT NULL CHECK (source IN ('wotc','scryfall')),
          published_at  TEXT NOT NULL,
          comment       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_rulings_oracle ON card_rulings(oracle_id);
    `,
  },
  {
    version: 15,
    description: 'Per-card deck copy limits (Relentless Rats and friends)',
    sql: `
      ALTER TABLE oracle_cards ADD COLUMN deck_copy_limit INTEGER;

      -- Backfilled here rather than left to the next sync, so an existing
      -- database enforces the exemption immediately. The patterns mirror
      -- parseDeckCopyLimit() in src/model/mtg.ts; keep the two in step.
      UPDATE oracle_cards SET deck_copy_limit = -1
       WHERE oracle_text_all LIKE '%deck can have any number of cards named%';

      -- "up to nine cards named Nazgul", "only one card named 1996 World
      -- Champion". Joined against a word list so the spelling-to-number
      -- mapping is written once instead of once per number.
      UPDATE oracle_cards SET deck_copy_limit = w.n
        FROM (SELECT 'one' AS word, 1 AS n
              UNION ALL SELECT 'two', 2       UNION ALL SELECT 'three', 3
              UNION ALL SELECT 'four', 4      UNION ALL SELECT 'five', 5
              UNION ALL SELECT 'six', 6       UNION ALL SELECT 'seven', 7
              UNION ALL SELECT 'eight', 8     UNION ALL SELECT 'nine', 9
              UNION ALL SELECT 'ten', 10      UNION ALL SELECT 'eleven', 11
              UNION ALL SELECT 'twelve', 12   UNION ALL SELECT 'thirteen', 13
              UNION ALL SELECT 'fourteen', 14 UNION ALL SELECT 'fifteen', 15
              UNION ALL SELECT 'sixteen', 16  UNION ALL SELECT 'seventeen', 17
              UNION ALL SELECT 'eighteen', 18 UNION ALL SELECT 'nineteen', 19
              UNION ALL SELECT 'twenty', 20) AS w
       WHERE oracle_cards.deck_copy_limit IS NULL
         AND (oracle_cards.oracle_text_all
                LIKE '%deck can have up to ' || w.word || ' card%'
           OR oracle_cards.oracle_text_all
                LIKE '%deck can have only ' || w.word || ' card%');

      -- Same fallback as the parser: a clause whose number the word list does
      -- not cover still overrides the format, we just cannot read by how much.
      UPDATE oracle_cards SET deck_copy_limit = -1
       WHERE deck_copy_limit IS NULL
         AND (oracle_text_all LIKE '%deck can have up to %cards named%'
           OR oracle_text_all LIKE '%deck can have only %cards named%'
           OR oracle_text_all LIKE '%deck can have up to %card named%'
           OR oracle_text_all LIKE '%deck can have only %card named%');
    `,
  },
  {
    version: 16,
    description: 'Events, the game log, and the two limited formats (Phase 11)',
    sql: `
      CREATE TABLE IF NOT EXISTS events (
          id              INTEGER PRIMARY KEY,
          name            TEXT    NOT NULL,
          format_code     TEXT    REFERENCES formats(code) ON DELETE SET NULL,
          event_date      TEXT,
          deck_id         INTEGER REFERENCES decks(id) ON DELETE SET NULL,
          import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
          notes           TEXT,
          created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_date  ON events(event_date DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_events_deck  ON events(deck_id);
      CREATE INDEX IF NOT EXISTS idx_events_batch ON events(import_batch_id);

      CREATE TABLE IF NOT EXISTS games (
          id           INTEGER PRIMARY KEY,
          event_id     INTEGER REFERENCES events(id) ON DELETE SET NULL,
          deck_id      INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
          played_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          opponents    TEXT,
          result       TEXT    NOT NULL CHECK (result IN ('win','loss','draw')),
          games_won    INTEGER,
          games_lost   INTEGER,
          games_drawn  INTEGER,
          round_number INTEGER,
          notes        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_games_deck  ON games(deck_id, played_at DESC);
      CREATE INDEX IF NOT EXISTS idx_games_event ON games(event_id, round_number);

      -- Draft and sealed as data, the same as every other format. Scryfall
      -- publishes no legalities for either, so the validator skips the check
      -- for them rather than reading every card as illegal; max_copies is 99
      -- because limited has no copy limit — you play what you opened.
      INSERT OR IGNORE INTO formats
          (code, display_name, min_deck_size, exact_deck_size, max_copies, is_singleton,
           sideboard_size, requires_commander, enforces_color_id, is_active, sort_order) VALUES
          ('draft',  'Draft',  40, NULL, 99, 0, NULL, 0, 0, 1, 230),
          ('sealed', 'Sealed', 40, NULL, 99, 0, NULL, 0, 0, 1, 240);
    `,
  },
  {
    version: 17,
    description: 'Games outlive the deck they were played with (Phase 11)',
    sql: `
      -- Stamped as the deck is deleted; NULL for as long as the deck exists,
      -- which is the only copy of its name worth reading until then.
      ALTER TABLE games ADD COLUMN deck_name TEXT;

      -- deck_id has to become nullable, with ON DELETE SET NULL in place of
      -- CASCADE, and SQLite can change neither in place — so the table is
      -- rebuilt. Safe inside the runner's transaction: games is a child of
      -- decks and events, no view reads it, and nothing else references it, so
      -- nothing cascades and no reference needs rewriting.
      --
      -- The trigger below is the exception, and it goes first: SQLite
      -- validates every trigger body whenever the schema is re-read, so
      -- dropping games out from under one that writes to it fails the whole
      -- migration. Same reason v10 dropped its views before rebuilding
      -- deck_cards. Harmless on the upgrade path, where it does not exist yet.
      DROP TRIGGER IF EXISTS trg_games_keep_deck_name;
      DROP INDEX IF EXISTS idx_games_deck;
      DROP INDEX IF EXISTS idx_games_event;

      CREATE TABLE games_new (
          id           INTEGER PRIMARY KEY,
          event_id     INTEGER REFERENCES events(id) ON DELETE SET NULL,
          deck_id      INTEGER REFERENCES decks(id) ON DELETE SET NULL,
          deck_name    TEXT,
          played_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
          opponents    TEXT,
          result       TEXT    NOT NULL CHECK (result IN ('win','loss','draw')),
          games_won    INTEGER,
          games_lost   INTEGER,
          games_drawn  INTEGER,
          round_number INTEGER,
          notes        TEXT
      );

      INSERT INTO games_new
        SELECT id, event_id, deck_id, deck_name, played_at, opponents, result,
               games_won, games_lost, games_drawn, round_number, notes
        FROM games;

      DROP TABLE games;
      ALTER TABLE games_new RENAME TO games;

      CREATE INDEX idx_games_deck  ON games(deck_id, played_at DESC);
      CREATE INDEX idx_games_event ON games(event_id, round_number);

      -- The other half of SET NULL: without this a detached game would keep no
      -- record of what it was played with.
      CREATE TRIGGER trg_games_keep_deck_name BEFORE DELETE ON decks BEGIN
          UPDATE games SET deck_name = OLD.name WHERE deck_id = OLD.id;
      END;
    `,
  },
  {
    version: 18,
    description: 'Allocation honesty: deck status, proxies, and the end of the availability views (Phase 22)',
    sql: `
      ALTER TABLE decks ADD COLUMN status TEXT NOT NULL DEFAULT 'brew'
          CHECK (status IN ('brew','building','assembled','disassembled'));
      ALTER TABLE decks ADD COLUMN status_changed_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_decks_status ON decks(status);

      -- Every existing deck reserves its copies today, and 'assembled' is the
      -- status that keeps doing so. Taking the column default instead would
      -- free hundreds of copies and change every number in the app during an
      -- upgrade, which is not a thing a migration gets to do. New decks get
      -- 'brew' from the default; these ones are stamped so status_changed_at
      -- is never NULL for a deck that has a status.
      UPDATE decks SET status = 'assembled',
                       status_changed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now');

      -- No cross-column CHECK: quantity_from_collection + quantity_proxied <=
      -- quantity is enforced in DeckStore, in one place, with a test. See the
      -- comment beside the column in schema.sql.
      ALTER TABLE deck_cards ADD COLUMN quantity_proxied INTEGER NOT NULL DEFAULT 0
          CHECK (quantity_proxied >= 0);
      ALTER TABLE deck_snapshot_cards ADD COLUMN quantity_proxied INTEGER NOT NULL DEFAULT 0;

      -- Availability is no longer expressible in SQL — it depends on deck
      -- status and on three app_settings keys — so the views that encoded the
      -- old \`owned - allocated\` rule go, rather than sitting beside
      -- server/src/decks/allocation.ts telling a different story.
      --
      -- Dropped innermost-last, exactly as v10 did, because SQLite validates
      -- every view whenever the schema is re-read. IF EXISTS because the
      -- migration-equivalence fixture is built from the current schema.sql,
      -- which no longer defines them.
      DROP VIEW IF EXISTS v_trade_list_status;
      DROP VIEW IF EXISTS v_deck_shopping_list;
      DROP VIEW IF EXISTS v_card_deck_usage;
      DROP VIEW IF EXISTS v_card_availability;
      DROP VIEW IF EXISTS v_allocated_by_oracle;

      CREATE VIEW v_card_deck_usage AS
      SELECT dc.oracle_id,
             d.id            AS deck_id,
             d.name          AS deck_name,
             dc.board,
             dc.quantity     AS slot_quantity,
             dc.quantity_from_collection AS qty_from_collection,
             dc.quantity_proxied         AS qty_proxied,
             d.status        AS deck_status,
             d.home_location_id,
             sl.name         AS deck_home_location
      FROM deck_cards dc
      JOIN decks d              ON d.id  = dc.deck_id
      LEFT JOIN storage_locations sl ON sl.id = d.home_location_id
      WHERE dc.quantity_from_collection > 0 OR dc.quantity_proxied > 0;

      CREATE VIEW v_trade_list_status AS
      SELECT tli.id                   AS trade_list_item_id,
             tli.trade_list_id,
             tli.quantity             AS listed_qty,
             ci.id                    AS collection_item_id,
             ci.quantity              AS owned_qty_this_row,
             p.oracle_id,
             (tli.quantity > ci.quantity)         AS exceeds_owned
      FROM trade_list_items tli
      JOIN collection_items ci ON ci.id = tli.collection_item_id
      JOIN card_printings p    ON p.id  = ci.printing_id;
    `,
  },
];
