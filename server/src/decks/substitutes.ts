import type Database from 'better-sqlite3';
import { imageUrlSql } from '../images/url.ts';
import { getSetting } from '../db/index.ts';
import { colorsFromMask, isLimitedFormat } from '../model/mtg.ts';
import { CATEGORY_LABELS, hasCardCategories } from '../sync/categories.ts';
import {
  allocationCtes, allocationSettings, allocationSqlRefs, ownedSemiJoinSql,
  LISTED_CTE, OWNED_CTE, RESERVED_CTE,
} from './allocation.ts';
import { heuristicRoles } from './roleHeuristics.ts';

/**
 * Phase 27 — cards you already own that could fill a slot you are short on.
 *
 * Every other phase in this set says what you are missing. This one says what
 * to do about it without opening a shopping cart: given a card a deck cannot
 * field and the deck for context, rank the owned, free, colour-legal,
 * format-legal cards that play the same role.
 *
 * Two halves, deliberately split:
 *
 * - **The pool** is SQL. Owned and available come from `allocation.ts`'s CTEs
 *   with this deck excluded, the same way every other caller reads them —
 *   nothing here subtracts anything. Colour identity is the indexable subset
 *   test Phase 3 uses, legality is the same `card_legalities` predicate the
 *   search uses. The pool is bounded by what you own, so it is small.
 * - **The ranking** is TypeScript over the survivors. Weighted, deterministic,
 *   and reported component by component so the reason line can be audited
 *   rather than trusted.
 *
 * Nothing here writes. Accepting a suggestion is an ordinary deck edit the
 * client makes through the existing card routes — remove one, add the other —
 * so there is no second allocation path to keep honest.
 */

// -- shapes -------------------------------------------------------------------

export type CategorySource = 'tagger' | 'heuristic';

export interface SharedCategory {
  category: string;
  label: string;
  source: CategorySource;
}

export interface ScoreComponents {
  total: number;
  category: number;
  type: number;
  cmc: number;
  edhrec: number;
  availability: number;
}

export interface SubstituteCandidate {
  oracleId: string;
  name: string;
  /** The default printing, for art. */
  printingId: string | null;
  imageSmall: string | null;
  cmc: number;
  typeLine: string;
  manaCost: string | null;
  colorIdentity: string;
  primaryType: string | null;
  /** Roles this card shares with the target. Empty when it matched on type and cost only. */
  sharedCategories: SharedCategory[];
  /** Free copies for this deck — its own claim excluded, other decks' not. */
  available: number;
  /** Where the copies physically live. */
  locations: Array<{ locationId: number; name: string; quantity: number }>;
  edhrecRank: number | null;
  score: ScoreComponents;
  /**
   * The reason line, one phrase per signal that fired: "Removal · Instant ·
   * CMC 2 · 3 available in Binder 3". Written here rather than in a client so
   * that every client explains a suggestion in the same words, and so a
   * candidate can never come back without a reason at all.
   */
  reasons: string[];
}

export interface SubstitutesResult {
  target: {
    oracleId: string;
    name: string;
    cmc: number;
    typeLine: string;
    primaryType: string | null;
    categories: SharedCategory[];
  };
  context: {
    deckId: number | null;
    deckName: string | null;
    formatCode: string | null;
    /** 'WU', '' for a colourless identity, or null when unconstrained. */
    colorIdentity: string | null;
  };
  /**
   * Where the role signal came from — the Tagger bulk file, the keyword
   * heuristic, or null when the target has no role under either and the
   * match is on type and cost only. The UI reads this for its one quiet line.
   */
  categorySource: CategorySource | null;
  candidates: SubstituteCandidate[];
  /** Survivors of the hard filters — before the relevance floor and the cut to
   *  `substitute_suggestion_count`. Non-zero with no candidates means "you own
   *  playable cards, none of them fill this role". */
  poolSize: number;
}

// -- settings -----------------------------------------------------------------

export const SUBSTITUTE_SUGGESTION_COUNT = 'substitute_suggestion_count';
export const SUBSTITUTE_SUGGESTION_COUNT_DEFAULT = 6;

