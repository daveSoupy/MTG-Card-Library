import type Database from 'better-sqlite3';
import { ListNameTakenError } from '../collection/wants.ts';

/**
 * Trade lists: specific owned copies flagged as available to trade away.
 *
 * Separate from total owned and from deck-allocated copies — its own quantity
 * per row. Reuses the named-list-with-order shape of want lists, surfaces the
 * deck-allocation conflict from v_trade_list_status, and exports as plaintext in
 * the deck-export convention for pasting into a trade thread.
 */
export class TradeListStore {
  private readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }

  lists() {
    return this.db.prepare(`
      SELECT tl.id, tl.name, tl.description, tl.is_default, tl.sort_order,
             COUNT(ti.id) AS item_count
      FROM trade_lists tl
      LEFT JOIN trade_list_items ti ON ti.trade_list_id = tl.id
      GROUP BY tl.id
      ORDER BY tl.is_default DESC, tl.sort_order, tl.name COLLATE NOCASE`).all() as any[];
  }

  get(listId?: number) {
    const list = listId
      ? this.db.prepare('SELECT id, name FROM trade_lists WHERE id = ?').get(listId)
      : this.db.prepare('SELECT id, name FROM trade_lists ORDER BY is_default DESC, sort_order LIMIT 1').get();
    if (!list) return null;
    const target = list as { id: number; name: string };

    const items = this.db.prepare(`
      SELECT ti.id, ti.collection_item_id, ti.quantity, ti.asking_price_usd, ti.notes, ti.sort_order,
             o.oracle_id, o.name, p.set_code, p.collector_number, ci.finish, ci.condition,
             sl.name AS location_name,
             COALESCE(p.image_small, ff.image_small) AS image_small,
             p.price_usd AS market_usd,
             st.owned_qty_this_row, st.available_qty_overall,
             st.exceeds_owned, st.conflicts_with_deck_allocation
      FROM trade_list_items ti
      JOIN collection_items ci ON ci.id = ti.collection_item_id
      JOIN card_printings p ON p.id = ci.printing_id
      JOIN oracle_cards o ON o.oracle_id = p.oracle_id
      LEFT JOIN storage_locations sl ON sl.id = ci.location_id
      LEFT JOIN card_faces ff ON ff.printing_id = p.id AND ff.face_index = 0
      LEFT JOIN v_trade_list_status st ON st.trade_list_item_id = ti.id
      WHERE ti.trade_list_id = ?
      ORDER BY ti.sort_order, o.name COLLATE NOCASE`).all(target.id) as any[];

    return {
      id: target.id,
      name: target.name,
      items: items.map((row) => ({
        id: row.id,
        collectionItemId: row.collection_item_id,
        oracleId: row.oracle_id,
        name: row.name,
        setCode: row.set_code,
        collectorNumber: row.collector_number,
        finish: row.finish,
        condition: row.condition,
        locationName: row.location_name,
        quantity: row.quantity,
        askingPriceUsd: row.asking_price_usd,
        marketUsd: row.market_usd,
        imageSmall: row.image_small,
        notes: row.notes,
        ownedQuantity: row.owned_qty_this_row,
        availableOverall: row.available_qty_overall,
        exceedsOwned: Boolean(row.exceeds_owned),
        conflictsWithDeck: Boolean(row.conflicts_with_deck_allocation),
      })),
    };
  }

  createList(name: string, description?: string | null): number {
    const trimmed = name.trim();
    if (this.db.prepare('SELECT 1 FROM trade_lists WHERE name = ?').get(trimmed)) {
      throw new ListNameTakenError(trimmed);
    }
    const order = (this.db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM trade_lists')
      .get() as { n: number }).n;
    const result = this.db.prepare(
      'INSERT INTO trade_lists (name, description, sort_order) VALUES (?,?,?)',
    ).run(trimmed, description ?? null, order);
    return Number(result.lastInsertRowid);
  }

  renameList(id: number, name: string): void {
    const trimmed = name.trim();
    if (this.db.prepare('SELECT id FROM trade_lists WHERE name = ? AND id <> ?').get(trimmed, id)) {
      throw new ListNameTakenError(trimmed);
    }
    this.db.prepare('UPDATE trade_lists SET name = ? WHERE id = ?').run(trimmed, id);
  }

  deleteList(id: number): void {
    const row = this.db.prepare('SELECT is_default FROM trade_lists WHERE id = ?')
      .get(id) as { is_default: number } | undefined;
    if (row?.is_default) throw new Error('The default trade list cannot be deleted.');
    this.db.prepare('DELETE FROM trade_lists WHERE id = ?').run(id);
  }

  reorderLists(orderedIds: number[]): void {
    const update = this.db.prepare('UPDATE trade_lists SET sort_order = ? WHERE id = ?');
    this.db.transaction(() => orderedIds.forEach((id, i) => update.run(i, id)))();
  }

  addItem(listId: number, collectionItemId: number, fields: {
    quantity?: number; askingPriceUsd?: number | null; notes?: string | null;
  } = {}): number {
    const order = (this.db.prepare(
      'SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM trade_list_items WHERE trade_list_id = ?',
    ).get(listId) as { n: number }).n;
    const result = this.db.prepare(`
      INSERT INTO trade_list_items (trade_list_id, collection_item_id, quantity, asking_price_usd, notes, sort_order)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(trade_list_id, collection_item_id) DO UPDATE SET
        quantity = excluded.quantity, asking_price_usd = excluded.asking_price_usd,
        notes = excluded.notes, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(
      listId, collectionItemId, Math.max(1, fields.quantity ?? 1),
      fields.askingPriceUsd ?? null, fields.notes ?? null, order);
    return Number(result.lastInsertRowid);
  }

  updateItem(itemId: number, changes: Record<string, unknown>): void {
    const columns: Record<string, string> = {
      quantity: 'quantity', askingPriceUsd: 'asking_price_usd', notes: 'notes',
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
    this.db.prepare(`UPDATE trade_list_items SET ${sets.join(', ')} WHERE id = ?`).run(...params, itemId);
  }

  removeItem(itemId: number): void {
    this.db.prepare('DELETE FROM trade_list_items WHERE id = ?').run(itemId);
  }

  reorderItems(listId: number, orderedIds: number[]): void {
    const update = this.db.prepare(
      'UPDATE trade_list_items SET sort_order = ? WHERE id = ? AND trade_list_id = ?');
    this.db.transaction(() => orderedIds.forEach((id, i) => update.run(i, id, listId)))();
  }

  /** Plaintext for pasting into a trade thread — the deck-export convention. */
  exportText(listId: number): string {
    const list = this.get(listId);
    if (!list) return '';
    const lines = list.items.map((item) => {
      const set = item.setCode ? ` (${String(item.setCode).toUpperCase()})` : '';
      const price = item.askingPriceUsd != null ? ` - $${item.askingPriceUsd.toFixed(2)}` : '';
      const foil = item.finish && item.finish !== 'nonfoil' ? ` [${item.finish}]` : '';
      return `${item.quantity} ${item.name}${set}${foil}${price}`;
    });
    return lines.join('\n');
  }
}
