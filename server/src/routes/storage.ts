import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { getSetting, libraryStatus, setSetting } from '../db/index.ts';
import { cacheSizeBytes, cacheLimitBytes } from '../images/cache.ts';
import { CacheLimitError, type DownloadScope, type ImageDownloadManager } from '../images/downloadManager.ts';
import { body as bodySchema } from './schema.ts';

const SCOPE = { type: 'string', enum: ['referenced', 'all'] } as const;

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
      /**
       * Phase 7's tag-derived categories. Reported because an empty
       * card_categories is invisible everywhere else: the template tracker
       * just reads "0 removal", which is indistinguishable from a deck that
       * genuinely has none.
       */
      categories: {
        cards: (db.prepare('SELECT COUNT(DISTINCT oracle_id) AS n FROM card_categories')
          .get() as { n: number }).n,
        rows: (db.prepare('SELECT COUNT(*) AS n FROM card_categories').get() as { n: number }).n,
        syncedAt: getSetting(db, 'last_category_sync_at') || null,
        error: getSetting(db, 'last_category_sync_error') || null,
      },
      coverage: downloads.referencedCoverage(),
      fullEstimateBytes: downloads.estimateFullBytes(),
    };
  });

  app.put<{ Body: { bytes: number } }>(
    '/api/v1/storage/cache-limit',
    {
      schema: {
        // A cap of zero would mean "cache nothing", which is not a setting the
        // download manager can honour; exclusiveMinimum keeps it positive.
        body: bodySchema({ bytes: { type: 'number', exclusiveMinimum: 0 } }, ['bytes']),
      },
    },
    async (request) => {
      setSetting(db, 'image_cache_max_bytes', String(Math.round(request.body.bytes)));
      return { limitBytes: cacheLimitBytes(db) };
    },
  );

  app.post<{ Body: { scope: DownloadScope } }>(
    '/api/v1/images/download',
    { schema: { body: bodySchema({ scope: SCOPE }, ['scope']) } },
    async (request, reply) => {
    const { scope } = request.body;
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
  },
  );

  app.get('/api/v1/images/download/status', async () => ({ status: downloads.current }));

  app.post('/api/v1/images/download/cancel', async () => {
    downloads.cancel();
    return { status: downloads.current };
  });
}
