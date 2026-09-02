-- =====================================================================
-- MTG Deck Builder — complete SQLite schema (v2)
--
-- Designed against the FULL Data Model in CLAUDE.md (all seven entities
-- plus allocation tracking), not just Phase 1, so later phases add code
-- rather than migrations.
--
-- v4 changes: partner_kind / partner_with capture how a card may pair as a
-- second commander. A single "has partner" boolean cannot: "Partner with
-- [name]" pairs only with that one card, so the name has to be stored.
--
-- v3 changes: filter_presets stores saved search + filter combinations.
--
-- v2 changes: collection_items is now LOT-grained (one row per purchase,
-- carrying its own cost basis) rather than one merged row per stack;
-- printing_price_history records per-card prices for owned/wanted cards;
-- and collection_disposals captures cost basis on the way out, so gain is
-- realized rather than lost when a card is traded, sold, or given away.
--
-- Conventions:
--   * Timestamps  : TEXT, ISO-8601 UTC ('2026-09-01T14:03:00Z')
--   * Dates       : TEXT, 'YYYY-MM-DD'
--   * Booleans    : INTEGER 0/1
--   * Money       : REAL, USD unless the column says otherwise
--   * JSON blobs  : TEXT holding a JSON array/object (queried with json_each)
--   * Scryfall ids: TEXT UUIDs, used directly as primary keys
-- =====================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA user_version = 6;


-- =====================================================================
-- SECTION 0 — App metadata, sync bookkeeping, format rules
-- =====================================================================

-- Simple key/value bag: last sync time, preferred currency, image cache
-- cap, "unsorted" location id, UI prefs. Avoids a migration per setting.
CREATE TABLE app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- One row per bulk-data sync attempt. Keeps a visible history so a failed
-- sync is diagnosable and a stale cache is explainable to the user.
CREATE TABLE sync_log (
    id                      INTEGER PRIMARY KEY,
    bulk_type               TEXT    NOT NULL,          -- 'default_cards' | 'oracle_cards' | 'sets' | 'prices'
    scryfall_updated_at     TEXT,                      -- bulk file's own updated_at, from the bulk-data manifest
    download_uri            TEXT,
    started_at              TEXT    NOT NULL,
    finished_at             TEXT,
    status                  TEXT    NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running','success','failed','cancelled')),
    bytes_downloaded        INTEGER,
    printings_upserted      INTEGER,
    oracle_cards_upserted   INTEGER,
    error_message           TEXT
);
CREATE INDEX idx_sync_log_started ON sync_log(started_at DESC);

-- Seeded reference data, NOT synced. Encodes the Phase 2 / Phase 3
-- deck-construction rules so validation is data-driven instead of a
-- switch statement. Rows are keyed by Scryfall's `legalities` keys.
CREATE TABLE formats (
    code                TEXT PRIMARY KEY,   -- 'standard','modern','commander','pauper',...
    display_name        TEXT    NOT NULL,
    min_deck_size       INTEGER,            -- 60 for most constructed; NULL = no minimum
    exact_deck_size     INTEGER,            -- 100 for Commander; NULL = use min_deck_size
    max_copies          INTEGER NOT NULL DEFAULT 4,   -- 4 constructed, 1 singleton
    basics_exempt       INTEGER NOT NULL DEFAULT 1,   -- basic lands ignore max_copies
    is_singleton        INTEGER NOT NULL DEFAULT 0,
    sideboard_size      INTEGER,            -- 15 constructed, NULL/0 = none
    requires_commander  INTEGER NOT NULL DEFAULT 0,
    enforces_color_id   INTEGER NOT NULL DEFAULT 0,   -- restrict deck to commander's color identity
    is_active           INTEGER NOT NULL DEFAULT 1,   -- show in the format picker
    sort_order          INTEGER NOT NULL DEFAULT 0
);


