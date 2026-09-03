import type Database from 'better-sqlite3';
import { compileQuery, mentionsDigital, mentionsLegality } from './query.ts';
import { normalizeName, EXTRA_LAYOUTS } from '../model/mtg.ts';

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
  printingCount: number;
}

export interface SearchResult {
  cards: CardSummary[];
  total: number;
  limit: number;
  offset: number;
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

/** Shared FROM/JOIN block. `owned` is a join so an owned-only filter is cheap. */
const FROM_CLAUSE = `
  FROM oracle_cards o
  -- A chosen art wins over the synced default, which the sync recomputes and
  -- can move underneath you.
  LEFT JOIN card_art_preferences pref ON pref.oracle_id = o.oracle_id
  LEFT JOIN card_printings dp ON dp.id = COALESCE(pref.printing_id, o.default_printing_id)
  LEFT JOIN sets s ON s.code = dp.set_code
  LEFT JOIN card_faces ff ON ff.printing_id = dp.id AND ff.face_index = 0
  LEFT JOIN (
      -- Written as a correlated lookup rather than a join to card_printings,
      -- because the planner reads the join form as licence to scan all 117,620
      -- printings and probe the collection for each — backwards, and paid on
      -- every search whether or not the collection is even involved. Driving
      -- from collection_items instead costs one primary-key lookup per lot.
      SELECT (SELECT cp.oracle_id FROM card_printings cp WHERE cp.id = ci.printing_id) AS oracle_id,
             SUM(ci.quantity) AS qty
      FROM collection_items ci
      GROUP BY 1
  ) owned ON owned.oracle_id = o.oracle_id`;

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

  private buildWhere(text: string, filters: SearchFilters) {
    const compiled = compileQuery(text);
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
      where.push(`EXISTS (SELECT 1 FROM card_legalities cl
                          WHERE cl.oracle_id = o.oracle_id
                            AND cl.legality IN ('legal','restricted'))`);
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
      where.push('COALESCE(owned.qty, 0) > 0');
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
    if (filters.format) {
      where.push(`EXISTS (SELECT 1 FROM card_legalities cl WHERE cl.oracle_id = o.oracle_id
                          AND cl.format_code = ? AND cl.legality IN ('legal','restricted'))`);
      params.push(filters.format);
    }
    if (typeof filters.minCmc === 'number') { where.push('o.cmc >= ?'); params.push(filters.minCmc); }
    if (typeof filters.maxCmc === 'number') { where.push('o.cmc <= ?'); params.push(filters.maxCmc); }

    return { where, params, freeText: compiled.freeText };
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
    const { where, params, freeText } = this.buildWhere(text, filters);
    const whereSql = where.length > 0 ? `WHERE ${where.join('\n    AND ')}` : '';

    // The count is the expensive half — it cannot stop at LIMIT and it runs
    // over the whole FROM clause. It also cannot change while paging through
    // one result set, so "Load more" skips it and reuses the total it has.
    const total = offset > 0 && knownTotal !== undefined
      ? knownTotal
      : (this.db
          .prepare(`SELECT count(*) AS n ${FROM_CLAUSE} ${whereSql}`)
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

    const rows = this.db
      .prepare(`
        SELECT o.oracle_id, o.name, o.mana_cost, o.cmc, o.type_line, o.power, o.toughness,
               o.loyalty, o.colors, o.color_identity,
               dp.id AS printing_id, dp.set_code, dp.collector_number, dp.rarity,
               -- Double-faced cards carry no card-level art; it lives on the
               -- faces. Without this fallback every transform card renders blank.
               COALESCE(dp.image_small, ff.image_small) AS image_small,
               COALESCE(dp.image_normal, ff.image_normal) AS image_normal,
               dp.price_usd, dp.price_usd_foil,
               s.name AS set_name,
               COALESCE(owned.qty, 0) AS owned_qty,
               (SELECT count(*) FROM card_printings cp WHERE cp.oracle_id = o.oracle_id) AS printing_count
        ${FROM_CLAUSE}
        ${whereSql}
        ORDER BY ${orderSql}
        LIMIT ? OFFSET ?`)
      .all(...params, ...rankParams, limit, offset) as any[];

    return { cards: rows.map(toSummary), total, limit, offset };
  }

  detail(oracleId: string) {
    const row = this.db.prepare(`
      SELECT o.oracle_id, o.name, o.mana_cost, o.cmc, o.type_line, o.power, o.toughness,
             o.loyalty, o.colors, o.color_identity, o.oracle_text, o.keywords,
             o.is_reserved, o.can_be_commander, o.edhrec_rank, o.layout,
             dp.id AS printing_id, dp.set_code, dp.collector_number, dp.rarity,
             COALESCE(dp.image_small, ff.image_small) AS image_small,
             COALESCE(dp.image_normal, ff.image_normal) AS image_normal,
             dp.price_usd, dp.price_usd_foil,
             dp.flavor_text, dp.artist, s.name AS set_name,
             COALESCE(owned.qty, 0) AS owned_qty,
             (pref.printing_id IS NOT NULL) AS art_is_pinned,
             (SELECT count(*) FROM card_printings cp WHERE cp.oracle_id = o.oracle_id) AS printing_count
      ${FROM_CLAUSE}
      WHERE o.oracle_id = ?`).get(oracleId) as any;

    if (!row) return null;

    const faces = this.db.prepare(`
      SELECT f.face_index, f.name, f.mana_cost, f.type_line, f.oracle_text,
             f.power, f.toughness, f.image_normal
      FROM card_faces f
      WHERE f.printing_id = (SELECT COALESCE(ap.printing_id, o.default_printing_id)
                               FROM oracle_cards o
                               LEFT JOIN card_art_preferences ap ON ap.oracle_id = o.oracle_id
                              WHERE o.oracle_id = ?)
      ORDER BY f.face_index`).all(oracleId) as any[];

    const printings = this.db.prepare(`
      SELECT p.id, p.set_code, p.collector_number, p.rarity, p.released_at,
             p.price_usd, p.price_usd_foil, p.image_normal, p.scryfall_uri,
             p.tcgplayer_id, p.is_digital,
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
               (p.image_normal IS NULL) ASC,
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
        ownedQuantity: p.owned_qty,
      })),
      legalities: legalities.map((l) => ({
        format: l.format_code,
        displayName: l.display_name,
        status: l.legality,
        playable: l.legality === 'legal' || l.legality === 'restricted',
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
    const { where, params } = this.buildWhere(text, filters);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const row = this.db.prepare(
      `SELECT o.oracle_id AS id ${FROM_CLAUSE} ${whereSql} ORDER BY random() LIMIT 1`,
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
    return this.db.prepare(
      `SELECT code, display_name, requires_commander AS requiresCommander
     FROM formats WHERE is_active = 1 ORDER BY sort_order`,
    ).all() as any[];
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
    printingCount: row.printing_count ?? 0,
  };
}
