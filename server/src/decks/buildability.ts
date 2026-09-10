import type Database from 'better-sqlite3';
import {
  allocationFromParts, allocationSettings, collectionCtes, deckClaimsSql, reserves,
  type AllocationSettings, type DeckStatus,
} from './allocation.ts';

/**
 * Could I put this deck on the table tonight, and what would finishing it cost?
 *
 * Two different things get called allocation, and this module depends on the
 * difference:
 *
 * - **Declared allocation** — `deck_cards.quantity_from_collection`, what the
 *   user marked. It is what a deck *reserves*, so it drives contention and
 *   every other deck's availability.
 * - **Computed coverage** — what the collection could actually supply this deck
 *   right now, whether or not anyone marked it up.
 *
 * Buildability reads coverage, deliberately. A deck you imported and never got
 * round to ticking "from my collection" on is not 0% buildable; it is a deck
 * whose cards are sitting in your binder. Reporting it as unbuildable would
 * send you shopping for cards you already own, which is the exact failure this
 * phase exists to prevent.
 *
 * Nothing here re-derives availability. `allocationFromParts` is Phase 22's
 * subtraction; this module's only job is to decide which *reservation* figure
 * to hand it — the one that excludes the deck being measured, so a deck never
 * competes with itself.
 */

// -- shapes -------------------------------------------------------------------

export interface DeckBuildability {
  deckId: number;
  /**
   * Σ covered / Σ required, or null when there is nothing to count.
   *
   * Null rather than 1: an empty deck is not a finished one, and a deck list
   * sorted by "most buildable" that puts every empty shell at the top is
   * useless. The client reads null as "empty".
   */
  buildablePct: number | null;
  requiredCards: number;
  coveredCards: number;
  missingCards: number;
  costToCompleteUsd: number;
  /**
   * Distinct missing cards that have no price at all.
   *
   * Reported beside the total instead of being folded into it. Rounding an
   * unknown price to zero is how a deck that reads "$0 to finish" costs $80.
   */
  unpricedCount: number;
  /** Distinct missing cards another reserving deck is holding copies of. */
  contestedCount: number;
}

/** One card's story, for the deck's own missing-card list. */
export interface BuildabilityRow {
  oracleId: string;
  name: string;
  required: number;
  owned: number;
  /** Free for *this* deck — its own claim excluded, other decks' claims not. */
  available: number;
  tradeListed: number;
  proxied: number;
  covered: number;
  missing: number;
  unitPriceUsd: number | null;
  /** `missing × unitPrice`, or null when the card has no price. */
  extendedUsd: number | null;
  /** Another reserving deck holds copies and this deck is short. */
  contested: boolean;
  /** Who is holding the rest, and how many each. */
  holdingDecks: Array<{ deckId: number; deckName: string; status: DeckStatus; quantity: number }>;
}

export interface BuildabilityDetail {
  deckId: number;
  deckName: string;
  summary: DeckBuildability;
  rows: BuildabilityRow[];
}

/**
 * Statuses to pretend decks have, for Phase 26's "what if I tore that deck
 * down?" simulation. Every read of `decks.status` in this module goes through
 * `effectiveStatus`, so an override is honoured for the deck being measured and
 * for every deck competing with it alike.
 */
export type StatusOverrides = Map<number, DeckStatus>;

export const BUILDABILITY_SORTS = ['buildable_desc', 'cost_to_complete_asc', 'missing_asc'] as const;
export type BuildabilitySort = (typeof BUILDABILITY_SORTS)[number];

export function isBuildabilitySort(value: unknown): value is BuildabilitySort {
  return BUILDABILITY_SORTS.includes(value as BuildabilitySort);
}

// -- the inputs, gathered in one pass -----------------------------------------

interface DeckMeta {
  id: number;
  name: string;
  status: DeckStatus;
  /** Whether the format has a sideboard, so 'side' slots count toward the deck. */
  hasSideboard: boolean;
}

interface SlotRow {
  deck_id: number;
  oracle_id: string;
  board: string;
  quantity: number;
  quantity_proxied: number;
  preferred_printing_id: string | null;
  card_name: string;
  is_basic_land: number;
}