-- Saved filter sets.
--
-- Rebuilding the same colour/format/rarity combination on every deck-building
-- session is the kind of friction that stops people using filters at all. The
-- filter payload is JSON rather than columns because nothing ever queries
-- *inside* it — it is handed back to the client exactly as it was saved, and
-- the set of filters will grow with later phases.
CREATE TABLE filter_presets (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    -- The structured filters, in the shape the search API accepts.
    filters     TEXT    NOT NULL,
    -- The Scryfall-syntax box, saved alongside so a preset can capture
    -- something like "cmc<=2" that has no structured equivalent.
    query_text  TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Which printing's art a card should wear, when the automatic choice is not
-- the one you want. The automatic choice (oracle_cards.default_printing_id)
-- is recomputed on every sync and can move; this does not.
CREATE TABLE card_art_preferences (
    oracle_id   TEXT PRIMARY KEY REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
    printing_id TEXT NOT NULL     REFERENCES card_printings(id)     ON DELETE CASCADE,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);


-- =====================================================================
-- SECTION 1 — CARD DATABASE (read-only mirror of Scryfall)
--
-- Split deliberately into ORACLE level and PRINTING level:
--   * Decks, legality, color identity, rules  -> oracle level
--   * Collection, prices, images, set/number  -> printing level
-- Conflating them is the single biggest schema mistake available here,
-- because CLAUDE.md requires per-printing collection value while deck
-- rules (4-of, singleton) count across all printings of a name.
-- =====================================================================

CREATE TABLE sets (
    code            TEXT PRIMARY KEY,       -- lowercase Scryfall set code, e.g. 'blb'
    scryfall_id     TEXT UNIQUE,
    name            TEXT    NOT NULL,
    set_type        TEXT,                   -- 'expansion','core','masters','commander',...
    released_at     TEXT,                   -- 'YYYY-MM-DD'
    card_count      INTEGER,                -- official count; denominator for set-completion %
    parent_set_code TEXT REFERENCES sets(code) ON DELETE SET NULL,
    block_code      TEXT,
    block_name      TEXT,
    digital         INTEGER NOT NULL DEFAULT 0,
    nonfoil_only    INTEGER NOT NULL DEFAULT 0,
    foil_only       INTEGER NOT NULL DEFAULT 0,
    icon_svg_uri    TEXT,
    scryfall_uri    TEXT,
    updated_at      TEXT
);
CREATE INDEX idx_sets_released ON sets(released_at DESC);
CREATE INDEX idx_sets_type     ON sets(set_type);

-- One row per distinct card (Scryfall oracle_id). Everything a deck or a
-- rules check cares about lives here.
--
-- partner_kind / partner_with record how a card may pair as a second commander.
-- A single boolean cannot express this, because "Partner with [name]" pairs
-- only with that one card:
--   'partner'            plain Partner, pairs with any other
--   'partner_with'       pairs only with the card named in partner_with
--   'friends_forever'    pairs with any other Friends forever
--   'doctors_companion'  pairs with a Time Lord Doctor
--   'choose_background'  pairs with a Background
--   'background'         is a Background
--
-- Those two sit at the end of the column list because they arrived in a
-- migration and SQLite's ADD COLUMN appends. Keep multi-line comments out of
-- the column list entirely: they corrupt the DDL that DROP COLUMN rewrites.
CREATE TABLE oracle_cards (
    oracle_id           TEXT PRIMARY KEY,   -- rowid-backed on purpose: FTS5 external content needs it
    name                TEXT    NOT NULL,   -- full name, incl. 'Fire // Ice'
    name_normalized     TEXT    NOT NULL,   -- lowercased, accents/punctuation stripped; import + OCR matching
    layout              TEXT,               -- 'normal','transform','modal_dfc','split','adventure',...
    mana_cost           TEXT,               -- NULL on split/DFC layouts; see card_faces
    cmc                 REAL    NOT NULL DEFAULT 0,
    type_line           TEXT,
    oracle_text         TEXT,               -- front face / whole card
    oracle_text_all     TEXT,               -- all faces concatenated; what FTS actually indexes
    power               TEXT,               -- TEXT: can be '*', '1+*'
    toughness           TEXT,
    loyalty             TEXT,
    defense             TEXT,

    -- Colors as bitmask: W=1 U=2 B=4 R=8 G=16. Subset test for Commander
    -- is one indexable expression: (color_identity_mask & ~:cmdr_mask) = 0
    colors_mask         INTEGER NOT NULL DEFAULT 0,
    color_identity_mask INTEGER NOT NULL DEFAULT 0,
    colors              TEXT    NOT NULL DEFAULT '',   -- 'WU' display form, WUBRG order
    color_identity      TEXT    NOT NULL DEFAULT '',   -- 'WUB' display form
    color_identity_count INTEGER NOT NULL DEFAULT 0,   -- 0..5, for "2-color commanders" style filters

    keywords            TEXT,               -- JSON array
    produced_mana       TEXT,               -- JSON array
    is_reserved         INTEGER NOT NULL DEFAULT 0,
    is_basic_land       INTEGER NOT NULL DEFAULT 0,   -- derived at sync; drives the max_copies exemption
    is_legendary        INTEGER NOT NULL DEFAULT 0,   -- derived from type_line
    can_be_commander    INTEGER NOT NULL DEFAULT 0,   -- legendary creature OR "can be your commander"
    can_be_partner      INTEGER NOT NULL DEFAULT 0,   -- oracle text mentions Partner / Friends forever
    can_be_background   INTEGER NOT NULL DEFAULT 0,   -- "Choose a Background" / is a Background
    edhrec_rank         INTEGER,
    game_changer        INTEGER NOT NULL DEFAULT 0,   -- Commander bracket flag, if present in bulk data

    -- Representative printing used for card art + price when no specific
    -- printing is in play (deck lists, want lists). Set at sync time,
    -- typically the newest non-digital, non-promo English printing.
    default_printing_id TEXT,               -- FK added after card_printings exists (see trigger note below)

    scryfall_updated_at TEXT,
    synced_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

    partner_kind        TEXT,   -- see the partner note above
    partner_with        TEXT    -- named partner, for 'partner_with' only
);
CREATE INDEX idx_oracle_name        ON oracle_cards(name_normalized);
CREATE INDEX idx_oracle_cmc         ON oracle_cards(cmc);
CREATE INDEX idx_oracle_ci          ON oracle_cards(color_identity_mask);
CREATE INDEX idx_oracle_commander   ON oracle_cards(can_be_commander) WHERE can_be_commander = 1;
CREATE INDEX idx_oracle_type        ON oracle_cards(type_line);

-- One row per physical printing (Scryfall card id). This is what the
-- Collection, prices, images, and set-completion all point at.
CREATE TABLE card_printings (
    id                      TEXT PRIMARY KEY,       -- Scryfall card UUID
    oracle_id               TEXT NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
    set_code                TEXT NOT NULL REFERENCES sets(code) ON DELETE RESTRICT,
    collector_number        TEXT NOT NULL,          -- TEXT: '12', '100a', '★7'
    -- Split out so binder/box order sorts correctly (Phase 4 set-scoped entry):
    collector_number_num    INTEGER,
    collector_number_suffix TEXT,
    lang                    TEXT NOT NULL DEFAULT 'en',
    rarity                  TEXT,                   -- 'common','uncommon','rare','mythic','special','bonus'
    released_at             TEXT,
    artist                  TEXT,
    flavor_text             TEXT,

    -- Printing traits. Also feed Phase 7's candidate ranking, which uses
    -- the scan session's frame/border/foil presets to pick the right
    -- printing among same-named reprints.
    finishes                TEXT,   -- JSON array: ["nonfoil","foil","etched"]
    frame                   TEXT,   -- '1993','1997','2003','2015','future'
    frame_effects           TEXT,   -- JSON array: ["showcase","extendedart",...]
    border_color            TEXT,   -- 'black','white','borderless','silver','gold'
    promo_types             TEXT,   -- JSON array
    is_full_art             INTEGER NOT NULL DEFAULT 0,
    is_textless             INTEGER NOT NULL DEFAULT 0,
    is_promo                INTEGER NOT NULL DEFAULT 0,
    is_reprint              INTEGER NOT NULL DEFAULT 0,
    is_variation            INTEGER NOT NULL DEFAULT 0,
    is_digital              INTEGER NOT NULL DEFAULT 0,
    is_oversized            INTEGER NOT NULL DEFAULT 0,
    in_booster              INTEGER NOT NULL DEFAULT 1,   -- set-completion can exclude non-booster cards

    -- Images for single-faced cards; multi-faced live in card_faces.
    image_small             TEXT,
    image_normal            TEXT,
    image_large             TEXT,
    image_png               TEXT,
    image_art_crop          TEXT,
    image_status            TEXT,   -- 'highres_scan','lowres','placeholder','missing'

    -- Prices, straight from Scryfall's fields. Treated as ~24h stale.
    price_usd               REAL,
    price_usd_foil          REAL,
    price_usd_etched        REAL,
    price_eur               REAL,
    price_eur_foil          REAL,
    price_tix               REAL,
    prices_updated_at       TEXT,

    -- Outbound links (Phase 1 detail view, Phase 5 cart links).
    tcgplayer_id            INTEGER,
    tcgplayer_etched_id     INTEGER,
    cardmarket_id           INTEGER,
    purchase_uris           TEXT,   -- JSON object from Scryfall
    scryfall_uri            TEXT,

    scryfall_updated_at     TEXT,
    synced_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

    UNIQUE (set_code, collector_number, lang)
);
CREATE INDEX idx_print_oracle   ON card_printings(oracle_id);
CREATE INDEX idx_print_set_num  ON card_printings(set_code, collector_number_num, collector_number_suffix);
CREATE INDEX idx_print_rarity   ON card_printings(set_code, rarity);
CREATE INDEX idx_print_price    ON card_printings(price_usd);

-- Search filters like `set:blb r:mythic` correlate a subquery on oracle_id and
-- then narrow by set or rarity. Without these the planner falls back to
-- idx_print_rarity, which leads on set_code, and the query degrades into a full
-- scan of oracle_cards — measured at 5 seconds on a 38k-card database.
CREATE INDEX idx_print_oracle_set    ON card_printings(oracle_id, set_code);
CREATE INDEX idx_print_oracle_rarity ON card_printings(oracle_id, rarity);

-- `a:"Rebecca Guay"` is a leading-wildcard LIKE, so no index can seek it — but
-- including artist makes the index covering, and the correlated subquery stops
-- fetching a full printing row per candidate. 128ms -> 18ms across 117,620
-- printings.
CREATE INDEX idx_print_oracle_artist ON card_printings(oracle_id, artist);

-- Now that card_printings exists, oracle_cards.default_printing_id has a
-- target. SQLite can't ALTER in a FK, so it is enforced by trigger.
CREATE TRIGGER trg_oracle_default_printing_ins
AFTER INSERT ON oracle_cards
WHEN NEW.default_printing_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM card_printings WHERE id = NEW.default_printing_id)
BEGIN
    SELECT RAISE(ABORT, 'default_printing_id must reference an existing card_printings row');
