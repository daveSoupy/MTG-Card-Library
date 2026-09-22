import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.ts';

/**
 * How many copies of a card a deck can actually have.
 *
 * This module is the single source of truth for owned / reserved / trade-listed
 * / available. Phase 22 replaced `available = owned - allocated` with a rule
 * that no longer fits in a view — it depends on each deck's status and on three
 * settings — so the two availability views were deleted rather than left in
 * schema.sql telling a second, slightly different story. Every caller (deck
 * rows, shopping lists, want lists, trade-list conflicts, trade completion, the
 * collection card detail) reads this file. Nothing re-derives the subtraction.
 *
 * Phases 23-27 are built on that holding: if one of them needs a variant, it
 * passes options into these functions rather than writing its own arithmetic.
 */

/** Mirrors `decks.status` in schema.sql. */
export const DECK_STATUSES = ['brew', 'building', 'assembled', 'disassembled'] as const;
export type DeckStatus = (typeof DECK_STATUSES)[number];

/**
 * The statuses that lay claim to physical copies.
 *
 * A brew is an idea — a card list with no claim on cardboard — and a
 * disassembled deck gave its cards back but kept its list. The two in the
 * middle are the ones holding real cards.
 */
export const RESERVING_STATUSES = ['building', 'assembled'] as const;

/** Boards whose slots claim copies. A maybeboard never does. */
export const RESERVING_BOARDS = ['main', 'side', 'command'] as const;

export const ALLOCATION_IGNORES_BASICS = 'allocation_ignores_basics';
export const BREWS_RESERVE_COPIES = 'brews_reserve_copies';
export const TRADELIST_REDUCES_AVAILABLE = 'tradelist_reduces_available';

export interface AllocationSettings {
  /** Basic lands are outside allocation entirely: never reserved, never short. */
  ignoreBasics: boolean;
  /** The escape hatch: put brews back into the reserving set. */
  brewsReserve: boolean;
  /** A copy promised to someone else is not a copy you can build with. */
  tradeListReduces: boolean;
}

export const ALLOCATION_DEFAULTS: AllocationSettings = {
  ignoreBasics: true,
  brewsReserve: false,
  tradeListReduces: true,
};

export function allocationSettings(db: Database.Database): AllocationSettings {
  const flag = (key: string, fallback: boolean): boolean => {
    const stored = getSetting(db, key);
    return stored === null ? fallback : stored === '1';
  };
  return {
    ignoreBasics: flag(ALLOCATION_IGNORES_BASICS, ALLOCATION_DEFAULTS.ignoreBasics),
    brewsReserve: flag(BREWS_RESERVE_COPIES, ALLOCATION_DEFAULTS.brewsReserve),
    tradeListReduces: flag(TRADELIST_REDUCES_AVAILABLE, ALLOCATION_DEFAULTS.tradeListReduces),
  };
}

/** The reserving set for the current settings — `RESERVING_STATUSES` plus brews
 *  when the escape hatch is on. */
export function reservingStatuses(settings: AllocationSettings): DeckStatus[] {
  return settings.brewsReserve ? [...RESERVING_STATUSES, 'brew'] : [...RESERVING_STATUSES];
}

export function reserves(status: DeckStatus, settings: AllocationSettings): boolean {
  return reservingStatuses(settings).includes(status);
}

export interface CardAllocation {
  oracleId: string;
  /**
   * False for a basic land while `allocation_ignores_basics` is on. Such a card
   * has no reservation, no shortfall, and never reaches a want list; `owned` is
   * still filled in because it is true and occasionally useful, but the UI
   * renders no owned/missing badge for it — a blank badge beats a wrong one.
   */
  tracked: boolean;
  /** Copies on the shelf. Archived storage locations do not count. */
  owned: number;
  /** Copies claimed by decks in a reserving status. */
  reserved: number;
  /** Copies offered on a trade list — reported whether or not they subtract. */
  tradeListed: number;
  /** `owned - reserved - tradeListed`, floored at 0. Never negative. */
  available: number;
  /** Decks collectively claim more copies than exist. Flagged, never blocked. */
  isOverAllocated: boolean;
}

export interface AllocationOptions {
  /** Exclude this deck's own claim, so a deck never competes with itself. */
  excludeDeckId?: number;
  /** Read once and reused when a caller is resolving many cards. */
  settings?: AllocationSettings;
}

/**
 * The one subtraction.
 *
 * Floored at 0 rather than allowed to go negative: "you own 1, a deck has it,
 * and it is on a trade list" is 0 copies free, not -1. Over-allocation is
 * reported separately so the flag survives the floor.
 */
