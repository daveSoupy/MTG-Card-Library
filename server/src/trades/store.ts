import type Database from 'better-sqlite3';
import type { CollectionStore, Finish, Condition } from '../collection/store.ts';
import type { AlertStore } from '../alerts/store.ts';
import { reconcileWants, type FulfilledWant } from '../collection/wants.ts';

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
export type Direction = 'out' | 'in';

export class TradeNotFoundError extends Error {
  constructor(id: number) { super(`No trade with id ${id}.`); this.name = 'TradeNotFoundError'; }
}
export class TradeNotDraftError extends Error {
  constructor() { super('Only a draft trade can be changed.'); this.name = 'TradeNotDraftError'; }
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

export interface Conflict {
  oracleId: string;
  name: string;
  owned: number;
  allocated: number;
  tradingAway: number;
}

export interface CompleteResult {
  completed: boolean;
  needsConfirmation?: boolean;
  conflicts?: Conflict[];
  fulfilledWants?: FulfilledWant[];
  clampedTradeListItems?: number;
  resolvedConflicts?: Conflict[];
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
      VALUES (?,?,?,?,?)`).run(
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

  update(id: number, changes: Record<string, unknown>): void {
    this.requireDraft(id);
    const columns: Record<string, string> = {
      counterpartyName: 'counterparty_name', counterpartyContact: 'counterparty_contact',
      tradeDate: 'trade_date', locationNote: 'location_note', notes: 'notes',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (changes[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(changes[key]);
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

  addItem(tradeId: number, item: TradeItemInput): number {
    this.requireDraft(tradeId);
    const result = this.db.prepare(`
      INSERT INTO trade_items
        (trade_id, direction, printing_id, quantity, finish, condition, language,
         source_collection_item_id, destination_location_id, unit_value_usd, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      tradeId, item.direction, item.printingId, Math.max(1, Math.trunc(item.quantity)),
      item.finish ?? 'nonfoil', item.condition ?? 'unknown', item.language ?? 'en',
      item.sourceCollectionItemId ?? null, item.destinationLocationId ?? null,
      item.unitValueUsd ?? null, item.notes ?? null);
    return Number(result.lastInsertRowid);
  }