END;

-- Faces of double-faced / split / adventure cards. Phase 1 needs the back
-- image; Phase 3 needs reverse-face mana symbols for color identity
-- (Scryfall already folds those into color_identity, this is the receipt).
CREATE TABLE card_faces (
    printing_id     TEXT    NOT NULL REFERENCES card_printings(id) ON DELETE CASCADE,
    face_index      INTEGER NOT NULL,       -- 0 = front
    name            TEXT    NOT NULL,
    mana_cost       TEXT,
    type_line       TEXT,
    oracle_text     TEXT,
    colors_mask     INTEGER NOT NULL DEFAULT 0,
    power           TEXT,
    toughness       TEXT,
    loyalty         TEXT,
    defense         TEXT,
    artist          TEXT,
    flavor_text     TEXT,
    image_small     TEXT,
    image_normal    TEXT,
    image_large     TEXT,
    image_png       TEXT,
    image_art_crop  TEXT,
    PRIMARY KEY (printing_id, face_index)
);

-- Legality per format, at oracle level. A table rather than a JSON blob so
-- "flag banned/restricted cards in this deck" is a join, not a scan.
CREATE TABLE card_legalities (
    oracle_id   TEXT NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
    format_code TEXT NOT NULL,      -- intentionally NOT an FK: Scryfall may add formats before formats is seeded
    legality    TEXT NOT NULL CHECK (legality IN ('legal','not_legal','restricted','banned')),
    PRIMARY KEY (oracle_id, format_code)
);
CREATE INDEX idx_legal_format ON card_legalities(format_code, legality);

-- Every name a card can be searched/imported/OCR'd by: full name, each
-- face name, flip name. Powers Phase 5 decklist import and Phase 7 OCR
-- matching without special-casing DFCs at query time.
CREATE TABLE card_name_variants (
    id                  INTEGER PRIMARY KEY,
    oracle_id           TEXT NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
    variant_name        TEXT NOT NULL,
    variant_normalized  TEXT NOT NULL,
    kind                TEXT NOT NULL CHECK (kind IN ('primary','face','flip','printed')),
    UNIQUE (oracle_id, variant_normalized, kind)
);
CREATE INDEX idx_variant_norm ON card_name_variants(variant_normalized);

-- On-disk image cache. Rows are disposable; deleting one just means
-- re-fetching. Kept in the DB so a size cap / LRU eviction is a query.
CREATE TABLE image_cache (
    printing_id     TEXT    NOT NULL REFERENCES card_printings(id) ON DELETE CASCADE,
    face_index      INTEGER NOT NULL DEFAULT 0,
    size            TEXT    NOT NULL CHECK (size IN ('small','normal','large','png','art_crop')),
    file_path       TEXT    NOT NULL,       -- relative to the app's Caches dir
    byte_size       INTEGER,
    downloaded_at   TEXT    NOT NULL,
    last_used_at    TEXT,
    PRIMARY KEY (printing_id, face_index, size)
);
CREATE INDEX idx_imgcache_lru ON image_cache(last_used_at);


-- ---------------------------------------------------------------------
-- Search indexes (Phase 1). Two FTS5 tables with different jobs:
--   card_search    -> natural-language / Scryfall-style text search
--   card_name_trgm -> fuzzy name matching for import (P5) and OCR (P7)
-- ---------------------------------------------------------------------

CREATE VIRTUAL TABLE card_search USING fts5(
    name,
    type_line,
    oracle_text_all,
    content='oracle_cards',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
);

-- IMPORTANT: sync must use UPSERT (ON CONFLICT DO UPDATE), never
-- INSERT OR REPLACE, or rowids churn and the external-content FTS
-- index silently desynchronises.
CREATE TRIGGER trg_oracle_ai AFTER INSERT ON oracle_cards BEGIN
    INSERT INTO card_search(rowid, name, type_line, oracle_text_all)
    VALUES (NEW.rowid, NEW.name, NEW.type_line, NEW.oracle_text_all);
END;
CREATE TRIGGER trg_oracle_ad AFTER DELETE ON oracle_cards BEGIN
    INSERT INTO card_search(card_search, rowid, name, type_line, oracle_text_all)
    VALUES ('delete', OLD.rowid, OLD.name, OLD.type_line, OLD.oracle_text_all);
END;
CREATE TRIGGER trg_oracle_au AFTER UPDATE ON oracle_cards BEGIN
    INSERT INTO card_search(card_search, rowid, name, type_line, oracle_text_all)
    VALUES ('delete', OLD.rowid, OLD.name, OLD.type_line, OLD.oracle_text_all);
    INSERT INTO card_search(rowid, name, type_line, oracle_text_all)
    VALUES (NEW.rowid, NEW.name, NEW.type_line, NEW.oracle_text_all);
END;

-- Trigram index over every name variant: substring + typo-tolerant
-- matching for "4 Lightnig Bolt" (import) and OCR misreads.
CREATE VIRTUAL TABLE card_name_trgm USING fts5(
    variant_normalized,
    content='card_name_variants',
    content_rowid='id',
    tokenize='trigram'
);
CREATE TRIGGER trg_variant_ai AFTER INSERT ON card_name_variants BEGIN
    INSERT INTO card_name_trgm(rowid, variant_normalized) VALUES (NEW.id, NEW.variant_normalized);
END;
CREATE TRIGGER trg_variant_ad AFTER DELETE ON card_name_variants BEGIN
    INSERT INTO card_name_trgm(card_name_trgm, rowid, variant_normalized)
    VALUES ('delete', OLD.id, OLD.variant_normalized);
END;


-- =====================================================================
-- SECTION 2 — STORAGE LOCATIONS
-- =====================================================================

