import type Database from 'better-sqlite3';
import { unlink } from 'node:fs/promises';

/**
 * Keeping the image cache from eating the disk.
 *
 * `image_cache_max_bytes` has been seeded in app_settings since the schema was
 * written and, until now, read by nothing — so the cache grew without limit. A
 * full warm-up across 117,620 printings is tens of gigabytes.
 */

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function cacheLimitBytes(db: Database.Database): number {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'image_cache_max_bytes'`)
    .get() as { value: string } | undefined;
  const parsed = Number.parseInt(row?.value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

export function cacheSizeBytes(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS n FROM image_cache').get() as { n: number };
  return row.n;
}

/**
 * Drops least-recently-used entries until the cache fits, deleting the files as
 * well as the rows — a cascade removes the row and leaves the file orphaned.
 */
export async function evictImages(db: Database.Database, limitOverride?: number): Promise<number> {
  const limit = limitOverride ?? cacheLimitBytes(db);
  let total = cacheSizeBytes(db);
  if (total <= limit) return 0;

  // Trim to 90% so eviction runs occasionally rather than on every request once
  // the cache is sitting at the limit.
  const target = Math.floor(limit * 0.9);
  const candidates = db.prepare(`
    SELECT printing_id, face_index, size, file_path, byte_size
    FROM image_cache
    ORDER BY COALESCE(last_used_at, downloaded_at) ASC
    LIMIT 5000`).all() as Array<{
      printing_id: string; face_index: number; size: string;
      file_path: string; byte_size: number;
    }>;

  const forget = db.prepare(
    'DELETE FROM image_cache WHERE printing_id = ? AND face_index = ? AND size = ?',
  );

  let removed = 0;
  for (const entry of candidates) {
    if (total <= target) break;
    // The file may already be gone; the row still has to go.
    await unlink(entry.file_path).catch(() => undefined);
    forget.run(entry.printing_id, entry.face_index, entry.size);
    total -= entry.byte_size ?? 0;
    removed += 1;
  }
  return removed;
}

/**
 * Records that cached images were used, so the LRU ordering means something.
 *
 * `last_used_at` was only ever written on download, which made it "last
 * downloaded" — an eviction built on it would have thrown away exactly the
 * images being looked at most. Touches are batched because a page of results is
 * 60 of them at once, and one write per request would put a synchronous SQLite
 * call in the middle of every response.
 */
export class UsageRecorder {
  private readonly db: Database.Database;
  private readonly delayMs: number;
  private readonly pending = new Map<string, [string, number, string]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Database.Database, delayMs = 5000) {
    this.db = db;
    this.delayMs = delayMs;
  }

  touch(printingId: string, face: number, size: string): void {
    this.pending.set(`${printingId}:${face}:${size}`, [printingId, face, size]);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    // Never hold the process open for a cache statistic.
    this.timer.unref?.();
  }

  flush(): void {
    this.timer = null;
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();

    const update = this.db.prepare(`
      UPDATE image_cache SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE printing_id = ? AND face_index = ? AND size = ?`);
    this.db.transaction(() => { for (const e of entries) update.run(...e); })();
  }
}
