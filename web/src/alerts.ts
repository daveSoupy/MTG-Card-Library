import type { Alert } from './api.ts';
import type { Route } from './router.ts';

/**
 * Reading the inbox: what each kind is called, and where its row points.
 *
 * Pure — reads only fields every raise site already puts on the alert
 * (`server/src/decks/contention.ts`, `pricing/alerts.ts`, `collection/wants.ts`,
 * `trades/store.ts`), so a new alert kind that forgets to set them up just gets
 * no link rather than a broken one.
 */

export const ALERT_KIND_LABEL: Record<string, string> = {
  allocation_conflict: 'Deck conflicts',
  price_target: 'Price targets',
  trade_list_clamped: 'Trade list',
  want_fulfilled: 'Wants fulfilled',
  sync_failed: 'Sync',
  import_unmatched: 'Import',
};

export function alertKindLabel(kind: string): string {
  return ALERT_KIND_LABEL[kind] ?? kind;
}

/** Where clicking an alert's title should take you — the deck/card/list it is
 *  about — or null when the kind carries nothing to point at. */
export function alertRoute(alert: Alert): Route | null {
  const payload = alert.payload as Record<string, unknown> | null;
  switch (alert.kind) {
    case 'allocation_conflict': {
      // Both raise sites (contention.ts's reconcileAlerts, and the trade path's
      // ad-hoc claim-reduction alert) put the card's name on the payload —
      // Browse is where "who holds it, where the rest lives" already renders,
      // in the card detail pane's Held By section.
      const name = typeof payload?.name === 'string' ? payload.name : null;
      return name ? { name: 'browse', q: name } : null;
    }
    case 'want_fulfilled':
    case 'price_target':
      return { name: 'collection', tab: 'wants' };
    case 'trade_list_clamped':
      return { name: 'collection', tab: 'tradelists' };
    case 'sync_failed':
    case 'import_unmatched':
      return { name: 'data' };
    default:
      return null;
  }
}

/** Alerts in kind order (each kind's own list order preserved), for grouped
 *  rendering. Kinds present in the list but missing a label sort last. */
export function groupByKind(alerts: Alert[]): Array<{ kind: string; alerts: Alert[] }> {
  const order = Object.keys(ALERT_KIND_LABEL);
  const groups = new Map<string, Alert[]>();
  for (const alert of alerts) {
    const bucket = groups.get(alert.kind);
    if (bucket) bucket.push(alert);
    else groups.set(alert.kind, [alert]);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    })
    .map(([kind, group]) => ({ kind, alerts: group }));
}