export function allocationFromParts(
  oracleId: string,
  isBasic: boolean,
  parts: { owned: number; reserved: number; tradeListed: number },
  settings: AllocationSettings,
): CardAllocation {
  const tracked = !(isBasic && settings.ignoreBasics);
  const reserved = tracked ? parts.reserved : 0;
  const subtracted = settings.tradeListReduces && tracked ? parts.tradeListed : 0;
  return {
    oracleId,
    tracked,
    owned: parts.owned,
    reserved,
    tradeListed: parts.tradeListed,
    available: Math.max(0, parts.owned - reserved - subtracted),
    isOverAllocated: tracked && reserved > parts.owned,
  };
}

// -- the SQL each number is built from ----------------------------------------
//
// Written once here and spliced into one query below. Callers never re-author
// these; if a later phase needs a different slice it adds an option, not a
// second copy.

/**
 * Copies owned, from non-archived storage locations only. An archived location
 * holds cards you no longer consider on the shelf — the same rule Phase 25 uses
 * when it picks real lots to pull from, and the two have to agree.
 */
const OWNED_BY_ORACLE_SQL = `
    SELECT p.oracle_id AS oracle_id, SUM(ci.quantity) AS qty
      FROM collection_items ci
      JOIN card_printings p     ON p.id  = ci.printing_id
      JOIN storage_locations sl ON sl.id = ci.location_id
     WHERE sl.is_archived = 0
     GROUP BY p.oracle_id`;

/** Copies offered on a trade list, over the same lots `owned` counts. */
const TRADE_LISTED_BY_ORACLE_SQL = `
    SELECT p.oracle_id AS oracle_id, SUM(tli.quantity) AS qty
      FROM trade_list_items tli
      JOIN collection_items ci  ON ci.id = tli.collection_item_id
      JOIN card_printings p     ON p.id  = ci.printing_id
      JOIN storage_locations sl ON sl.id = ci.location_id
     WHERE sl.is_archived = 0
     GROUP BY p.oracle_id`;

function reservedByOracleSql(settings: AllocationSettings, excludeDeckId?: number): string {
  const statuses = reservingStatuses(settings).map((status) => `'${status}'`).join(',');
  const boards = RESERVING_BOARDS.map((board) => `'${board}'`).join(',');
  // Spliced rather than bound: these fragments are composed into a larger query
  // whose remaining placeholders would otherwise have to be counted by hand.
  // Safe because the value is proven to be an integer first — everything else
  // in the fragment is a constant from this file.
  if (excludeDeckId !== undefined && !Number.isInteger(excludeDeckId)) {
    throw new TypeError(`excludeDeckId must be an integer, got ${excludeDeckId}`);
  }
  const exclude = excludeDeckId === undefined ? '' : `AND dc.deck_id <> ${excludeDeckId}`;
  return `
    SELECT dc.oracle_id AS oracle_id, SUM(dc.quantity_from_collection) AS qty
      FROM deck_cards dc
      JOIN decks d ON d.id = dc.deck_id
     WHERE dc.board IN (${boards})
       AND dc.quantity_from_collection > 0
       AND d.status IN (${statuses})
       ${exclude}
     GROUP BY dc.oracle_id`;
}

/**
 * The three rollups above, named, as the body of a `WITH` clause.
 *
 * Exported for the one caller that cannot use `allocationForMany` — Phase 23's
 * owned-aware search, which has to compute allocation across a whole result set
 * inside a single query rather than for a known list of cards. It composes
 * these fragments and the expressions from `allocationSqlRefs` below, so the
 * rule still lives here and nothing is written a second time.
 *
 * `MATERIALIZED` where the caller asks for it: over an unconstrained query the
 * planner will otherwise re-run each rollup per candidate row, which is the
 * shape the repo already has one five-second regression on record for. The
 * three tables are small, so evaluating each once and probing it is strictly
 * the cheaper plan.
 */
export function allocationCtes(
  settings: AllocationSettings,
  options: { excludeDeckId?: number; materialized?: boolean } = {},
): string {
  const as = options.materialized ? 'AS MATERIALIZED' : 'AS';
  return `${collectionCtes(options)},
       ${RESERVED_CTE} ${as} (${reservedByOracleSql(settings, options.excludeDeckId)})`;
}

/**
 * The two collection-side rollups on their own — owned and trade-listed, with
 * no deck-side reservation.
 *
 * For the caller that has to compute reservation itself: Phase 24's
 * buildability runs every deck in one pass, and each deck needs reservation
 * *by the other decks*, which is a different number per deck and can be asked
 * of a hypothetical set of statuses. It pairs these with `deckClaimsSql()` and
 * folds the result through `allocationFromParts`, so the subtraction is still
 * this file's.
 */
