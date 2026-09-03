import type Database from 'better-sqlite3';
import type { AlertStore } from '../alerts/store.ts';
import { wantList } from './shopping.ts';

/**
 * Reconciling want lists against what you now own.
 *
 * A want is "satisfied" once the collection holds at least as many copies as the
 * entry asks for — whether those copies arrived through a completed trade or a
 * plain collection edit. Satisfied entries are marked fulfilled (which drops
 * them off the active list and, with them, the deck-linked "still needed" note),
 * and an alert records it. Shared so trade completion and the collection routes
 * behave identically, exactly as the spec requires.
 */

export interface FulfilledWant {
  wantListItemId: number;
  wantListId: number;
  oracleId: string;
  name: string;
  quantity: number;
}

export function reconcileWants(
  db: Database.Database,
  alerts: AlertStore,
  oracleId: string,
  options: { tradeId?: number } = {},
): FulfilledWant[] {
  const candidates = db.prepare(`
    SELECT w.id, w.want_list_id, w.quantity, o.name,
           COALESCE(owned.qty, 0) AS owned_qty
    FROM want_list_items w
    JOIN oracle_cards o ON o.oracle_id = w.oracle_id
    LEFT JOIN (
        SELECT p.oracle_id, SUM(ci.quantity) AS qty
        FROM collection_items ci JOIN card_printings p ON p.id = ci.printing_id
        WHERE p.oracle_id = ?
        GROUP BY p.oracle_id
    ) owned ON owned.oracle_id = w.oracle_id
    WHERE w.oracle_id = ? AND w.status = 'active'`).all(oracleId, oracleId) as Array<{
      id: number; want_list_id: number; quantity: number; name: string; owned_qty: number;
    }>;

  const fulfilled: FulfilledWant[] = [];
  const mark = db.prepare(`
    UPDATE want_list_items
       SET status = 'fulfilled',
           fulfilled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           fulfilled_by_trade_id = ?
     WHERE id = ?`);

  for (const row of candidates) {
    if (row.owned_qty < row.quantity) continue;
    mark.run(options.tradeId ?? null, row.id);
    alerts.raise({
      kind: 'want_fulfilled',
      dedupeKey: `want_fulfilled:${row.id}`,
      subjectType: 'want_list_item',
      subjectId: row.id,
      title: `Want fulfilled: ${row.name}`,
      message: options.tradeId
        ? `You now own ${row.owned_qty} — marked fulfilled from a completed trade.`
        : `You now own ${row.owned_qty} — marked fulfilled.`,
      payload: { oracleId, owned: row.owned_qty, wanted: row.quantity },
    });
    fulfilled.push({
      wantListItemId: row.id, wantListId: row.want_list_id,
      oracleId, name: row.name, quantity: row.quantity,
    });
  }
  return fulfilled;
}

/** A named-list rename that would collide with another list. */
export class ListNameTakenError extends Error {
  constructor(name: string) {
    super(`A list called "${name}" already exists.`);
    this.name = 'ListNameTakenError';
  }
}

/**
 * Want-list management: named lists, their items, and per-list ordering.
 *
 * Reads reuse `wantList()` from shopping.ts (which already carries per-deck
 * "needed for" and owned counts). This adds the writes the spec needs: any
 * number of named lists, manual add/edit, and independent drag-order per list.
 */
