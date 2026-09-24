import type Database from 'better-sqlite3';
import { artUrlSql } from '../images/url.ts';
import {
  allocationFor, allocationForMany, allocationSettings, reservingStatuses,
} from '../decks/allocation.ts';
import type { CollectionStore, Finish, Condition } from '../collection/store.ts';
import type { AlertStore } from '../alerts/store.ts';
import { reconcileWants, type FulfilledWant } from '../collection/wants.ts';
import { reconcileAlerts } from '../decks/contention.ts';
import { prepared } from '../db/index.ts';

/**
 * Recording trades.
 *
 * A trade is built and edited as a draft that never touches the collection;
 * only completion applies the deltas — copies leave, copies arrive, disposals
 * are logged, matching wants are fulfilled and trade lists are reconciled. That
 * split is what keeps collection numbers honest while a trade is still being
 * negotiated at the table.
 */

export type TradeStatus = 'draft' | 'completed' | 'cancelled';
export const TRADE_SORTS = ['date', 'oldest', 'person'] as const;
export type TradeSort = typeof TRADE_SORTS[number];
export type Direction = 'out' | 'in';

export class TradeNotFoundError extends Error {
  constructor(id: number) { super(`No trade with id ${id}.`); this.name = 'TradeNotFoundError'; }
}
export class TradeNotDraftError extends Error {
  constructor() { super('Only a draft trade can be changed.'); this.name = 'TradeNotDraftError'; }
}

/** An outgoing card the collection cannot supply enough copies of. */
export interface Shortfall {
  /** The trade item that came up short (absent when raised by a bare disposal). */
  itemId?: number;
  oracleId: string;
  name: string;
  /** Copies the trade wants to give away. */
  requested: number;
  /** Copies actually there to draw from. */
  found: number;
}

/**
 * Thrown before anything commits when copies leaving are not there to leave.
 *
 * A trade item names a lot, but the lot can change or vanish while the trade
 * is still a draft. Refusing here — rather than completing with nothing
 * disposed — is what keeps the trade's `value_out_usd`, the collection and the
 * disposal log agreeing with each other.
 */
export class TradeShortfallError extends Error {
  readonly shortfalls: Shortfall[];
  constructor(shortfalls: Shortfall[]) {
    super(shortfalls.map(({ name, requested, found }) => {
      const missing = requested - found;
      return `${missing} ${missing === 1 ? 'copy' : 'copies'} of ${name} ${missing === 1 ? 'is' : 'are'} not in your collection.`;
    }).join(' '));
    this.name = 'TradeShortfallError';
    this.shortfalls = shortfalls;
  }
}

export interface TradeItemInput {
  direction: Direction;
  printingId: string;
  quantity: number;
  finish?: Finish;
  condition?: Condition;
  language?: string;
  sourceCollectionItemId?: number | null;
  destinationLocationId?: number | null;
  unitValueUsd?: number | null;
  notes?: string | null;
}

/** The mutable fields of a draft trade. Anything omitted is left alone. */
export interface TradeUpdate {
  counterpartyName?: string;
  counterpartyContact?: string | null;
  tradeDate?: string | null;
  locationNote?: string | null;
  notes?: string | null;
}

/** The mutable fields of one card in a draft trade. */
export interface TradeItemUpdate {
  quantity?: number;
  printingId?: string;
  finish?: Finish;
  condition?: Condition;
  language?: string;
  sourceCollectionItemId?: number | null;
  destinationLocationId?: number | null;
  unitValueUsd?: number | null;
  notes?: string | null;
}

export interface Conflict {
  oracleId: string;
  name: string;
  owned: number;
  allocated: number;
  tradingAway: number;
}

/**
 * What to do when copies leaving would drop availability below what decks claim.
 *
 * `'prompt'` is the web UI's path: stop and ask, then clamp the deck on `force`.
 * `'alert'` is the non-interactive path for Phase 13's sales and Phase 36's
 * offline replay — never blocks, never edits a deck, and leaves one alert per
 * affected card behind instead.
 */
export type ConflictMode = 'prompt' | 'alert';

/** A card a deck still claims more copies of than are now owned. */
export interface AllocationShortfall {
  oracleId: string;
  name: string;
  owned: number;
  allocated: number;
  /** Copies decks claim that no longer exist. */
  short: number;
}

export interface CompleteResult {
  completed: boolean;
  needsConfirmation?: boolean;
  conflicts?: Conflict[];
  /**
   * Outgoing copies that are not in the collection. Unlike a conflict this is
   * not a decision — `force` cannot complete past it.
   */
  shortfalls?: Shortfall[];
  fulfilledWants?: FulfilledWant[];
  clampedTradeListItems?: number;
  resolvedConflicts?: Conflict[];
  /** `conflictMode: 'alert'` only — the alerts raised instead of blocking. */
  allocationAlerts?: AllocationShortfall[];
}