export function collectionCtes(options: { materialized?: boolean } = {}): string {
  const as = options.materialized ? 'AS MATERIALIZED' : 'AS';
  return `${OWNED_CTE} ${as} (${OWNED_BY_ORACLE_SQL}),
       ${LISTED_CTE} ${as} (${TRADE_LISTED_BY_ORACLE_SQL})`;
}

/**
 * Every deck's claim on every card, at (deck, oracle) grain and **before
 * status is applied**.
 *
 * `reservedByOracleSql` above is the same rollup with the reserving-status
 * filter already folded in, and it stays the one to use when you just want
 * "what is reserved" — it is the shape the deck-row and search paths are tuned
 * for. This variant exists because Phase 24 has to vary the status test per
 * caller rather than per query: it answers each deck's coverage while excluding
 * that deck, and Phase 26 asks the same question against statuses no deck
 * actually has yet. A caller of this function owes the reader an explicit
 * status test — `reserves()` — over every row it keeps.
 *
 * Takes no parameters; filter the result by deck in the caller.
 */
export function deckClaimsSql(): string {
  const boards = RESERVING_BOARDS.map((board) => `'${board}'`).join(',');
  return `
    SELECT dc.deck_id AS deck_id, dc.oracle_id AS oracle_id,
           SUM(dc.quantity_from_collection) AS qty
      FROM deck_cards dc
     WHERE dc.board IN (${boards})
       AND dc.quantity_from_collection > 0
     GROUP BY dc.deck_id, dc.oracle_id`;
}

/** The names `allocationCtes` and `collectionCtes` bind, for composing callers. */
export const OWNED_CTE = 'alloc_owned';
export const RESERVED_CTE = 'alloc_reserved';
export const LISTED_CTE = 'alloc_listed';

/**
 * A semi-join against the owned rollup, for a query that filters on a *lower
 * bound* of owned or available.
 *
 * Purely a planner hint, and only sound as one. `COALESCE(alloc_owned.qty,0)
 * >= 1` is a condition on a left-joined column, so SQLite scans all 117k oracle
 * rows and probes the rollup for each — 94ms to find ten cards. Written as
 * `oracle_id IN (SELECT ... WHERE qty >= 1)` it drives from the collection
 * instead and the same answer takes 0.2ms.
 *
 * The caller adds this *alongside* the real expression, never instead of it,
 * and only where it is implied by that expression — so it narrows nothing and
 * stays correct under negation, where `NOT (implied AND expr)` is still
 * `NOT expr`. Availability qualifies because it can never exceed owned.
 *
 * Takes one bound parameter: the quantity.
 */
export function ownedSemiJoinSql(qtyOperator: string, oracleColumn = 'o.oracle_id'): string {
  return `${oracleColumn} IN (SELECT oracle_id FROM ${OWNED_CTE} WHERE qty ${qtyOperator} ?)`;
}

/** SQL expressions over the CTEs `allocationCtes` defines, one per number. */
export interface AllocationSqlRefs {
  owned: string;
  /** Effective reservation — 0 for an exempt basic, exactly as `allocationFromParts` does. */
  reserved: string;
  /** Raw, reported whether or not it subtracts — again matching `allocationFromParts`. */
  tradeListed: string;
  available: string;
  /** 1 when the card is inside allocation at all, 0 for an exempt basic land. */
  tracked: string;
}

/**
 * The one subtraction again, this time as SQL.
 *
 * A second expression of the same rule is a liability, so it is written once,
 * here, next to `allocationFromParts()` — and `allocation.test.ts` runs both over the same
 * fixtures and asserts they agree. If the rule changes, both change together or
 * the test fails.
 */
export function allocationSqlRefs(
  settings: AllocationSettings,
  isBasicColumn = 'o.is_basic_land',
): AllocationSqlRefs {
  const owned = `COALESCE(${OWNED_CTE}.qty, 0)`;
  const rawReserved = `COALESCE(${RESERVED_CTE}.qty, 0)`;
  const rawListed = `COALESCE(${LISTED_CTE}.qty, 0)`;

  const tracked = settings.ignoreBasics ? `(COALESCE(${isBasicColumn}, 0) = 0)` : '1';
  const whenTracked = (value: string) =>
    settings.ignoreBasics ? `(CASE WHEN ${tracked} THEN ${value} ELSE 0 END)` : value;

  const reserved = whenTracked(rawReserved);
  const subtracted = settings.tradeListReduces ? whenTracked(rawListed) : '0';

  return {
    owned,
    reserved,
    tradeListed: rawListed,
    // Floored at 0 for the same reason `allocationFromParts` floors it: "you own 1, a deck
    // has it, and it is on a trade list" is 0 copies free, not -1.
    available: `MAX(0, ${owned} - ${reserved} - ${subtracted})`,
    tracked,
  };
}