CREATE TABLE storage_locations (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    kind        TEXT    NOT NULL DEFAULT 'other'
                    CHECK (kind IN ('binder','box','deck_box','shoebox','shelf','other')),
    notes       TEXT,
    -- Exactly one row should be the fallback bucket ("Unsorted"), used as
    -- the default destination for incoming trade cards (Phase 6).
    is_default  INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_location_single_default ON storage_locations(is_default) WHERE is_default = 1;


-- =====================================================================
-- SECTION 3 — COLLECTION
--
-- Grain: (printing, location, finish, condition, language). Matches
-- CLAUDE.md exactly — "2 copies of the modern reprint in one binder,
-- 2 copies of an old foil in a box" is two rows, valued independently.
-- =====================================================================

-- Lets a bad CSV import (Phase 5) be undone as a unit instead of hunted
-- down row by row.
CREATE TABLE import_batches (
    id              INTEGER PRIMARY KEY,
    source          TEXT NOT NULL,      -- 'csv','deckbox','tcgplayer','manabox','manual','trade','ocr'
    file_name       TEXT,
    imported_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    rows_total      INTEGER,
    rows_imported   INTEGER,
    rows_unmatched  INTEGER,
    notes           TEXT
);

CREATE TABLE collection_items (
    id              INTEGER PRIMARY KEY,
    printing_id     TEXT    NOT NULL REFERENCES card_printings(id)     ON DELETE RESTRICT,
    location_id     INTEGER NOT NULL REFERENCES storage_locations(id)  ON DELETE RESTRICT,
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    finish          TEXT    NOT NULL DEFAULT 'nonfoil'
                        CHECK (finish IN ('nonfoil','foil','etched')),
    condition       TEXT    NOT NULL DEFAULT 'unknown'
                        CHECK (condition IN ('M','NM','LP','MP','HP','DMG','unknown')),
    language        TEXT    NOT NULL DEFAULT 'en',
    -- Manual value for these specific copies; wins over the synced price.
    price_override  REAL    CHECK (price_override IS NULL OR price_override >= 0),
    is_signed       INTEGER NOT NULL DEFAULT 0,
    is_altered      INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,

    -- Cost basis. Deliberately per COPY, not per line, so editing quantity
    -- never silently rewrites what you paid.
    acquired_at        TEXT,                -- 'YYYY-MM-DD', optional
    acquired_unit_cost REAL CHECK (acquired_unit_cost IS NULL OR acquired_unit_cost >= 0),
    acquisition_kind   TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (acquisition_kind IN ('purchase','trade','gift','pull','unknown')),
    acquired_from      TEXT,                -- 'TCGplayer', 'LGS', 'trade with Dave'
    acquired_trade_id  INTEGER REFERENCES trades(id) ON DELETE SET NULL,

    import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))

    -- NO UNIQUE constraint, on purpose. Each row is a purchase LOT: buying the
    -- same printing twice at different prices must produce two rows, or one of
    -- the two costs is lost. Side benefit: two copies of the same printing in
    -- the same binder can now carry different price_override values.
    --
    -- App-level merge rule: when adding copies, merge into an existing row only
    -- if printing, location, finish, condition, language, acquired_at AND
    -- acquired_unit_cost all match. Anything else becomes a new lot; a NULL
    -- cost never merges.
    --
    -- When copies leave (trade completion, manual decrement) the caller picks
    -- the lot — trade_items.source_collection_item_id already records which.
    -- Default that picker to FIFO: oldest acquired_at first, NULLs last.
);
CREATE INDEX idx_coll_location ON collection_items(location_id);
CREATE INDEX idx_coll_printing ON collection_items(printing_id);
CREATE INDEX idx_coll_batch    ON collection_items(import_batch_id);
CREATE INDEX idx_coll_stack    ON collection_items(printing_id, location_id, finish, condition);
CREATE INDEX idx_coll_acquired ON collection_items(acquired_at);

CREATE TRIGGER trg_coll_touch AFTER UPDATE ON collection_items
WHEN NEW.updated_at = OLD.updated_at BEGIN
    UPDATE collection_items
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id = NEW.id;
END;

