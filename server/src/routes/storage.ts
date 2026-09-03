import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { libraryStatus, setSetting } from '../db/index.ts';
import { cacheSizeBytes, cacheLimitBytes } from '../images/cache.ts';
import { CacheLimitError, type DownloadScope, type ImageDownloadManager } from '../images/downloadManager.ts';

/**
 * Storage and image-download control for the Data section.
 *
 * Reports how much disk the database and image cache use and how many cards are
 * stored, drives the pre-download job, and lets the user set the cache cap.
 */
export function registerStorageRoutes(
  app: FastifyInstance,
  db: Database.Database,
  databasePath: string,
  downloads: ImageDownloadManager,
): void {
  const fileBytes = (path: string) => {
    try { return statSync(path).size; } catch { return 0; }
  };

  app.get('/api/v1/storage', async () => {
    const library = libraryStatus(db);
    const imageCount = (db.prepare('SELECT COUNT(*) AS n FROM image_cache').get() as { n: number }).n;

    return {
      database: {
        // WAL and shared-memory files count toward what is actually on disk.
        bytes: fileBytes(databasePath)
          + fileBytes(`${databasePath}-wal`)
          + fileBytes(`${databasePath}-shm`),
      },
      imageCache: {
        bytes: cacheSizeBytes(db),
        count: imageCount,
        limitBytes: cacheLimitBytes(db),
      },
      cards: {
        oracleCards: library.oracleCards,
        printings: library.printings,
        sets: library.sets,
      },
      coverage: downloads.referencedCoverage(),
      fullEstimateBytes: downloads.estimateFullBytes(),
    };
  });

  app.put('/api/v1/storage/cache-limit', async (request, reply) => {
    const bytes = Number((request.body as any)?.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return reply.status(400).send({ error: 'bytes must be a positive number.' });
    }
    setSetting(db, 'image_cache_max_bytes', String(Math.round(bytes)));
    return { limitBytes: cacheLimitBytes(db) };
  });

  app.post('/api/v1/images/download', async (request, reply) => {
    const scope = (request.body as any)?.scope as DownloadScope;
    if (scope !== 'referenced' && scope !== 'all') {
      return reply.status(400).send({ error: 'scope must be "referenced" or "all".' });
    }
    if (downloads.isRunning) {
      return reply.status(409).send({ error: 'A download is already running.', status: downloads.current });
    }
    try {
      return { status: downloads.start(scope) };
    } catch (error) {
      if (error instanceof CacheLimitError) {
        return reply.status(413).send({
          error: 'The full catalogue is larger than the image cache limit. Raise the limit first.',
          estimateBytes: error.estimateBytes,
          limitBytes: error.limitBytes,
        });
      }
      throw error;
    }
  });

  app.get('/api/v1/images/download/status', async () => ({ status: downloads.current }));

  app.post('/api/v1/images/download/cancel', async () => {
    downloads.cancel();
    return { status: downloads.current };
  });
}
