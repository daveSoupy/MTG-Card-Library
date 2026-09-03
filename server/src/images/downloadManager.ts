import type Database from 'better-sqlite3';
import { FetchQueue } from './fetchQueue.ts';
import { fetchAndCacheImage, type ImageSize } from './fetch.ts';
import { cacheLimitBytes } from './cache.ts';

/**
 * Downloading card art ahead of time, so browsing and deck-building have no
 * per-image network wait.
 *
 * Two scopes: 'referenced' warms only the printings the user actually uses —
 * their decks, collection, covers and pinned art — which is small; 'all' mirrors
 * the whole catalogue, which is tens of gigabytes and so is gated behind the
 * cache cap. Network-bound with tiny per-image DB writes, so it runs as a plain
 * async job on the main thread rather than in a worker like the bulk sync.
 */

export type DownloadScope = 'referenced' | 'all';

/** The two sizes worth pre-fetching; larger art stays on-demand. */
const WARM_SIZES: ImageSize[] = ['small', 'normal'];

/** Fallback average bytes when the cache has no samples to measure from. */
const FALLBACK_AVG: Record<string, number> = { small: 40_000, normal: 130_000 };

export interface ImageDownloadState {
  running: boolean;
  scope: DownloadScope | null;
  total: number;
  processed: number;
  downloaded: number;
  skipped: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  canceled: boolean;
}

/** Thrown when a full download would not fit under the cache cap. */
export class CacheLimitError extends Error {
  readonly estimateBytes: number;
  readonly limitBytes: number;
  constructor(estimateBytes: number, limitBytes: number) {
    super('The full catalogue would not fit under the image cache limit.');
    this.name = 'CacheLimitError';
    this.estimateBytes = estimateBytes;
    this.limitBytes = limitBytes;
  }
}

interface WorkItem { printingId: string; face: number; size: ImageSize; }

export class ImageDownloadManager {
  private readonly db: Database.Database;
  private readonly imageDir: string;
  private readonly queue = new FetchQueue(8);
  private state: ImageDownloadState = ImageDownloadManager.idle();

  constructor(db: Database.Database, imageDir: string) {
    this.db = db;
    this.imageDir = imageDir;
  }

  private static idle(): ImageDownloadState {
    return {
      running: false, scope: null, total: 0, processed: 0, downloaded: 0,
      skipped: 0, failed: 0, startedAt: null, finishedAt: null, lastError: null, canceled: false,
    };
  }

  get current(): ImageDownloadState {
    return { ...this.state };
  }

  get isRunning(): boolean {
    return this.state.running;
  }

  /** Estimated bytes to mirror the whole catalogue at the warmed sizes. */
  estimateFullBytes(): number {
    const averages = new Map<string, number>();
    for (const row of this.db.prepare(
      `SELECT size, AVG(byte_size) AS avg FROM image_cache WHERE byte_size > 0 GROUP BY size`,
    ).all() as Array<{ size: string; avg: number }>) {
      averages.set(row.size, row.avg);
    }

    let total = 0;
    for (const size of WARM_SIZES) {
      const column = size === 'small' ? 'image_small' : 'image_normal';
      const count = (this.db.prepare(
        `SELECT COUNT(*) AS n FROM card_printings WHERE ${column} IS NOT NULL`,
      ).get() as { n: number }).n;
      total += count * (averages.get(size) ?? FALLBACK_AVG[size]);
    }
    return Math.round(total);
  }

  /**
   * Printings the user actually references — decks (with their preferred art),
   * collection, deck covers, pinned art, and want/trade lists.
   */
  private referencedPrintingIds(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT pid FROM (
        SELECT COALESCE(dc.preferred_printing_id, o.default_printing_id) AS pid
          FROM deck_cards dc JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
        UNION SELECT printing_id            FROM collection_items
        UNION SELECT cover_printing_id      FROM decks
        UNION SELECT printing_id            FROM card_art_preferences
        UNION SELECT COALESCE(wli.preferred_printing_id, o2.default_printing_id)
          FROM want_list_items wli JOIN oracle_cards o2 ON o2.oracle_id = wli.oracle_id
        UNION SELECT ci.printing_id
          FROM trade_list_items tli JOIN collection_items ci ON ci.id = tli.collection_item_id
      ) WHERE pid IS NOT NULL`).all() as Array<{ pid: string }>;
    return rows.map((r) => r.pid);
  }

  private allPrintingIds(): string[] {
    return (this.db.prepare('SELECT id FROM card_printings').all() as Array<{ id: string }>)
      .map((r) => r.id);
  }

  /** How much of the referenced set is already cached, for the Data section. */
  referencedCoverage(): { referenced: number; cached: number } {
    const referenced = this.referencedPrintingIds().length * WARM_SIZES.length;
    const remaining = this.buildWorkList('referenced').length;
    return { referenced, cached: referenced - remaining };
  }

  /** Desired (printing, face, size) items minus what is already on disk. */
  private buildWorkList(scope: DownloadScope): WorkItem[] {
    const printingIds = scope === 'all' ? this.allPrintingIds() : this.referencedPrintingIds();

    const cached = new Set<string>();
    for (const row of this.db.prepare(
      `SELECT printing_id, face_index, size FROM image_cache`,
    ).all() as Array<{ printing_id: string; face_index: number; size: string }>) {
      cached.add(`${row.printing_id}:${row.face_index}:${row.size}`);
    }

    const work: WorkItem[] = [];
    for (const printingId of printingIds) {
      for (const size of WARM_SIZES) {
        if (!cached.has(`${printingId}:0:${size}`)) work.push({ printingId, face: 0, size });
      }
    }
    return work;
  }

  start(scope: DownloadScope): ImageDownloadState {
    if (this.state.running) return this.current;

    if (scope === 'all') {
      const estimate = this.estimateFullBytes();
      const limit = cacheLimitBytes(this.db);
      if (estimate > limit) throw new CacheLimitError(estimate, limit);
    }

    const work = this.buildWorkList(scope);
    this.state = {
      ...ImageDownloadManager.idle(),
      running: true,
      scope,
      total: work.length,
      startedAt: new Date().toISOString(),
    };

    // Fire and forget: the run advances in the background and is observed by
    // polling `current`. Any throw is captured onto the state, never unhandled.
    void this.run(work);
    return this.current;
  }

  cancel(): void {
    if (this.state.running) this.state.canceled = true;
  }

  private async run(work: WorkItem[]): Promise<void> {
    const CONCURRENCY = 6;
    let next = 0;

    const worker = async () => {
      while (!this.state.canceled) {
        const index = next;
        next += 1;
        if (index >= work.length) break;
        const item = work[index];
        try {
          const result = await fetchAndCacheImage(
            this.db, this.imageDir, this.queue, item.printingId, item.face, item.size,
          );
          if (result.status === 'downloaded') this.state.downloaded += 1;
          else this.state.skipped += 1;
        } catch (error) {
          this.state.failed += 1;
          this.state.lastError = error instanceof Error ? error.message : String(error);
        }
        this.state.processed += 1;
      }
    };

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    } finally {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
    }
  }
}
