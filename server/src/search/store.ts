import type Database from 'better-sqlite3';
import { artUrlSql, imageUrlSql } from '../images/url.ts';
import { compileQuery, mentionsDigital, mentionsLegality } from './query.ts';
import { nameChecker, ownedAtLeast, type SearchContext } from './collection.ts';
import {
  allocationCtes, allocationSettings, allocationSqlRefs, type AllocationSettings,
} from '../decks/allocation.ts';
import { isLimitedFormat, normalizeName, EXTRA_LAYOUTS } from '../model/mtg.ts';

/**
 * The free text as a trigram MATCH, or null when it is too short to be one.
 *
 * FTS5's trigram tokenizer indexes three-character windows, so a one- or
 * two-character query matches nothing and raises rather than returning empty.
 * Short queries fall back to the word index alone, which handles them fine.
 */
function trigramTerm(freeText: string): string | null {
  const normalized = normalizeName(freeText);
  if (normalized.length < 3) return null;
  return `"${normalized}"`;
}

export interface SearchFilters {
  ownedOnly?: boolean;
  /** Colour identity must fit inside these colours (deck-building semantics). */
  colors?: string[];
  colorsExact?: boolean;
  /** Two or more colours. About how many, not which — so not a colour pill. */
  gold?: boolean;
  /** A hybrid symbol in the cost, like {G/W}. Independent of colour count. */
  hybrid?: boolean;
  rarities?: string[];
  setCode?: string;
  format?: string;
  minCmc?: number;
  maxCmc?: number;
  /** Alchemy and other digital-only cards are hidden unless asked for. */
  includeDigital?: boolean;
  /** Art series, tokens and emblems are hidden unless asked for. */
  includeExtras?: boolean;
  /** Cards legal in no format — Un-sets, playtest cards — hidden unless asked for. */
  includeUnplayable?: boolean;
  /**
   * A format code: restrict results to cards that could lead a deck in it.
   * The rule differs per format, so the server resolves it rather than making
   * the client encode four variants of "commander".
   */
  commanderFor?: string;
  /**
   * Hide crossover cards — Lord of the Rings, Final Fantasy, Marvel and the
   * rest. The opposite polarity to the three above, on purpose: those hide
   * clutter by default, whereas crossover cards are real tournament cards and
   * are shown until you ask for them to go.
   */
  excludeUniversesBeyond?: boolean;
  /** Phase 7 shortfall links: cards resolved into this card_categories value. */
  category?: string;
  /**
   * The deck this search is being run from, so `available` excludes that deck's
   * own reservation — a deck must never compete with itself for its own cards.
   * The deck builder always sends it; Browse never does.
   *
   * Not a filter in the narrowing sense, but it arrives on the same query
   * string and changes what the same query means, so it travels with them.
   */
  deckId?: number;
}

export type SortOrder = 'relevance' | 'name' | 'manaValue' | 'newest' | 'price' | 'edhrec';

export interface CardSummary {
  oracleId: string;
  name: string;
  manaCost: string | null;
  cmc: number;
  typeLine: string;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  colors: string;
  colorIdentity: string;
  rarity: string | null;
  setCode: string | null;
  setName: string | null;
  collectorNumber: string | null;
  imageSmall: string | null;
  imageNormal: string | null;
  priceUsd: number | null;
  priceUsdFoil: number | null;
  printingId: string | null;
  ownedQuantity: number;
  wantedQuantity: number;
  printingCount: number;
  /**
   * Phase 23. Carried on every row so the client renders badges from the result
   * set — a follow-up request per card is the failure mode this exists to
   * avoid. All four mean exactly what allocation.ts says they mean.
   */
  availableQuantity: number;
  /** Effective reservation — 0 for a basic land outside allocation. */
  reservedQuantity: number;
  tradeListedQuantity: number;
  /** Decks that reference the card, and their names. */
  deckCount: number;
  deckNames: string[];
  /**
   * False for a basic land exempted by `allocation_ignores_basics`. Such a card
   * gets no owned/available badge at all — a blank badge beats a wrong one.
   */
  allocationTracked: boolean;
}

