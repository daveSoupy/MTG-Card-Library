import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.ts';
import { reconcileDeckClaims } from './reconcile.ts';
import { buildabilityDetail, type BuildabilityRow } from './buildability.ts';

/**
 * The physical half of the app: which binder to open, in what order, and
 * putting the cards back afterwards.
 *
 * Allocation is stored as a per-slot count and never as a link to a lot — the
 * choice that makes "deleting a deck releases its allocation" a cascade with no
 * way to leak (CLAUDE.md, Section 4). The price of it is that the app can say
 * you own two Sol Rings and cannot say which binder they are in, which leaves
 * you standing at a shelf with a decklist on a phone doing the work by hand.
 *
 * This module buys that back without touching the model: allocations are
 * resolved to specific lots **at assembly time**, as a run, and the result is
 * recorded on `deck_assembly_runs` / `deck_assembly_items`. Between runs the
 * steady-state schema is exactly as it was.
 *
 * Two rules hold this together and both have tests:
 *
 * - **Nothing here re-derives availability.** How many copies a deck may claim
 *   comes from `buildability.ts`, which got it from `allocation.ts`. This file
 *   only decides *which* lots those copies are, and in what order to fetch them.
 * - **A move is location-only.** Relocating a lot into the deck's home location
 *   changes where a card *is*; `quantity_from_collection` is what is *claimed*.
 *   Letting a move also count as a reservation would double-count and push
 *   `available` below zero, which is the bug this design invites.
 */

/**
 * Off, a run is a checklist and touches no data. On, completing it physically
 * relocates lots to the deck's home location.
 *
 * Default off because the safe version is useful on its own and the destructive
 * version should be a decision.
 */
export const ASSEMBLY_MOVES_LOTS = 'assembly_moves_lots';
export const ASSEMBLY_MOVES_LOTS_DEFAULT = false;

export function assemblyMovesLots(db: Database.Database): boolean {
  const stored = getSetting(db, ASSEMBLY_MOVES_LOTS);
  return stored === null ? ASSEMBLY_MOVES_LOTS_DEFAULT : stored === '1';
}

// -- shapes -------------------------------------------------------------------

export type RunKind = 'assemble' | 'disassemble';
export type RunStatus = 'open' | 'completed' | 'cancelled';

export interface RunSummary {
  id: number;
  deckId: number;
  kind: RunKind;
  status: RunStatus;
  movesLots: boolean;
  sourceRunId: number | null;
  startedAt: string;
  completedAt: string | null;
  notes: string | null;
  /** Lines, and copies, on the sheet — history reads without loading items. */
  lineCount: number;
  cardCount: number;
  pickedCount: number;
  /**
   * Copies the sheet sent you for that were not where it said — the lines still
   * un-ticked when an assemble run was completed. Only ever non-empty on a
   * completed assemble: while a run is open an un-ticked line is merely one you
   * have not reached yet.
   *
   * This is the durable record of a shortfall. The deck's claim cannot hold it,
   * being recomputed from the collection on every edit, so the run does.
   */
  notFoundCount: number;
  notFound: Array<{ oracleId: string; name: string; quantity: number }>;
}

/** One line of the sheet: some copies of one printing, out of one lot. */
export interface SheetLine {
  id: number;
  oracleId: string;
  name: string;
  printingId: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  finish: string | null;
  condition: string | null;
  language: string | null;
  quantity: number;
  picked: boolean;
  unavailable: boolean;
  notes: string | null;
  collectionItemId: number | null;
  fromLocationId: number | null;
  fromLocationName: string | null;
  toLocationId: number | null;
  toLocationName: string | null;
  /** Copies of this lot currently offered on a trade list; 0 when none. */
  tradeListed: number;
  /** Only on "Not available" lines, and always today's price. */
  unitPriceUsd: number | null;
  extendedUsd: number | null;
}

/** The sheet, grouped the way a shelf is actually organised. */
export interface SheetGroup {
  locationId: number | null;
  locationName: string;
  lines: SheetLine[];
  cardCount: number;
  pickedCount: number;
}

export interface AssemblySheet {
  run: RunSummary;
  deck: {
    id: number;
    name: string;
    status: string;
    homeLocationId: number | null;
    homeLocationName: string | null;
  };
  groups: SheetGroup[];
  /** Cards the collection could not supply — the sheet's buy list. */
  unavailable: SheetLine[];
  summary: {
    cardsToPull: number;
    pickedCards: number;
    lineCount: number;
    pickedLines: number;
    unavailableCards: number;
    unavailableCostUsd: number;
    unpricedCount: number;
    tradeListedLines: number;
    proxiedCards: number;
  };
  /** Whether completing this run will relocate lots. Decided when it opened. */
  movesLots: boolean;
  /**
   * Why it will not, when the setting says it should — today only ever "this
   * deck has no home location". Said out loud rather than silently downgraded.
   */
  movesLotsBlocked: string | null;
}

export interface TradeListAdjustment {
  listName: string;
  cardName: string;
  quantity: number;
  removed: boolean;
}

export interface CompletionSummary {
  runId: number;
  kind: RunKind;
  deckId: number;
  deckStatus: string;
  pulledCards: number;
  notFoundCards: number;
  proxiedCards: number;
  stillMissingCards: number;
  stillMissingCostUsd: number;
  unpricedCount: number;
  movedLots: boolean;
  copiesMoved: number;
  tradeListAdjustments: TradeListAdjustment[];
  /** Anything that did not go to plan, in words, for the summary screen. */
  problems: string[];
}

export class AssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssemblyError';
  }
}

// -- lot identity -------------------------------------------------------------

