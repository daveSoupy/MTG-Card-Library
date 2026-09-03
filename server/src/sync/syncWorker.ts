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
import type { BulkType } from './scryfall.ts';

export interface SyncWorkerInput {
  dataDir: string;
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

try {
  const result = await runSync(library.db, {
    bulkType: input.bulkType,
    force: input.force,
    onProgress: (payload) => port.postMessage({ kind: 'progress', payload } satisfies SyncWorkerMessage),
  });
  port.postMessage({ kind: 'done', payload: result } satisfies SyncWorkerMessage);
} catch (error) {
  port.postMessage({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  } satisfies SyncWorkerMessage);
} finally {
  library.close();
}
