import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { libraryStatus } from '../db/index.ts';
import type { SyncManager } from '../sync/syncManager.ts';
import type { SyncProgress } from '../sync/runSync.ts';
import { BULK_TYPES, type BulkType } from '../sync/scryfall.ts';

export function registerSyncRoutes(
  app: FastifyInstance,
  db: Database.Database,
  sync: SyncManager,
): void {
  app.get('/api/v1/status', async () => ({
    library: libraryStatus(db),
    sync: sync.current,
    bulkTypes: BULK_TYPES,
  }));

  app.post('/api/v1/sync', async (request, reply) => {
    if (sync.isRunning) {
      return reply.status(409).send({ error: 'A sync is already running.', sync: sync.current });
    }
    const body = (request.body ?? {}) as { bulkType?: string; force?: boolean };
    const bulkType =
      body.bulkType === 'oracle_cards' || body.bulkType === 'default_cards'
        ? (body.bulkType as BulkType)
        : undefined;
    return { sync: sync.start({ bulkType, force: body.force === true }) };
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