/**
 * Every column of a lot except its id, location and quantity.
 *
 * This is the app-level merge rule from the `collection_items` comment, written
 * out in full rather than trusted to a list of columns someone might shorten
 * later: two lots merge only when *everything* about them matches, because a
 * merge that ignores a column silently destroys that column's value for the
 * copies being merged in. A lot bought for $18 and one bought for nothing are
 * two lots, and so are a signed copy and a plain one.
 */
export interface LotIdentity {
  printingId: string;
  finish: string;
  condition: string;
  language: string;
  priceOverride: number | null;
  isSigned: number;
  isAltered: number;
  notes: string | null;
  acquiredAt: string | null;
  acquiredUnitCost: number | null;
  acquisitionKind: string;
  acquiredFrom: string | null;
  acquiredTradeId: number | null;
  importBatchId: number | null;
}

/** The columns `LotIdentity` reads, for any `SELECT` that builds one. */
const LOT_IDENTITY_COLUMNS = `ci.printing_id, ci.finish, ci.condition, ci.language,
       ci.price_override, ci.is_signed, ci.is_altered, ci.notes,
       ci.acquired_at, ci.acquired_unit_cost, ci.acquisition_kind, ci.acquired_from,
       ci.acquired_trade_id, ci.import_batch_id`;

function identityOf(row: any): LotIdentity {
  return {
    printingId: row.printing_id,
    finish: row.finish,
    condition: row.condition,
    language: row.language,
    priceOverride: row.price_override ?? null,
    isSigned: row.is_signed ?? 0,
    isAltered: row.is_altered ?? 0,
    notes: row.notes ?? null,
    acquiredAt: row.acquired_at ?? null,
    acquiredUnitCost: row.acquired_unit_cost ?? null,
    acquisitionKind: row.acquisition_kind ?? 'unknown',
    acquiredFrom: row.acquired_from ?? null,
    acquiredTradeId: row.acquired_trade_id ?? null,
    importBatchId: row.import_batch_id ?? null,
  };
}

/**
 * The identity as one comparable string, stored on the item as
 * `snapshot_lot_key`.
 *
 * A string rather than a column-by-column `WHERE` because the forward move and
 * the return move have to agree exactly, and two hand-written predicates over
 * fourteen nullable columns are two chances to disagree. Both directions call
 * this, so the return move is the inverse of the forward move by construction
 * rather than by review.
 */
export function lotKey(identity: LotIdentity): string {
  return JSON.stringify([
    identity.printingId, identity.finish, identity.condition, identity.language,
    identity.priceOverride, identity.isSigned, identity.isAltered, identity.notes,
    identity.acquiredAt, identity.acquiredUnitCost, identity.acquisitionKind,
    identity.acquiredFrom, identity.acquiredTradeId, identity.importBatchId,
  ]);
}

/** The lot at `locationId` that a move should merge into, or null for a new one. */
function findLot(
  db: Database.Database,
  locationId: number,
  identity: LotIdentity,
): { id: number; quantity: number } | null {
  // Narrowed in SQL to the one printing at the one location — a handful of rows
  // at most — then matched on the key in TypeScript, where "the same lot" is
  // defined exactly once.
  const rows = db.prepare(`
    SELECT ci.id, ci.quantity, ${LOT_IDENTITY_COLUMNS}
      FROM collection_items ci
     WHERE ci.location_id = ? AND ci.printing_id = ?
     ORDER BY ci.id`).all(locationId, identity.printingId) as any[];

  const wanted = lotKey(identity);
  const match = rows.find((row) => lotKey(identityOf(row)) === wanted);
  return match ? { id: match.id, quantity: match.quantity } : null;
}

// -- the resolver -------------------------------------------------------------

interface CandidateLot {
  id: number;
  oracleId: string;
  quantity: number;
  locationId: number;
  locationName: string;
  locationSort: number;
  setCode: string;
  collectorNumber: string;
  tradeListed: number;
  /** `price_override ?? price_usd` for this lot's finish; null when unpriced. */
  effectivePrice: number | null;
  identity: LotIdentity;
}

/** nonfoil before foil/etched, per the resolver's preference order. */
const FINISH_RANK: Record<string, number> = { nonfoil: 0, foil: 1, etched: 2 };

/**
 * Poorer condition first — the collectible copy stays in the binder and the
 * beater goes in the deck — with two exceptions at the ends. `DMG` is last
 * because a damaged card is one you may not be able to sleeve up, and `unknown`
 * sits just before it because an unexamined copy is a worse thing to hand
 * someone than a known-played one.
 */
const CONDITION_RANK: Record<string, number> = {
  HP: 0, MP: 1, LP: 2, NM: 3, M: 4, unknown: 5, DMG: 6,
};

const rank = (table: Record<string, number>, value: string): number =>
  table[value] ?? Object.keys(table).length;

/**
 * Which lots to pull from, in the order a person would want to be told.
 *
 * Deterministic and explainable, because the user has to trust it while holding
 * a binder — and because two runs over an unchanged collection have to produce
 * identical sheets, which the `id` tie-break at the end guarantees.
 */