export interface SearchResult {
  cards: CardSummary[];
  total: number;
  limit: number;
  offset: number;
  /** Parse warnings — an unknown location, a count that was not a number. */
  warnings: string[];
}

/**
 * Ordering runs on name_normalized rather than `name COLLATE NOCASE`.
 *
 * Two reasons, one of each kind. It is indexable — idx_oracle_name is on
 * name_normalized, and COLLATE NOCASE cannot use it, so sorting the whole
 * result set meant materialising every joined row into a temp B-tree to pick
 * sixty. And it sorts by the name people read: normalisation strips leading
 * punctuation, so Unfinity's "_____ Balls of Fire" files under B instead of
 * colonising the first page ahead of every real card.
 */
const SORT_SQL: Record<Exclude<SortOrder, 'relevance'>, string> = {
  name: 'o.name_normalized ASC',
  manaValue: 'o.cmc ASC, o.name_normalized ASC',
  newest: `COALESCE(dp.released_at,'0000-00-00') DESC, o.name_normalized ASC`,
  price: 'COALESCE(dp.price_usd, 0) DESC, o.name_normalized ASC',
  edhrec: 'COALESCE(o.edhrec_rank, 999999) ASC, o.name_normalized ASC',
};

/**
 * Which decks reference a card, and how many — the badge on a result row.
 *
 * Any board, any status, on purpose: this is "spoken for by a list", not the
 * allocation question, and `indeck` in ./collection.ts reads the same
 * definition so a filter and a badge can never disagree. Names are joined with
 * a unit separator rather than a comma because deck names may contain commas.
 */
const DECK_USAGE_CTE = `deck_usage AS MATERIALIZED (
      SELECT oracle_id,
             COUNT(*)                        AS deck_count,
             group_concat(name, char(31))    AS deck_names
      FROM (SELECT DISTINCT dc.oracle_id AS oracle_id, d.name AS name
              FROM deck_cards dc
              JOIN decks d ON d.id = dc.deck_id)
      GROUP BY oracle_id)`;

/**
 * The `WITH` block every search runs under.
 *
 * The three allocation rollups come from allocation.ts so owned / reserved /
 * trade-listed mean here exactly what they mean in a deck row — an archived
 * location does not count, a brew does not reserve. They bind no parameters,
 * so prepending this never disturbs the placeholder order below.
 */
function withClause(settings: AllocationSettings, excludeDeckId?: number): string {
  return `WITH ${allocationCtes(settings, { excludeDeckId, materialized: true })},
       ${DECK_USAGE_CTE}`;
}

/**
 * Shared FROM/JOIN block.
 *
 * The rollups are joins rather than per-row subqueries so an `owned>=1` or
 * `available>=1` filter costs one probe of a small materialised table. The
 * previous hand-rolled `owned` subquery lived here and counted archived
 * locations, which stopped being what "owned" means in Phase 22.
 */
const FROM_CLAUSE = `
  FROM oracle_cards o
  -- A chosen art wins over the synced default, which the sync recomputes and
  -- can move underneath you.
  LEFT JOIN card_art_preferences pref ON pref.oracle_id = o.oracle_id
  LEFT JOIN card_printings dp ON dp.id = COALESCE(pref.printing_id, o.default_printing_id)
  LEFT JOIN sets s ON s.code = dp.set_code
  LEFT JOIN card_faces ff ON ff.printing_id = dp.id AND ff.face_index = 0
  LEFT JOIN alloc_owned    ON alloc_owned.oracle_id    = o.oracle_id
  LEFT JOIN alloc_reserved ON alloc_reserved.oracle_id = o.oracle_id
  LEFT JOIN alloc_listed   ON alloc_listed.oracle_id   = o.oracle_id
  LEFT JOIN deck_usage     ON deck_usage.oracle_id     = o.oracle_id`;

