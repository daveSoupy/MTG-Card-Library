import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { USER_AGENT } from '../sync/scryfall.ts';
import { FetchQueue } from '../images/fetchQueue.ts';
import { UsageRecorder, evictImages } from '../images/cache.ts';

type ImageSize = 'small' | 'normal' | 'large' | 'art_crop' | 'png';
const SIZES = new Set<ImageSize>(['small', 'normal', 'large', 'art_crop', 'png']);

const COLUMN: Record<ImageSize, string> = {
  small: 'image_small',
  normal: 'image_normal',
  large: 'image_large',
  art_crop: 'image_art_crop',
  png: 'image_png',
};

/**
 * Serves card art from a local disk cache, fetching from Scryfall on a miss.
 *
 * CLAUDE.md asks that images be cached rather than re-fetched. Serving them
 * from here rather than pointing the browser at Scryfall also keeps the phone
 * fast on a cell connection, and gives a future native client the same URLs.
 */
export function registerImageRoutes(
  app: FastifyInstance,
  db: Database.Database,
  imageDir: string,
): void {
  const lookupPrinting = db.prepare(
    `SELECT image_small, image_normal, image_large, image_art_crop, image_png
     FROM card_printings WHERE id = ?`,
  );
  const lookupFace = db.prepare(
    `SELECT image_small, image_normal, image_large, image_art_crop, image_png
     FROM card_faces WHERE printing_id = ? AND face_index = ?`,
  );
  const recordCache = db.prepare(
    `INSERT INTO image_cache (printing_id, face_index, size, file_path, byte_size, downloaded_at, last_used_at)
     VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(printing_id, face_index, size) DO UPDATE SET
       file_path=excluded.file_path, byte_size=excluded.byte_size,
       last_used_at=excluded.last_used_at`,
  );

  /** Sharded by hash prefix so no directory ends up with 500k entries. */
  const cachePathFor = (key: string, extension: string) => {
    const hash = createHash('sha1').update(key).digest('hex');
    return { dir: join(imageDir, hash.slice(0, 2)), file: `${hash}.${extension}` };
  };

  const queue = new FetchQueue(6);
  const usage = new UsageRecorder(db);

  // Eviction is checked occasionally rather than per request: it is a SUM over
  // image_cache, and running it 60 times a page would cost more than it saves.
  let downloadsSinceSweep = 0;
  const maybeEvict = () => {
    if ((downloadsSinceSweep += 1) < 200) return;
    downloadsSinceSweep = 0;
    evictImages(db).catch((error) => app.log.warn({ error }, 'image cache eviction failed'));
  };

  app.get('/api/v1/images/:printingId/:size', async (request, reply) => {
    const { printingId, size } = request.params as { printingId: string; size: string };
    const face = Number.parseInt(String((request.query as any).face ?? '0'), 10) || 0;

    if (!SIZES.has(size as ImageSize)) {
      return reply.status(400).send({ error: `Unknown image size "${size}".` });
    }
    const imageSize = size as ImageSize;

    const row = (face > 0
      ? lookupFace.get(printingId, face)
      : lookupPrinting.get(printingId) ?? lookupFace.get(printingId, 0)) as
      | Record<string, string | null>
      | undefined;

    // Double-faced cards keep their art on the faces, so fall back to face 0.
    const remoteUrl =
      row?.[COLUMN[imageSize]] ??
      (face === 0 ? (lookupFace.get(printingId, 0) as any)?.[COLUMN[imageSize]] : null);

    if (!remoteUrl) return reply.status(404).send({ error: 'No image for that card.' });

    const extension = imageSize === 'png' ? 'png' : 'jpg';
    const key = `${printingId}:${face}:${imageSize}`;
    const { dir, file } = cachePathFor(key, extension);
    const path = join(dir, file);
    const contentType = extension === 'png' ? 'image/png' : 'image/jpeg';
    // The art for a printing never changes, so the cache key is the identity.
    const etag = `"${file.replace(/\.\w+$/, '')}"`;

    const serve = () => {
      // Card art for a given printing never changes, so it can be cached hard.
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      reply.header('ETag', etag);
      reply.type(contentType);
      return reply.send(createReadStream(path));
    };

    try {
      await stat(path);
      usage.touch(printingId, face, imageSize);
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();
      return serve();
    } catch {
      // Not cached yet.
    }

    try {
      // Deduplicated and capped: sixty tiles wanting the same art make one
      // request, and the page as a whole never opens more than a handful.
      const bytes = await queue.run(key, async () => {
        // Another request may have finished this one while we waited for a slot.
        try {
          await stat(path);
          return Buffer.alloc(0);
        } catch { /* still missing */ }

        const response = await fetch(remoteUrl, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) {
          throw new Error(`Scryfall returned ${response.status} for that image.`);
        }
        const downloaded = Buffer.from(await response.arrayBuffer());
        await mkdir(dir, { recursive: true });
        // Write then rename so a concurrent request never sees a partial file.
        // The name is per-request, not per-process: two requests for one key
        // used to pick the same temp path and interleave their writes.
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, downloaded);
          await rename(temp, path);
        } catch (error) {
          await unlink(temp).catch(() => undefined);
          throw error;
        }
        recordCache.run(printingId, face, imageSize, path, downloaded.byteLength);
        return downloaded;
      });

      if (bytes.byteLength > 0) maybeEvict();
      return serve();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: 'Could not fetch that image.', detail: message });
    }
  });

  // A tidy shutdown should not lose the last few seconds of usage stamps.
  app.addHook('onClose', async () => usage.flush());
}