function comparePreference(
  a: CandidateLot,
  b: CandidateLot,
  context: { preferredPrintingId: string | null; homeLocationId: number | null },
): number {
  // 1. Don't pull a card you have offered to someone else. Only reached at all
  //    when nothing untouched covers the slot, and flagged when it is.
  const listed = Number(a.tradeListed > 0) - Number(b.tradeListed > 0);
  if (listed !== 0) return listed;

  // 2. The printing the slot is pinned to, if any.
  if (context.preferredPrintingId) {
    const pinned = Number(b.identity.printingId === context.preferredPrintingId)
      - Number(a.identity.printingId === context.preferredPrintingId);
    if (pinned !== 0) return pinned;
  }

  // 3. Already in the deck's box — it may not need moving at all.
  if (context.homeLocationId !== null) {
    const home = Number(b.locationId === context.homeLocationId)
      - Number(a.locationId === context.homeLocationId);
    if (home !== 0) return home;
  }

  // 4. Cheapest acceptable copy. An unpriced lot sorts last rather than first:
  //    treating an unknown price as zero is the same lie as a deck that reads
  //    "$0 to finish" and costs $80.
  const priceA = a.effectivePrice ?? Number.POSITIVE_INFINITY;
  const priceB = b.effectivePrice ?? Number.POSITIVE_INFINITY;
  if (priceA !== priceB) return priceA - priceB;

  const finish = rank(FINISH_RANK, a.identity.finish) - rank(FINISH_RANK, b.identity.finish);
  if (finish !== 0) return finish;

  // 5. Poorer condition first among equals.
  const condition = rank(CONDITION_RANK, a.identity.condition)
    - rank(CONDITION_RANK, b.identity.condition);
  if (condition !== 0) return condition;

  // 6. So the same collection always produces the same sheet.
  return a.id - b.id;
}

function candidateLots(db: Database.Database, oracleIds: string[]): Map<string, CandidateLot[]> {
  const byOracle = new Map<string, CandidateLot[]>();
  if (oracleIds.length === 0) return byOracle;

  // Archived locations are excluded, the same rule `allocation.ts` uses for
  // `owned` — a sheet that sends you to a box you have written off would be
  // pulling from copies the rest of the app does not believe you have.
  const rows = db.prepare(`
    SELECT ci.id, ci.quantity, ci.location_id, ${LOT_IDENTITY_COLUMNS},
           p.oracle_id, p.set_code, p.collector_number,
           p.price_usd, p.price_usd_foil, p.price_usd_etched,
           sl.name AS location_name, sl.sort_order AS location_sort,
           COALESCE((SELECT SUM(tli.quantity) FROM trade_list_items tli
                      WHERE tli.collection_item_id = ci.id), 0) AS trade_listed
      FROM collection_items ci
      JOIN card_printings p     ON p.id  = ci.printing_id
      JOIN storage_locations sl ON sl.id = ci.location_id
     WHERE sl.is_archived = 0
       AND p.oracle_id IN (${oracleIds.map(() => '?').join(',')})`).all(...oracleIds) as any[];

  for (const row of rows) {
    const identity = identityOf(row);
    const market = identity.finish === 'foil' ? row.price_usd_foil
      : identity.finish === 'etched' ? row.price_usd_etched
        : row.price_usd;
    const lot: CandidateLot = {
      id: row.id,
      oracleId: row.oracle_id,
      quantity: row.quantity,
      locationId: row.location_id,
      locationName: row.location_name,
      locationSort: row.location_sort,
      setCode: row.set_code,
      collectorNumber: row.collector_number,
      tradeListed: row.trade_listed,
      effectivePrice: identity.priceOverride ?? market ?? null,
      identity,
    };
    const list = byOracle.get(lot.oracleId) ?? [];
    list.push(lot);
    byOracle.set(lot.oracleId, list);
  }
  return byOracle;
}

/** One resolved line, before it becomes a row. */
interface PlannedPull {
  row: BuildabilityRow;
  lot: CandidateLot;
  quantity: number;
}

export interface ResolvedPlan {
  deck: DeckRecord;
  pulls: PlannedPull[];
  /** Copies the collection cannot supply, with Phase 24's cost attached. */
  shortfalls: BuildabilityRow[];
  rows: BuildabilityRow[];
}

/**
 * Which lots to pull for a deck, and what it still cannot cover.
 *
 * The budget per card is not computed here: `covered - proxied` is exactly the
 * copies Phase 24 says this deck's collection can supply, which is Phase 22's
 * `available` with the deck's own claim excluded and basics already dropped.
 * Re-deriving it would produce a sheet that quietly disagrees with the deck
 * header above it.
 */
export function resolveLots(db: Database.Database, deckId: number): ResolvedPlan {
  const deck = deckRecord(db, deckId);
  if (!deck) throw new AssemblyError('No deck with that id.');

  const detail = buildabilityDetail(db, deckId);
  const rows = detail?.rows ?? [];
  const lots = candidateLots(db, rows.map((row) => row.oracleId));

  // Guards the general case rather than today's: one lot holds one printing and
  // so serves one card, but a run that took the same copies twice would be a
  // sheet telling you to pull cards that are not there.
  const takenFromLot = new Map<number, number>();
  const pulls: PlannedPull[] = [];
  const shortfalls: BuildabilityRow[] = [];

  const pinned = preferredPrintings(db, deckId);

  for (const row of rows) {
    // Basics never reach this loop while the exemption is on: they are not
    // requirements, so a pile of Islands never lands on a checklist.
    let remaining = Math.max(0, row.covered - row.proxied);
    const candidates = (lots.get(row.oracleId) ?? [])
      .slice()
      .sort((a, b) => comparePreference(a, b, {
        preferredPrintingId: pinned.get(row.oracleId) ?? null,
        homeLocationId: deck.homeLocationId,
      }));

    for (const lot of candidates) {
      if (remaining <= 0) break;
      const free = lot.quantity - (takenFromLot.get(lot.id) ?? 0);
      if (free <= 0) continue;
      const take = Math.min(free, remaining);
      takenFromLot.set(lot.id, (takenFromLot.get(lot.id) ?? 0) + take);
      pulls.push({ row, lot, quantity: take });
      remaining -= take;
    }

    if (row.missing > 0) shortfalls.push(row);
  }

  return { deck, pulls, shortfalls, rows };
}

/**
 * The printing each slot is pinned to — preference 2 in the order above, and
 * the printing an unfillable line is shown as.
 *
 * Read for the whole deck in one query rather than per card: it is consulted
 * inside a comparator, where a query would run once per comparison.
 */