/** Clamped: zero suggestions is a disabled feature, and thirty is a search result. */
export function suggestionCount(db: Database.Database): number {
  const stored = Number(getSetting(db, SUBSTITUTE_SUGGESTION_COUNT));
  if (!Number.isFinite(stored) || stored < 1) return SUBSTITUTE_SUGGESTION_COUNT_DEFAULT;
  return Math.min(24, Math.floor(stored));
}

// -- the weights --------------------------------------------------------------
//
// Tuned during the Phase 27 session against a copy of the live library (a
// small collection, so treat these as a first cut rather than a fit). The
// shape matters more than the numbers:
//
// - One shared role (10) outweighs everything else combined (3 + 2 + 0.15 +
//   0.1 = 5.25), so a card sharing a role always ranks above one sharing
//   none — the invariant the phase doc names and the test checks. Two roles
//   beat one for the same reason.
// - Type (3) beats the whole CMC range (2): an instant that costs one more is
//   a closer fit for an instant slot than a creature at the same cost.
// - CMC is `1/(1+|Δ|)` scaled to 2, so Δ0→2.0, Δ1→1.0, Δ2→0.67 — the first
//   step away costs the most, which is how a curve actually feels.
// - EDHREC rank and copies owned are tie-breaks. Their maxima (0.15, 0.1) are
//   below the smallest CMC step that matters (Δ2→Δ3 is 0.17), so they only
//   decide between cards that are otherwise level.

const CATEGORY_WEIGHT = 10;
const TYPE_WEIGHT = 3;
const CMC_WEIGHT = 2;
const EDHREC_WEIGHT = 0.15;
/** Ranks past this are all "obscure" for the purposes of a tie-break. */
const EDHREC_FLOOR = 30_000;
const AVAILABILITY_WEIGHT = 0.1;
/** Four is a full playset; owning more does not make a card more useful. */
const AVAILABILITY_CAP = 4;

/**
 * The card type a slot is really about. First match wins, in the same order
 * `stats.ts` groups a decklist by, so an "Artifact Creature" is a creature
 * here for the same reason it sits under Creatures there. Front face only: a
 * transforming creature is a creature.
 */
const PRIMARY_TYPES = [
  'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land',
] as const;

export function primaryType(typeLine: string | null): string | null {
  const front = (typeLine ?? '').split(' // ')[0];
  return PRIMARY_TYPES.find((type) => new RegExp(`\\b${type}\\b`).test(front)) ?? null;
}

/** The scoring rule, pure so the weights can be tested without a database. */
export function scoreCandidate(input: {
  sharedCategories: number;
  sameType: boolean;
  cmcDelta: number;
  edhrecRank: number | null;
  available: number;
}): ScoreComponents {
  const category = CATEGORY_WEIGHT * input.sharedCategories;
  const type = input.sameType ? TYPE_WEIGHT : 0;
  const cmc = CMC_WEIGHT / (1 + Math.abs(input.cmcDelta));
  const edhrec = input.edhrecRank == null
    ? 0
    : EDHREC_WEIGHT * (1 - Math.min(input.edhrecRank, EDHREC_FLOOR) / EDHREC_FLOOR);
  const availability = AVAILABILITY_WEIGHT * (Math.min(input.available, AVAILABILITY_CAP) / AVAILABILITY_CAP);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    total: round(category + type + cmc + edhrec + availability),
    category: round(category),
    type: round(type),
    cmc: round(cmc),
    edhrec: round(edhrec),
    availability: round(availability),
  };
}

// -- context ------------------------------------------------------------------

interface Context {
  deckId: number | null;
  deckName: string | null;
  formatCode: string | null;
  /** Null means unconstrained. */
  colorMask: number | null;
  /** The format to test legality in, or null to skip (no format, or limited). */
  legalityFormat: string | null;
  /** Every card on any board — a substitute already in the deck is not one. */
  inDeck: Set<string>;
}

/**
 * What a deck allows.
 *
 * Colour: under a format that enforces identity, the command zone's union —
 * the rule `validate.ts` applies. Otherwise the union of everything in the
 * deck outside the maybeboard, because a UB deck should not be offered a
 * green removal spell even though Modern would let it. An empty union means
 * the deck has said nothing about colour yet, so nothing is filtered.
 *
 * Legality: the deck's format, except for draft and sealed, where the card
 * pool is what you opened and legality is not a concept.
 */
