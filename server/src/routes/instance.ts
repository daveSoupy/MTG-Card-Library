import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { instanceId } from '../db/index.ts';
import { describeInstance } from '../discovery/instance.ts';

/**
 * Phase 33. `GET /api/v1/instance` — who this server is and where it is,
 * for the pairing panel's QR and for a phone checking that the address it
 * found still belongs to the library it paired with.
 *
 * `port` and `host` are what the server actually bound, passed in by
 * `index.ts` after `listen`, not re-read from the environment here.
 */
export function registerInstanceRoutes(
  app: FastifyInstance,
  db: Database.Database,
  bound: { port: number; host: string; version: string },
): void {
  app.get('/api/v1/instance', async () => describeInstance({
    instanceId: instanceId(db),
    version: bound.version,
    port: bound.port,
    host: bound.host,
  }));
}