/**
 * A deck's requirement for one card, summed across the boards that count.
 *
 * Per oracle id rather than per slot: a card that appears in both the main deck
 * and the sideboard is one card competing for one pool of copies, and scoring
 * the two slots separately would let the same physical copy cover both.
 */
interface Requirement {
  oracleId: string;
  name: string;
  isBasic: boolean;
  required: number;
  proxied: number;
  preferredPrintingId: string | null;
}

const inChunks = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

/** Well under every SQLite build's bound-parameter ceiling. */
const CHUNK = 900;

/** Owned and trade-listed copies for the whole collection, keyed by oracle id. */
function collectionRollup(db: Database.Database): Map<string, { owned: number; listed: number }> {
  // No `IN (...)` filter: the rollups are collection-sized, not catalog-sized,
  // and reading them whole is cheaper than building a placeholder list of every
  // card in every deck. Driving off `alloc_owned` is complete because a trade
  // list entry points at a collection lot, so nothing can be listed unowned.
  const rows = db.prepare(`
    WITH ${collectionCtes()}
    SELECT alloc_owned.oracle_id AS oracle_id,
           alloc_owned.qty       AS owned,
           COALESCE(alloc_listed.qty, 0) AS listed
      FROM alloc_owned
      LEFT JOIN alloc_listed ON alloc_listed.oracle_id = alloc_owned.oracle_id`)
    .all() as Array<{ oracle_id: string; owned: number; listed: number }>;

  const map = new Map<string, { owned: number; listed: number }>();
  for (const row of rows) map.set(row.oracle_id, { owned: row.owned, listed: row.listed });
  return map;
}

/**
 * What one missing copy costs.
 *
 * The pinned printing first, because a slot pinned to a specific set is a
 * statement about which copy you intend to buy. Otherwise the cheapest
 * non-digital printing — you are shopping, and nobody buys the expensive
 * version of a card they need four of. Foil is the fallback rather than a
 * competitor: a card whose only printing is foil has a foil price and no other.
 *
 * A pinned printing that carries no price of its own falls through to the
 * oracle-level cheapest rather than reading as unpriced. The pin expresses art,
 * not budget, and "you pinned an unpriced promo, so this deck is free to
 * finish" is the same lie as rounding an unknown to zero.
 */