function deckContext(db: Database.Database, deckId: number): Context | null {
  const deck = db.prepare(`
    SELECT d.id, d.name, d.format_code, COALESCE(f.enforces_color_id, 0) AS enforces
      FROM decks d LEFT JOIN formats f ON f.code = d.format_code
     WHERE d.id = ?`).get(deckId) as
    | { id: number; name: string; format_code: string | null; enforces: number } | undefined;
  if (!deck) return null;

  const cards = db.prepare(`
    SELECT dc.oracle_id, dc.board, o.color_identity_mask
      FROM deck_cards dc JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
     WHERE dc.deck_id = ?`).all(deckId) as Array<{
       oracle_id: string; board: string; color_identity_mask: number;
     }>;

  const inDeck = new Set(cards.map((card) => card.oracle_id));
  const command = cards.filter((card) => card.board === 'command');
  let colorMask: number | null;
  if (deck.enforces && command.length > 0) {
    colorMask = command.reduce((mask, card) => mask | card.color_identity_mask, 0);
  } else {
    const union = cards
      .filter((card) => card.board !== 'maybe')
      .reduce((mask, card) => mask | card.color_identity_mask, 0);
    colorMask = union === 0 ? null : union;
  }

  return {
    deckId: deck.id,
    deckName: deck.name,
    formatCode: deck.format_code,
    colorMask,
    legalityFormat: isLimitedFormat(deck.format_code) ? null : deck.format_code,
    inDeck,
  };
}

const NO_CONTEXT: Context = {
  deckId: null, deckName: null, formatCode: null, colorMask: null, legalityFormat: null,
  inDeck: new Set(),
};

// -- the query ----------------------------------------------------------------

interface CardRow {
  oracle_id: string;
  name: string;
  cmc: number;
  type_line: string | null;
  mana_cost: string | null;
  color_identity: string;
  oracle_text_all: string | null;
  edhrec_rank: number | null;
  is_basic_land: number;
  printing_id: string | null;
  image_small: string | null;
}

const CARD_COLUMNS = `
    o.oracle_id, o.name, o.cmc, o.type_line, o.mana_cost, o.color_identity,
    o.oracle_text_all, o.edhrec_rank, o.is_basic_land,
    o.default_printing_id AS printing_id,
    ${imageUrlSql({ id: 'p.id', ts: 'p.image_ts', override: 'p.image_url_override', size: 'small' })} AS image_small`;

/**
 * The hard filters, all in one statement.
 *
 * Driven from the owned rollup via `ownedSemiJoinSql`, so SQLite scans the
 * collection rather than the catalogue — the difference between 0.2ms and
 * 94ms on a full card database. The availability expression is
 * `allocationSqlRefs`' own; it is repeated in the WHERE clause rather than
 * referenced by alias because SQLite does not allow an alias there.
 */
function candidatePool(db: Database.Database, targetOracleId: string, context: Context):
  Array<CardRow & { available: number }> {
  const settings = allocationSettings(db);
  const refs = allocationSqlRefs(settings);
  const params: unknown[] = [1, targetOracleId];
  const where: string[] = [
    ownedSemiJoinSql('>='),
    'o.oracle_id <> ?',
    'o.is_basic_land = 0',
    `${refs.available} >= 1`,
  ];
  if (context.colorMask !== null) {
    where.push('(o.color_identity_mask & ~?) = 0');
    params.push(context.colorMask);
  }
  if (context.legalityFormat) {
    where.push(`EXISTS (SELECT 1 FROM card_legalities cl
                         WHERE cl.oracle_id = o.oracle_id AND cl.format_code = ?
                           AND cl.legality IN ('legal','restricted'))`);
    params.push(context.legalityFormat);
  }
  if (context.inDeck.size > 0) {
    where.push(`o.oracle_id NOT IN (${[...context.inDeck].map(() => '?').join(',')})`);
    params.push(...context.inDeck);
  }

  return db.prepare(`
    WITH ${allocationCtes(settings, { excludeDeckId: context.deckId ?? undefined })}
    SELECT ${CARD_COLUMNS}, ${refs.available} AS available
      FROM oracle_cards o
      LEFT JOIN card_printings p ON p.id = o.default_printing_id
      LEFT JOIN ${OWNED_CTE}    ON ${OWNED_CTE}.oracle_id    = o.oracle_id
      LEFT JOIN ${RESERVED_CTE} ON ${RESERVED_CTE}.oracle_id = o.oracle_id
      LEFT JOIN ${LISTED_CTE}   ON ${LISTED_CTE}.oracle_id   = o.oracle_id
     WHERE ${where.join('\n       AND ')}`).all(...params) as Array<CardRow & { available: number }>;
}

