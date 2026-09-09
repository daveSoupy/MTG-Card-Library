import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { libraryStatus } from '../db/index.ts';
import type { SyncManager } from '../sync/syncManager.ts';
import type { SyncProgress } from '../sync/runSync.ts';
import { BULK_TYPES, type BulkType } from '../sync/scryfall.ts';
import { CATEGORY_LABELS } from '../sync/categories.ts';
import { FLAG, body as bodySchema } from './schema.ts';

export function registerSyncRoutes(
  app: FastifyInstance,
  db: Database.Database,
  sync: SyncManager,
): void {
  app.get('/api/v1/status', async () => ({
    library: libraryStatus(db),
    sync: sync.current,
    bulkTypes: BULK_TYPES,
    /** Display names for the tag categories, so the client renders 'sweeper'
     *  as "Board wipes" without keeping its own copy of the list to drift. */
    categoryLabels: CATEGORY_LABELS,
  }));

  app.post<{ Body: { bulkType?: BulkType; force?: boolean } }>(
    '/api/v1/sync',
    {
      schema: {
        body: bodySchema({ bulkType: { type: 'string', enum: Object.keys(BULK_TYPES) }, force: FLAG }),
      },
    },
    async (request, reply) => {
      if (sync.isRunning) {
        return reply.status(409).send({ error: 'A sync is already running.', sync: sync.current });
      }
      const { bulkType, force } = request.body ?? {};
      return { sync: sync.start({ bulkType, force: force === true }) };
    },
  );

  /**
   * Resolve the category tags on their own.
   *
   * A card re-import takes ~17 seconds and is usually not what is wrong; this
   * is one small bulk file and a rewrite of card_categories. `force` because
   * asking for this explicitly means "do it now", not "skip if the published
   * file has not moved".
   */
  app.post('/api/v1/sync/categories', async (_request, reply) => {
    if (sync.isRunning) {
      return reply.status(409).send({ error: 'A sync is already running.', sync: sync.current });
    }
    return { sync: sync.start({ task: 'categories', force: true }) };
  });

  /**
   * Progress as Server-Sent Events.
   *
   * SSE rather than websockets: the traffic is one-way, it survives proxies,
   * and the browser reconnects on its own.
   */
  app.get('/api/v1/sync/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send current state immediately so a browser that connects mid-sync, or
    // reloads, sees where things stand without waiting for the next tick.
    send('state', sync.current);

    const onProgress = (progress: SyncProgress) => send('progress', progress);
    const onFinished = (state: unknown) => send('finished', state);
    sync.on('progress', onProgress);
    sync.on('finished', onFinished);

    // Proxies and browsers drop idle event streams; a periodic comment keeps
    // the connection open between phases.
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 20_000);

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      sync.off('progress', onProgress);
      sync.off('finished', onFinished);
    });
  });
}