  updateItem(tradeId: number, itemId: number, changes: Record<string, unknown>): void {
    this.requireDraft(tradeId);
    const columns: Record<string, string> = {
      quantity: 'quantity', finish: 'finish', condition: 'condition', language: 'language',
      sourceCollectionItemId: 'source_collection_item_id',
      destinationLocationId: 'destination_location_id',
      unitValueUsd: 'unit_value_usd', notes: 'notes',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (changes[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(changes[key]);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE trade_items SET ${sets.join(', ')} WHERE id = ? AND trade_id = ?`)
      .run(...params, itemId, tradeId);
  }

  removeItem(tradeId: number, itemId: number): void {
    this.requireDraft(tradeId);
    this.db.prepare('DELETE FROM trade_items WHERE id = ? AND trade_id = ?').run(itemId, tradeId);
  }

  // -- reads -----------------------------------------------------------------

  list(options: { status?: TradeStatus } = {}) {
    const rows = options.status
      ? this.db.prepare(`
          SELECT * FROM trades WHERE status = ?
          ORDER BY COALESCE(completed_at, trade_date, created_at) DESC, id DESC`).all(options.status)
      : this.db.prepare(`
          SELECT * FROM trades
          ORDER BY (status = 'draft') DESC,
                   COALESCE(completed_at, trade_date, created_at) DESC, id DESC`).all();
    return (rows as any[]).map((t) => this.summarise(t));
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
    };
  }

  private itemsFor(tradeId: number) {
    const rows = this.db.prepare(`
      SELECT ti.*, o.oracle_id, o.name AS card_name, o.mana_cost,
             p.set_code, p.collector_number,
             COALESCE(p.image_small, ff.image_small) AS image_small,
             CASE ti.finish WHEN 'foil' THEN p.price_usd_foil
                            WHEN 'etched' THEN p.price_usd_etched
                            ELSE p.price_usd END AS market_usd
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
   * completes. Returns a confirmation request instead of acting when an outgoing
   * card is claimed by a deck and `force` was not given.
   */
  complete(id: number, options: { force?: boolean } = {}): CompleteResult {
    const trade = this.requireDraft(id);
    const items = this.itemsFor(id);
    const out = items.filter((i) => i.direction === 'out');
    const incoming = items.filter((i) => i.direction === 'in');

    const conflicts = this.detectConflicts(out);
    if (conflicts.length > 0 && !options.force) {
      return { completed: false, needsConfirmation: true, conflicts };
    }

    const fulfilledWants: FulfilledWant[] = [];
    let clampedTradeListItems = 0;
    let resolvedConflicts: Conflict[] = [];

    this.db.transaction(() => {
      // OUT — copies leave, disposals logged.
      let valueOut = 0;
      for (const item of out) {
        const unitValue = item.unitValueUsd ?? this.priceFor(item.printingId, item.finish) ?? 0;
        valueOut += unitValue * item.quantity;
        this.disposeOut(id, trade.counterparty_name, trade.trade_date, item, unitValue);
      }

      // Force-resolve deck conflicts by clamping the deck's claim.
      resolvedConflicts = options.force ? this.clampDeckAllocations(conflicts) : [];

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

      // Reconcile trade lists against the new owned quantities.
      const affectedOracles = new Set(out.map((i) => i.oracleId));
      clampedTradeListItems = this.reconcileTradeLists(affectedOracles);

      this.db.prepare(`
        UPDATE trades
           SET status = 'completed',
               completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
               value_out_usd = ?, value_in_usd = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ?`).run(
        Math.round(valueOut * 100) / 100, Math.round(valueIn * 100) / 100, id);
    })();

    return { completed: true, fulfilledWants, clampedTradeListItems, resolvedConflicts };
  }

  /** Outgoing cards that a deck is currently using. */
  private detectConflicts(out: ReturnType<TradeStore['itemsFor']>): Conflict[] {
    const byOracle = new Map<string, { name: string; qty: number }>();
    for (const item of out) {
      const entry = byOracle.get(item.oracleId) ?? { name: item.name, qty: 0 };
      entry.qty += item.quantity;
      byOracle.set(item.oracleId, entry);
    }

    const conflicts: Conflict[] = [];
    for (const [oracleId, { name, qty }] of byOracle) {
      const avail = this.db.prepare(
        `SELECT owned_qty, allocated_qty FROM v_card_availability WHERE oracle_id = ?`,
      ).get(oracleId) as { owned_qty: number; allocated_qty: number } | undefined;
      const owned = avail?.owned_qty ?? 0;
      const allocated = avail?.allocated_qty ?? 0;
      if (owned - qty < allocated) {
        conflicts.push({ oracleId, name, owned, allocated, tradingAway: qty });
      }
    }
    return conflicts;
  }

  /** Decrements the source lot(s) FIFO and records a disposal per lot consumed. */
  private disposeOut(
    tradeId: number, counterparty: string, tradeDate: string | null,
    item: ReturnType<TradeStore['itemsFor']>[number], unitValue: number,
  ): void {
    let remaining = item.quantity;

    // Prefer the chosen lot, then fall back to other matching lots, oldest first.
    const lots = this.db.prepare(`
      SELECT id, quantity, acquired_unit_cost, acquired_at, location_id
      FROM collection_items
      WHERE printing_id = ? AND finish = ? AND condition = ? AND language = ?
      ORDER BY (id = ?) DESC, (acquired_at IS NULL), acquired_at ASC, id ASC`)
      .all(item.printingId, item.finish, item.condition, item.language,
           item.sourceCollectionItemId ?? -1) as Array<{
        id: number; quantity: number; acquired_unit_cost: number | null;
        acquired_at: string | null; location_id: number;
      }>;

    let primaryLocation: number | null = null;
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.quantity);
      primaryLocation ??= lot.location_id;

      this.db.prepare(`
        INSERT INTO collection_disposals
          (printing_id, quantity, finish, condition, language, disposed_on, disposal_kind,
           unit_proceeds_usd, unit_cost_usd, acquired_at, source_lot_id, trade_id, counterparty)
        VALUES (?,?,?,?,?,?, 'trade', ?,?,?,?,?,?)`).run(
        item.printingId, take, item.finish, item.condition, item.language,
        tradeDate ?? new Date().toISOString().slice(0, 10),
        unitValue > 0 ? unitValue : null, lot.acquired_unit_cost, lot.acquired_at,
        lot.id, tradeId, counterparty);

      this.collection.updateLot(lot.id, { quantity: lot.quantity - take });
      remaining -= take;
    }

    this.db.prepare(`
      UPDATE trade_items
         SET source_location_id = COALESCE(source_location_id, ?),
             snapshot_name = ?, snapshot_set_code = ?, snapshot_number = ?,
             unit_value_usd = COALESCE(unit_value_usd, ?), price_source = 'market'
       WHERE id = ?`).run(
      primaryLocation, item.name, item.setCode, item.collectorNumber,
      unitValue > 0 ? unitValue : null, item.id);
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

      const claims = this.db.prepare(`
        SELECT dc.id, dc.quantity_from_collection AS q, d.name AS deck_name
        FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
        WHERE dc.oracle_id = ? AND dc.board IN ('main','side','command')
          AND dc.quantity_from_collection > 0
        ORDER BY dc.quantity_from_collection DESC`).all(conflict.oracleId) as Array<{
          id: number; q: number; deck_name: string;
        }>;

      for (const claim of claims) {
        if (overclaim <= 0) break;
        const reduce = Math.min(claim.q, overclaim);
        this.db.prepare('UPDATE deck_cards SET quantity_from_collection = ? WHERE id = ?')
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

  /** Clamps trade-list quantities that now exceed what the owning lot holds. */
  private reconcileTradeLists(oracleIds: Set<string>): number {
    if (oracleIds.size === 0) return 0;
    let clamped = 0;
    const rows = this.db.prepare(`
      SELECT tli.id, tli.quantity, ci.quantity AS owned, o.name
      FROM trade_list_items tli
      JOIN collection_items ci ON ci.id = tli.collection_item_id
      JOIN card_printings p ON p.id = ci.printing_id
      JOIN oracle_cards o ON o.oracle_id = p.oracle_id
      WHERE tli.quantity > ci.quantity`).all() as Array<{
        id: number; quantity: number; owned: number; name: string;
      }>;

    for (const row of rows) {
      this.db.prepare('UPDATE trade_list_items SET quantity = ? WHERE id = ?')
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
