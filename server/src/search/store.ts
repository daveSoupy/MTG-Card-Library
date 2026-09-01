import type Database from 'better-sqlite3';
import { compileQuery, mentionsDigital } from './query.ts';
import { normalizeName } from '../model/mtg.ts';

export interface SearchFilters {
  ownedOnly?: boolean;
  /** Colour identity must fit inside these colours (deck-building semantics). */
  colors?: string[];
  colorsExact?: boolean;
  rarities?: string[];
  setCode?: string;
  format?: string;
  minCmc?: number;
  maxCmc?: number;
  /** Alchemy and other digital-only cards are hidden unless asked for. */
  includeDigital?: boolean;
  /** Art series, tokens and emblems are hidden unless asked for. */
  includeExtras?: boolean;
}

/**
 * Layouts that are not playable cards at all — art cards, tokens, emblems and
 * the "front_card" display entries. 3,612 of them, and they otherwise crowd out
 * real results: searching "Delver of Secrets" returned the art card rather than
 * the creature. Planar, vanguard and scheme are deliberately *not* here; they
 * are genuine cards, merely not legal in the formats this app tracks.
 */
const EXTRA_LAYOUTS = ['art_series', 'token', 'double_faced_token', 'emblem', 'front_card'];

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

const SORT_SQL: Record<Exclude<SortOrder, 'relevance'>, string> = {
  name: 'o.name COLLATE NOCASE ASC',
  manaValue: 'o.cmc ASC, o.name COLLATE NOCASE ASC',
  newest: `COALESCE(dp.released_at,'0000-00-00') DESC, o.name COLLATE NOCASE ASC`,
  price: 'COALESCE(dp.price_usd, 0) DESC, o.name COLLATE NOCASE ASC',
  edhrec: 'COALESCE(o.edhrec_rank, 999999) ASC, o.name COLLATE NOCASE ASC',
};

/** Shared FROM/JOIN block. `owned` is a join so an owned-only filter is cheap. */
const FROM_CLAUSE = `
  FROM oracle_cards o
  LEFT JOIN card_printings dp ON dp.id = o.default_printing_id
  LEFT JOIN sets s ON s.code = dp.set_code
  LEFT JOIN card_faces ff ON ff.printing_id = dp.id AND ff.face_index = 0
  LEFT JOIN (
      SELECT p.oracle_id, SUM(ci.quantity) AS qty
      FROM collection_items ci
      JOIN card_printings p ON p.id = ci.printing_id
      GROUP BY p.oracle_id
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
      where.push('o.rowid IN (SELECT rowid FROM card_search WHERE card_search MATCH ?)');
      params.push(compiled.ftsMatch);
    }

    // Alchemy and Arena-only cards are flagged is_digital and sort first
    // alphabetically, so without this they dominate ordinary results. An
    // explicit is:digital / is:paper in the query wins over the default.
    if (!filters.includeDigital && !mentionsDigital(text)) {
      where.push('COALESCE(dp.is_digital, 0) = 0');
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
      const mask = maskOf(filters.colors);
      if (filters.colorsExact) {
        where.push('o.color_identity_mask = ?');
      } else {
        // Cards that fit *inside* the chosen colours — the deck-building
        // question, not "mentions this colour".
        where.push('(o.color_identity_mask & ~?) = 0 AND o.color_identity_mask <> 0');
      }
      params.push(mask);
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
  ): SearchResult {
    const { where, params, freeText } = this.buildWhere(text, filters);
    const whereSql = where.length > 0 ? `WHERE ${where.join('\n    AND ')}` : '';

    const total = (this.db
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
          o.name COLLATE NOCASE ASC`;
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
             (SELECT count(*) FROM card_printings cp WHERE cp.oracle_id = o.oracle_id) AS printing_count
      ${FROM_CLAUSE}
      WHERE o.oracle_id = ?`).get(oracleId) as any;

    if (!row) return null;

    const faces = this.db.prepare(`
      SELECT f.face_index, f.name, f.mana_cost, f.type_line, f.oracle_text,
             f.power, f.toughness, f.image_normal
      FROM card_faces f
      WHERE f.printing_id = (SELECT default_printing_id FROM oracle_cards WHERE oracle_id = ?)
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
      ORDER BY COALESCE(p.released_at,'0000-00-00') DESC, p.set_code, p.collector_number_num`)
      .all(oracleId) as any[];

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

  sets() {
    return this.db.prepare(`
      SELECT code, name, released_at, card_count FROM sets
      WHERE EXISTS (SELECT 1 FROM card_printings p WHERE p.set_code = sets.code)
      ORDER BY COALESCE(released_at,'0000-00-00') DESC, name`).all() as any[];
  }

  formats() {
    return this.db.prepare(
      'SELECT code, display_name FROM formats WHERE is_active = 1 ORDER BY sort_order',
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
