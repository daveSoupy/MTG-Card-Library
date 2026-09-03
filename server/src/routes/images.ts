import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { FetchQueue } from '../images/fetchQueue.ts';
import { UsageRecorder, evictImages } from '../images/cache.ts';
import { SIZES, cachePathFor, remoteUrlFor, fetchAndCacheImage, type ImageSize } from '../images/fetch.ts';

/**
 * Serves card art from a local disk cache, fetching from Scryfall on a miss.
 *
 * CLAUDE.md asks that images be cached rather than re-fetched. Serving them
 * from here rather than pointing the browser at Scryfall also keeps the phone
 * fast on a cell connection, and gives a future native client the same URLs.
 *
 * The fetch-and-store mechanics live in ../images/fetch.ts, shared with the
 * bulk download job so both write the cache identically.
 */
export function registerImageRoutes(
  app: FastifyInstance,
  db: Database.Database,
  imageDir: string,
): void {
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

    const { file, path } = cachePathFor(imageDir, printingId, face, imageSize);
    const contentType = imageSize === 'png' ? 'image/png' : 'image/jpeg';
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

    if (!remoteUrlFor(db, printingId, face, imageSize)) {
      return reply.status(404).send({ error: 'No image for that card.' });
    }

    try {
      const result = await fetchAndCacheImage(db, imageDir, queue, printingId, face, imageSize);
      if (result.status === 'downloaded') maybeEvict();
      return serve();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(502).send({ error: 'Could not fetch that image.', detail: message });
    }
  });

  // A tidy shutdown should not lose the last few seconds of usage stamps.
  app.addHook('onClose', async () => usage.flush());
}
