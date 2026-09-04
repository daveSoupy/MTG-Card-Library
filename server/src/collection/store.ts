import type Database from 'better-sqlite3';

/**
 * Reads and writes the collection.
 *
 * `collection_items` is lot-grained — one row per purchase, not one per stack —
 * so almost everything here aggregates upward. Three tiers, the same shape the
 * deck view uses: card → printing → individual lots.
 */

export type Finish = 'nonfoil' | 'foil' | 'etched';
export const FINISHES: Finish[] = ['nonfoil', 'foil', 'etched'];

export type Condition = 'M' | 'NM' | 'LP' | 'MP' | 'HP' | 'DMG' | 'unknown';
export const CONDITIONS: Condition[] = ['M', 'NM', 'LP', 'MP', 'HP', 'DMG', 'unknown'];

export type AcquisitionKind = 'purchase' | 'trade' | 'gift' | 'pull' | 'unknown';
export const ACQUISITION_KINDS: AcquisitionKind[] = ['purchase', 'trade', 'gift', 'pull', 'unknown'];

/**
 * How to assume a per-copy cost basis when it isn't typed in by hand.
 * - unknown: record nothing (NULL) — excluded from cost and gain
 * - free:    zero — gifts, pack pulls; full market value reads as gain
 * - market:  snapshot the printing's current price (finish-aware) at add time
 * - fixed:   a configured dollar amount
 * - box:     a lump sum split evenly across every copy in a cost pool (batch)
 */
export type CostMethod = 'unknown' | 'free' | 'market' | 'fixed' | 'box';
export const COST_METHODS: CostMethod[] = ['unknown', 'free', 'market', 'fixed', 'box'];

export class LocationInUseError extends Error {
  readonly cardCount: number;
  constructor(name: string, cardCount: number) {
    super(`"${name}" still holds ${cardCount} card${cardCount === 1 ? '' : 's'}. Move them somewhere else first.`);
    this.name = 'LocationInUseError';
    this.cardCount = cardCount;
  }
}

export interface CollectionFilters {
  locationId?: number;
  setCode?: string;
  /** Free text against the card name. */
  query?: string;
  /** Only cards with copies free of any deck's claim. */
  unallocatedOnly?: boolean;
}

export type CollectionSort = 'name' | 'value' | 'quantity' | 'recent' | 'setNumber';

const SORT_SQL: Record<CollectionSort, string> = {
  name: 'o.name COLLATE NOCASE ASC',
  value: 'value_usd DESC, o.name COLLATE NOCASE ASC',
  quantity: 'owned_qty DESC, o.name COLLATE NOCASE ASC',
  recent: 'last_added DESC, o.name COLLATE NOCASE ASC',
  // Binder order: set, then collector number as a number rather than a string.
  setNumber: 'min_set ASC, min_number ASC, o.name COLLATE NOCASE ASC',
};