function preferredPrintings(db: Database.Database, deckId: number): Map<string, string> {
  const rows = db.prepare(`
    SELECT oracle_id, preferred_printing_id FROM deck_cards
     WHERE deck_id = ? AND preferred_printing_id IS NOT NULL`)
    .all(deckId) as Array<{ oracle_id: string; preferred_printing_id: string }>;
  return new Map(rows.map((row) => [row.oracle_id, row.preferred_printing_id]));
}

// -- decks --------------------------------------------------------------------

export interface DeckRecord {
  id: number;
  name: string;
  status: string;
  homeLocationId: number | null;
  homeLocationName: string | null;
}

function deckRecord(db: Database.Database, deckId: number): DeckRecord | null {
  const row = db.prepare(`
    SELECT d.id, d.name, d.status, d.home_location_id, sl.name AS home_name
      FROM decks d
      LEFT JOIN storage_locations sl ON sl.id = d.home_location_id
     WHERE d.id = ?`).get(deckId) as
    | { id: number; name: string; status: string; home_location_id: number | null; home_name: string | null }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    homeLocationId: row.home_location_id,
    homeLocationName: row.home_name,
  };
}

/**
 * The deck's status, stamped.
 *
 * The same two columns `DeckStore.update` writes, written here because the
 * status change has to land in the same transaction as the allocation it is
 * describing — a deck that says "assembled" while the copies it claims were
 * rolled back would be a lie the next screen repeats.
 */
function setDeckStatus(db: Database.Database, deckId: number, status: string): void {
  db.prepare(`UPDATE decks SET status = ?,
                status_changed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
              WHERE id = ?`).run(status, deckId);
}

/** The fallback destination when a card's original location is gone. */
function defaultLocationId(db: Database.Database): number | null {
  const row = db.prepare(`
    SELECT id FROM storage_locations
     WHERE is_archived = 0
     ORDER BY is_default DESC, sort_order, id LIMIT 1`).get() as { id: number } | undefined;
  return row?.id ?? null;
}

// -- opening a run ------------------------------------------------------------

const INSERT_ITEM = `
  INSERT INTO deck_assembly_items
    (run_id, oracle_id, printing_id, collection_item_id, quantity,
     from_location_id, to_location_id, picked, unavailable, notes,
     snapshot_name, snapshot_set_code, snapshot_number, snapshot_finish,
     snapshot_condition, snapshot_language, snapshot_acquired_at,
     snapshot_acquired_unit_cost, snapshot_acquisition_kind, snapshot_acquired_from,
     snapshot_lot_key)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/**
 * Opens an assemble run: resolves lots, writes the sheet, returns it.
 *
 * A deck may have only one open run. A second request returns the existing one
 * rather than a second sheet — you are halfway through a binder, and a fresh
 * sheet would throw away every line you had already ticked.
 */
export function openAssemblyRun(db: Database.Database, deckId: number): AssemblySheet {
  const existing = openRunFor(db, deckId);
  if (existing) return assemblySheet(db, existing.id)!;

  const plan = resolveLots(db, deckId);
  const { deck } = plan;
  // Snapshotted onto the run, never read live afterwards: a sheet that opened
  // as a harmless checklist must not start moving cardboard because the setting
  // was flipped while its owner was standing at the shelf.
  const movesLots = assemblyMovesLots(db) && deck.homeLocationId !== null;

  const runId = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO deck_assembly_runs (deck_id, kind, moves_lots) VALUES (?, 'assemble', ?)`)
      .run(deckId, movesLots ? 1 : 0);
    const id = Number(result.lastInsertRowid);

    const insert = db.prepare(INSERT_ITEM);
    for (const pull of plan.pulls) {
      insert.run(
        id, pull.row.oracleId, pull.lot.identity.printingId, pull.lot.id, pull.quantity,
        pull.lot.locationId, deck.homeLocationId, 0, 0,
        pull.lot.tradeListed > 0
          ? 'On a trade list — nothing else covers this slot.'
          : null,
        pull.row.name, pull.lot.setCode, pull.lot.collectorNumber,
        pull.lot.identity.finish, pull.lot.identity.condition, pull.lot.identity.language,
        pull.lot.identity.acquiredAt, pull.lot.identity.acquiredUnitCost,
        pull.lot.identity.acquisitionKind, pull.lot.identity.acquiredFrom,
        lotKey(pull.lot.identity),
      );
    }

    // The "Not available" section, persisted rather than recomputed, so an old
    // run still says what it could not find at the time.
    const pinned = preferredPrintings(db, deckId);
    for (const row of plan.shortfalls) {
      const printing = displayPrinting(db, row.oracleId, pinned.get(row.oracleId) ?? null);
      insert.run(
        id, row.oracleId, printing?.id ?? null, null, row.missing,
        null, deck.homeLocationId, 0, 1, null,
        row.name, printing?.setCode ?? null, printing?.collectorNumber ?? null,
        null, null, null, null, null, null, null, null,
      );
    }
    return id;
  })();

  return assemblySheet(db, runId)!;
}

/**
 * Opens a disassemble run from the deck's most recent completed assemble run.
 *
 * Each line goes back where it came from — `to_location_id` is the original
 * `from_location_id` — falling back to the default location when that place has
 * since been archived or deleted, because a card with nowhere to go still has
 * to go somewhere.
 */