function priceLookup(
  db: Database.Database,
  oracleIds: string[],
  printingIds: string[],
): (oracleId: string, preferredPrintingId: string | null) => number | null {
  const cheapest = new Map<string, number>();
  for (const chunk of inChunks(oracleIds, CHUNK)) {
    const rows = db.prepare(`
      SELECT oracle_id,
             MIN(price_usd)      AS cheap_usd,
             MIN(price_usd_foil) AS cheap_foil
        FROM card_printings
       WHERE is_digital = 0
         AND oracle_id IN (${chunk.map(() => '?').join(',')})
       GROUP BY oracle_id`).all(...chunk) as Array<{
         oracle_id: string; cheap_usd: number | null; cheap_foil: number | null;
       }>;
    // MIN ignores NULLs, so `cheap_usd` is the cheapest *priced* printing and
    // is itself NULL only when no printing has a non-foil price at all.
    for (const row of rows) {
      const price = row.cheap_usd ?? row.cheap_foil;
      if (price != null) cheapest.set(row.oracle_id, price);
    }
  }

  const pinned = new Map<string, number>();
  for (const chunk of inChunks(printingIds, CHUNK)) {
    const rows = db.prepare(`
      SELECT id, price_usd, price_usd_foil FROM card_printings
       WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{
         id: string; price_usd: number | null; price_usd_foil: number | null;
       }>;
    for (const row of rows) {
      const price = row.price_usd ?? row.price_usd_foil;
      if (price != null) pinned.set(row.id, price);
    }
  }

  return (oracleId, preferredPrintingId) => {
    if (preferredPrintingId) {
      const pin = pinned.get(preferredPrintingId);
      if (pin != null) return pin;
    }
    return cheapest.get(oracleId) ?? null;
  };
}

// -- the computation ----------------------------------------------------------

interface Engine {
  settings: AllocationSettings;
  decks: Map<number, DeckMeta>;
  /** Every deck's claim on every card, before status is applied. */
  claims: Map<number, Map<string, number>>;
  /** Claims summed over the decks that reserve under the effective statuses. */
  reservedByAll: Map<string, number>;
  collection: Map<string, { owned: number; listed: number }>;
  requirements: Map<number, Requirement[]>;
  unitPrice: (oracleId: string, preferredPrintingId: string | null) => number | null;
  effectiveStatus: (deckId: number) => DeckStatus;
}

/**
 * Everything every deck's answer depends on, read in a fixed number of queries.
 *
 * Five statements regardless of how many decks are asked about — the deck list
 * calls this once for all of them. A per-deck loop issuing queries would be
 * correct and still fail this phase: the deck list is the deliverable, and a
 * screen that takes a second to paint does not get used.
 */
function gather(
  db: Database.Database,
  deckIds: number[] | undefined,
  statusOverrides: StatusOverrides | undefined,
): Engine {
  const settings = allocationSettings(db);

  // Every deck, not just the ones asked about: the decks competing for a card
  // are exactly the ones we were not asked about.
  const deckRows = db.prepare(`
    SELECT d.id, d.name, d.status, COALESCE(f.sideboard_size, 0) AS sideboard_size
      FROM decks d
      LEFT JOIN formats f ON f.code = d.format_code`).all() as Array<{
        id: number; name: string; status: DeckStatus; sideboard_size: number;
      }>;

  const decks = new Map<number, DeckMeta>();
  for (const row of deckRows) {
    decks.set(row.id, {
      id: row.id,
      name: row.name,
      status: row.status,
      hasSideboard: row.sideboard_size > 0,
    });
  }

  const effectiveStatus = (deckId: number): DeckStatus =>
    statusOverrides?.get(deckId) ?? decks.get(deckId)?.status ?? 'brew';

  const claimRows = db.prepare(deckClaimsSql()).all() as Array<{
    deck_id: number; oracle_id: string; qty: number;
  }>;

  const claims = new Map<number, Map<string, number>>();
  const reservedByAll = new Map<string, number>();
  for (const row of claimRows) {
    const forDeck = claims.get(row.deck_id) ?? new Map<string, number>();
    forDeck.set(row.oracle_id, row.qty);
    claims.set(row.deck_id, forDeck);
    // `deckClaimsSql` deliberately does not filter on status, so the status
    // test lives here — which is what lets an override be honoured.
    if (reserves(effectiveStatus(row.deck_id), settings)) {
      reservedByAll.set(row.oracle_id, (reservedByAll.get(row.oracle_id) ?? 0) + row.qty);
    }
  }

  const scoped = deckIds && deckIds.length > 0;
  const slotRows = db.prepare(`
    SELECT dc.deck_id, dc.oracle_id, dc.board, dc.quantity, dc.quantity_proxied,
           dc.preferred_printing_id, o.name AS card_name, o.is_basic_land
      FROM deck_cards dc
      JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
     WHERE dc.board IN ('main','side','command')
       ${scoped ? `AND dc.deck_id IN (${deckIds!.map(() => '?').join(',')})` : ''}`)
    .all(...(scoped ? deckIds! : [])) as SlotRow[];

  const requirements = new Map<number, Requirement[]>();
  const byDeckAndOracle = new Map<number, Map<string, Requirement>>();
  for (const row of slotRows) {
    const deck = decks.get(row.deck_id);
    if (!deck) continue;
    // A sideboard the format does not have is a scratchpad, not a requirement —
    // the same reasoning that keeps the maybeboard out entirely.
    if (row.board === 'side' && !deck.hasSideboard) continue;
    // Basics are outside allocation entirely under the exemption: not required,
    // not missing, not shopped for. 38 Islands are not 38 missing cards, and
    // counting them as covered would flatter every land-heavy deck's percentage.
    const isBasic = Boolean(row.is_basic_land);
    if (isBasic && settings.ignoreBasics) continue;

    const forDeck = byDeckAndOracle.get(row.deck_id) ?? new Map<string, Requirement>();
    const existing = forDeck.get(row.oracle_id);
    if (existing) {
      existing.required += row.quantity;
      existing.proxied += row.quantity_proxied;
      existing.preferredPrintingId ??= row.preferred_printing_id;
    } else {
      forDeck.set(row.oracle_id, {
        oracleId: row.oracle_id,
        name: row.card_name,
        isBasic,
        required: row.quantity,
        proxied: row.quantity_proxied,
        preferredPrintingId: row.preferred_printing_id,
      });
    }
    byDeckAndOracle.set(row.deck_id, forDeck);
  }
  for (const [deckId, forDeck] of byDeckAndOracle) {
    requirements.set(deckId, [...forDeck.values()]);
  }

  const oracleIds = [...new Set(slotRows.map((row) => row.oracle_id))];
  const printingIds = [...new Set(
    slotRows.map((row) => row.preferred_printing_id).filter((id): id is string => id !== null),
  )];

  return {
    settings,
    decks,
    claims,
    reservedByAll,
    collection: collectionRollup(db),
    requirements,
    unitPrice: priceLookup(db, oracleIds, printingIds),
    effectiveStatus,
  };
}

/** One deck's per-card rows, from inputs that were already gathered. */
function rowsFor(engine: Engine, deckId: number, withHolders: boolean): BuildabilityRow[] {
  const ownClaims = engine.claims.get(deckId) ?? new Map<string, number>();
  const deckReserves = reserves(engine.effectiveStatus(deckId), engine.settings);

  return (engine.requirements.get(deckId) ?? []).map((requirement) => {
    const { oracleId } = requirement;
    const holdings = engine.collection.get(oracleId) ?? { owned: 0, listed: 0 };

    // Reservation by *other* reserving decks. Subtracting this deck's own claim
    // from the total is what `excludeDeckId` does in allocation.ts, done here
    // because the excluded deck differs per row of the deck list — and the
    // deck's own claim only contributed to the total if it reserves at all.
    const ownClaim = deckReserves ? (ownClaims.get(oracleId) ?? 0) : 0;
    const reservedByOthers = Math.max(0, (engine.reservedByAll.get(oracleId) ?? 0) - ownClaim);

    // Phase 22's subtraction, unchanged and not restated — only the reservation
    // figure handed to it is this module's.
    const allocation = allocationFromParts(
      oracleId,
      requirement.isBasic,
      { owned: holdings.owned, reserved: reservedByOthers, tradeListed: holdings.listed },
      engine.settings,
    );

    const covered = Math.min(requirement.required, allocation.available + requirement.proxied);
    const missing = requirement.required - covered;
    const unitPriceUsd = engine.unitPrice(oracleId, requirement.preferredPrintingId);

    const holdingDecks = withHolders && missing > 0
      ? [...engine.claims]
        .filter(([otherId]) => otherId !== deckId
          && reserves(engine.effectiveStatus(otherId), engine.settings))
        .flatMap(([otherId, forDeck]) => {
          const quantity = forDeck.get(oracleId) ?? 0;
          const meta = engine.decks.get(otherId);
          if (quantity <= 0 || !meta) return [];
          return [{
            deckId: otherId,
            deckName: meta.name,
            status: engine.effectiveStatus(otherId),
            quantity,
          }];
        })
        .sort((a, b) => b.quantity - a.quantity
          || a.deckName.localeCompare(b.deckName, undefined, { sensitivity: 'base' }))
      : [];

    return {
      oracleId,
      name: requirement.name,
      required: requirement.required,
      owned: allocation.owned,
      available: allocation.available,
      tradeListed: allocation.tradeListed,
      proxied: requirement.proxied,
      covered,
      missing,
      unitPriceUsd,
      extendedUsd: unitPriceUsd == null ? null : round2(missing * unitPriceUsd),
      contested: reservedByOthers > 0 && missing > 0,
      holdingDecks,
    };
  });
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function summarise(deckId: number, rows: BuildabilityRow[]): DeckBuildability {
  let requiredCards = 0;
  let coveredCards = 0;
  let missingCards = 0;
  let cost = 0;
  let unpricedCount = 0;
  let contestedCount = 0;

  for (const row of rows) {
    requiredCards += row.required;
    coveredCards += row.covered;
    missingCards += row.missing;
    if (row.missing > 0) {
      if (row.unitPriceUsd == null) unpricedCount += 1;
      else cost += row.missing * row.unitPriceUsd;
      if (row.contested) contestedCount += 1;
    }
  }

  return {
    deckId,
    buildablePct: requiredCards === 0
      ? null
      : Math.round((coveredCards / requiredCards) * 10_000) / 10_000,
    requiredCards,
    coveredCards,
    missingCards,
    costToCompleteUsd: round2(cost),
    unpricedCount,
    contestedCount,
  };
}

/**
 * Buildability for many decks in one pass.
 *
 * `deckIds` omitted means every deck. `statusOverrides` answers the question
 * "what would these numbers be if that deck were a brew?" without writing
 * anything — Phase 26's teardown simulation — and is honoured for the deck
 * being measured as well as for every deck competing with it.
 */
export function buildabilityForDecks(
  db: Database.Database,
  deckIds?: number[],
  statusOverrides?: StatusOverrides,
): Map<number, DeckBuildability> {
  const engine = gather(db, deckIds, statusOverrides);
  const wanted = deckIds && deckIds.length > 0 ? deckIds : [...engine.decks.keys()];

  const result = new Map<number, DeckBuildability>();
  for (const deckId of wanted) {
    if (!engine.decks.has(deckId)) continue;
    // A deck with no countable cards still gets an answer — an empty summary,
    // which reads as "empty" rather than as a missing key the client has to
    // guard on every row.
    result.set(deckId, summarise(deckId, rowsFor(engine, deckId, false)));
  }
  return result;
}

/** One deck's per-card breakdown, with who else is holding what. */
export function buildabilityDetail(
  db: Database.Database,
  deckId: number,
  statusOverrides?: StatusOverrides,
): BuildabilityDetail | null {
  const engine = gather(db, [deckId], statusOverrides);
  const meta = engine.decks.get(deckId);
  if (!meta) return null;

  const rows = rowsFor(engine, deckId, true).sort((a, b) =>
    b.missing - a.missing
    || (b.extendedUsd ?? 0) - (a.extendedUsd ?? 0)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    deckId,
    deckName: meta.name,
    summary: summarise(deckId, rows),
    rows,
  };
}

/** The missing set, in the shape the want-list push takes. */
export function missingForWantList(
  db: Database.Database,
  deckId: number,
): Array<{ oracleId: string; needed: number }> {
  const detail = buildabilityDetail(db, deckId);
  if (!detail) return [];
  // Basics are already absent (the exemption drops them before they become a
  // requirement) and proxied copies are already counted as covered, so a card
  // you decided to proxy never reaches the list.
  return detail.rows
    .filter((row) => row.missing > 0)
    .map((row) => ({ oracleId: row.oracleId, needed: row.missing }));
}

/**
 * The deck-list orderings, resolved server-side so every client sorts alike.
 *
 * Decks with nothing to count sort last in every order rather than winning
 * "most buildable" on a technicality.
 */
export function compareBuildability(
  sort: BuildabilitySort,
  a: DeckBuildability | undefined,
  b: DeckBuildability | undefined,
): number {
  const empty = (value: DeckBuildability | undefined) => !value || value.buildablePct === null;
  if (empty(a) && empty(b)) return 0;
  if (empty(a)) return 1;
  if (empty(b)) return -1;

  switch (sort) {
    case 'buildable_desc':
      return b!.buildablePct! - a!.buildablePct!;
    case 'cost_to_complete_asc':
      return a!.costToCompleteUsd - b!.costToCompleteUsd;
    case 'missing_asc':
      return a!.missingCards - b!.missingCards;
  }
}
