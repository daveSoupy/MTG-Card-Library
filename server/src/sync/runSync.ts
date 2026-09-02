import type Database from 'better-sqlite3';
import { setSetting, getSetting } from '../db/index.ts';
import { CardImporter } from './importer.ts';
import { fetchBulkEntry, fetchSets, streamBulkCards, type BulkType } from './scryfall.ts';

export type SyncPhase =
  | 'checking'
  | 'sets'
  | 'downloading'
  | 'importing'
  | 'finalizing'
  | 'done'
  | 'skipped'
  | 'failed';

export interface SyncProgress {
  phase: SyncPhase;
  message: string;
  /** 0..1 where known, otherwise null for indeterminate phases. */
  fraction: number | null;
  cardsImported?: number;
  setsImported?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  error?: string;
}

export interface SyncOptions {
  bulkType?: BulkType;
  /** Re-import even when the published file has not changed since last sync. */
  force?: boolean;
  onProgress?: (progress: SyncProgress) => void;
}

export interface SyncResult {
  status: 'done' | 'skipped';
  cardsImported: number;
  printingsImported: number;
  setsImported: number;
  skippedRecords: number;
  bulkUpdatedAt: string;
  durationMs: number;
}

/** Rows per write transaction. Small enough to keep WAL churn bounded. */
const BATCH_SIZE = 2000;

/**
 * Downloads the current Scryfall bulk file and upserts it into the database.
 *
 * Intended to run inside a worker thread: better-sqlite3 is synchronous, and a
 * full import takes tens of seconds, which would otherwise block every HTTP
 * request for the duration.
 */