/** One card leaving the collection. Lots are drawn oldest-first. */
export interface DisposalRequest {
  printingId: string;
  quantity: number;
  finish?: Finish;
  condition?: Condition;
  language?: string;
  /** Preferred lot to draw from; other matching lots follow it, oldest first. */
  sourceCollectionItemId?: number | null;
  /** Per-copy value credited (trade) or cash received (sale). */
  unitProceedsUsd?: number | null;
}

/** Why the copies left, and who got them. */
export interface DisposalContext {
  kind: 'trade' | 'sale' | 'gift' | 'loss';
  /** 'YYYY-MM-DD'. Today when omitted. */
  disposedOn?: string | null;
  tradeId?: number | null;
  counterparty?: string | null;
  notes?: string | null;
}

/** One lot drawn down by a `DisposalRequest`. */
export interface LotConsumption {
  /** Index into the `requests` array this came from. */
  requestIndex: number;
  lotId: number;
  locationId: number;
  quantity: number;
}

export interface DisposeResult {
  consumed: LotConsumption[];
  clampedTradeListItems: number;
  allocationAlerts: AllocationShortfall[];
}

export class TradeStore {
  private readonly db: Database.Database;
  private readonly collection: CollectionStore;
  private readonly alerts: AlertStore;

  constructor(db: Database.Database, collection: CollectionStore, alerts: AlertStore) {
    this.db = db;
    this.collection = collection;
    this.alerts = alerts;
  }

  // -- draft CRUD ------------------------------------------------------------