export function openDisassemblyRun(db: Database.Database, deckId: number): AssemblySheet {
  const existing = openRunFor(db, deckId);
  if (existing) return assemblySheet(db, existing.id)!;

  const deck = deckRecord(db, deckId);
  if (!deck) throw new AssemblyError('No deck with that id.');

  const source = db.prepare(`
    SELECT id, moves_lots FROM deck_assembly_runs
     WHERE deck_id = ? AND kind = 'assemble' AND status = 'completed'
     ORDER BY completed_at DESC, id DESC LIMIT 1`).get(deckId) as
    | { id: number; moves_lots: number } | undefined;
  if (!source) {
    throw new AssemblyError(
      'This deck has no completed assembly to reverse — nothing is recorded as having gone into it.',
    );
  }

  const items = db.prepare(`
    SELECT i.*, sl.is_archived AS from_archived
      FROM deck_assembly_items i
      LEFT JOIN storage_locations sl ON sl.id = i.from_location_id
     WHERE i.run_id = ? AND i.unavailable = 0 AND i.picked = 1
     ORDER BY i.id`).all(source.id) as any[];

  const fallback = defaultLocationId(db);

  const runId = db.transaction(() => {
    // The forward run's setting, not today's: the reverse of a move is a move.
    // If those copies were physically relocated, the database says they are in
    // the deck box, and a checklist that left them there would make it lie.
    const result = db.prepare(`
      INSERT INTO deck_assembly_runs (deck_id, kind, moves_lots, source_run_id)
      VALUES (?, 'disassemble', ?, ?)`).run(deckId, source.moves_lots, source.id);
    const id = Number(result.lastInsertRowid);

    const insert = db.prepare(INSERT_ITEM);
    for (const item of items) {
      const back = item.from_location_id !== null && !item.from_archived
        ? item.from_location_id
        : fallback;
      // Looked up for the sheet only. Completion resolves it again, because the
      // collection can move between opening a run and finishing it.
      const match = source.moves_lots && deck.homeLocationId !== null && item.snapshot_lot_key
        ? findLotByKey(db, deck.homeLocationId, item.printing_id, item.snapshot_lot_key)
        : null;

      insert.run(
        id, item.oracle_id, item.printing_id, match?.id ?? null, item.quantity,
        deck.homeLocationId, back, 0, 0,
        source.moves_lots && !match
          ? 'No matching copies at the deck’s home location — they may have been sold or edited.'
          : null,
        item.snapshot_name, item.snapshot_set_code, item.snapshot_number,
        item.snapshot_finish, item.snapshot_condition, item.snapshot_language,
        item.snapshot_acquired_at, item.snapshot_acquired_unit_cost,
        item.snapshot_acquisition_kind, item.snapshot_acquired_from,
        item.snapshot_lot_key,
      );
    }
    return id;
  })();

  return assemblySheet(db, runId)!;
}

/** A lot at `locationId` whose full identity matches a recorded key. */
function findLotByKey(
  db: Database.Database,
  locationId: number,
  printingId: string | null,
  key: string,
): { id: number; quantity: number } | null {
  if (!printingId) return null;
  const rows = db.prepare(`
    SELECT ci.id, ci.quantity, ${LOT_IDENTITY_COLUMNS}
      FROM collection_items ci
     WHERE ci.location_id = ? AND ci.printing_id = ?
     ORDER BY ci.id`).all(locationId, printingId) as any[];
  const match = rows.find((row) => lotKey(identityOf(row)) === key);
  return match ? { id: match.id, quantity: match.quantity } : null;
}

/** The printing to show a card as when no lot of it was found. */
function displayPrinting(
  db: Database.Database,
  oracleId: string,
  preferredPrintingId: string | null,
): { id: string; setCode: string; collectorNumber: string } | null {
  const row = db.prepare(`
    SELECT p.id, p.set_code, p.collector_number
      FROM card_printings p
     WHERE p.id = COALESCE(?, (SELECT default_printing_id FROM oracle_cards WHERE oracle_id = ?))`)
    .get(preferredPrintingId, oracleId) as
    | { id: string; set_code: string; collector_number: string } | undefined;
  return row ? { id: row.id, setCode: row.set_code, collectorNumber: row.collector_number } : null;
}

export function openRunFor(db: Database.Database, deckId: number): RunSummary | null {
  const row = db.prepare(`
    SELECT id FROM deck_assembly_runs WHERE deck_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`).get(deckId) as { id: number } | undefined;
  return row ? runSummary(db, row.id) : null;
}

// -- reading a run ------------------------------------------------------------

function runSummary(db: Database.Database, runId: number): RunSummary | null {
  const row = db.prepare(`
    SELECT r.*,
           (SELECT COUNT(*) FROM deck_assembly_items i
             WHERE i.run_id = r.id AND i.unavailable = 0)              AS line_count,
           (SELECT COALESCE(SUM(i.quantity), 0) FROM deck_assembly_items i
             WHERE i.run_id = r.id AND i.unavailable = 0)              AS card_count,
           (SELECT COALESCE(SUM(i.quantity), 0) FROM deck_assembly_items i
             WHERE i.run_id = r.id AND i.unavailable = 0 AND i.picked = 1) AS picked_count
      FROM deck_assembly_runs r WHERE r.id = ?`).get(runId) as any;
  if (!row) return null;

  const notFound = row.kind === 'assemble' && row.status === 'completed'
    ? (db.prepare(`
        SELECT i.oracle_id, COALESCE(i.snapshot_name, o.name) AS name, SUM(i.quantity) AS quantity
          FROM deck_assembly_items i
          JOIN oracle_cards o ON o.oracle_id = i.oracle_id
         WHERE i.run_id = ? AND i.unavailable = 0 AND i.picked = 0
         GROUP BY i.oracle_id
         ORDER BY name COLLATE NOCASE`).all(runId) as Array<{
           oracle_id: string; name: string; quantity: number;
         }>).map((line) => ({ oracleId: line.oracle_id, name: line.name, quantity: line.quantity }))
    : [];

  return {
    id: row.id,
    deckId: row.deck_id,
    kind: row.kind,
    status: row.status,
    movesLots: Boolean(row.moves_lots),
    sourceRunId: row.source_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    notes: row.notes,
    lineCount: row.line_count,
    cardCount: row.card_count,
    pickedCount: row.picked_count,
    notFoundCount: notFound.reduce((total, line) => total + line.quantity, 0),
    notFound,
  };
}

