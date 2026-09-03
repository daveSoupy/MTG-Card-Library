import type Database from 'better-sqlite3';

/**
 * In-app alerts.
 *
 * Single-user behind Tailscale, so there is nowhere to push to — alerts are a
 * durable in-app inbox instead. Raised by the price sync (a want's target price
 * was met) and by trade completion (a deck lost copies it was using, a want was
 * fulfilled, a trade-list quantity had to be clamped). `dedupe_key` stops a
 * daily sync re-raising the same price alert forever.
 */

export type AlertKind =
  | 'price_target' | 'trade_list_clamped' | 'allocation_conflict'
  | 'want_fulfilled' | 'sync_failed' | 'import_unmatched';

export type AlertState = 'active' | 'acknowledged' | 'resolved';

export interface RaiseAlert {
  kind: AlertKind;
  /** When set, re-raising with the same key reactivates one row rather than piling up. */
  dedupeKey?: string;
  subjectType?: string;
  subjectId?: number;
  title: string;
  message?: string;
  payload?: unknown;
}

export interface AlertRow {
  id: number;
  kind: AlertKind;
  state: AlertState;
  subjectType: string | null;
  subjectId: number | null;
  title: string;
  message: string | null;
  payload: unknown;
  createdAt: string;
  acknowledgedAt: string | null;
}

export class AlertStore {
  private readonly db: Database.Database;
  constructor(db: Database.Database) { this.db = db; }

  raise(alert: RaiseAlert): number {
    const payload = alert.payload === undefined ? null : JSON.stringify(alert.payload);

    if (alert.dedupeKey) {
      // Reactivate an existing row for this key rather than stacking duplicates.
      const row = this.db.prepare(`
        INSERT INTO alerts (kind, dedupe_key, state, subject_type, subject_id, title, message, payload)
        VALUES (?,?,'active',?,?,?,?,?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          state = 'active', acknowledged_at = NULL,
          subject_type = excluded.subject_type, subject_id = excluded.subject_id,
          title = excluded.title, message = excluded.message, payload = excluded.payload,
          created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
        RETURNING id`).get(
        alert.kind, alert.dedupeKey, alert.subjectType ?? null, alert.subjectId ?? null,
        alert.title, alert.message ?? null, payload,
      ) as { id: number };
      return row.id;
    }

    const result = this.db.prepare(`
      INSERT INTO alerts (kind, state, subject_type, subject_id, title, message, payload)
      VALUES (?,'active',?,?,?,?,?)`).run(
      alert.kind, alert.subjectType ?? null, alert.subjectId ?? null,
      alert.title, alert.message ?? null, payload,
    );
    return Number(result.lastInsertRowid);
  }

  /** Marks a keyed alert resolved — used to re-arm a price target once the price rises back. */
  resolveByKey(dedupeKey: string): void {
    this.db.prepare(
      `UPDATE alerts SET state = 'resolved' WHERE dedupe_key = ? AND state <> 'resolved'`,
    ).run(dedupeKey);
  }

  list(options: { state?: AlertState } = {}): AlertRow[] {
    const rows = options.state
      ? this.db.prepare(
          `SELECT * FROM alerts WHERE state = ? ORDER BY created_at DESC, id DESC`,
        ).all(options.state)
      : this.db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC, id DESC`).all();
    return (rows as any[]).map(toAlert);
  }

  activeCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE state = 'active'`)
      .get() as { n: number }).n;
  }

  setState(id: number, state: AlertState): void {
    const stamp = state === 'active' ? null : "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
    this.db.prepare(
      `UPDATE alerts SET state = ?, acknowledged_at = ${stamp ?? 'NULL'} WHERE id = ?`,
    ).run(state, id);
  }

  acknowledge(id: number): void { this.setState(id, 'acknowledged'); }
  resolve(id: number): void { this.setState(id, 'resolved'); }
}

function toAlert(row: any): AlertRow {
  let payload: unknown = null;
  if (row.payload != null) { try { payload = JSON.parse(row.payload); } catch { payload = null; } }
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    title: row.title,
    message: row.message,
    payload,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}