export async function runSync(
  db: Database.Database,
  { bulkType, force = false, onProgress }: SyncOptions = {},
): Promise<SyncResult> {
  const started = Date.now();
  const type: BulkType = bulkType ?? ((getSetting(db, 'bulk_data_type') as BulkType) || 'default_cards');
  const report = (progress: SyncProgress) => onProgress?.(progress);

  report({ phase: 'checking', message: 'Checking Scryfall for new card data…', fraction: null });
  const entry = await fetchBulkEntry(type);

  const alreadyLoaded = getSetting(db, 'loaded_bulk_updated_at');
  const sameType = getSetting(db, 'bulk_data_type') === type;
  const hasCards = (db.prepare('SELECT count(*) AS n FROM oracle_cards').get() as { n: number }).n > 0;

  if (!force && hasCards && sameType && alreadyLoaded === entry.updatedAt) {
    report({ phase: 'skipped', message: 'Card data is already up to date.', fraction: 1 });
    return {
      status: 'skipped',
      cardsImported: 0, printingsImported: 0, setsImported: 0, skippedRecords: 0,
      bulkUpdatedAt: entry.updatedAt,
      durationMs: Date.now() - started,
    };
  }

  const log = db.prepare(`
    INSERT INTO sync_log (bulk_type, scryfall_updated_at, download_uri, started_at, status)
    VALUES (?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'running')`)
    .run(type, entry.updatedAt, entry.downloadUrl);
  const logId = Number(log.lastInsertRowid);

  const importer = new CardImporter(db);

  try {
    // Sets first — card_printings.set_code is a RESTRICT foreign key onto sets,
    // and the official card_count feeds set-completion percentages.
    report({ phase: 'sets', message: 'Fetching set list…', fraction: null });
    const sets = await fetchSets();
    db.transaction(() => importer.importSets(sets))();
    report({
      phase: 'sets',
      message: `Imported ${sets.length.toLocaleString()} sets.`,
      fraction: null,
      setsImported: sets.length,
    });

    report({
      phase: 'downloading',
      message: 'Downloading card data…',
      fraction: 0,
      totalBytes: entry.compressedSize,
    });

    let batch: Record<string, unknown>[] = [];
    let bytesDownloaded = 0;
    let lastReport = 0;

    const flush = db.transaction((records: Record<string, unknown>[]) => {
      for (const record of records) importer.importCard(record);
    });

    for await (const card of streamBulkCards(entry, (bytes) => { bytesDownloaded = bytes; })) {
      batch.push(card);
      if (batch.length >= BATCH_SIZE) {
        flush(batch);
        batch = [];
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          report({
            phase: 'importing',
            message: `Imported ${importer.printingCount.toLocaleString()} cards…`,
            fraction: entry.compressedSize > 0
              ? Math.min(0.99, bytesDownloaded / entry.compressedSize)
              : null,
            cardsImported: importer.printingCount,
            bytesDownloaded,
            totalBytes: entry.compressedSize,
          });
        }
      }
    }
    if (batch.length > 0) flush(batch);

    report({ phase: 'finalizing', message: 'Building indexes…', fraction: 0.99 });
    db.transaction(() => importer.assignDefaultPrintings())();

    const pricePoints = recordPriceHistory(db);
    if (pricePoints > 0) {
      report({
        phase: 'finalizing',
        message: `Recorded ${pricePoints.toLocaleString()} price changes…`,
        fraction: 0.99,
      });
    }
    // Give the planner real statistics; without these the correlated subqueries
    // behind set and rarity filters choose poorly.
    db.exec('ANALYZE');

    const now = new Date().toISOString();
    setSetting(db, 'bulk_data_type', type);
    setSetting(db, 'loaded_bulk_updated_at', entry.updatedAt);
    setSetting(db, 'last_bulk_sync_at', now);

    db.prepare(`
      UPDATE sync_log SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             status = 'success', bytes_downloaded = ?, printings_upserted = ?,
             oracle_cards_upserted = ?
       WHERE id = ?`)
      .run(bytesDownloaded, importer.printingCount, importer.oracleCount, logId);

    const result: SyncResult = {
      status: 'done',
      cardsImported: importer.oracleCount,
      printingsImported: importer.printingCount,
      setsImported: sets.length,
      skippedRecords: importer.skippedCount,
      bulkUpdatedAt: entry.updatedAt,
      durationMs: Date.now() - started,
    };

    report({
      phase: 'done',
      message: `Imported ${result.cardsImported.toLocaleString()} cards from ${result.setsImported.toLocaleString()} sets.`,
      fraction: 1,
      cardsImported: result.printingsImported,
      setsImported: result.setsImported,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE sync_log SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             status = 'failed', error_message = ? WHERE id = ?`)
      .run(message, logId);
    // A stale cache is fine; the app stays usable on whatever was already
    // imported, so surface the failure rather than tearing anything down.
    report({ phase: 'failed', message: 'Sync failed.', fraction: null, error: message });
    throw error;
  }
}

/**
 * Records today's price for cards worth tracking.
 *
 * Two deliberate narrowings, both from the schema's own reasoning: only cards
 * that are owned, want-listed or on a trade list (`v_tracked_printings`), and
 * only when the price actually differs from the last point stored. Tracking
 * every printing on every sync would be roughly half a million rows a day for
 * a chart nobody asked for; a quiet week now costs almost nothing.
 *
 * Returns the number of points written.
 */
export function recordPriceHistory(db: Database.Database): number {
  const today = new Date().toISOString().slice(0, 10);

  const result = db.transaction(() => {
    let written = 0;
    // One statement per finish, so an etched printing charts separately from
    // its non-foil sibling.
    for (const [finish, column] of [
      ['nonfoil', 'price_usd'],
      ['foil', 'price_usd_foil'],
      ['etched', 'price_usd_etched'],
    ] as const) {
      const outcome = db.prepare(`
        INSERT INTO printing_price_history (printing_id, finish, observed_on, price_usd)
        SELECT p.id, ?, ?, p.${column}
        FROM card_printings p
        JOIN v_tracked_printings t ON t.printing_id = p.id
        WHERE p.${column} IS NOT NULL
          AND p.${column} <> COALESCE(
              (SELECT l.price_usd FROM v_printing_price_latest l
                WHERE l.printing_id = p.id AND l.finish = ?), -1)
        ON CONFLICT(printing_id, finish, observed_on) DO UPDATE SET
          price_usd = excluded.price_usd`).run(finish, today, finish);
      written += outcome.changes;
    }
    return written;
  })();

  return result;
}