/** Categories for a set of cards, from whichever source is speaking. */
function categoriesFor(
  db: Database.Database,
  cards: CardRow[],
  source: CategorySource,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (cards.length === 0) return result;

  if (source === 'heuristic') {
    for (const card of cards) {
      result.set(card.oracle_id, heuristicRoles(card.oracle_text_all, card.type_line));
    }
    return result;
  }

  const ids = cards.map((card) => card.oracle_id);
  for (let i = 0; i < ids.length; i += 900) {
    const chunk = ids.slice(i, i + 900);
    const rows = db.prepare(`
      SELECT oracle_id, category FROM card_categories
       WHERE oracle_id IN (${chunk.map(() => '?').join(',')})
       ORDER BY category`).all(...chunk) as Array<{ oracle_id: string; category: string }>;
    for (const row of rows) {
      result.set(row.oracle_id, [...(result.get(row.oracle_id) ?? []), row.category]);
    }
  }
  return result;
}

/** Where each candidate's copies live, non-archived locations only — the same
 *  lots `owned` counted. */
function locationsFor(
  db: Database.Database,
  oracleIds: string[],
): Map<string, Array<{ locationId: number; name: string; quantity: number }>> {
  const result = new Map<string, Array<{ locationId: number; name: string; quantity: number }>>();
  if (oracleIds.length === 0) return result;
  const rows = db.prepare(`
    SELECT p.oracle_id, sl.id, sl.name, SUM(ci.quantity) AS qty
      FROM collection_items ci
      JOIN card_printings p     ON p.id  = ci.printing_id
      JOIN storage_locations sl ON sl.id = ci.location_id
     WHERE sl.is_archived = 0
       AND p.oracle_id IN (${oracleIds.map(() => '?').join(',')})
     GROUP BY p.oracle_id, sl.id
     ORDER BY qty DESC, sl.sort_order, sl.name COLLATE NOCASE`).all(...oracleIds) as Array<{
       oracle_id: string; id: number; name: string; qty: number;
     }>;
  for (const row of rows) {
    result.set(row.oracle_id, [
      ...(result.get(row.oracle_id) ?? []),
      { locationId: row.id, name: row.name, quantity: row.qty },
    ]);
  }
  return result;
}

const labelled = (category: string, source: CategorySource): SharedCategory => ({
  category,
  label: CATEGORY_LABELS[category] ?? category,
  source,
});

/** The reason line, from the components that actually fired. */
function reasonsFor(
  candidate: {
    sharedCategories: SharedCategory[]; primaryType: string | null; sameType: boolean;
    cmc: number; available: number;
    locations: Array<{ name: string; quantity: number }>;
  },
): string[] {
  const reasons: string[] = [];
  for (const shared of candidate.sharedCategories) {
    reasons.push(shared.source === 'heuristic' ? `${shared.label} (heuristic)` : shared.label);
  }
  if (candidate.sameType && candidate.primaryType) reasons.push(candidate.primaryType);
  reasons.push(`CMC ${Number.isInteger(candidate.cmc) ? candidate.cmc : candidate.cmc.toFixed(1)}`);
  const where = candidate.locations[0];
  reasons.push(where
    ? `${candidate.available} available in ${where.name}${candidate.locations.length > 1 ? ' +' : ''}`
    : `${candidate.available} available`);
  return reasons;
}

// -- the entry points -----------------------------------------------------------

export class SubstituteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SubstituteError';
    this.status = status;
  }
}