/**
 * Runs searches and detail lookups against the local card database.
 *
 * Every query hits SQLite only — never the network — which is what keeps search
 * responsive per keystroke.
 */
export class CardSearchStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * The allocation rule as this database is configured right now.
   *
   * Read per search rather than cached: the three settings behind it are
   * toggleable from the UI, and a search that answered from a stale copy would
   * disagree with the deck rows on the same screen. Three key/value reads.
   */
  private contextFor(filters: SearchFilters): {
    settings: AllocationSettings; excludeDeckId?: number; query: SearchContext;
  } {
    const settings = allocationSettings(this.db);
    return {
      settings,
      excludeDeckId: filters.deckId,
      query: {
        allocation: allocationSqlRefs(settings),
        nameExists: nameChecker(this.db),
      },
    };
  }

  private buildWhere(text: string, filters: SearchFilters, context: SearchContext) {
    const compiled = compileQuery(text, context);
    const where = [...compiled.where];
    const params: (string | number)[] = [...compiled.params];

    if (compiled.ftsMatch) {
      // Two ways in, unioned.
      //
      // card_search is word-oriented: it covers name, type line and rules text,
      // and with the trailing `*` from compileQuery it matches word prefixes.
      // That alone still cannot find a name by its middle — "ightning bolt" —
      // because FTS5 indexes tokens, not substrings.
      //
      // card_name_trgm is the substring half. It already exists for decklist
      // import, where the same string has always resolved; searching used to
      // ignore it, which is why the box was stricter than the importer.
      const trigram = trigramTerm(compiled.freeText);
      if (trigram) {
        where.push(`(o.rowid IN (SELECT rowid FROM card_search WHERE card_search MATCH ?)
                     OR o.oracle_id IN (SELECT v.oracle_id FROM card_name_trgm t
                                        JOIN card_name_variants v ON v.id = t.rowid
                                        WHERE card_name_trgm MATCH ?))`);
        params.push(compiled.ftsMatch, trigram);
      } else {
        where.push('o.rowid IN (SELECT rowid FROM card_search WHERE card_search MATCH ?)');
        params.push(compiled.ftsMatch);
      }
    }

    // Alchemy and Arena-only cards are flagged is_digital and sort first
    // alphabetically, so without this they dominate ordinary results. An
    // explicit is:digital / is:paper in the query wins over the default.
    if (!filters.includeDigital && !mentionsDigital(text)) {
      where.push('COALESCE(dp.is_digital, 0) = 0');
    }

    // Un-cards, "Unknown Event" cards and Mystery Booster playtest cards are
    // legal nowhere and are 6% of the database. Tested by legality rather than
    // by set, because joke sets are not uniformly illegal — Unfinity's
    // non-acorn cards are legal in Legacy, Vintage and Commander.
    //
    // Planes, schemes and vanguards go too. They are genuine cards for
    // Planechase and Archenemy, which is why EXTRA_LAYOUTS spares them from the
    // tokens filter, but they are oversized supplementary cards you never build
    // with in the formats this app tracks — so here they are just 342 more
    // rows in the way.
    //
    // Switched off by an explicit legality term, or `banned:vintage` would
    // return nothing — a card banned everywhere is legal nowhere by definition,
    // which is exactly what makes it interesting to ask about.
    if (!filters.includeUnplayable && !mentionsLegality(text)) {
      // The flag, not the subquery — see query.ts's 'playable' case.
      where.push('o.is_playable = 1');
    }

    if (filters.commanderFor) {
      const kind = (this.db.prepare('SELECT commander_kind FROM formats WHERE code = ?')
        .get(filters.commanderFor) as { commander_kind: string } | undefined)?.commander_kind;
      const legendaryWalker = `(o.is_legendary = 1 AND o.type_line LIKE '%Planeswalker%')`;

      if (kind === 'planeswalker') {
        where.push(legendaryWalker);
      } else if (kind === 'legendary_or_planeswalker') {
        where.push(`(o.can_be_commander = 1 OR ${legendaryWalker})`);
      } else if (kind === 'uncommon_creature') {
        where.push(`(o.type_line LIKE '%Creature%' AND o.has_uncommon_printing = 1)`);
      } else if (kind) {
        where.push('o.can_be_commander = 1');
      }
    }

    if (filters.excludeUniversesBeyond) {
      // A card counts as Universes Beyond when it has *no* ordinary printing.
      // Testing "has a UB printing" instead would take Sol Ring and Command
      // Tower with it, since those are reprinted in the crossover precons —
      // 1,574 cards have a foot in both worlds, against 3,717 born in one.
      //
      // So the clause keeps a card that has at least one ordinary printing.
      // That is the negation of is:ub, and getting it backwards silently shows
      // only the crossover cards — which is what the tests below are for.
      where.push(`EXISTS (SELECT 1 FROM card_printings ubp
                          WHERE ubp.oracle_id = o.oracle_id
                            AND COALESCE(ubp.promo_types,'') NOT LIKE '%universesbeyond%')`);
    }

    if (!filters.includeExtras) {
      const placeholders = EXTRA_LAYOUTS.map(() => '?').join(',');
      where.push(`COALESCE(o.layout,'') NOT IN (${placeholders})`);
      params.push(...EXTRA_LAYOUTS);
    }

    if (filters.ownedOnly) {
      // Literally the same fragment `owned>=1` compiles to, so the checkbox and
      // the term cannot give different answers or different performance.
      const fragment = ownedAtLeast(context, 1);
      where.push(fragment.sql);
      params.push(...fragment.params);
    }
    if (filters.colors && filters.colors.length > 0) {
      // "C" is a sixth choice alongside WUBRG, not the absence of a choice.
      // Colourless artifacts belong in almost every deck, so a mono-white
      // filter that silently hid Sol Ring was wrong.
      const includeColorless = filters.colors.some((c) => c.toUpperCase() === 'C');
      const mask = maskOf(filters.colors.filter((c) => c.toUpperCase() !== 'C'));

      if (mask === 0 && includeColorless) {
        // Colourless on its own means exactly that, in either mode.
        where.push('o.color_identity_mask = 0');
      } else if (filters.colorsExact) {
        where.push(includeColorless
          ? '(o.color_identity_mask = ? OR o.color_identity_mask = 0)'
          : 'o.color_identity_mask = ?');
        params.push(mask);
      } else {
        // Cards that fit *inside* the chosen colours — the deck-building
        // question, not "mentions this colour". Colourless cards fit inside
        // everything, so they are only excluded when C is not selected.
        where.push(includeColorless
          ? '(o.color_identity_mask & ~?) = 0'
          : '(o.color_identity_mask & ~?) = 0 AND o.color_identity_mask <> 0');
        params.push(mask);
      }
    }
    if (filters.gold) {
      where.push('(o.colors_mask & (o.colors_mask - 1)) <> 0');
    }
    if (filters.hybrid) {
      where.push(`o.mana_cost LIKE '%/%'`);
    }

    if (filters.rarities && filters.rarities.length > 0) {
      const placeholders = filters.rarities.map(() => '?').join(',');
      where.push(`EXISTS (SELECT 1 FROM card_printings rp WHERE rp.oracle_id = o.oracle_id
                          AND rp.rarity IN (${placeholders}))`);
      params.push(...filters.rarities);
    }
    if (filters.setCode) {
      where.push(`EXISTS (SELECT 1 FROM card_printings sp WHERE sp.oracle_id = o.oracle_id
                          AND sp.set_code = ?)`);
      params.push(filters.setCode);
    }
    // Limited is the one format the legality table cannot answer for: Scryfall
    // publishes nothing for draft or sealed, so this clause would match no card
    // at all and the deck builder's picker would come back empty for a draft
    // deck. Every card is playable in limited anyway — the pool, not the format,
    // is the restriction — so the filter is simply not applied.
    if (filters.format && !isLimitedFormat(filters.format)) {
      where.push(`EXISTS (SELECT 1 FROM card_legalities cl WHERE cl.oracle_id = o.oracle_id
                          AND cl.format_code = ? AND cl.legality IN ('legal','restricted'))`);
      params.push(filters.format);
    }
    if (typeof filters.minCmc === 'number') { where.push('o.cmc >= ?'); params.push(filters.minCmc); }
    if (typeof filters.maxCmc === 'number') { where.push('o.cmc <= ?'); params.push(filters.maxCmc); }
    if (filters.category) {
      where.push(`EXISTS (SELECT 1 FROM card_categories cc
                          WHERE cc.oracle_id = o.oracle_id AND cc.category = ?)`);
      params.push(filters.category);
    }

    return { where, params, freeText: compiled.freeText, warnings: compiled.warnings };
  }

  search(
    text: string,
    filters: SearchFilters = {},
    sort: SortOrder = 'relevance',
    limit = 100,
    offset = 0,
    /** The total from the first page, so later pages need not recount. */
    knownTotal?: number,
  ): SearchResult {
    const context = this.contextFor(filters);
    const { where, params, freeText, warnings } =
      this.buildWhere(text, filters, context.query);
    const whereSql = where.length > 0 ? `WHERE ${where.join('\n    AND ')}` : '';
    const with_ = withClause(context.settings, context.excludeDeckId);

    // The count is the expensive half — it cannot stop at LIMIT and it runs
    // over the whole FROM clause. It also cannot change while paging through
    // one result set, so "Load more" skips it and reuses the total it has.
    const total = offset > 0 && knownTotal !== undefined
      ? knownTotal
      : (this.db
          .prepare(`${with_} SELECT count(*) AS n ${FROM_CLAUSE} ${whereSql}`)
          .get(...params) as { n: number }).n;

    // Relevance ordering only means something when the user typed words. An
    // exact name has to win: searching "lightning bolt" must return Lightning
    // Bolt itself, not the alphabetically-first card mentioning both words.
    const rankParams: (string | number)[] = [];
    let orderSql: string;
    if (sort === 'relevance' && freeText) {
      const normalized = normalizeName(freeText);
      orderSql = `CASE
            WHEN o.name_normalized = ? THEN 0
            WHEN o.name_normalized LIKE ? THEN 1
            WHEN o.name_normalized LIKE ? THEN 2
            ELSE 3 END,
          -- Within a tier, the shortest name is the closest match: every card
          -- beginning "waste" ranks the same, and alphabetical order alone
          -- buries "Wastes" beneath "Waste Away" and "Waste Management".
          length(o.name_normalized) ASC,
          o.name_normalized ASC`;
      rankParams.push(normalized, `${normalized}%`, `%${normalized}%`);
    } else {
      orderSql = SORT_SQL[sort === 'relevance' ? 'name' : sort];
    }

    const refs = context.query.allocation;
    const rows = this.db
      .prepare(`
        ${with_}
        SELECT o.oracle_id, o.name, o.mana_cost, o.cmc, o.type_line, o.power, o.toughness,
               o.loyalty, o.colors, o.color_identity,
               dp.id AS printing_id, dp.set_code, dp.collector_number, dp.rarity,
               -- Double-faced cards carry no card-level art; it lives on the
               -- faces. Without this fallback every transform card renders blank.
               ${artUrlSql('dp', 'ff', 'small')} AS image_small,
               ${artUrlSql('dp', 'ff', 'normal')} AS image_normal,
               dp.price_usd, dp.price_usd_foil,
               s.name AS set_name,
               ${refs.owned}       AS owned_qty,
               ${refs.available}   AS available_qty,
               ${refs.reserved}    AS reserved_qty,
               ${refs.tradeListed} AS trade_listed_qty,
               ${refs.tracked}     AS allocation_tracked,
               COALESCE(deck_usage.deck_count, 0) AS deck_count,
               deck_usage.deck_names,
               -- On any active want list? A small table, so a scalar subquery
               -- over a page of results is cheap. Drives the "wanted" badge.
               (SELECT COALESCE(SUM(w.quantity), 0) FROM want_list_items w
                WHERE w.oracle_id = o.oracle_id AND w.status = 'active') AS wanted_qty,
               (SELECT count(*) FROM card_printings cp WHERE cp.oracle_id = o.oracle_id) AS printing_count
        ${FROM_CLAUSE}
        ${whereSql}
        ORDER BY ${orderSql}
        LIMIT ? OFFSET ?`)
      .all(...params, ...rankParams, limit, offset) as any[];

    return { cards: rows.map(toSummary), total, limit, offset, warnings };
  }

  detail(oracleId: string) {
    const settings = allocationSettings(this.db);
    const refs = allocationSqlRefs(settings);
    const row = this.db.prepare(`
      ${withClause(settings)}
      SELECT o.oracle_id, o.name, o.mana_cost, o.cmc, o.type_line, o.power, o.toughness,
             o.loyalty, o.colors, o.color_identity, o.oracle_text, o.keywords,
             o.is_reserved, o.can_be_commander, o.edhrec_rank, o.layout,
             o.deck_copy_limit,
             dp.id AS printing_id, dp.set_code, dp.collector_number, dp.rarity,
             ${artUrlSql('dp', 'ff', 'small')} AS image_small,
             ${artUrlSql('dp', 'ff', 'normal')} AS image_normal,
             dp.price_usd, dp.price_usd_foil,
             dp.flavor_text, dp.artist, s.name AS set_name,
             ${refs.owned}       AS owned_qty,
             ${refs.available}   AS available_qty,
             ${refs.reserved}    AS reserved_qty,
             ${refs.tradeListed} AS trade_listed_qty,
             ${refs.tracked}     AS allocation_tracked,
             COALESCE(deck_usage.deck_count, 0) AS deck_count,
             deck_usage.deck_names,
             (pref.printing_id IS NOT NULL) AS art_is_pinned,
             (SELECT count(*) FROM card_printings cp WHERE cp.oracle_id = o.oracle_id) AS printing_count,
             -- Same "on any active want list" check the search results use, so
             -- the detail pane's want button reflects a card wanted from
             -- anywhere, not just this session's browse grid.
             (SELECT COALESCE(SUM(w.quantity), 0) FROM want_list_items w
              WHERE w.oracle_id = o.oracle_id AND w.status = 'active') AS wanted_qty
      ${FROM_CLAUSE}
      WHERE o.oracle_id = ?`).get(oracleId) as any;

    if (!row) return null;

    const faces = this.db.prepare(`
      SELECT f.face_index, f.name, f.mana_cost, f.type_line, f.oracle_text,
             f.power, f.toughness,
             ${imageUrlSql({
               id: 'f.printing_id',
               ts: 'f.image_ts',
               override: 'f.image_url_override',
               size: 'normal',
               side: `CASE WHEN f.face_index = 0 THEN 'front' ELSE 'back' END`,
             })} AS image_normal
      FROM card_faces f
      WHERE f.printing_id = (SELECT COALESCE(ap.printing_id, o.default_printing_id)
                               FROM oracle_cards o
                               LEFT JOIN card_art_preferences ap ON ap.oracle_id = o.oracle_id
                              WHERE o.oracle_id = ?)
      ORDER BY f.face_index`).all(oracleId) as any[];

    const printings = this.db.prepare(`
      SELECT p.id, p.set_code, p.collector_number, p.rarity, p.released_at,
             p.price_usd, p.price_usd_foil,
             ${imageUrlSql({ id: 'p.id', ts: 'p.image_ts', override: 'p.image_url_override', size: 'normal' })} AS image_normal,
             p.scryfall_uri,
             p.tcgplayer_id, p.is_digital, p.is_promo, p.promo_types,
             COALESCE(s.name, p.set_code) AS set_name,
             COALESCE((SELECT SUM(ci.quantity) FROM collection_items ci
                       WHERE ci.printing_id = p.id), 0) AS owned_qty
      FROM card_printings p
      LEFT JOIN sets s ON s.code = p.set_code
      WHERE p.oracle_id = ?
      -- The printing on screen comes first, so the list answers "which one am
      -- I looking at" before it answers anything else. After that: things you
      -- can actually see and price, newest first — promos and placeholders
      -- used to head the list purely because they were recent.
      ORDER BY (p.id = ?) DESC,
               (p.image_ts IS NULL) ASC,
               (p.price_usd IS NULL) ASC,
               COALESCE(p.released_at,'0000-00-00') DESC,
               p.set_code, p.collector_number_num`)
      .all(oracleId, row.printing_id) as any[];

    // Only formats the app knows about, in picker order, so the detail pane
    // does not list every experimental format Scryfall has ever published.
    const legalities = this.db.prepare(`
      SELECT cl.format_code, cl.legality, f.display_name
      FROM card_legalities cl
      JOIN formats f ON f.code = cl.format_code
      WHERE cl.oracle_id = ? AND f.is_active = 1
      ORDER BY f.sort_order`).all(oracleId) as any[];

    const faceImages = faces.map((f: any) => f.image_normal).filter(Boolean);
    return {
      ...toSummary(row),
      layout: row.layout,
      // Resolved server-side: a client should never have to know that
      // double-faced art lives on the faces rather than the card.
      frontImage: row.image_normal ?? faceImages[0] ?? null,
      backImage: faces.length > 1 ? (faces[1].image_normal ?? null) : null,
      oracleText: row.oracle_text,
      flavorText: row.flavor_text,
      artist: row.artist,
      keywords: parseJsonArray(row.keywords),
      isReserved: Boolean(row.is_reserved),
      canBeCommander: Boolean(row.can_be_commander),
      /** The card's own copy cap; -1 means any number. Null for ordinary cards. */
      deckCopyLimit: row.deck_copy_limit ?? null,
      /** True when this art was chosen rather than picked by the sync. */
      artIsPinned: Boolean(row.art_is_pinned),
      edhrecRank: row.edhrec_rank,
      faces: faces.map((f) => ({
        index: f.face_index,
        name: f.name,
        manaCost: f.mana_cost,
        typeLine: f.type_line,
        oracleText: f.oracle_text,
        powerToughness: f.power && f.toughness ? `${f.power}/${f.toughness}` : null,
        imageNormal: f.image_normal,
      })),
      printings: printings.map((p) => ({
        id: p.id,
        setCode: p.set_code,
        setName: p.set_name,
        collectorNumber: p.collector_number,
        rarity: p.rarity,
        releasedAt: p.released_at,
        priceUsd: p.price_usd,
        priceUsdFoil: p.price_usd_foil,
        imageNormal: p.image_normal,
        scryfallUri: p.scryfall_uri,
        tcgplayerId: p.tcgplayer_id,
        isDigital: Boolean(p.is_digital),
        isPromo: Boolean(p.is_promo),
        promoTypes: parseJsonArray(p.promo_types),
        ownedQuantity: p.owned_qty,
      })),
      legalities: legalities.map((l) => ({
        format: l.format_code,
        displayName: l.display_name,
        status: l.legality,
        playable: l.legality === 'legal' || l.legality === 'restricted',
      })),
      rulings: (this.db.prepare(`
        SELECT source, published_at, comment FROM card_rulings
        WHERE oracle_id = ? ORDER BY published_at DESC, id DESC`)
        .all(oracleId) as any[]).map((r) => ({
          source: r.source,
          publishedAt: r.published_at,
          comment: r.comment,
        })),
    };
  }

  /** Pins the art for a card, or clears the pin when printingId is null. */
  setArtPreference(oracleId: string, printingId: string | null): void {
    if (printingId === null) {
      this.db.prepare('DELETE FROM card_art_preferences WHERE oracle_id = ?').run(oracleId);
      return;
    }
    // The printing has to belong to the card, or the detail pane would show
    // somebody else's art with no way to tell where it came from.
    const owned = this.db.prepare(
      'SELECT 1 FROM card_printings WHERE id = ? AND oracle_id = ?',
    ).get(printingId, oracleId);
    if (!owned) throw new Error('That printing does not belong to that card.');

    this.db.prepare(`
      INSERT INTO card_art_preferences (oracle_id, printing_id) VALUES (?, ?)
      ON CONFLICT(oracle_id) DO UPDATE SET printing_id = excluded.printing_id,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(oracleId, printingId);
  }

  /**
   * A random card matching the current filters.
   *
   * ORDER BY random() sorts the whole matching set, which is fine here because
   * the filters have already cut it down and this runs once per click, not per
   * keystroke.
   */
  random(text: string, filters: SearchFilters): string | null {
    const context = this.contextFor(filters);
    const { where, params } = this.buildWhere(text, filters, context.query);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db.prepare(
      `${withClause(context.settings, context.excludeDeckId)}
       SELECT o.oracle_id AS id ${FROM_CLAUSE} ${whereSql} ORDER BY random() LIMIT 1`,
    ).get(...params) as { id: string } | undefined;
    return row?.id ?? null;
  }

  sets() {
    return this.db.prepare(`
      SELECT code, name, released_at, card_count FROM sets
      WHERE EXISTS (SELECT 1 FROM card_printings p WHERE p.set_code = sets.code)
      ORDER BY COALESCE(released_at,'0000-00-00') DESC, name`).all() as any[];
  }

  formats() {
    const rows = this.db.prepare(
      `SELECT code, display_name, requires_commander AS requiresCommander,
            is_singleton AS isSingleton
     FROM formats WHERE is_active = 1 ORDER BY sort_order`,
    ).all() as any[];
    // isLimited travels with the format so the client never has to keep its own
    // copy of which formats these are: it changes what the deck builder's
    // picker says, and adding a card to one of them also buys the card.
    return rows.map((row) => ({ ...row, isLimited: isLimitedFormat(row.code) ? 1 : 0 }));
  }
}

function maskOf(colors: string[]): number {
  const bits: Record<string, number> = { W: 1, U: 2, B: 4, R: 8, G: 16 };
  return colors.reduce((mask, c) => mask | (bits[c.toUpperCase()] ?? 0), 0);
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toSummary(row: any): CardSummary {
  return {
    oracleId: row.oracle_id,
    name: row.name,
    manaCost: row.mana_cost,
    cmc: row.cmc,
    typeLine: row.type_line,
    power: row.power,
    toughness: row.toughness,
    loyalty: row.loyalty,
    colors: row.colors ?? '',
    colorIdentity: row.color_identity ?? '',
    rarity: row.rarity,
    setCode: row.set_code,
    setName: row.set_name,
    collectorNumber: row.collector_number,
    imageSmall: row.image_small,
    imageNormal: row.image_normal,
    priceUsd: row.price_usd,
    priceUsdFoil: row.price_usd_foil,
    printingId: row.printing_id,
    ownedQuantity: row.owned_qty ?? 0,
    wantedQuantity: row.wanted_qty ?? 0,
    printingCount: row.printing_count ?? 0,
    availableQuantity: row.available_qty ?? 0,
    reservedQuantity: row.reserved_qty ?? 0,
    tradeListedQuantity: row.trade_listed_qty ?? 0,
    deckCount: row.deck_count ?? 0,
    // group_concat with a unit separator, so a deck named "Rakdos, Lord of
    // Riots" survives the round trip intact.
    deckNames: row.deck_names ? String(row.deck_names).split('\u001f') : [],
    // The column is SQLite's 1/0; an older row with nothing there is tracked,
    // which is the safe default — it shows a badge rather than hiding one.
    allocationTracked: row.allocation_tracked === undefined
      ? true : Boolean(row.allocation_tracked),
  };
}
