import type Database from 'better-sqlite3';
import { AlertStore } from '../alerts/store.ts';

/**
 * Turning a want's target price into something the app acts on.
 *
 * Run after each price sync: for every active want with a target set, compare
 * the current market price of its chosen (or default) printing. At or below the
 * target raises a `price_target` alert; back above resolves it, re-arming for
 * next time. Deduped by want-item id so a daily sync never re-stacks the same
 * alert.
 */
export function checkPriceTargets(db: Database.Database): number {
  const alerts = new AlertStore(db);

  const rows = db.prepare(`
    SELECT w.id, w.target_price_usd, w.preferred_finish, o.name,
           COALESCE(
             CASE w.preferred_finish
               WHEN 'foil'   THEN pp.price_usd_foil
               WHEN 'etched' THEN pp.price_usd_etched
               ELSE pp.price_usd END,
             dp.price_usd
           ) AS current_price
    FROM want_list_items w
    JOIN oracle_cards o ON o.oracle_id = w.oracle_id
    LEFT JOIN card_printings pp ON pp.id = w.preferred_printing_id
    LEFT JOIN card_printings dp ON dp.id = o.default_printing_id
    WHERE w.status = 'active' AND w.target_price_usd IS NOT NULL`).all() as Array<{
      id: number; target_price_usd: number; name: string; current_price: number | null;
    }>;

  let raised = 0;
  for (const row of rows) {
    const key = `price_target:${row.id}`;
    if (row.current_price != null && row.current_price <= row.target_price_usd) {
      alerts.raise({
        kind: 'price_target',
        dedupeKey: key,
        subjectType: 'want_list_item',
        subjectId: row.id,
        title: `Price target hit: ${row.name}`,
        message: `Now $${row.current_price.toFixed(2)} — at or below your $${row.target_price_usd.toFixed(2)} target.`,
        payload: { target: row.target_price_usd, current: row.current_price },
      });
      raised += 1;
    } else {
      // Price rose back above (or vanished) — re-arm so a later drop alerts again.
      alerts.resolveByKey(key);
    }
  }
  return raised;
}
