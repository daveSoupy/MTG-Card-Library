import type Database from 'better-sqlite3';
import type { FetchQueue } from './fetchQueue.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { USER_AGENT } from '../sync/scryfall.ts';

/**
 * Fetching a single card image into the disk cache.
 *
 * Shared by the on-demand image route and the bulk download job, so both write
 * the cache the same way — one file per (printing, face, size), sharded by hash,
 * with a matching `image_cache` row for size accounting and LRU eviction.
 */

export type ImageSize = 'small' | 'normal' | 'large' | 'art_crop' | 'png';
export const SIZES = new Set<ImageSize>(['small', 'normal', 'large', 'art_crop', 'png']);

const COLUMN: Record<ImageSize, string> = {
  small: 'image_small',
  normal: 'image_normal',
  large: 'image_large',
  art_crop: 'image_art_crop',
  png: 'image_png',
};

const extensionFor = (size: ImageSize) => (size === 'png' ? 'png' : 'jpg');

/** Where a given image lives on disk. Sharded so no directory holds 500k files. */
export function cachePathFor(imageDir: string, printingId: string, face: number, size: ImageSize) {
  const key = `${printingId}:${face}:${size}`;
  const hash = createHash('sha1').update(key).digest('hex');
  const dir = join(imageDir, hash.slice(0, 2));
  const file = `${hash}.${extensionFor(size)}`;
  return { key, dir, file, path: join(dir, file) };
}

/**
 * The Scryfall URL for one image, or null when there is none.
 *
 * Double-faced cards carry no card-level art, so a face-0 request falls back to
 * the front face's image — the same rule the route has always used.
 */
export function remoteUrlFor(
  db: Database.Database,
  printingId: string,
  face: number,
  size: ImageSize,
): string | null {
  const column = COLUMN[size];
  const fromFace = (index: number) =>
    (db.prepare(`SELECT ${column} AS url FROM card_faces WHERE printing_id = ? AND face_index = ?`)
      .get(printingId, index) as { url: string | null } | undefined)?.url ?? null;

  if (face > 0) return fromFace(face);

  const printing = (db.prepare(`SELECT ${column} AS url FROM card_printings WHERE id = ?`)
    .get(printingId) as { url: string | null } | undefined)?.url ?? null;
  return printing ?? fromFace(0);
}

const recordCacheSql =
  `INSERT INTO image_cache (printing_id, face_index, size, file_path, byte_size, downloaded_at, last_used_at)
   VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))
   ON CONFLICT(printing_id, face_index, size) DO UPDATE SET
     file_path=excluded.file_path, byte_size=excluded.byte_size,
     last_used_at=excluded.last_used_at`;

export interface FetchResult {
  /** Bytes written; 0 when the image was already on disk or has no source. */
  bytes: number;
  status: 'downloaded' | 'cached' | 'missing';
}

/**
 * Ensures one image is on disk, downloading it from Scryfall if needed.
 *
 * Deduplicated through the shared queue: many callers wanting the same image
 * make one request. Writes to a per-call temp file then renames, so a concurrent
 * reader never sees a partial file.
 */
export async function fetchAndCacheImage(
  db: Database.Database,
  imageDir: string,
  queue: FetchQueue,
  printingId: string,
  face: number,
  size: ImageSize,
): Promise<FetchResult> {
  const remoteUrl = remoteUrlFor(db, printingId, face, size);
  if (!remoteUrl) return { bytes: 0, status: 'missing' };

  const { key, dir, path } = cachePathFor(imageDir, printingId, face, size);

  try {
    await stat(path);
    return { bytes: 0, status: 'cached' };
  } catch { /* not on disk yet */ }

  const bytes = await queue.run(key, async () => {
    // Another caller may have finished this one while we waited for a slot.
    try {
      await stat(path);
      return Buffer.alloc(0);
    } catch { /* still missing */ }

    const response = await fetch(remoteUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`Scryfall returned ${response.status} for that image.`);

    const downloaded = Buffer.from(await response.arrayBuffer());
    await mkdir(dir, { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, downloaded);
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    db.prepare(recordCacheSql).run(printingId, face, size, path, downloaded.byteLength);
    return downloaded;
  });

  // Zero-length means a concurrent caller had already written it.
  return bytes.byteLength > 0
    ? { bytes: bytes.byteLength, status: 'downloaded' }
    : { bytes: 0, status: 'cached' };
}