/**
 * Substitutes for a card, in a deck's context or in none.
 *
 * `deckId` null is the want-list case with nothing to say about colour or
 * format: every owned, free, non-basic card is a candidate and the ranking
 * does the rest.
 */
export function substitutesFor(
  db: Database.Database,
  oracleId: string,
  deckId: number | null,
  options: { limit?: number } = {},
): SubstitutesResult {
  const target = db.prepare(`
    SELECT ${CARD_COLUMNS} FROM oracle_cards o
      LEFT JOIN card_printings p ON p.id = o.default_printing_id
     WHERE o.oracle_id = ?`).get(oracleId) as CardRow | undefined;
  if (!target) throw new SubstituteError('No card with that id.', 404);

  let context = NO_CONTEXT;
  if (deckId !== null) {
    const found = deckContext(db, deckId);
    if (!found) throw new SubstituteError('No deck with that id.', 404);
    context = found;
  }

  // One source or the other, never both — see roleHeuristics.ts.
  const source: CategorySource = hasCardCategories(db) ? 'tagger' : 'heuristic';
  const pool = candidatePool(db, oracleId, context);
  const categories = categoriesFor(db, [target, ...pool], source);
  const locations = locationsFor(db, pool.map((row) => row.oracle_id));

  const targetCategories = categories.get(oracleId) ?? [];
  const targetSet = new Set(targetCategories);
  const targetType = primaryType(target.type_line);

  const scored = pool.map((row): SubstituteCandidate => {
    const shared = (categories.get(row.oracle_id) ?? [])
      .filter((category) => targetSet.has(category))
      .map((category) => labelled(category, source));
    const type = primaryType(row.type_line);
    const sameType = type !== null && type === targetType;
    const where = locations.get(row.oracle_id) ?? [];
    const score = scoreCandidate({
      sharedCategories: shared.length,
      sameType,
      cmcDelta: row.cmc - target.cmc,
      edhrecRank: row.edhrec_rank,
      available: row.available,
    });
    return {
      oracleId: row.oracle_id,
      name: row.name,
      printingId: row.printing_id,
      imageSmall: row.image_small,
      cmc: row.cmc,
      typeLine: row.type_line ?? '',
      manaCost: row.mana_cost,
      colorIdentity: row.color_identity ?? '',
      primaryType: type,
      sharedCategories: shared,
      available: row.available,
      locations: where,
      edhrecRank: row.edhrec_rank,
      score,
      reasons: reasonsFor({
        sharedCategories: shared, primaryType: type, sameType, cmc: row.cmc,
        available: row.available, locations: where,
      }),
    };
  });

  // The relevance floor. A card that survived the hard filters is owned, free
  // and legal — but "costs the same" is not a reason to play it, and a sheet
  // padded out with CMC-only matches is the five bad suggestions the phase doc
  // warns against. When the target has a role, a candidate must share one;
  // when it has none, it must at least be the same kind of card. "Nothing you
  // own fills this role" is a useful answer, so it is allowed to be the answer.
  const candidates = scored.filter((candidate) => targetCategories.length > 0
    ? candidate.sharedCategories.length > 0
    : candidate.primaryType !== null && candidate.primaryType === targetType);

  // Deterministic: score, then the most-played, then the name — never insertion
  // order, which is whatever the planner felt like.
  candidates.sort((a, b) =>
    b.score.total - a.score.total
    || (a.edhrecRank ?? Infinity) - (b.edhrecRank ?? Infinity)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const limit = options.limit ?? suggestionCount(db);

  return {
    target: {
      oracleId,
      name: target.name,
      cmc: target.cmc,
      typeLine: target.type_line ?? '',
      primaryType: targetType,
      categories: targetCategories.map((category) => labelled(category, source)),
    },
    context: {
      deckId: context.deckId,
      deckName: context.deckName,
      formatCode: context.formatCode,
      colorIdentity: context.colorMask === null ? null : colorsFromMask(context.colorMask).join(''),
    },
    // Null when the target has no role under the source in use: then no
    // candidate can share one, and the match really is type and cost only.
    categorySource: targetCategories.length > 0 ? source : null,
    candidates: candidates.slice(0, limit),
    poolSize: scored.length,
  };
}
