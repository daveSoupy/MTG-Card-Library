import type Database from 'better-sqlite3';
import type { AlertStore } from '../alerts/store.ts';

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
