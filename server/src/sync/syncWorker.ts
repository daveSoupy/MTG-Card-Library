/**
 * Worker-thread entry point for the bulk sync.
 *
 * better-sqlite3 is synchronous and a full import takes tens of seconds, so
 * running it on the main thread would block every HTTP request for the whole
 * duration. This runs it on its own thread with its own connection; WAL lets
 * the main thread keep serving reads while the import writes.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openLibrary } from '../db/index.ts';
import { runSync } from './runSync.ts';
import { syncCardCategories } from './categories.ts';
import { describeSyncFailure } from './syncFailure.ts';
import type { BulkType } from './scryfall.ts';

export interface SyncWorkerInput {
  dataDir: string;
  /** 'categories' resolves the tag file alone — seconds, rather than the ~17s
   *  a full card re-import costs — for when only that needs putting right. */
  task?: 'cards' | 'categories';
  bulkType?: BulkType;
  force?: boolean;
}

export type SyncWorkerMessage =
  | { kind: 'progress'; payload: import('./runSync.ts').SyncProgress }
  | { kind: 'done'; payload: import('./runSync.ts').SyncResult }
  | { kind: 'error'; message: string };

const port = parentPort;
if (!port) throw new Error('syncWorker must be run as a worker thread');

const input = workerData as SyncWorkerInput;
const library = openLibrary({ dataDir: input.dataDir });

const progress = (payload: import('./runSync.ts').SyncProgress) =>
  port.postMessage({ kind: 'progress', payload } satisfies SyncWorkerMessage);

try {
  if (input.task === 'categories') {
    // Same worker and the same SSE stream as a card sync, so there is still
    // exactly one writer and the browser needs no second channel to watch.
    // Categories alone — not the whole side-load pair: this exists so putting
    // the tags right does not cost a 79,000-row rulings download as well.
    const started = Date.now();
    progress({ phase: 'finalizing', message: 'Resolving card categories…', fraction: 0.5 });
    const result = await syncCardCategories(library.db, { force: true });
    progress({
      phase: result.status === 'failed' ? 'failed' : 'done',
      message: result.status === 'failed'
        ? `Could not resolve categories: ${result.error}`
        : `Categorised ${result.rows.toLocaleString()} cards.`,
      fraction: 1,
      ...(result.error ? { error: result.error } : {}),
    });
    port.postMessage({
      kind: 'done',
      payload: {
        status: 'done',
        cardsImported: 0, printingsImported: 0, setsImported: 0, skippedRecords: 0,
        bulkUpdatedAt: '', durationMs: Date.now() - started,
      },
    } satisfies SyncWorkerMessage);
  } else {
    const result = await runSync(library.db, {
      bulkType: input.bulkType,
      force: input.force,
      onProgress: progress,
    });
    port.postMessage({ kind: 'done', payload: result } satisfies SyncWorkerMessage);
  }
} catch (error) {
  // Only a string crosses to the main thread, so the network-failure mapping
  // runs here, while the error's `cause` is still attached.
  port.postMessage({ kind: 'error', message: describeSyncFailure(error) } satisfies SyncWorkerMessage);
} finally {
  library.close();
}
