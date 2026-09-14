import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SyncProgress, SyncResult } from './runSync.ts';
import type { BulkType } from './scryfall.ts';
import type { SyncWorkerMessage } from './syncWorker.ts';
import { describeSyncFailure } from './syncFailure.ts';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface SyncState {
  running: boolean;
  progress: SyncProgress | null;
  lastResult: SyncResult | null;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Owns the single background sync.
 *
 * Only one may run at a time — two concurrent bulk imports would fight over the
 * same write lock and achieve nothing. Progress is broadcast so any number of
 * connected browsers can watch the same run.
 */
export class SyncManager extends EventEmitter {
  private readonly dataDir: string;
  private worker: Worker | null = null;
  private state: SyncState = {
    running: false,
    progress: null,
    lastResult: null,
    lastError: null,
    startedAt: null,
    finishedAt: null,
  };

  constructor(dataDir: string) {
    super();
    this.dataDir = dataDir;
    // Many browsers may watch one sync; the default cap of 10 is too low.
    this.setMaxListeners(0);
  }

  get current(): SyncState {
    return { ...this.state };
  }

  get isRunning(): boolean {
    return this.state.running;
  }

  start(options: { task?: 'cards' | 'categories'; bulkType?: BulkType; force?: boolean } = {}): SyncState {
    if (this.state.running) return this.current;

    // tsx and node --experimental-strip-types both load .ts directly; a built
    // dist/ run resolves the sibling .js instead.
    const isTypeScript = moduleDir.includes(`${'src'}`);
    const entry = join(moduleDir, isTypeScript ? 'syncWorker.ts' : 'syncWorker.js');

    this.state = {
      running: true,
      progress: {
        phase: 'checking',
        message: options.task === 'categories' ? 'Resolving card categories…' : 'Starting sync…',
        fraction: null,
      },
      lastResult: null,
      lastError: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.emit('progress', this.state.progress);

    const worker = new Worker(entry, {
      workerData: {
        dataDir: this.dataDir,
        task: options.task,
        bulkType: options.bulkType,
        force: options.force,
      },
      // Lets the worker load .ts sources under a dev run.
      execArgv: isTypeScript ? ['--experimental-strip-types', '--no-warnings'] : [],
    });
    this.worker = worker;

    worker.on('message', (message: SyncWorkerMessage) => {
      if (message.kind === 'progress') {
        this.state.progress = message.payload;
        this.emit('progress', message.payload);
      } else if (message.kind === 'done') {
        this.state.lastResult = message.payload;
        this.emit('progress', this.state.progress);
      } else {
        this.failed(message.message);
      }
    });

    // An error the worker did not catch — a crash before its own handler ran.
    worker.on('error', (error) => this.failed(describeSyncFailure(error)));

    worker.on('exit', () => {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
      this.worker = null;
      this.emit('finished', this.current);
    });

    return this.current;
  }

  /**
   * Records the failure and pushes it down the progress stream, so a dialog
   * already watching sees the reason at once rather than on its next reload.
   */
  private failed(message: string): void {
    this.state.lastError = message;
    this.state.progress = { phase: 'failed', message: 'Sync failed.', fraction: null, error: message };
    this.emit('progress', this.state.progress);
  }

  async stop(): Promise<void> {
    if (this.worker) await this.worker.terminate();
  }
}