-- Copies that have LEFT the collection. Append-only, and written BEFORE the
-- source lot is decremented so the cost basis is captured on its way out
-- instead of vanishing with the row.
--
-- A trade is treated as a simultaneous sell and buy at fair market value:
-- outgoing copies realize gain against their cost here, while incoming
-- copies enter collection_items with acquired_unit_cost set to the same
-- trade value. That keeps lifetime gain continuous — the moment a card
-- leaves, its unrealized gain becomes realized gain of equal size, rather
-- than disappearing. The alternative (carrying the old basis onto the
-- incoming card) has no non-arbitrary answer when 3 cards trade for 1.
--
-- Careful with the wording in the UI: for a trade this measures
-- APPRECIATION, not profit. An even-value trade realizes gain without
-- making you any richer. Only disposal_kind='sale' involves real money —
-- v_collection_pnl separates the two.
CREATE TABLE collection_disposals (
    id                INTEGER PRIMARY KEY,
    printing_id       TEXT    NOT NULL REFERENCES card_printings(id) ON DELETE RESTRICT,
    quantity          INTEGER NOT NULL CHECK (quantity > 0),
    finish            TEXT    NOT NULL DEFAULT 'nonfoil'
                          CHECK (finish IN ('nonfoil','foil','etched')),
    condition         TEXT    NOT NULL DEFAULT 'unknown'
                          CHECK (condition IN ('M','NM','LP','MP','HP','DMG','unknown')),
    language          TEXT    NOT NULL DEFAULT 'en',
    disposed_on       TEXT    NOT NULL,          -- 'YYYY-MM-DD'
    disposal_kind     TEXT    NOT NULL
                          CHECK (disposal_kind IN ('trade','sale','gift','loss')),

    -- What the copies fetched. Trade: the fair market value credited in the
    -- trade. Sale: cash actually received. NULL for gift/loss — nothing came
    -- back, so those record the departure without faking a sale.
    unit_proceeds_usd REAL CHECK (unit_proceeds_usd IS NULL OR unit_proceeds_usd >= 0),
    -- Copied off the source lot at disposal time. NULL when that lot never
    -- had a known cost; realized gain then reports NULL, not a windfall.
    unit_cost_usd     REAL CHECK (unit_cost_usd IS NULL OR unit_cost_usd >= 0),
    acquired_at       TEXT,       -- from the source lot, so holding period survives it
    source_lot_id     INTEGER,    -- historical only, deliberately no FK: that lot is usually gone

    trade_id          INTEGER REFERENCES trades(id) ON DELETE SET NULL,
    counterparty      TEXT,       -- buyer or recipient when there is no trade record
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_disposal_date     ON collection_disposals(disposed_on DESC);
CREATE INDEX idx_disposal_printing ON collection_disposals(printing_id);
CREATE INDEX idx_disposal_trade    ON collection_disposals(trade_id);

-- Phase 4 "value over time": one row per snapshot, written alongside the
-- daily price sync. This is the whole-collection trend line; per-card
-- history lives in printing_price_history below.
CREATE TABLE collection_value_snapshots (
    id                  INTEGER PRIMARY KEY,
    captured_on         TEXT NOT NULL UNIQUE,   -- 'YYYY-MM-DD', one per day
    captured_at         TEXT NOT NULL,
    total_value_usd     REAL NOT NULL,
    total_cards         INTEGER NOT NULL,       -- sum of quantity
    distinct_printings  INTEGER NOT NULL,
    distinct_cards      INTEGER NOT NULL,       -- distinct oracle_id
    override_value_usd  REAL,                   -- portion coming from price overrides

    -- Second series for the chart: what the collection cost against what it
    -- is worth. cost_known_cards is carried so the gain figure can say what
    -- share of the collection it actually covers, rather than quietly
    -- treating unknown-cost copies as free.
    total_cost_basis_usd REAL,
    cost_known_cards     INTEGER,
    -- Cumulative realized gain as of this snapshot, so the chart can plot
    -- lifetime gain (realized + unrealized) as one continuous line that a
    -- trade does not make jump.
    realized_gain_to_date_usd REAL,

    priced_at           TEXT,                   -- prices_updated_at of the sync this reflects
    note                TEXT
);

-- Per-card price history for cards you own or want (see v_tracked_printings).
-- Written only when a price actually MOVES, so an unchanged week costs
-- nothing. Tracking all ~500k printings every sync was the alternative;
-- this covers the cards the collection actually cares about for a tiny
-- fraction of the rows.
CREATE TABLE printing_price_history (
    printing_id TEXT NOT NULL REFERENCES card_printings(id) ON DELETE CASCADE,
    finish      TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
    observed_on TEXT NOT NULL,                  -- 'YYYY-MM-DD'
    price_usd   REAL NOT NULL,
    PRIMARY KEY (printing_id, finish, observed_on)
) WITHOUT ROWID;


-- =====================================================================
-- SECTION 4 — DECKS + ALLOCATION
--
-- Allocation is stored as a per-slot count, not a link to a specific
-- collection row. That matches CLAUDE.md's own example output
-- ("Deck A x2 (home: Blue Tackle Box), Binder 3 x2 available"), where a
-- deck's copies resolve to the DECK's home location, not a binder row.
-- Consequence: "deleting a deck releases its allocation" is just
-- ON DELETE CASCADE + a view — no fix-up pass, and no way to leak.
-- =====================================================================

CREATE TABLE decks (
    id              INTEGER PRIMARY KEY,
    name            TEXT    NOT NULL,
    format_code     TEXT    REFERENCES formats(code) ON DELETE SET NULL,
    -- Where the physical deck lives, so allocated copies resolve to a
    -- real place rather than just "in a deck".
    home_location_id INTEGER REFERENCES storage_locations(id) ON DELETE SET NULL,
    description     TEXT,
    notes           TEXT,
    colors_override TEXT,                       -- optional manual color tag for the deck list UI
    is_archived     INTEGER NOT NULL DEFAULT 0,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_decks_format ON decks(format_code);
CREATE INDEX idx_decks_home   ON decks(home_location_id);

CREATE TABLE deck_cards (
    id                      INTEGER PRIMARY KEY,
    deck_id                 INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    oracle_id               TEXT    NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE RESTRICT,
    board                   TEXT    NOT NULL DEFAULT 'main'
                                CHECK (board IN ('main','side','command','maybe')),
    quantity                INTEGER NOT NULL CHECK (quantity > 0),

    -- The allocation. 0 = entirely "need to buy"; == quantity = entirely
    -- "from my collection"; in between = a partially-covered slot, which
    -- is what makes the Phase 4 shopping list fall out for free.
    quantity_from_collection INTEGER NOT NULL DEFAULT 0
                                CHECK (quantity_from_collection >= 0
                                       AND quantity_from_collection <= quantity),

    -- Optional pin to a specific printing: drives set-code/collector-number
    -- deck export (Phase 5) and lets a slot show the art you own.
    -- Allocation math stays at oracle level regardless.
    preferred_printing_id   TEXT REFERENCES card_printings(id) ON DELETE SET NULL,

    -- Phase 3: distinguishes a plain commander from Partner/Background so
    -- the "one commander" relaxations are representable.
    commander_role          TEXT CHECK (commander_role IS NULL OR commander_role IN
                                ('commander','partner','background','companion')),
    category                TEXT,           -- user grouping: 'Ramp','Removal',...
    notes                   TEXT,
    sort_order              INTEGER NOT NULL DEFAULT 0,
    created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

    UNIQUE (deck_id, oracle_id, board)
);
CREATE INDEX idx_deckcards_deck   ON deck_cards(deck_id);
CREATE INDEX idx_deckcards_oracle ON deck_cards(oracle_id);
CREATE INDEX idx_deckcards_alloc  ON deck_cards(oracle_id) WHERE quantity_from_collection > 0;


-- =====================================================================
-- SECTION 5 — TRADES
-- =====================================================================

CREATE TABLE trades (
    id                      INTEGER PRIMARY KEY,
    counterparty_name       TEXT    NOT NULL,
    counterparty_contact    TEXT,
    -- Draft never touches the Collection; only 'completed' applies deltas.
    status                  TEXT    NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','completed','cancelled')),
    trade_date              TEXT,           -- 'YYYY-MM-DD', user-set
    completed_at            TEXT,           -- set when status -> 'completed'
    location_note           TEXT,           -- "Saturday FNM at Gamer's Gauntlet"
    notes                   TEXT,
    value_out_usd           REAL,           -- snapshotted at completion
    value_in_usd            REAL,
    created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_trades_status ON trades(status, trade_date DESC);

CREATE TABLE trade_items (
    id                  INTEGER PRIMARY KEY,
    trade_id            INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    direction           TEXT    NOT NULL CHECK (direction IN ('out','in')),
    printing_id         TEXT    NOT NULL REFERENCES card_printings(id) ON DELETE RESTRICT,
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    finish              TEXT    NOT NULL DEFAULT 'nonfoil'
                            CHECK (finish IN ('nonfoil','foil','etched')),
    condition           TEXT    NOT NULL DEFAULT 'unknown'
                            CHECK (condition IN ('M','NM','LP','MP','HP','DMG','unknown')),
    language            TEXT    NOT NULL DEFAULT 'en',

    -- OUT: which owned copies are leaving (the "choose which copies/
    -- location" requirement). SET NULL because the source row may be
    -- deleted once it hits zero after completion.
    source_collection_item_id INTEGER REFERENCES collection_items(id) ON DELETE SET NULL,
    -- IN: where the incoming cards land; defaults to the is_default
    -- location ("Unsorted") when the user hasn't decided yet.
    destination_location_id   INTEGER REFERENCES storage_locations(id) ON DELETE SET NULL,
    -- OUT: denormalised so history survives a location rename/delete.
    source_location_id        INTEGER REFERENCES storage_locations(id) ON DELETE SET NULL,

    unit_value_usd      REAL,       -- agreed/market value per copy, snapshotted at completion
    price_source        TEXT,       -- 'market','override','manual'
    -- Display snapshots so the trade log stays readable even if the card
    -- cache is ever rebuilt from scratch.
    snapshot_name       TEXT,
    snapshot_set_code   TEXT,
    snapshot_number     TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_tradeitems_trade    ON trade_items(trade_id, direction);
CREATE INDEX idx_tradeitems_printing ON trade_items(printing_id);


-- =====================================================================
-- SECTION 6 — WANT LISTS (multiple, independently ordered)
-- =====================================================================

CREATE TABLE want_lists (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- 'Commander wants','Grails'
    description TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,   -- target for "add all to Want List" from a deck
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_wantlist_single_default ON want_lists(is_default) WHERE is_default = 1;

CREATE TABLE want_list_items (
    id                  INTEGER PRIMARY KEY,
    want_list_id        INTEGER NOT NULL REFERENCES want_lists(id) ON DELETE CASCADE,
    oracle_id           TEXT    NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
    quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),

    -- Optional preferences, not part of identity.
    preferred_printing_id TEXT REFERENCES card_printings(id) ON DELETE SET NULL,
    preferred_finish    TEXT CHECK (preferred_finish IS NULL OR preferred_finish IN ('nonfoil','foil','etched')),
    target_price_usd    REAL CHECK (target_price_usd IS NULL OR target_price_usd >= 0),
    priority            INTEGER NOT NULL DEFAULT 0,     -- 0 = none, 1 = low ... 3 = high
    notes               TEXT,

    status              TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','fulfilled','archived')),
    fulfilled_at        TEXT,
    fulfilled_by_trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL,

    -- Per-list manual drag order. Scoped by want_list_id, so each named
    -- list keeps its own independent ranking as the spec requires.
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

    -- Enforces the consolidation rule: one row per card per list, with
    -- per-deck needs hanging off it (below) rather than duplicate rows.
    UNIQUE (want_list_id, oracle_id)
);
CREATE INDEX idx_wantitems_list   ON want_list_items(want_list_id, sort_order);
CREATE INDEX idx_wantitems_oracle ON want_list_items(oracle_id) WHERE status = 'active';
CREATE INDEX idx_wantitems_target ON want_list_items(target_price_usd) WHERE target_price_usd IS NOT NULL AND status = 'active';

-- "needed for: Deck A x2, Deck C x1". The want item's own quantity is the
-- sum of these plus any freestanding want.
CREATE TABLE want_list_item_decks (
    want_list_item_id   INTEGER NOT NULL REFERENCES want_list_items(id) ON DELETE CASCADE,
    deck_id             INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (want_list_item_id, deck_id)
);
CREATE INDEX idx_wantdeck_deck ON want_list_item_decks(deck_id);


-- =====================================================================
-- SECTION 7 — TRADE LISTS (same named-list-with-order mechanism)
--
-- Kept structurally parallel to want lists but separate, because the item
-- grain genuinely differs: a want is a card you don't have (oracle level),
-- a trade-list entry is specific owned copies (collection row level).
-- =====================================================================

CREATE TABLE trade_lists (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- 'Bulk trades','High value'
    description TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_tradelist_single_default ON trade_lists(is_default) WHERE is_default = 1;

CREATE TABLE trade_list_items (
    id                  INTEGER PRIMARY KEY,
    trade_list_id       INTEGER NOT NULL REFERENCES trade_lists(id) ON DELETE CASCADE,
    -- Points at the specific owned copies. CASCADE: if those copies leave
    -- the collection entirely, the offer to trade them goes with them.
    collection_item_id  INTEGER NOT NULL REFERENCES collection_items(id) ON DELETE CASCADE,
    -- Its own quantity, separate from owned and from deck-allocated.
    -- Clamped down by Phase 6 reconciliation when a trade drops owned qty.
    quantity            INTEGER NOT NULL CHECK (quantity > 0),
    asking_price_usd    REAL,
    notes               TEXT,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (trade_list_id, collection_item_id)
);
CREATE INDEX idx_tradelistitems_list ON trade_list_items(trade_list_id, sort_order);
CREATE INDEX idx_tradelistitems_coll ON trade_list_items(collection_item_id);


-- =====================================================================
-- SECTION 8 — ALERTS / NOTICES
--
-- One table serves Phase 6's price alerts, Phase 6's "surface a quick
-- notice" for trade-list clamping, and Phase 1/4 sync failures.
-- =====================================================================

CREATE TABLE alerts (
    id              INTEGER PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN
                        ('price_target','trade_list_clamped','allocation_conflict',
                         'want_fulfilled','sync_failed','import_unmatched')),
    -- Stops a daily price sync from re-raising the same alert forever.
    -- Convention: 'price_target:<want_item_id>'. Cleared/resolved when the
    -- price rises back above target, re-arming the alert.
    dedupe_key      TEXT UNIQUE,
    state           TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','acknowledged','resolved')),
    subject_type    TEXT,       -- 'want_list_item','trade_list_item','deck','trade','sync_log'
    subject_id      INTEGER,
    title           TEXT NOT NULL,
    message         TEXT,
    payload         TEXT,       -- JSON: e.g. {"target":12.5,"current":9.99,"printing_id":"..."}
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    acknowledged_at TEXT
);
CREATE INDEX idx_alerts_active ON alerts(state, created_at DESC);


-- =====================================================================
-- SECTION 9 — PHASE 7 (OCR) — optional stretch goal, tables cost nothing
-- =====================================================================

-- The batch-scanning session's preset attributes (foil, frame/border,
-- location, condition, set) that the on-screen banner displays.
CREATE TABLE scan_sessions (
    id                  INTEGER PRIMARY KEY,
    started_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    ended_at            TEXT,
    default_finish      TEXT CHECK (default_finish IS NULL OR default_finish IN ('nonfoil','foil','etched')),
    default_frame       TEXT,
    default_frame_effect TEXT,      -- 'borderless','extendedart','showcase',...
    default_border      TEXT,
    default_condition   TEXT,
    default_set_code    TEXT REFERENCES sets(code) ON DELETE SET NULL,
    default_location_id INTEGER REFERENCES storage_locations(id) ON DELETE SET NULL,
    cards_added         INTEGER NOT NULL DEFAULT 0,
    notes               TEXT
);

-- "Correction memory": a personalised alias table of (OCR text -> the card
-- the user actually picked), checked before fuzzy matching runs again.
-- Not model retraining; just a lookup that gets better with use.
CREATE TABLE ocr_corrections (
    id                  INTEGER PRIMARY KEY,
    ocr_text_normalized TEXT    NOT NULL,
    set_code_context    TEXT REFERENCES sets(code) ON DELETE CASCADE,   -- NULL = applies regardless of set scope
    oracle_id           TEXT    NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
    printing_id         TEXT    REFERENCES card_printings(id) ON DELETE SET NULL,
    times_confirmed     INTEGER NOT NULL DEFAULT 1,
    first_seen_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    last_used_at        TEXT,
    UNIQUE (ocr_text_normalized, set_code_context)
);
CREATE INDEX idx_ocr_text ON ocr_corrections(ocr_text_normalized);


-- =====================================================================
-- SECTION 10 — DERIVED VIEWS
--
-- Allocation, availability, shopping lists and "where do my copies live"
-- are all computed, never stored. That is what makes CLAUDE.md's
-- "deleting a deck releases its allocation ... without a manual fix-up
-- step" true by construction.
-- =====================================================================

-- Value of one collection row: override wins, else the finish-matched
-- market price.
CREATE VIEW v_collection_item_value AS
SELECT ci.id                AS collection_item_id,
       ci.printing_id,
       p.oracle_id,
       ci.location_id,
       ci.quantity,
       ci.finish,
       ci.condition,
       ci.language,
       COALESCE(
           ci.price_override,
           CASE ci.finish
               WHEN 'foil'   THEN p.price_usd_foil
               WHEN 'etched' THEN p.price_usd_etched
               ELSE               p.price_usd
           END
       )                    AS unit_value_usd,
       ci.quantity * COALESCE(
           ci.price_override,
           CASE ci.finish
               WHEN 'foil'   THEN p.price_usd_foil
               WHEN 'etched' THEN p.price_usd_etched
               ELSE               p.price_usd
           END, 0.0
       )                    AS line_value_usd,
       (ci.price_override IS NOT NULL) AS is_overridden,

       -- Cost basis for this lot. NULL, never 0, when the cost is unknown —
       -- an unpriced lot must not read as "acquired for free".
       ci.acquired_unit_cost,
       ci.acquired_at,
       ci.acquisition_kind,
       ci.quantity * ci.acquired_unit_cost AS line_cost_basis_usd,
       CASE WHEN ci.acquired_unit_cost IS NULL THEN NULL ELSE
           ci.quantity * COALESCE(
               ci.price_override,
               CASE ci.finish
                   WHEN 'foil'   THEN p.price_usd_foil
                   WHEN 'etched' THEN p.price_usd_etched
                   ELSE               p.price_usd
               END, 0.0
           ) - ci.quantity * ci.acquired_unit_cost
       END                  AS unrealized_gain_usd
FROM collection_items ci
JOIN card_printings p ON p.id = ci.printing_id;

-- Total owned + total value per card name (across every printing/location).
CREATE VIEW v_owned_by_oracle AS
SELECT oracle_id,
       SUM(quantity)                AS owned_qty,
       SUM(line_value_usd)          AS owned_value_usd,
       COUNT(*)                     AS lot_count,
       COUNT(DISTINCT printing_id)  AS printing_count,
       SUM(line_cost_basis_usd)     AS cost_basis_usd,
       SUM(unrealized_gain_usd)     AS unrealized_gain_usd,
       -- How many copies the cost basis above actually accounts for.
       SUM(CASE WHEN acquired_unit_cost IS NOT NULL THEN quantity ELSE 0 END)
                                    AS cost_known_qty
FROM v_collection_item_value
GROUP BY oracle_id;

-- Middle tier of the drill-down: one row per printing + finish, so the UI can
-- show "4 Sol Rings" at the top and still let you select, price and edit each
-- printing separately underneath.
CREATE VIEW v_owned_by_printing AS
SELECT v.oracle_id,
       v.printing_id,
       v.finish,
       p.set_code,
       s.name                       AS set_name,
       p.collector_number,
       p.rarity,
       SUM(v.quantity)              AS owned_qty,
       COUNT(*)                     AS lot_count,
       COUNT(DISTINCT v.location_id) AS location_count,
       SUM(v.line_value_usd)        AS market_value_usd,
       SUM(v.line_cost_basis_usd)   AS cost_basis_usd,
       SUM(v.unrealized_gain_usd)   AS unrealized_gain_usd,
       SUM(CASE WHEN v.acquired_unit_cost IS NOT NULL THEN v.quantity ELSE 0 END)
                                    AS cost_known_qty
FROM v_collection_item_value v
JOIN card_printings p ON p.id = v.printing_id
LEFT JOIN sets s      ON s.code = p.set_code
GROUP BY v.oracle_id, v.printing_id, v.finish;

-- Copies currently claimed by decks. 'maybe' boards deliberately excluded.
CREATE VIEW v_allocated_by_oracle AS
SELECT oracle_id, SUM(quantity_from_collection) AS allocated_qty
FROM deck_cards
WHERE board IN ('main','side','command')
  AND quantity_from_collection > 0
GROUP BY oracle_id;

-- The owned / allocated / available triple the spec asks for.
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

-- "Deck A x2 (home: Blue Tackle Box)" — the deck half of the card detail
-- breakdown.
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

-- "Binder 3 x2 available" — the physical half of the same breakdown.
CREATE VIEW v_card_locations AS
SELECT p.oracle_id,
       ci.location_id,
       sl.name         AS location_name,
       sl.kind         AS location_kind,
       ci.printing_id,
       p.set_code,
       p.collector_number,
       ci.finish,
       ci.condition,
       ci.quantity
FROM collection_items ci
JOIN card_printings p     ON p.id  = ci.printing_id
JOIN storage_locations sl ON sl.id = ci.location_id;

-- Phase 4 per-deck shopping list: falls straight out of allocation.
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

-- Current total collection value (the number snapshotted daily).
CREATE VIEW v_collection_value AS
SELECT ROUND(SUM(line_value_usd), 2)        AS total_value_usd,
       SUM(quantity)                        AS total_cards,
       COUNT(*)                             AS total_lots,
       COUNT(DISTINCT printing_id)          AS distinct_printings,
       COUNT(DISTINCT oracle_id)            AS distinct_cards,
       ROUND(SUM(line_cost_basis_usd), 2)   AS total_cost_basis_usd,
       ROUND(SUM(unrealized_gain_usd), 2)   AS unrealized_gain_usd,
       SUM(CASE WHEN acquired_unit_cost IS NOT NULL THEN quantity ELSE 0 END)
                                            AS cost_known_cards
FROM v_collection_item_value;

-- Realized gain per disposal. NULL — never 0 — when either side is unknown,
-- so an unpriced lot cannot fake a profit. Mirrors the unrealized rule.
CREATE VIEW v_realized_gains AS
SELECT d.id                AS disposal_id,
       p.oracle_id,
       d.printing_id,
       p.set_code,
       p.collector_number,
       d.finish,
       d.condition,
       d.quantity,
       d.disposed_on,
       d.disposal_kind,
       d.acquired_at,
       d.unit_cost_usd,
       d.unit_proceeds_usd,
       d.quantity * d.unit_cost_usd     AS cost_basis_usd,
       d.quantity * d.unit_proceeds_usd AS proceeds_usd,
       CASE WHEN d.unit_cost_usd IS NULL OR d.unit_proceeds_usd IS NULL THEN NULL
            ELSE d.quantity * (d.unit_proceeds_usd - d.unit_cost_usd)
       END                 AS realized_gain_usd,
       CASE WHEN d.acquired_at IS NULL THEN NULL
            ELSE CAST(julianday(d.disposed_on) - julianday(d.acquired_at) AS INTEGER)
       END                 AS held_days,
       d.trade_id,
       d.counterparty
FROM collection_disposals d
JOIN card_printings p ON p.id = d.printing_id;

-- Lifetime position: what you still hold, plus what you have let go.
--
-- lifetime_gain_usd is the number that stays continuous across a trade —
-- unrealized gain converts into realized gain of the same size rather than
-- vanishing. The cash_* columns count only disposal_kind='sale', because
-- trade gains are appreciation on cards you no longer hold, not money.
CREATE VIEW v_collection_pnl AS
SELECT (SELECT ROUND(SUM(line_value_usd),2)      FROM v_collection_item_value) AS holdings_value_usd,
       (SELECT ROUND(SUM(line_cost_basis_usd),2) FROM v_collection_item_value) AS holdings_cost_usd,
       (SELECT ROUND(SUM(unrealized_gain_usd),2) FROM v_collection_item_value) AS unrealized_gain_usd,
       (SELECT ROUND(SUM(cost_basis_usd),2)      FROM v_realized_gains)        AS disposed_cost_usd,
       (SELECT ROUND(SUM(proceeds_usd),2)        FROM v_realized_gains)        AS disposed_proceeds_usd,
       (SELECT ROUND(SUM(realized_gain_usd),2)   FROM v_realized_gains)        AS realized_gain_usd,
       ROUND(COALESCE((SELECT SUM(unrealized_gain_usd) FROM v_collection_item_value), 0.0)
           + COALESCE((SELECT SUM(realized_gain_usd)   FROM v_realized_gains),        0.0), 2)
                                                                              AS lifetime_gain_usd,
       (SELECT ROUND(SUM(proceeds_usd),2)      FROM v_realized_gains WHERE disposal_kind='sale')
                                                                              AS cash_proceeds_usd,
       (SELECT ROUND(SUM(realized_gain_usd),2) FROM v_realized_gains WHERE disposal_kind='sale')
                                                                              AS cash_realized_gain_usd;

-- Which printings are worth keeping price history for: anything owned, on a
-- trade list, or want-listed. Want entries are oracle-level, so they resolve
-- through their preferred printing and fall back to the card's default.
CREATE VIEW v_tracked_printings AS
SELECT DISTINCT printing_id FROM (
    SELECT ci.printing_id
      FROM collection_items ci
    UNION
    SELECT ci.printing_id
      FROM trade_list_items tli
      JOIN collection_items ci ON ci.id = tli.collection_item_id
    UNION
    SELECT COALESCE(wli.preferred_printing_id, o.default_printing_id) AS printing_id
      FROM want_list_items wli
      JOIN oracle_cards o ON o.oracle_id = wli.oracle_id
     WHERE wli.status = 'active'
)
WHERE printing_id IS NOT NULL;

-- Most recent stored price per series. Lets the sync answer "did this move?"
-- with a join instead of a correlated subquery per card.
CREATE VIEW v_printing_price_latest AS
SELECT h.printing_id, h.finish, h.observed_on, h.price_usd
FROM printing_price_history h
WHERE h.observed_on = (
    SELECT MAX(h2.observed_on)
      FROM printing_price_history h2
     WHERE h2.printing_id = h.printing_id
       AND h2.finish      = h.finish
);

-- Set-completion %, counting distinct printings owned against card_count.
CREATE VIEW v_set_completion AS
SELECT s.code                               AS set_code,
       s.name                               AS set_name,
       s.card_count                         AS total_cards,
       COUNT(DISTINCT ci.printing_id)       AS owned_printings,
       CASE WHEN s.card_count > 0
            THEN ROUND(100.0 * COUNT(DISTINCT ci.printing_id) / s.card_count, 1)
            ELSE NULL END                   AS percent_complete
FROM sets s
LEFT JOIN card_printings cp  ON cp.set_code = s.code
LEFT JOIN collection_items ci ON ci.printing_id = cp.id
GROUP BY s.code;

-- Trade-list rows whose quantity exceeds what is actually free, either
-- because owned qty dropped or because decks claim the copies.
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


-- =====================================================================
-- SECTION 11 — BOOTSTRAP SEED DATA
--
-- Not synced from Scryfall. The format rows are the Phase 2/3 deck
-- validator's rule table; keys match Scryfall's `legalities` keys exactly
-- so card_legalities.format_code joins straight onto them.
-- =====================================================================

INSERT INTO formats
    (code, display_name, min_deck_size, exact_deck_size, max_copies, is_singleton,
     sideboard_size, requires_commander, enforces_color_id, is_active, sort_order) VALUES
    ('standard',        'Standard',           60, NULL, 4, 0, 15, 0, 0, 1, 10),
    ('pioneer',         'Pioneer',            60, NULL, 4, 0, 15, 0, 0, 1, 20),
    ('modern',          'Modern',             60, NULL, 4, 0, 15, 0, 0, 1, 30),
    ('legacy',          'Legacy',             60, NULL, 4, 0, 15, 0, 0, 1, 40),
    ('vintage',         'Vintage',            60, NULL, 4, 0, 15, 0, 0, 1, 50),
    ('pauper',          'Pauper',             60, NULL, 4, 0, 15, 0, 0, 1, 60),
    ('commander',       'Commander',        NULL,  100, 1, 1,  0, 1, 1, 1, 70),
    ('paupercommander', 'Pauper Commander', NULL,  100, 1, 1,  0, 1, 1, 1, 80),
    ('duel',            'Duel Commander',   NULL,  100, 1, 1,  0, 1, 1, 1, 90),
    ('predh',           'PreDH',            NULL,  100, 1, 1,  0, 1, 1, 0, 100),
    ('oathbreaker',     'Oathbreaker',      NULL,   60, 1, 1,  0, 1, 1, 1, 110),
    ('brawl',           'Brawl',            NULL,  100, 1, 1,  0, 1, 1, 1, 120),
    ('standardbrawl',   'Standard Brawl',   NULL,   60, 1, 1,  0, 1, 1, 1, 130),
    ('gladiator',       'Gladiator',        NULL,  100, 1, 1,  0, 0, 0, 0, 140),
    ('historic',        'Historic',           60, NULL, 4, 0, 15, 0, 0, 1, 150),
    ('timeless',        'Timeless',           60, NULL, 4, 0, 15, 0, 0, 1, 160),
    ('explorer',        'Explorer',           60, NULL, 4, 0, 15, 0, 0, 1, 170),
    ('alchemy',         'Alchemy',            60, NULL, 4, 0, 15, 0, 0, 0, 180),
    ('premodern',       'Premodern',          60, NULL, 4, 0, 15, 0, 0, 0, 190),
    ('oldschool',       'Old School',         60, NULL, 4, 0, 15, 0, 0, 0, 200),
    ('penny',           'Penny Dreadful',     60, NULL, 4, 0, 15, 0, 0, 0, 210),
    ('future',          'Future Standard',    60, NULL, 4, 0, 15, 0, 0, 0, 220);

-- Fallback bucket. Phase 6 drops incoming trade cards here when no
-- location is chosen; Phase 5 CSV import uses it for unmapped rows.
INSERT INTO storage_locations (name, kind, is_default, sort_order, notes)
VALUES ('Unsorted', 'other', 1, 0, 'Default destination for incoming cards that have not been filed yet.');

INSERT INTO want_lists  (name, is_default, sort_order) VALUES ('Wants',  1, 0);
INSERT INTO trade_lists (name, is_default, sort_order) VALUES ('Trades', 1, 0);

INSERT INTO app_settings (key, value) VALUES
    ('schema_version',        '4'),
    ('bulk_data_type',        'default_cards'),
    ('display_currency',      'usd'),
    ('last_bulk_sync_at',     ''),
    ('image_cache_max_bytes', '2147483648'),
    ('scryfall_user_agent',   'MTGLibrary/1.0 (macOS; personal collection manager)');