export class WantStore {
  private readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }

  lists() {
    return this.db.prepare(`
      SELECT wl.id, wl.name, wl.description, wl.is_default, wl.sort_order,
             COUNT(wi.id) FILTER (WHERE wi.status = 'active') AS active_count
      FROM want_lists wl
      LEFT JOIN want_list_items wi ON wi.want_list_id = wl.id
      GROUP BY wl.id
      ORDER BY wl.is_default DESC, wl.sort_order, wl.name COLLATE NOCASE`).all() as any[];
  }

  get(listId?: number) { return wantList(this.db, listId); }

  createList(name: string, description?: string | null): number {
    const trimmed = name.trim();
    if (this.db.prepare('SELECT 1 FROM want_lists WHERE name = ?').get(trimmed)) {
      throw new ListNameTakenError(trimmed);
    }
    const order = (this.db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM want_lists')
      .get() as { n: number }).n;
    const result = this.db.prepare(
      'INSERT INTO want_lists (name, description, sort_order) VALUES (?,?,?)',
    ).run(trimmed, description ?? null, order);
    return Number(result.lastInsertRowid);
  }

  renameList(id: number, name: string): void {
    const trimmed = name.trim();
    const clash = this.db.prepare('SELECT id FROM want_lists WHERE name = ? AND id <> ?')
      .get(trimmed, id) as { id: number } | undefined;
    if (clash) throw new ListNameTakenError(trimmed);
    this.db.prepare('UPDATE want_lists SET name = ? WHERE id = ?').run(trimmed, id);
  }

  deleteList(id: number): void {
    // The default list is the push target for deck shopping lists; keep one.
    const row = this.db.prepare('SELECT is_default FROM want_lists WHERE id = ?')
      .get(id) as { is_default: number } | undefined;
    if (row?.is_default) throw new Error('The default want list cannot be deleted.');
    this.db.prepare('DELETE FROM want_lists WHERE id = ?').run(id);
  }

  reorderLists(orderedIds: number[]): void {
    const update = this.db.prepare('UPDATE want_lists SET sort_order = ? WHERE id = ?');
    this.db.transaction(() => orderedIds.forEach((id, i) => update.run(i, id)))();
  }

  addItem(listId: number, oracleId: string, fields: {
    quantity?: number; targetPriceUsd?: number | null; priority?: number;
    notes?: string | null; preferredPrintingId?: string | null; preferredFinish?: string | null;
  } = {}): number {
    const order = (this.db.prepare(
      'SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM want_list_items WHERE want_list_id = ?',
    ).get(listId) as { n: number }).n;
    // One row per card per list; a re-add reactivates and updates preferences.
    this.db.prepare(`
      INSERT INTO want_list_items
        (want_list_id, oracle_id, quantity, target_price_usd, priority, notes,
         preferred_printing_id, preferred_finish, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(want_list_id, oracle_id) DO UPDATE SET
        status = 'active', quantity = excluded.quantity,
        target_price_usd = excluded.target_price_usd, priority = excluded.priority,
        notes = excluded.notes, preferred_printing_id = excluded.preferred_printing_id,
        preferred_finish = excluded.preferred_finish,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(
      listId, oracleId, Math.max(1, fields.quantity ?? 1), fields.targetPriceUsd ?? null,
      fields.priority ?? 0, fields.notes ?? null, fields.preferredPrintingId ?? null,
      fields.preferredFinish ?? null, order);
    return (this.db.prepare('SELECT id FROM want_list_items WHERE want_list_id = ? AND oracle_id = ?')
      .get(listId, oracleId) as { id: number }).id;
  }

  updateItem(itemId: number, changes: Record<string, unknown>): void {
    const columns: Record<string, string> = {
      quantity: 'quantity', targetPriceUsd: 'target_price_usd', priority: 'priority',
      notes: 'notes', preferredPrintingId: 'preferred_printing_id',
      preferredFinish: 'preferred_finish', status: 'status',
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
    this.db.prepare(`UPDATE want_list_items SET ${sets.join(', ')} WHERE id = ?`).run(...params, itemId);
  }

  removeItem(itemId: number): void {
    this.db.prepare('DELETE FROM want_list_items WHERE id = ?').run(itemId);
  }

  reorderItems(listId: number, orderedIds: number[]): void {
    const update = this.db.prepare(
      'UPDATE want_list_items SET sort_order = ? WHERE id = ? AND want_list_id = ?');
    this.db.transaction(() => orderedIds.forEach((id, i) => update.run(i, id, listId)))();
  }
}