export class CollectionStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // -- storage locations -----------------------------------------------------

  locations() {
    return this.db.prepare(`
      SELECT l.id, l.name, l.kind, l.notes, l.is_default, l.is_archived, l.sort_order,
             COALESCE(SUM(ci.quantity), 0) AS card_count,
             COUNT(DISTINCT ci.printing_id) AS distinct_printings,
             COALESCE(SUM(v.line_value_usd), 0) AS value_usd
      FROM storage_locations l
      LEFT JOIN collection_items ci ON ci.location_id = l.id
      LEFT JOIN v_collection_item_value v ON v.collection_item_id = ci.id
      GROUP BY l.id
      ORDER BY l.is_archived, l.sort_order, l.name COLLATE NOCASE`).all() as any[];
  }

  createLocation(input: { name: string; kind?: string; notes?: string | null }): number {
    const result = this.db.prepare(
      'INSERT INTO storage_locations (name, kind, notes) VALUES (?,?,?)',
    ).run(input.name.trim(), input.kind ?? 'other', input.notes ?? null);
    return Number(result.lastInsertRowid);
  }

  updateLocation(
    id: number,
    changes: { name?: string; kind?: string; notes?: string | null; isArchived?: boolean },
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name.trim()); }
    if (changes.kind !== undefined) { sets.push('kind = ?'); params.push(changes.kind); }
    if (changes.notes !== undefined) { sets.push('notes = ?'); params.push(changes.notes); }
    if (changes.isArchived !== undefined) { sets.push('is_archived = ?'); params.push(changes.isArchived ? 1 : 0); }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE storage_locations SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  /**
   * Deleting a location refuses while it still holds cards.
   *
   * The schema's foreign key is RESTRICT on purpose — silently cascading would
   * delete the collection rows, which is real data, to remove a label.
   */
  deleteLocation(id: number): void {
    const row = this.db.prepare(`
      SELECT l.name, COALESCE(SUM(ci.quantity), 0) AS cards
      FROM storage_locations l
      LEFT JOIN collection_items ci ON ci.location_id = l.id
      WHERE l.id = ? GROUP BY l.id`).get(id) as { name: string; cards: number } | undefined;
    if (!row) return;
    if (row.cards > 0) throw new LocationInUseError(row.name, row.cards);
    this.db.prepare('DELETE FROM storage_locations WHERE id = ?').run(id);
  }

  /** Moves every card from one location to another, merging identical lots. */
  moveLocationContents(fromId: number, toId: number): number {
    return this.db.transaction(() => {
      const moved = (this.db.prepare(
        'SELECT COALESCE(SUM(quantity), 0) AS n FROM collection_items WHERE location_id = ?',
      ).get(fromId) as { n: number }).n;
      this.db.prepare('UPDATE collection_items SET location_id = ? WHERE location_id = ?')
        .run(toId, fromId);
      return moved;
    })();
  }

  // -- browsing --------------------------------------------------------------

  /** Tier one: a row per card, aggregated across printings and lots. */
  browse(filters: CollectionFilters = {}, sort: CollectionSort = 'name', limit = 100, offset = 0) {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters.locationId !== undefined) { where.push('v.location_id = ?'); params.push(filters.locationId); }
    if (filters.setCode) { where.push('p.set_code = ?'); params.push(filters.setCode); }
    if (filters.query) { where.push('o.name_normalized LIKE ?'); params.push(`%${filters.query}%`); }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // One row per printing *and* finish, not per card name: different art (and
    // a foil vs. its nonfoil) are genuinely different objects worth very
    // different money, so each gets its own tile rather than being summed
    // together under the oracle name.
    const from = `
      FROM v_collection_item_value v
      JOIN card_printings p ON p.id = v.printing_id
      JOIN oracle_cards o ON o.oracle_id = v.oracle_id
      LEFT JOIN sets s ON s.code = p.set_code
      ${whereSql}
      GROUP BY v.printing_id, v.finish`;

    const rows = this.db.prepare(`
      SELECT o.oracle_id, o.name, o.mana_cost, o.cmc, o.type_line, o.color_identity,
             v.printing_id, v.finish,
             p.set_code, s.name AS set_name, p.collector_number,
             SUM(v.quantity) AS owned_qty,
             0 AS allocated_qty,
             SUM(v.quantity) AS available_qty,
             SUM(v.line_value_usd) AS value_usd,
             SUM(v.line_cost_basis_usd) AS cost_usd,
             SUM(v.unrealized_gain_usd) AS gain_usd,
             1 AS printing_count,
             COUNT(DISTINCT v.location_id) AS location_count,
             COUNT(*) AS lot_count,
             MAX(COALESCE(v.acquired_at, '')) AS last_added,
             p.set_code AS min_set,
             COALESCE(p.collector_number_num, 999999) AS min_number,
             COALESCE(p.image_small,
                      (SELECT ff.image_small FROM card_faces ff
                        WHERE ff.printing_id = p.id AND ff.face_index = 0)) AS image_small
      ${from}
      ORDER BY ${SORT_SQL[sort]}
      LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];

    const totals = this.db.prepare(`
      SELECT COUNT(*) AS distinct_cards, COALESCE(SUM(cards), 0) AS total_cards,
             COALESCE(SUM(value), 0) AS total_value
      FROM (SELECT SUM(v.quantity) AS cards, SUM(v.line_value_usd) AS value ${from})`)
      .get(...params) as any;

    return {
      cards: rows.map(toCollectionCard),
      distinctCards: totals.distinct_cards,
      totalCards: totals.total_cards,
      totalValue: totals.total_value,
      limit,
      offset,
    };
  }

  /** Tiers two and three: every printing and every lot for one card. */
  cardDetail(oracleId: string) {
    const printings = this.db.prepare(`
      SELECT v.printing_id, v.finish, p.set_code, s.name AS set_name, p.collector_number,
             p.rarity, p.price_usd, p.price_usd_foil, p.image_small,
             SUM(v.quantity) AS owned_qty,
             SUM(v.line_value_usd) AS value_usd,
             SUM(v.line_cost_basis_usd) AS cost_usd
      FROM v_collection_item_value v
      JOIN card_printings p ON p.id = v.printing_id
      LEFT JOIN sets s ON s.code = p.set_code
      WHERE v.oracle_id = ?
      GROUP BY v.printing_id, v.finish
      ORDER BY COALESCE(p.released_at,'0000-00-00') DESC, p.collector_number_num`)
      .all(oracleId) as any[];

    const lots = this.db.prepare(`
      SELECT v.collection_item_id AS id, v.printing_id, v.quantity, v.finish, v.condition,
             v.language, v.unit_value_usd, v.line_value_usd, v.is_overridden,
             v.acquired_unit_cost, v.acquired_at, v.acquisition_kind, v.unrealized_gain_usd,
             ci.price_override, ci.acquired_from, ci.notes,
             l.id AS location_id, l.name AS location_name,
             p.set_code, s.name AS set_name, p.collector_number
      FROM v_collection_item_value v
      JOIN collection_items ci ON ci.id = v.collection_item_id
      JOIN storage_locations l ON l.id = v.location_id
      JOIN card_printings p ON p.id = v.printing_id
      LEFT JOIN sets s ON s.code = p.set_code
      WHERE v.oracle_id = ?
      ORDER BY l.name COLLATE NOCASE, p.set_code, v.finish, COALESCE(v.acquired_at,'')`)
      .all(oracleId) as any[];

    // "Deck A ×2 (home: Blue Tackle Box), Binder 3 ×2 available" — the exact
    // breakdown CLAUDE.md asks for, from the views built in Phase 1.
    const decks = this.db.prepare(`
      SELECT deck_id, deck_name, board, qty_from_collection, deck_home_location
      FROM v_card_deck_usage WHERE oracle_id = ? ORDER BY deck_name`).all(oracleId) as any[];

    const availability = this.db.prepare(
      'SELECT owned_qty, allocated_qty, available_qty FROM v_card_availability WHERE oracle_id = ?',
    ).get(oracleId) as any;

    return { printings, lots, decks, availability: availability ?? null };
  }

  // -- editing ---------------------------------------------------------------

  /**
   * Adds copies.
   *
   * Merges into an existing lot only when everything about it matches,
   * including the purchase price and date — a different price is a different
   * lot, which is the whole reason the table is lot-grained.
   */
  addLot(input: {
    printingId: string;
    locationId: number;
    quantity: number;
    finish?: Finish;
    condition?: Condition;
    language?: string;
    priceOverride?: number | null;
    acquiredAt?: string | null;
    acquiredUnitCost?: number | null;
    acquisitionKind?: AcquisitionKind;
    acquiredFrom?: string | null;
    notes?: string | null;
    importBatchId?: number | null;
    /** Assume the cost basis when acquiredUnitCost isn't given explicitly. */
    costMethod?: CostMethod;
    /** The amount for the 'fixed' method. */
    fixedAmount?: number | null;
  }): number {
    const finish = input.finish ?? 'nonfoil';
    const condition = input.condition ?? 'NM';
    const language = input.language ?? 'en';
    const quantity = Math.max(1, Math.trunc(input.quantity));
    // A typed-in cost always wins; otherwise assume one from the method. 'box'
    // resolves to NULL here and is set by the pool re-split after insert.
    const unitCost = input.acquiredUnitCost !== undefined && input.acquiredUnitCost !== null
      ? input.acquiredUnitCost
      : this.assumeUnitCost(input.printingId, finish, input.costMethod, input.fixedAmount);

    // In a cost pool the per-copy cost is managed by the re-split, not fixed at
    // add time, so two copies of the same card must still merge even though the
    // running cost has moved — match without the cost predicate for pool adds.
    const poolManaged = input.costMethod === 'box' && input.importBatchId != null;

    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id, quantity FROM collection_items
        WHERE printing_id = ? AND location_id = ? AND finish = ? AND condition = ?
          AND language = ?
          ${poolManaged ? '' : 'AND COALESCE(acquired_unit_cost, -1) = COALESCE(?, -1)'}
          AND COALESCE(acquired_at, '') = COALESCE(?, '')
          AND COALESCE(price_override, -1) = COALESCE(?, -1)
          -- Batch is part of the identity so an import stays undoable: merging
          -- its rows into pre-existing ones would make the undo take copies
          -- the import never added.
          AND COALESCE(import_batch_id, -1) = COALESCE(?, -1)`)
        .get(input.printingId, input.locationId, finish, condition, language,
             ...(poolManaged ? [] : [unitCost]), input.acquiredAt ?? null,
             input.priceOverride ?? null, input.importBatchId ?? null,
        ) as { id: number; quantity: number } | undefined;

      let lotId: number;
      if (existing) {
        this.db.prepare('UPDATE collection_items SET quantity = ? WHERE id = ?')
          .run(existing.quantity + quantity, existing.id);
        lotId = existing.id;
      } else {
        const result = this.db.prepare(`
          INSERT INTO collection_items
            (printing_id, location_id, quantity, finish, condition, language, price_override,
             acquired_at, acquired_unit_cost, acquisition_kind, acquired_from, notes,
             import_batch_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(input.printingId, input.locationId, quantity, finish, condition, language,
               input.priceOverride ?? null, input.acquiredAt ?? null,
               unitCost, input.acquisitionKind ?? 'unknown',
               input.acquiredFrom ?? null, input.notes ?? null,
               input.importBatchId ?? null);
        lotId = Number(result.lastInsertRowid);
      }

      // A cost-pool ('box') batch spreads its lump sum evenly across every copy
      // it holds, so each added lot re-divides the total over the new count.
      if (input.importBatchId != null) this.resplitCostPool(input.importBatchId);
      return lotId;
    })();
  }

  /**
   * Resolves an assumed per-copy cost basis from the method. Returns NULL for
   * 'unknown' and 'box' (box is set later by the pool re-split), and for
   * 'market'/'fixed' when no price is available.
   */
  private assumeUnitCost(
    printingId: string,
    finish: Finish,
    method: CostMethod | undefined,
    fixedAmount: number | null | undefined,
  ): number | null {
    switch (method) {
      case 'free':
        return 0;
      case 'fixed':
        return fixedAmount != null && fixedAmount >= 0 ? fixedAmount : null;
      case 'market': {
        const row = this.db.prepare(
          'SELECT price_usd, price_usd_foil FROM card_printings WHERE id = ?',
        ).get(printingId) as { price_usd: number | null; price_usd_foil: number | null } | undefined;
        const price = finish === 'nonfoil' ? row?.price_usd : row?.price_usd_foil;
        return price ?? null;
      }
      case 'box':
      case 'unknown':
      default:
        return null;
    }
  }

  /**
   * Opens a cost pool — an import batch carrying a lump sum to spread across the
   * copies later added to it (the 'box' cost method). Returns the batch id.
   */
  openCostPool(input: { totalCostUsd: number; notes?: string | null }): number {
    const total = Math.max(0, input.totalCostUsd);
    const result = this.db.prepare(`
      INSERT INTO import_batches (source, total_cost_usd, split_method, notes)
      VALUES ('manual', ?, 'even', ?)`)
      .run(total, input.notes ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Re-divides a cost pool's total evenly over every copy it now holds. */
  private resplitCostPool(batchId: number): void {
    const batch = this.db.prepare(
      'SELECT total_cost_usd FROM import_batches WHERE id = ?',
    ).get(batchId) as { total_cost_usd: number | null } | undefined;
    if (!batch || batch.total_cost_usd == null) return; // ordinary import batch

    const { qty } = this.db.prepare(
      'SELECT COALESCE(SUM(quantity), 0) AS qty FROM collection_items WHERE import_batch_id = ?',
    ).get(batchId) as { qty: number };
    if (qty <= 0) return;

    const perCopy = batch.total_cost_usd / qty;
    this.db.prepare(
      `UPDATE collection_items
          SET acquired_unit_cost = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE import_batch_id = ?`,
    ).run(perCopy, batchId);
  }

  updateLot(id: number, changes: Record<string, unknown>): void {
    const columns: Record<string, string> = {
      quantity: 'quantity', locationId: 'location_id', finish: 'finish',
      condition: 'condition', language: 'language', priceOverride: 'price_override',
      acquiredAt: 'acquired_at', acquiredUnitCost: 'acquired_unit_cost',
      acquisitionKind: 'acquisition_kind', acquiredFrom: 'acquired_from', notes: 'notes',
    };

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (changes[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(changes[key]);
    }
    if (sets.length === 0) return;

    // Quantity 0 means "gone", which the CHECK constraint would otherwise
    // reject; deleting the lot is what the user means.
    if (changes.quantity !== undefined && Number(changes.quantity) <= 0) {
      this.removeLot(id);
      return;
    }
    this.db.prepare(`UPDATE collection_items SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  removeLot(id: number): void {
    this.db.prepare('DELETE FROM collection_items WHERE id = ?').run(id);
  }

  /**
   * Removes one copy of a plainly-added card — the undo for the tap-to-add,
   * add-by-set flow. Targets the same lot addLot would have merged into (no cost
   * basis, no override, not from an import), decrementing it or deleting it at
   * zero. Never touches a lot that carries a purchase price, so a mis-tap can't
   * quietly erase cost history. Returns the copies now owned there, or null when
   * there was nothing to remove.
   */
  decrementCopy(input: {
    printingId: string; locationId: number; finish?: Finish; condition?: Condition; language?: string;
  }): number | null {
    const finish = input.finish ?? 'nonfoil';
    const condition = input.condition ?? 'NM';
    const language = input.language ?? 'en';

    return this.db.transaction(() => {
      const lot = this.db.prepare(`
        SELECT id, quantity FROM collection_items
        WHERE printing_id = ? AND location_id = ? AND finish = ? AND condition = ? AND language = ?
          AND acquired_unit_cost IS NULL AND acquired_at IS NULL
          AND price_override IS NULL AND import_batch_id IS NULL
        ORDER BY id DESC LIMIT 1`)
        .get(input.printingId, input.locationId, finish, condition, language) as
        | { id: number; quantity: number } | undefined;
      if (!lot) return null;

      if (lot.quantity > 1) {
        this.db.prepare('UPDATE collection_items SET quantity = ? WHERE id = ?')
          .run(lot.quantity - 1, lot.id);
        return lot.quantity - 1;
      }
      this.db.prepare('DELETE FROM collection_items WHERE id = ?').run(lot.id);
      return 0;
    })();
  }

  // -- value -----------------------------------------------------------------

  value() {
    const totals = this.db.prepare('SELECT * FROM v_collection_value').get() as any;
    const pnl = this.db.prepare('SELECT * FROM v_collection_pnl').get() as any;
    return { ...totals, ...pnl };
  }

  history(limit = 180) {
    return this.db.prepare(`
      SELECT captured_on, total_value_usd, total_cost_basis_usd, realized_gain_to_date_usd,
             total_cards, distinct_cards, cost_known_cards
      FROM collection_value_snapshots
      ORDER BY captured_on DESC LIMIT ?`).all(limit).reverse() as any[];
  }

  /**
   * Writes today's snapshot. Called after a price sync and available manually.
   * One row per day — a second call the same day updates it.
   */
  takeSnapshot(): { capturedOn: string; totalValue: number } {
    const today = new Date().toISOString().slice(0, 10);
    const totals = this.db.prepare('SELECT * FROM v_collection_value').get() as any;
    const realized = this.db.prepare(
      'SELECT COALESCE(SUM(realized_gain_usd), 0) AS gain FROM v_realized_gains',
    ).get() as { gain: number };

    this.db.prepare(`
      INSERT INTO collection_value_snapshots
        (captured_on, captured_at, total_value_usd, total_cards, distinct_printings,
         distinct_cards, total_cost_basis_usd, cost_known_cards, realized_gain_to_date_usd)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?,?,?,?,?,?,?)
      ON CONFLICT(captured_on) DO UPDATE SET
        captured_at = excluded.captured_at,
        total_value_usd = excluded.total_value_usd,
        total_cards = excluded.total_cards,
        distinct_printings = excluded.distinct_printings,
        distinct_cards = excluded.distinct_cards,
        total_cost_basis_usd = excluded.total_cost_basis_usd,
        cost_known_cards = excluded.cost_known_cards,
        realized_gain_to_date_usd = excluded.realized_gain_to_date_usd`)
      .run(today, totals?.total_value_usd ?? 0, totals?.total_cards ?? 0,
           totals?.distinct_printings ?? 0, totals?.distinct_cards ?? 0,
           totals?.total_cost_basis_usd ?? null, totals?.cost_known_cards ?? 0,
           realized.gain);

    return { capturedOn: today, totalValue: totals?.total_value_usd ?? 0 };
  }

  // -- set completion --------------------------------------------------------

  setCompletion(limit = 60, ownedOnly = true) {
    return this.db.prepare(`
      SELECT set_code, set_name, total_cards, owned_printings, percent_complete
      FROM v_set_completion
      ${ownedOnly ? 'WHERE owned_printings > 0' : ''}
      ORDER BY percent_complete DESC, set_name
      LIMIT ?`).all(limit) as any[];
  }

  /** Every card in a set, with how many you own — the checklist view. */
  setChecklist(setCode: string) {
    return this.db.prepare(`
      SELECT p.id AS printing_id, p.collector_number, p.collector_number_num,
             p.rarity, p.price_usd, p.image_small, o.oracle_id, o.name, o.mana_cost,
             COALESCE(owned.qty, 0) AS owned_qty
      FROM card_printings p
      JOIN oracle_cards o ON o.oracle_id = p.oracle_id
      LEFT JOIN (
          SELECT printing_id, SUM(quantity) AS qty FROM collection_items GROUP BY printing_id
      ) owned ON owned.printing_id = p.id
      WHERE p.set_code = ?
      ORDER BY p.collector_number_num, p.collector_number`).all(setCode) as any[];
  }
}

function toCollectionCard(row: any) {
  return {
    oracleId: row.oracle_id,
    name: row.name,
    manaCost: row.mana_cost,
    cmc: row.cmc,
    typeLine: row.type_line,
    colorIdentity: row.color_identity ?? '',
    ownedQuantity: row.owned_qty,
    allocatedQuantity: row.allocated_qty,
    availableQuantity: row.available_qty,
    valueUsd: row.value_usd,
    costUsd: row.cost_usd,
    gainUsd: row.gain_usd,
    printingCount: row.printing_count,
    locationCount: row.location_count,
    lotCount: row.lot_count,
    printingId: row.printing_id,
    finish: row.finish,
    setCode: row.set_code,
    setName: row.set_name,
    collectorNumber: row.collector_number,
    imageSmall: row.image_small,
  };
}