  create(input: {
    counterpartyName: string; counterpartyContact?: string | null;
    tradeDate?: string | null; locationNote?: string | null; notes?: string | null;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO trades (counterparty_name, counterparty_contact, trade_date, location_note, notes)
      VALUES (?,?, COALESCE(?, date('now','localtime')), ?, ?)`).run(
      input.counterpartyName.trim(), input.counterpartyContact ?? null,
      input.tradeDate ?? null, input.locationNote ?? null, input.notes ?? null);
    return Number(result.lastInsertRowid);
  }

  private requireDraft(id: number): { id: number; status: TradeStatus; counterparty_name: string; trade_date: string | null } {
    const trade = this.db.prepare(
      'SELECT id, status, counterparty_name, trade_date FROM trades WHERE id = ?',
    ).get(id) as any;
    if (!trade) throw new TradeNotFoundError(id);
    if (trade.status !== 'draft') throw new TradeNotDraftError();
    return trade;
  }

  update(id: number, changes: TradeUpdate): void {
    this.requireDraft(id);
    const columns: Record<string, string> = {
      counterpartyName: 'counterparty_name', counterpartyContact: 'counterparty_contact',
      tradeDate: 'trade_date', locationNote: 'location_note', notes: 'notes',
    };
    const values = changes as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (values[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(values[key]);
    }
    if (sets.length === 0) return;
    sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    this.db.prepare(`UPDATE trades SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  delete(id: number): void {
    this.requireDraft(id);
    this.db.prepare('DELETE FROM trades WHERE id = ?').run(id);
  }

  cancel(id: number): void {
    this.requireDraft(id);
    this.db.prepare(`UPDATE trades SET status = 'cancelled' WHERE id = ?`).run(id);
  }

  /**
   * Copies an outgoing item can actually draw from: its chosen lot, whatever
   * that lot's finish/condition/language now are, plus every other lot of the
   * same printing/finish/condition/language. The same set `disposeFromLot`
   * walks, so the cap and the "own N" figure agree with what completion does.
   */
  private ownedFor(
    printingId: string, finish: string, condition: string, language: string,
    sourceLotId: number | null,
  ): number {
    return (this.db.prepare(
      `SELECT COALESCE(SUM(quantity),0) AS n FROM collection_items
       WHERE printing_id = ?
         AND ((finish = ? AND condition = ? AND language = ?) OR id = ?)`,
    ).get(printingId, finish, condition, language, sourceLotId ?? -1) as { n: number }).n;
  }

  /** What a chosen lot is, so an item drafted from it describes the same copies. */
  private lotIdentity(lotId: number | null | undefined):
    | { printingId: string; finish: Finish; condition: Condition; language: string }
    | undefined {
    if (lotId == null) return undefined;
    const row = this.db.prepare(
      'SELECT printing_id, finish, condition, language FROM collection_items WHERE id = ?',
    ).get(lotId) as
      | { printing_id: string; finish: Finish; condition: Condition; language: string }
      | undefined;
    return row && {
      printingId: row.printing_id, finish: row.finish, condition: row.condition, language: row.language,
    };
  }

  /**
   * Adds a card to the trade, or bumps its existing row.
   *
   * One row per printing/finish/condition per side — re-adding the same card
   * increases its quantity rather than stacking duplicate rows. Outgoing is
   * capped at what you own, so a trade can never give away more than the
   * collection holds; incoming is uncapped. An outgoing item that names a lot
   * takes that lot's finish/condition/language unless told otherwise — a
   * default of 'unknown' would describe copies the lot does not hold.
   */
  addItem(tradeId: number, item: TradeItemInput): number {
    this.requireDraft(tradeId);
    const lot = this.lotIdentity(item.sourceCollectionItemId);
    const finish = item.finish ?? lot?.finish ?? 'nonfoil';
    const condition = item.condition ?? lot?.condition ?? 'unknown';
    const language = item.language ?? lot?.language ?? 'en';
    const add = Math.max(1, Math.trunc(item.quantity));

    const existing = this.db.prepare(
      `SELECT id, quantity FROM trade_items
       WHERE trade_id = ? AND direction = ? AND printing_id = ? AND finish = ? AND condition = ?`,
    ).get(tradeId, item.direction, item.printingId, finish, condition) as
      | { id: number; quantity: number } | undefined;

    const cap = (n: number) => item.direction === 'out'
      ? Math.max(1, Math.min(n, this.ownedFor(
          item.printingId, finish, condition, language, item.sourceCollectionItemId ?? null)))
      : n;

    if (existing) {
      this.db.prepare('UPDATE trade_items SET quantity = ? WHERE id = ?')
        .run(cap(existing.quantity + add), existing.id);
      return existing.id;
    }

    const result = this.db.prepare(`
      INSERT INTO trade_items
        (trade_id, direction, printing_id, quantity, finish, condition, language,
         source_collection_item_id, destination_location_id, unit_value_usd, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      tradeId, item.direction, item.printingId, cap(add),
      finish, condition, language,
      item.sourceCollectionItemId ?? null, item.destinationLocationId ?? null,
      item.unitValueUsd ?? null, item.notes ?? null);
    return Number(result.lastInsertRowid);
  }

  updateItem(tradeId: number, itemId: number, changes: TradeItemUpdate): void {
    this.requireDraft(tradeId);

    const values: Record<string, unknown> = { ...changes };
    if (values.quantity !== undefined) {
      values.quantity = Math.max(1, Math.trunc(Number(values.quantity)));
    }
    // Pointing the item at a different lot re-describes it as that lot's
    // copies, for any of finish/condition/language the caller left unsaid.
    if (changes.sourceCollectionItemId != null) {
      const lot = this.lotIdentity(changes.sourceCollectionItemId);
      if (lot) {
        values.finish ??= lot.finish;
        values.condition ??= lot.condition;
        values.language ??= lot.language;
      }
    }

    const columns: Record<string, string> = {
      quantity: 'quantity', printingId: 'printing_id', finish: 'finish', condition: 'condition',
      language: 'language', sourceCollectionItemId: 'source_collection_item_id',
      destinationLocationId: 'destination_location_id',
      unitValueUsd: 'unit_value_usd', notes: 'notes',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (values[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(values[key]);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE trade_items SET ${sets.join(', ')} WHERE id = ? AND trade_id = ?`)
      .run(...params, itemId, tradeId);

    // Re-clamp an outgoing item to what's owned — the printing/finish/condition
    // may have just changed, so the cap can be different from before.
    const row = this.db.prepare(
      `SELECT direction, printing_id, finish, condition, language, quantity, source_collection_item_id
       FROM trade_items WHERE id = ? AND trade_id = ?`,
    ).get(itemId, tradeId) as
      | {
          direction: Direction; printing_id: string; finish: string; condition: string;
          language: string; quantity: number; source_collection_item_id: number | null;
        }
      | undefined;
    if (row?.direction === 'out') {
      const cap = Math.max(1, this.ownedFor(
        row.printing_id, row.finish, row.condition, row.language, row.source_collection_item_id));
      if (row.quantity > cap) {
        this.db.prepare('UPDATE trade_items SET quantity = ? WHERE id = ?').run(cap, itemId);
      }
    }
  }

  removeItem(tradeId: number, itemId: number): void {
    this.requireDraft(tradeId);
    this.db.prepare('DELETE FROM trade_items WHERE id = ? AND trade_id = ?').run(itemId, tradeId);
  }

  // -- reads -----------------------------------------------------------------

  /**
   * The trade log, optionally narrowed to one status and to counterparties
   * whose name contains `query`, in one of three orders. Drafts lead the
   * date orders when no status is asked for — they are the ones still open.
   *
   * `totals` is over exactly the trades returned, so "trades with Alex" says
   * what went back and forth with Alex. Values are the ones each trade froze
   * when it completed; a completed trade with no value on a side is counted,
   * not summed as $0.
   */
  list(options: { status?: TradeStatus; query?: string; sort?: TradeSort } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.status) { where.push('status = ?'); params.push(options.status); }
    const query = options.query?.trim();
    if (query) {
      // LIKE's own wildcards in a name are matched literally.
      where.push("counterparty_name LIKE ? ESCAPE '\\'");
      params.push(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const when = 'COALESCE(completed_at, trade_date, created_at)';
    const drafts = options.status ? '' : "(status = 'draft') DESC, ";
    const order = options.sort === 'person'
      ? `${drafts}counterparty_name COLLATE NOCASE, ${when} DESC, id DESC`
      : options.sort === 'oldest'
        ? `${drafts}${when} ASC, id ASC`
        : `${drafts}${when} DESC, id DESC`;
    // A draft has no frozen value_out_usd/value_in_usd — those are only
    // written at completion — so the list row for one is summed live from its
    // items instead, the same arithmetic TradeEditor's sumValue does. Gated by
    // status inside the CASE so a completed or cancelled row, the common case,
    // never runs the correlated subquery at all.
    const rows = this.db.prepare(`
      SELECT trades.*,
        CASE WHEN status = 'draft' THEN
          (SELECT COUNT(*) FROM trade_items WHERE trade_id = trades.id) END AS draft_item_count,
        CASE WHEN status = 'draft' THEN
          (SELECT COALESCE(SUM(quantity), 0) FROM trade_items WHERE trade_id = trades.id) END AS draft_card_count,
        CASE WHEN status = 'draft' THEN
          (SELECT COALESCE(SUM(unit_value_usd * quantity), 0) FROM trade_items
            WHERE trade_id = trades.id AND direction = 'out') END AS draft_value_out_usd,
        CASE WHEN status = 'draft' THEN
          (SELECT COUNT(*) FROM trade_items
            WHERE trade_id = trades.id AND direction = 'out' AND unit_value_usd IS NULL) END AS draft_out_unpriced,
        CASE WHEN status = 'draft' THEN
          (SELECT COALESCE(SUM(unit_value_usd * quantity), 0) FROM trade_items
            WHERE trade_id = trades.id AND direction = 'in') END AS draft_value_in_usd,
        CASE WHEN status = 'draft' THEN
          (SELECT COUNT(*) FROM trade_items
            WHERE trade_id = trades.id AND direction = 'in' AND unit_value_usd IS NULL) END AS draft_in_unpriced
      FROM trades
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order}`).all(...params) as any[];

    const completed = rows.filter((t) => t.status === 'completed');
    const sum = (key: 'value_out_usd' | 'value_in_usd') =>
      completed.reduce((total, t) => total + (t[key] ?? 0), 0);
    return {
      trades: rows.map((t) => this.summarise(t)),
      totals: {
        count: rows.length,
        completedCount: completed.length,
        valueOutUsd: sum('value_out_usd'),
        valueInUsd: sum('value_in_usd'),
        unvaluedCount: completed.filter((t) => t.value_out_usd == null || t.value_in_usd == null).length,
      },
    };
  }

  get(id: number) {
    const trade = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as any;
    if (!trade) throw new TradeNotFoundError(id);
    return { ...this.summarise(trade), items: this.itemsFor(id) };
  }

  private summarise(trade: any) {
    return {
      id: trade.id,
      counterpartyName: trade.counterparty_name,
      counterpartyContact: trade.counterparty_contact,
      status: trade.status as TradeStatus,
      tradeDate: trade.trade_date,
      completedAt: trade.completed_at,
      locationNote: trade.location_note,
      notes: trade.notes,
      valueOutUsd: trade.value_out_usd,
      valueInUsd: trade.value_in_usd,
      createdAt: trade.created_at,
      updatedAt: trade.updated_at,
      // Present only on a draft row from list() — undefined (dropped by JSON)
      // everywhere else, including get(), which returns the real items instead.
      draftItemCount: trade.draft_item_count ?? undefined,
      draftCardCount: trade.draft_card_count ?? undefined,
      draftValueOutUsd: trade.draft_value_out_usd ?? undefined,
      draftOutUnpriced: trade.draft_out_unpriced ?? undefined,
      draftValueInUsd: trade.draft_value_in_usd ?? undefined,
      draftInUnpriced: trade.draft_in_unpriced ?? undefined,
    };
  }

  private itemsFor(tradeId: number) {
    const rows = this.db.prepare(`
      SELECT ti.*, o.oracle_id, o.name AS card_name, o.mana_cost,
             p.set_code, p.collector_number,
             ${artUrlSql('p', 'ff', 'small')} AS image_small,
             CASE ti.finish WHEN 'foil' THEN p.price_usd_foil
                            WHEN 'etched' THEN p.price_usd_etched
                            ELSE p.price_usd END AS market_usd,
             -- Owned copies this item can draw from — its chosen lot as it now
             -- is, plus other lots of the same printing/finish/condition/language.
             -- The ceiling for how many may be given away (outgoing items), and
             -- the same set disposeFromLot walks at completion.
             (SELECT COALESCE(SUM(ci.quantity),0) FROM collection_items ci
              WHERE ci.printing_id = ti.printing_id
                AND ((ci.finish = ti.finish AND ci.condition = ti.condition
                      AND ci.language = ti.language)
                     OR ci.id = ti.source_collection_item_id)) AS owned_qty
      FROM trade_items ti
      JOIN card_printings p ON p.id = ti.printing_id
      JOIN oracle_cards o ON o.oracle_id = p.oracle_id
      LEFT JOIN card_faces ff ON ff.printing_id = ti.printing_id AND ff.face_index = 0
      WHERE ti.trade_id = ?
      ORDER BY ti.direction DESC, o.name COLLATE NOCASE`).all(tradeId) as any[];

    return rows.map((row) => ({
      id: row.id,
      direction: row.direction as Direction,
      printingId: row.printing_id,
      oracleId: row.oracle_id,
      name: row.snapshot_name ?? row.card_name,
      setCode: row.snapshot_set_code ?? row.set_code,
      collectorNumber: row.snapshot_number ?? row.collector_number,
      manaCost: row.mana_cost,
      quantity: row.quantity,
      /** Owned copies of this printing/finish/condition — the outgoing ceiling. */
      ownedQuantity: row.owned_qty ?? 0,
      finish: row.finish,
      condition: row.condition,
      language: row.language,
      sourceCollectionItemId: row.source_collection_item_id,
      destinationLocationId: row.destination_location_id,
      unitValueUsd: row.unit_value_usd ?? row.market_usd,
      marketUsd: row.market_usd,
      imageSmall: row.image_small,
      notes: row.notes,
    }));
  }

  // -- completion ------------------------------------------------------------

  private defaultLocationId(): number {
    const row = this.db.prepare(
      `SELECT id FROM storage_locations
       ORDER BY is_default DESC, is_archived ASC, sort_order, id LIMIT 1`).get() as { id: number } | undefined;
    if (!row) throw new Error('No storage location exists to receive incoming cards.');
    return row.id;
  }

  private priceFor(printingId: string, finish: string): number | null {
    const row = this.db.prepare(
      `SELECT price_usd, price_usd_foil, price_usd_etched FROM card_printings WHERE id = ?`,
    ).get(printingId) as any;
    if (!row) return null;
    return finish === 'foil' ? row.price_usd_foil
      : finish === 'etched' ? row.price_usd_etched : row.price_usd;
  }

  /**
   * Applies a draft trade to the collection. Idempotent guard: only a draft
   * completes.
   *
   * Under the default `conflictMode: 'prompt'`, an outgoing card a deck is
   * using returns a confirmation request instead of acting, and `force` then
   * clamps the deck's claim. Under `'alert'` the trade always completes, decks
   * are left exactly as they are, and each affected card gets an
   * `allocation_conflict` alert to sort out later.
   *
   * A shortfall — outgoing copies the collection does not hold — is neither a
   * prompt nor an alert: there is nothing to give. 'prompt' reports it so the
   * UI can say so; 'alert' has nobody to tell and throws. Either way nothing
   * is written, and `force` does not apply.
   */
  complete(id: number, options: { force?: boolean; conflictMode?: ConflictMode } = {}): CompleteResult {
    const trade = this.requireDraft(id);
    const items = this.itemsFor(id);
    const out = items.filter((i) => i.direction === 'out');
    const incoming = items.filter((i) => i.direction === 'in');
    const conflictMode = options.conflictMode ?? 'prompt';

    const { conflicts, shortfalls } = this.detectConflicts(out);
    if (shortfalls.length > 0) {
      if (conflictMode === 'alert') throw new TradeShortfallError(shortfalls);
      return { completed: false, shortfalls, conflicts };
    }
    if (conflictMode === 'prompt' && conflicts.length > 0 && !options.force) {
      return { completed: false, needsConfirmation: true, conflicts };
    }

    const fulfilledWants: FulfilledWant[] = [];
    let clampedTradeListItems = 0;
    let resolvedConflicts: Conflict[] = [];
    let allocationAlerts: AllocationShortfall[] = [];

    this.db.transaction(() => {
      // Clamp deck claims first, ahead of the copies actually leaving. The
      // clamp works off the conflicts detected above either way, and going
      // first means disposeFromLot's alert pass sees availability already
      // reconciled and raises nothing on top of the clamp's own alert.
      resolvedConflicts = conflictMode === 'prompt' && options.force
        ? this.clampDeckAllocations(conflicts)
        : [];

      // OUT — copies leave, disposals logged, trade lists and deck-allocation
      // alerts reconciled.
      let valueOut = 0;
      const requests: DisposalRequest[] = out.map((item) => {
        const unitValue = item.unitValueUsd ?? this.priceFor(item.printingId, item.finish) ?? 0;
        valueOut += unitValue * item.quantity;
        return {
          printingId: item.printingId,
          quantity: item.quantity,
          finish: item.finish,
          condition: item.condition,
          language: item.language,
          sourceCollectionItemId: item.sourceCollectionItemId,
          unitProceedsUsd: unitValue > 0 ? unitValue : null,
        };
      });
      const disposed = this.disposeFromLot(requests, {
        kind: 'trade',
        disposedOn: trade.trade_date,
        tradeId: id,
        counterparty: trade.counterparty_name,
      });
      clampedTradeListItems = disposed.clampedTradeListItems;
      allocationAlerts = disposed.allocationAlerts;
      this.snapshotOutgoing(out, requests, disposed.consumed);

      // IN — copies arrive, wants reconciled.
      let valueIn = 0;
      const defaultLocation = incoming.length > 0 ? this.defaultLocationId() : 0;
      for (const item of incoming) {
        const unitValue = item.unitValueUsd ?? this.priceFor(item.printingId, item.finish) ?? 0;
        valueIn += unitValue * item.quantity;
        this.collection.addLot({
          printingId: item.printingId,
          locationId: item.destinationLocationId ?? defaultLocation,
          quantity: item.quantity,
          finish: item.finish, condition: item.condition, language: item.language,
          acquiredAt: trade.trade_date ?? null,
          acquiredUnitCost: unitValue > 0 ? unitValue : null,
          acquisitionKind: 'trade',
          acquiredFrom: trade.counterparty_name,
        });
        this.snapshotItem(item);
        fulfilledWants.push(...reconcileWants(this.db, this.alerts, item.oracleId, { tradeId: id }));
      }

      // Copies arriving can cover a shortfall an earlier disposal alerted on.
      this.reconcileAllocationAlerts(incoming.map((i) => i.oracleId));

      this.db.prepare(`
        UPDATE trades
           SET status = 'completed',
               completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
               value_out_usd = ?, value_in_usd = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`).run(
        Math.round(valueOut * 100) / 100, Math.round(valueIn * 100) / 100, id);
    })();

    return { completed: true, fulfilledWants, clampedTradeListItems, resolvedConflicts, allocationAlerts };
  }

  /**
   * What stands in the way of the outgoing side leaving.
   *
   * Two different problems, kept apart because they call for different
   * answers. A *shortfall* is an item wanting more copies than its lots hold
   * (the lot was edited or deleted after drafting) — not a decision, just
   * copies that are not there. A *conflict* is a deck using copies that are
   * there — a decision, which `force` makes. Reporting a shortfall as a
   * conflict with nothing allocated would invite the user to "complete anyway"
   * a trade that cannot complete.
   *
   * Shortfalls are judged per item; `disposeFromLot` is the guarantee behind
   * this pre-check, and throws if two items turn out to be drawing on the
   * same copies.
   */
  private detectConflicts(
    out: ReturnType<TradeStore['itemsFor']>,
  ): { conflicts: Conflict[]; shortfalls: Shortfall[] } {
    const shortfalls: Shortfall[] = out
      .filter((item) => item.quantity > item.ownedQuantity)
      .map((item) => ({
        itemId: item.id, oracleId: item.oracleId, name: item.name,
        requested: item.quantity, found: item.ownedQuantity,
      }));

    const byOracle = new Map<string, { name: string; qty: number }>();
    for (const item of out) {
      const entry = byOracle.get(item.oracleId) ?? { name: item.name, qty: 0 };
      entry.qty += item.quantity;
      byOracle.set(item.oracleId, entry);
    }

    // One rollup for every card in the trade, not one per card. allocationFor
    // is allocationForMany over a single id, and each call rebuilds the whole
    // three-CTE collection/trade-list/deck aggregation — so a 40-card trade ran
    // 40 complete rollups to ask 40 questions of the same data.
    const allocation = allocationForMany(this.db, byOracle.keys());

    const conflicts: Conflict[] = [];
    for (const [oracleId, { name, qty }] of byOracle) {
      // allocation.ts owns what "claimed" means: only decks in a reserving
      // status count, and an exempt basic land is claimed by nobody. With no
      // claim at all there is no deck to be in conflict with — copies simply
      // missing are the shortfall above, not this.
      const { owned, reserved: allocated } = allocation.get(oracleId)!;
      if (allocated > 0 && owned - qty < allocated) {
        conflicts.push({ oracleId, name, owned, allocated, tradingAway: qty });
      }
    }
    return { conflicts, shortfalls };
  }

  /**
   * The one path copies take out of the collection.
   *
   * Decrements the source lot(s) oldest-first, records a disposal per lot
   * consumed, then reconciles what the departure invalidates: trade-list
   * quantities that now exceed the lot behind them, and deck claims that now
   * exceed what is owned. Deck claims are never edited here — the shortfall
   * becomes an `allocation_conflict` alert, one per card, keyed so it resolves
   * itself once availability catches up.
   *
   * Every request must be met in full. One that cannot be — the lots hold
   * fewer copies than asked — throws `TradeShortfallError` inside the
   * transaction, so no lot, disposal or trade row is left half-applied.
   *
   * Trade completion calls this; so do Phase 13's sales and Phase 36's offline
   * replay, which have no one to prompt.
   */
  disposeFromLot(requests: DisposalRequest[], context: DisposalContext): DisposeResult {
    return this.db.transaction((): DisposeResult => {
      const consumed: LotConsumption[] = [];
      const shortfalls: Shortfall[] = [];
      const oracleIds = new Set<string>();
      const disposedOn = context.disposedOn ?? new Date().toISOString().slice(0, 10);

      requests.forEach((request, requestIndex) => {
        const finish = request.finish ?? 'nonfoil';
        const condition = request.condition ?? 'unknown';
        const language = request.language ?? 'en';
        const oracleId = this.oracleIdFor(request.printingId);
        if (oracleId) oracleIds.add(oracleId);

        const wanted = Math.max(0, Math.trunc(request.quantity));
        let remaining = wanted;

        // The chosen lot first, as it is now — its finish/condition/language
        // may have been edited since the trade was drafted, and the user's
        // choice of lot is the stronger statement of which copies are meant.
        // Then other matching lots, oldest first.
        const lots = prepared(this.db, `
          SELECT id, quantity, finish, condition, language,
                 acquired_unit_cost, acquired_at, location_id
          FROM collection_items
          WHERE printing_id = ?
            AND ((finish = ? AND condition = ? AND language = ?) OR id = ?)
          ORDER BY (id = ?) DESC, (acquired_at IS NULL), acquired_at ASC, id ASC`)
          .all(request.printingId, finish, condition, language,
               request.sourceCollectionItemId ?? -1,
               request.sourceCollectionItemId ?? -1) as Array<{
            id: number; quantity: number; finish: string; condition: string; language: string;
            acquired_unit_cost: number | null; acquired_at: string | null; location_id: number;
          }>;

        for (const lot of lots) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, lot.quantity);

          prepared(this.db, `
            INSERT INTO collection_disposals
              (printing_id, quantity, finish, condition, language, disposed_on, disposal_kind,
               unit_proceeds_usd, unit_cost_usd, acquired_at, source_lot_id, trade_id,
               counterparty, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            // The lot's own description, not the request's: the disposal log is
            // the record of the copy that physically left.
            request.printingId, take, lot.finish, lot.condition, lot.language, disposedOn, context.kind,
            request.unitProceedsUsd ?? null, lot.acquired_unit_cost, lot.acquired_at,
            lot.id, context.tradeId ?? null, context.counterparty ?? null,
            context.notes ?? null);

          // Copies *leaving* are the conflict case, and this store already has
          // a deliberate policy for it — clamp, or alert and leave the deck
          // alone. Letting the generic reconcile run underneath would resolve
          // that conflict silently and throw away the very signal 'alert' mode
          // exists to raise. Copies arriving are just more availability, so the
          // incoming path reconciles normally.
          this.collection.updateLot(
            lot.id, { quantity: lot.quantity - take }, { reconcileDecks: false },
          );
          consumed.push({ requestIndex, lotId: lot.id, locationId: lot.location_id, quantity: take });
          remaining -= take;
        }

        if (remaining > 0) {
          shortfalls.push({
            oracleId: oracleId ?? '', name: this.cardNameFor(request.printingId),
            requested: wanted, found: wanted - remaining,
          });
        }
      });

      // Thrown inside the transaction: every decrement and disposal above
      // rolls back with it.
      if (shortfalls.length > 0) throw new TradeShortfallError(shortfalls);

      return {
        consumed,
        clampedTradeListItems: this.reconcileTradeLists(oracleIds),
        allocationAlerts: this.reconcileAllocationAlerts(oracleIds),
      };
    })();
  }

  private oracleIdFor(printingId: string): string | null {
    const row = this.db.prepare('SELECT oracle_id FROM card_printings WHERE id = ?')
      .get(printingId) as { oracle_id: string } | undefined;
    return row?.oracle_id ?? null;
  }

  private cardNameFor(printingId: string): string {
    const row = this.db.prepare(
      `SELECT o.name FROM card_printings p JOIN oracle_cards o ON o.oracle_id = p.oracle_id
       WHERE p.id = ?`).get(printingId) as { name: string } | undefined;
    return row?.name ?? printingId;
  }

  /**
   * Brings `allocation_conflict` alerts in line with the contested set.
   *
   * Phase 26 owns the definition (`contention.ts`), and this is the one path
   * that has to call it by hand: the outgoing trade deliberately does not
   * reconcile claims, so that shipping a claimed copy away leaves the deck
   * over-allocated and *visible* rather than silently un-claimed. Returns the
   * shortfalls in the shape the completion result has always reported.
   */
  reconcileAllocationAlerts(oracleIds: Iterable<string>): AllocationShortfall[] {
    return reconcileAlerts(this.db, oracleIds).map((alert) => ({
      oracleId: alert.oracleId,
      name: alert.name,
      owned: alert.owned,
      allocated: alert.allocated,
      short: alert.short,
    }));
  }

  /** Stamps the outgoing trade rows with where the copies came from and what they were. */
  private snapshotOutgoing(
    out: ReturnType<TradeStore['itemsFor']>,
    requests: DisposalRequest[],
    consumed: LotConsumption[],
  ): void {
    out.forEach((item, index) => {
      const primaryLocation = consumed.find((c) => c.requestIndex === index)?.locationId ?? null;
      prepared(this.db, `
        UPDATE trade_items
           SET source_location_id = COALESCE(source_location_id, ?),
               snapshot_name = ?, snapshot_set_code = ?, snapshot_number = ?,
               unit_value_usd = COALESCE(unit_value_usd, ?), price_source = 'market'
         WHERE id = ?`).run(
        primaryLocation, item.name, item.setCode, item.collectorNumber,
        requests[index]?.unitProceedsUsd ?? null, item.id);
    });
  }

  private snapshotItem(item: ReturnType<TradeStore['itemsFor']>[number]): void {
    this.db.prepare(`
      UPDATE trade_items
         SET snapshot_name = ?, snapshot_set_code = ?, snapshot_number = ?
       WHERE id = ?`).run(item.name, item.setCode, item.collectorNumber, item.id);
  }

  /** Reduces decks' claims so no deck claims more copies than are now owned. */
  private clampDeckAllocations(conflicts: Conflict[]): Conflict[] {
    for (const conflict of conflicts) {
      const newOwned = Math.max(0, conflict.owned - conflict.tradingAway);
      let overclaim = conflict.allocated - newOwned;
      if (overclaim <= 0) continue;

      // Only reserving decks are trimmed. A brew's declared claim is the
      // user's intent for a deck that holds no cardboard, and rewriting it here
      // would quietly lose that intent over a trade it had no part in.
      const statuses = reservingStatuses(allocationSettings(this.db))
        .map((status) => `'${status}'`).join(',');
      const claims = prepared(this.db, `
        SELECT dc.id, dc.quantity_from_collection AS q, d.name AS deck_name
        FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
        WHERE dc.oracle_id = ? AND dc.board IN ('main','side','command')
          AND dc.quantity_from_collection > 0
          AND d.status IN (${statuses})
        ORDER BY dc.quantity_from_collection DESC`).all(conflict.oracleId) as Array<{
          id: number; q: number; deck_name: string;
        }>;

      for (const claim of claims) {
        if (overclaim <= 0) break;
        const reduce = Math.min(claim.q, overclaim);
        prepared(this.db, 'UPDATE deck_cards SET quantity_from_collection = ? WHERE id = ?')
          .run(claim.q - reduce, claim.id);
        overclaim -= reduce;
      }

      this.alerts.raise({
        kind: 'allocation_conflict',
        dedupeKey: `allocation_conflict:${conflict.oracleId}:${Date.now()}`,
        subjectType: 'trade', title: `Deck claim reduced: ${conflict.name}`,
        message: `Traded away ${conflict.tradingAway}; decks now claim only what you still own (${newOwned}).`,
        payload: conflict,
      });
    }
    return conflicts;
  }

  /**
   * Clamps trade-list quantities that now exceed what the owning lot holds.
   *
   * `oracleIds` is the set of cards this trade moved, and it now reaches the
   * WHERE clause. It used to gate entry and then be ignored, so completing any
   * trade scanned every over-stated trade-list row in the database and raised
   * an alert for each — including rows about cards the trade never touched,
   * which the user would see attributed to a trade they had just made.
   */
  private reconcileTradeLists(oracleIds: Set<string>): number {
    if (oracleIds.size === 0) return 0;
    let clamped = 0;
    const ids = [...oracleIds];
    const rows = this.db.prepare(`
      SELECT tli.id, tli.quantity, ci.quantity AS owned, o.name
      FROM trade_list_items tli
      JOIN collection_items ci ON ci.id = tli.collection_item_id
      JOIN card_printings p ON p.id = ci.printing_id
      JOIN oracle_cards o ON o.oracle_id = p.oracle_id
      WHERE tli.quantity > ci.quantity
        AND o.oracle_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Array<{
        id: number; quantity: number; owned: number; name: string;
      }>;

    for (const row of rows) {
      prepared(this.db, 'UPDATE trade_list_items SET quantity = ? WHERE id = ?')
        .run(row.owned, row.id);
      this.alerts.raise({
        kind: 'trade_list_clamped',
        dedupeKey: `trade_list_clamped:${row.id}:${Date.now()}`,
        subjectType: 'trade_list_item', subjectId: row.id,
        title: `Trade-list quantity clamped: ${row.name}`,
        message: `Listed ${row.quantity}, but you now own ${row.owned}. Clamped to ${row.owned}.`,
      });
      clamped += 1;
    }
    return clamped;
  }
}