/** Allocation for a set of cards in one query. The bulk form every caller with
 *  more than one card should use. */
export function allocationForMany(
  db: Database.Database,
  oracleIds: Iterable<string>,
  options: AllocationOptions = {},
): Map<string, CardAllocation> {
  const ids = [...new Set(oracleIds)];
  const result = new Map<string, CardAllocation>();
  if (ids.length === 0) return result;

  const settings = options.settings ?? allocationSettings(db);
  const placeholders = ids.map(() => '?').join(',');

  const rows = db.prepare(`
    WITH ${allocationCtes(settings, { excludeDeckId: options.excludeDeckId })}
    SELECT o.oracle_id,
           o.is_basic_land,
           COALESCE(alloc_owned.qty, 0)    AS owned,
           COALESCE(alloc_reserved.qty, 0) AS reserved,
           COALESCE(alloc_listed.qty, 0)   AS listed
      FROM oracle_cards o
      LEFT JOIN alloc_owned    ON alloc_owned.oracle_id    = o.oracle_id
      LEFT JOIN alloc_reserved ON alloc_reserved.oracle_id = o.oracle_id
      LEFT JOIN alloc_listed   ON alloc_listed.oracle_id   = o.oracle_id
     WHERE o.oracle_id IN (${placeholders})`).all(...ids) as Array<{
       oracle_id: string; is_basic_land: number;
       owned: number; reserved: number; listed: number;
     }>;

  for (const row of rows) {
    result.set(row.oracle_id, allocationFromParts(
      row.oracle_id,
      Boolean(row.is_basic_land),
      { owned: row.owned, reserved: row.reserved, tradeListed: row.listed },
      settings,
    ));
  }

  // A card the database has never heard of still deserves an answer rather than
  // a missing key — callers otherwise have to guard every lookup.
  for (const id of ids) {
    if (!result.has(id)) {
      result.set(id, allocationFromParts(id, false, { owned: 0, reserved: 0, tradeListed: 0 }, settings));
    }
  }
  return result;
}

export function allocationFor(
  db: Database.Database,
  oracleId: string,
  options: AllocationOptions = {},
): CardAllocation {
  return allocationForMany(db, [oracleId], options).get(oracleId)!;
}

export function availableFor(
  db: Database.Database,
  oracleId: string,
  options: AllocationOptions = {},
): number {
  return allocationFor(db, oracleId, options).available;
}

// -- slot arithmetic ----------------------------------------------------------

/** The shape of a deck slot these helpers read. */
export interface AllocatedSlot {
  quantity: number;
  quantityFromCollection: number;
  quantityProxied: number;
  /** False for an exempt basic land; such a slot is never short of anything. */
  allocationTracked: boolean;
}

/**
 * Copies of a slot that still have to be bought.
 *
 * A proxy fills a slot without being owned and without being on a shopping
 * list, so it subtracts here exactly as a collection copy does. An exempt basic
 * land needs nothing bought at all — 38 Islands are not 38 missing cards.
 */
export function copiesToBuy(slot: AllocatedSlot): number {
  if (!slot.allocationTracked) return 0;
  return Math.max(0, slot.quantity - slot.quantityFromCollection - slot.quantityProxied);
}

/** A slot claiming or proxying more copies than it holds. */
export class SlotOverfilledError extends Error {
  readonly quantity: number;
  readonly fromCollection: number;
  readonly proxied: number;

  constructor(quantity: number, fromCollection: number, proxied: number) {
    super(
      `A slot of ${quantity} cannot be ${fromCollection} from your collection plus ` +
      `${proxied} proxied — that is ${fromCollection + proxied} copies of ${quantity}.`,
    );
    this.name = 'SlotOverfilledError';
    this.quantity = quantity;
    this.fromCollection = fromCollection;
    this.proxied = proxied;
  }
}

/** Throws rather than clamping: silently discarding half of what was asked for
 *  is how a UI ends up showing a number the user never chose. */
export function assertSlotFits(quantity: number, fromCollection: number, proxied: number): void {
  if (fromCollection < 0 || proxied < 0 || fromCollection + proxied > quantity) {
    throw new SlotOverfilledError(quantity, fromCollection, proxied);
  }
}