export function listRuns(db: Database.Database, deckId: number, limit = 20): RunSummary[] {
  const rows = db.prepare(`
    SELECT id FROM deck_assembly_runs WHERE deck_id = ?
     ORDER BY started_at DESC, id DESC LIMIT ?`).all(deckId, limit) as Array<{ id: number }>;
  return rows.map((row) => runSummary(db, row.id)!).filter(Boolean);
}

/**
 * The sheet, grouped the way a shelf is organised.
 *
 * Locations in their own `sort_order`, then name; within a location, newest set
 * first and then collector number — the order cards sit in a set-sorted binder,
 * which is what `collector_number_num` was split out for. Reading a sheet in any
 * other order means walking the same binder twice.
 */
export function assemblySheet(db: Database.Database, runId: number): AssemblySheet | null {
  const run = runSummary(db, runId);
  if (!run) return null;
  const deck = deckRecord(db, run.deckId);
  if (!deck) return null;

  const rows = db.prepare(`
    SELECT i.*,
           o.name AS card_name,
           src.name AS from_name, src.sort_order AS from_sort,
           dst.name AS to_name,
           p.released_at, p.set_code AS printing_set,
           p.collector_number_num, p.collector_number_suffix,
           COALESCE((SELECT SUM(tli.quantity) FROM trade_list_items tli
                      WHERE tli.collection_item_id = i.collection_item_id), 0) AS trade_listed
      FROM deck_assembly_items i
      JOIN oracle_cards o ON o.oracle_id = i.oracle_id
      LEFT JOIN storage_locations src ON src.id = i.from_location_id
      LEFT JOIN storage_locations dst ON dst.id = i.to_location_id
      LEFT JOIN card_printings p ON p.id = i.printing_id
     WHERE i.run_id = ?`).all(runId) as any[];

  // Prices for the buy list are today's, and only worth fetching while the run
  // is open: a finished run is a record of what happened, not a shopping list.
  const prices = new Map<string, BuildabilityRow>();
  if (run.status === 'open') {
    for (const row of buildabilityDetail(db, run.deckId)?.rows ?? []) {
      prices.set(row.oracleId, row);
    }
  }

  const toLine = (row: any): SheetLine => {
    const priced = prices.get(row.oracle_id);
    return {
      id: row.id,
      oracleId: row.oracle_id,
      name: row.snapshot_name ?? row.card_name,
      printingId: row.printing_id,
      setCode: row.snapshot_set_code ?? row.printing_set,
      collectorNumber: row.snapshot_number,
      finish: row.snapshot_finish,
      condition: row.snapshot_condition,
      language: row.snapshot_language,
      quantity: row.quantity,
      picked: Boolean(row.picked),
      unavailable: Boolean(row.unavailable),
      notes: row.notes,
      collectionItemId: row.collection_item_id,
      fromLocationId: row.from_location_id,
      fromLocationName: row.from_name,
      toLocationId: row.to_location_id,
      toLocationName: row.to_name,
      tradeListed: row.trade_listed,
      unitPriceUsd: row.unavailable ? priced?.unitPriceUsd ?? null : null,
      // Extended over this line's own quantity rather than Phase 24's, which
      // counts the whole card: the two agree today and would silently stop
      // agreeing the moment a shortfall were ever split across lines.
      extendedUsd: row.unavailable && priced?.unitPriceUsd != null
        ? round2(row.quantity * priced.unitPriceUsd)
        : null,
    };
  };

  const pullRows = rows.filter((row) => !row.unavailable);
  const groups = new Map<string, { sort: number; group: SheetGroup }>();
  for (const row of pullRows) {
    const key = String(row.from_location_id ?? 'none');
    const fresh: { sort: number; group: SheetGroup } = {
      sort: row.from_sort ?? Number.MAX_SAFE_INTEGER,
      group: {
        locationId: row.from_location_id,
        locationName: row.from_name ?? 'Location unknown',
        lines: [],
        cardCount: 0,
        pickedCount: 0,
      },
    };
    const entry = groups.get(key) ?? fresh;
    entry.group.lines.push(toLine(row));
    entry.group.cardCount += row.quantity;
    if (row.picked) entry.group.pickedCount += row.quantity;
    groups.set(key, entry);
  }

  const withinLocation = (a: any, b: any) =>
    String(b.released_at ?? '').localeCompare(String(a.released_at ?? ''))
    || String(a.snapshot_set_code ?? a.printing_set ?? '')
      .localeCompare(String(b.snapshot_set_code ?? b.printing_set ?? ''))
    || (a.collector_number_num ?? Number.MAX_SAFE_INTEGER)
      - (b.collector_number_num ?? Number.MAX_SAFE_INTEGER)
    || String(a.collector_number_suffix ?? '').localeCompare(String(b.collector_number_suffix ?? ''))
    || a.id - b.id;

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const { group } of groups.values()) {
    group.lines.sort((a, b) => withinLocation(byId.get(a.id), byId.get(b.id)));
  }

  const ordered = [...groups.values()]
    .sort((a, b) => a.sort - b.sort
      || a.group.locationName.localeCompare(b.group.locationName, undefined, { sensitivity: 'base' }))
    .map((entry) => entry.group);

  const unavailable = rows.filter((row) => row.unavailable).map(toLine)
    .sort((a, b) => b.quantity - a.quantity
      || (b.extendedUsd ?? 0) - (a.extendedUsd ?? 0)
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const proxiedCards = run.status === 'open'
    ? [...prices.values()].reduce((total, row) => total + row.proxied, 0)
    : 0;

  return {
    run,
    deck,
    groups: ordered,
    unavailable,
    summary: {
      cardsToPull: run.cardCount,
      pickedCards: run.pickedCount,
      lineCount: run.lineCount,
      pickedLines: pullRows.filter((row) => row.picked).length,
      unavailableCards: unavailable.reduce((total, line) => total + line.quantity, 0),
      unavailableCostUsd: round2(
        unavailable.reduce((total, line) => total + (line.extendedUsd ?? 0), 0),
      ),
      unpricedCount: unavailable.filter((line) => line.unitPriceUsd == null).length,
      tradeListedLines: pullRows.filter((row) => row.trade_listed > 0).length,
      proxiedCards,
    },
    movesLots: run.movesLots,
    movesLotsBlocked: !run.movesLots && assemblyMovesLots(db) && deck.homeLocationId === null
      ? 'This deck has no home location, so there is nowhere to move cards to. '
        + 'Set one on the deck and start a new run to move lots.'
      : null,
  };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Ticking a line off. The one thing that happens while holding a binder. */
export function setItemPicked(
  db: Database.Database,
  runId: number,
  itemId: number,
  picked: boolean,
): AssemblySheet | null {
  const run = runSummary(db, runId);
  if (!run) return null;
  if (run.status !== 'open') throw new AssemblyError('This run is already finished.');

  const item = db.prepare('SELECT unavailable FROM deck_assembly_items WHERE id = ? AND run_id = ?')
    .get(itemId, runId) as { unavailable: number } | undefined;
  if (!item) throw new AssemblyError('No such line on this run.');
  // A line the collection could not supply is not a line you can tick — it is
  // there to be bought, not found.
  if (item.unavailable) throw new AssemblyError('That line is a card you do not have to pull.');

  db.prepare('UPDATE deck_assembly_items SET picked = ? WHERE id = ?').run(picked ? 1 : 0, itemId);
  return assemblySheet(db, runId);
}

export function cancelRun(db: Database.Database, runId: number): RunSummary | null {
  const run = runSummary(db, runId);
  if (!run) return null;
  if (run.status !== 'open') throw new AssemblyError('This run is already finished.');
  db.prepare(`UPDATE deck_assembly_runs SET status = 'cancelled',
                completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(runId);
  return runSummary(db, runId);
}

// -- moving copies ------------------------------------------------------------

interface MoveOutcome {
  moved: number;
  adjustments: TradeListAdjustment[];
  problem: string | null;
}

/**
 * Moves copies between locations, preserving cost basis.
 *
 * A move is: decrement the source lot, then insert or merge at the destination
 * carrying the *identical* identity — printing, finish, condition, language,
 * override, signature, notes, acquisition date, unit cost, kind and source.
 * Merging on anything less would fold two different purchases into one row and
 * silently destroy P&L history, which is why `lotKey` is one function and both
 * directions call it.
 */
function moveCopies(
  db: Database.Database,
  input: { lotId: number; quantity: number; toLocationId: number; cardName: string },
): MoveOutcome {
  const source = db.prepare(`
    SELECT ci.id, ci.quantity, ci.location_id, ${LOT_IDENTITY_COLUMNS}
      FROM collection_items ci WHERE ci.id = ?`).get(input.lotId) as any | undefined;

  if (!source) {
    return {
      moved: 0,
      adjustments: [],
      problem: `${input.cardName}: the copies this run was going to move are no longer in your collection.`,
    };
  }

  // A card already in the deck's box is not a card that moves. Without this,
  // the lot would be decremented to zero, deleted and re-inserted identically —
  // a new id for the same cardboard, and, worse, a trade-list row settled as
  // though the copies had left when they never went anywhere.
  if (source.location_id === input.toLocationId) {
    return { moved: Math.min(input.quantity, source.quantity), adjustments: [], problem: null };
  }

  const moved = Math.min(input.quantity, source.quantity);
  const remaining = source.quantity - moved;
  const problem = moved < input.quantity
    ? `${input.cardName}: expected ${input.quantity} copies in that lot but found ${moved}.`
    : null;
  if (moved <= 0) return { moved: 0, adjustments: [], problem };

  const identity = identityOf(source);

  // Trade-list rows point at a specific lot, so they are settled *before* the
  // lot is touched. Letting the FK cascade do it instead would silently drop an
  // offer with no record of why, and a partial move would leave a listing
  // claiming more copies than remain.
  const adjustments: TradeListAdjustment[] = [];
  const listings = db.prepare(`
    SELECT tli.id, tli.quantity, tl.name AS list_name
      FROM trade_list_items tli
      JOIN trade_lists tl ON tl.id = tli.trade_list_id
     WHERE tli.collection_item_id = ?`).all(source.id) as
    Array<{ id: number; quantity: number; list_name: string }>;

  for (const listing of listings) {
    // Decrement by what was taken — a card that went into a deck is no longer
    // on offer — and never above what is left, so a listing that was already
    // over-stated comes back within bounds rather than staying wrong.
    const next = Math.min(listing.quantity - moved, remaining);
    if (next > 0) {
      db.prepare(`UPDATE trade_list_items SET quantity = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
        .run(next, listing.id);
      adjustments.push({
        listName: listing.list_name,
        cardName: input.cardName,
        quantity: listing.quantity - next,
        removed: false,
      });
    } else {
      db.prepare('DELETE FROM trade_list_items WHERE id = ?').run(listing.id);
      adjustments.push({
        listName: listing.list_name,
        cardName: input.cardName,
        quantity: listing.quantity,
        removed: true,
      });
    }
  }

  if (remaining > 0) {
    db.prepare(`UPDATE collection_items SET quantity = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(remaining, source.id);
  } else {
    db.prepare('DELETE FROM collection_items WHERE id = ?').run(source.id);
  }

  const destination = findLot(db, input.toLocationId, identity);
  if (destination) {
    db.prepare(`UPDATE collection_items SET quantity = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(destination.quantity + moved, destination.id);
  } else {
    db.prepare(`
      INSERT INTO collection_items
        (printing_id, location_id, quantity, finish, condition, language, price_override,
         is_signed, is_altered, notes, acquired_at, acquired_unit_cost, acquisition_kind,
         acquired_from, acquired_trade_id, import_batch_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      identity.printingId, input.toLocationId, moved, identity.finish, identity.condition,
      identity.language, identity.priceOverride, identity.isSigned, identity.isAltered,
      identity.notes, identity.acquiredAt, identity.acquiredUnitCost, identity.acquisitionKind,
      identity.acquiredFrom, identity.acquiredTradeId, identity.importBatchId,
    );
  }

  return { moved, adjustments, problem };
}

// -- completing a run ---------------------------------------------------------

/**
 * Finishes a run.
 *
 * One transaction. An assemble sets the deck to `assembled` and — only when the
 * run was opened with `assembly_moves_lots` on — moves the lots. A disassemble
 * sets `disassembled` and moves back what the forward run moved. Both end by
 * reconciling the deck's claim, because completion is a write and every write
 * that can change what a deck holds ends that way (`reconcile.ts`).
 *
 * What completion deliberately does *not* do is write the claim from the
 * ticks. `quantity_from_collection` is a derived figure — what the collection
 * can spare — and is never set by hand, so a lower number written here would
 * be raised straight back by the next edit to the deck, taking "I could not
 * find the second copy" with it. That fact lives on the run instead, as the
 * un-ticked lines, where nothing recomputes it: `RunSummary.notFound` reads it
 * back for as long as the run is the deck's latest.
 */
export function completeRun(db: Database.Database, runId: number): CompletionSummary | null {
  const run = runSummary(db, runId);
  if (!run) return null;
  if (run.status !== 'open') throw new AssemblyError('This run is already finished.');
  const deck = deckRecord(db, run.deckId);
  if (!deck) throw new AssemblyError('No deck with that id.');

  const problems: string[] = [];
  const adjustments: TradeListAdjustment[] = [];
  let copiesMoved = 0;

  db.transaction(() => {
    const items = db.prepare(`
      SELECT * FROM deck_assembly_items
       WHERE run_id = ? AND unavailable = 0 AND picked = 1 ORDER BY id`)
      .all(runId) as any[];

    if (run.movesLots) {
      for (const item of items) {
        const name = item.snapshot_name ?? 'This card';
        const to = item.to_location_id;
        if (to === null) {
          problems.push(`${name}: nowhere to move these copies to.`);
          continue;
        }

        // Resolved again here rather than trusted from when the run opened: the
        // collection can move between picking up a binder and putting it down.
        const lotId = run.kind === 'assemble'
          ? item.collection_item_id
          : (deck.homeLocationId === null
            ? null
            : findLotByKey(db, deck.homeLocationId, item.printing_id, item.snapshot_lot_key)?.id
              ?? null);

        if (lotId === null) {
          // Never invent a lot from nothing. The line is marked and the rest of
          // the run completes around it.
          db.prepare(`UPDATE deck_assembly_items SET unavailable = 1, notes = ? WHERE id = ?`).run(
            run.kind === 'assemble'
              ? 'The lot this line was resolved to no longer exists.'
              : 'No matching copies at the deck’s home location — nothing was moved back.',
            item.id,
          );
          problems.push(
            `${name}: no matching copies to move${run.kind === 'assemble' ? '' : ' back'}.`,
          );
          continue;
        }

        const outcome = moveCopies(db, {
          lotId, quantity: item.quantity, toLocationId: to, cardName: name,
        });
        copiesMoved += outcome.moved;
        adjustments.push(...outcome.adjustments);
        if (outcome.problem) {
          problems.push(outcome.problem);
          db.prepare('UPDATE deck_assembly_items SET notes = ? WHERE id = ?')
            .run(outcome.problem, item.id);
        }
        // The moved copies are now in the deck box. The lot they came from may
        // be gone, so the item stops pointing at it and keeps its snapshot,
        // which is what a later disassembly matches on.
        if (run.kind === 'assemble') {
          db.prepare('UPDATE deck_assembly_items SET collection_item_id = NULL WHERE id = ?')
            .run(item.id);
        }
      }
    }

    setDeckStatus(db, run.deckId, run.kind === 'assemble' ? 'assembled' : 'disassembled');
    // Inside the transaction, after any lot moves, so the claim is settled
    // against the collection as this run leaves it.
    reconcileDeckClaims(db, run.deckId);

    db.prepare(`UPDATE deck_assembly_runs SET status = 'completed',
                  completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(runId);
  })();

  const after = runSummary(db, runId)!;
  const notFound = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS qty FROM deck_assembly_items
     WHERE run_id = ? AND unavailable = 0 AND picked = 0`).get(runId) as { qty: number };

  // What is still missing is asked of Phase 24 *after* the write, so the figure
  // on the summary screen is the one the deck header will show a second later.
  const detail = buildabilityDetail(db, run.deckId);

  return {
    runId,
    kind: run.kind,
    deckId: run.deckId,
    deckStatus: run.kind === 'assemble' ? 'assembled' : 'disassembled',
    pulledCards: after.pickedCount,
    notFoundCards: notFound.qty,
    proxiedCards: (detail?.rows ?? []).reduce((total, row) => total + row.proxied, 0),
    stillMissingCards: detail?.summary.missingCards ?? 0,
    stillMissingCostUsd: detail?.summary.costToCompleteUsd ?? 0,
    unpricedCount: detail?.summary.unpricedCount ?? 0,
    movedLots: run.movesLots,
    copiesMoved,
    tradeListAdjustments: adjustments,
    problems,
  };
}
