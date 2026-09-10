import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  AssemblyError, assemblySheet, cancelRun, completeRun, listRuns, openAssemblyRun,
  openDisassemblyRun, openRunFor, setItemPicked,
} from '../decks/assembly.ts';
import { FLAG, body, idParams } from './schema.ts';

/**
 * Assembly runs: the pull sheet, its checkboxes, and putting the deck away.
 *
 * Every rule lives in `decks/assembly.ts` — which lots, in what order, what a
 * completion writes. These handlers only turn a URL into a call and a thrown
 * `AssemblyError` into a 400, so a native client gets the same behaviour for
 * free.
 */
export function registerAssemblyRoutes(app: FastifyInstance, db: Database.Database): void {
  const guard = async <T>(reply: any, run: () => T) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof AssemblyError) return reply.status(400).send({ error: error.message });
      throw error;
    }
  };

  /**
   * Opens a run and returns the sheet.
   *
   * A deck may have only one open run: a second POST returns the one already
   * open rather than a fresh sheet, because the first one has ticks on it and
   * its owner is halfway through a binder.
   */
  app.post<{ Params: { id: number } }>(
    '/api/v1/decks/:id/assembly',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => openAssemblyRun(db, request.params.id)),
  );

  app.post<{ Params: { id: number } }>(
    '/api/v1/decks/:id/disassembly',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => openDisassemblyRun(db, request.params.id)),
  );

  /** The open run, if there is one — so the deck header can offer to resume it. */
  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/assembly',
    { schema: { params: idParams('id') } },
    async (request) => ({ run: openRunFor(db, request.params.id) }),
  );

  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/assembly/runs',
    { schema: { params: idParams('id') } },
    async (request) => ({ runs: listRuns(db, request.params.id) }),
  );

  /** Re-read a sheet. The tick state lives here, so a reload mid-pull resumes. */
  app.get<{ Params: { runId: number } }>(
    '/api/v1/assembly/:runId',
    { schema: { params: idParams('runId') } },
    async (request, reply) => {
      const sheet = assemblySheet(db, request.params.runId);
      if (!sheet) return reply.status(404).send({ error: 'No such assembly run.' });
      return sheet;
    },
  );

  app.patch<{ Params: { runId: number; itemId: number }; Body: { picked: boolean } }>(
    '/api/v1/assembly/:runId/items/:itemId',
    {
      schema: {
        params: idParams('runId', 'itemId'),
        body: body({ picked: FLAG }, ['picked']),
      },
    },
    async (request, reply) => guard(reply, () => {
      const sheet = setItemPicked(
        db, request.params.runId, request.params.itemId, request.body.picked,
      );
      if (!sheet) return reply.status(404).send({ error: 'No such assembly run.' });
      return sheet;
    }),
  );

  app.post<{ Params: { runId: number } }>(
    '/api/v1/assembly/:runId/complete',
    { schema: { params: idParams('runId') } },
    async (request, reply) => guard(reply, () => {
      const summary = completeRun(db, request.params.runId);
      if (!summary) return reply.status(404).send({ error: 'No such assembly run.' });
      return summary;
    }),
  );

  app.post<{ Params: { runId: number } }>(
    '/api/v1/assembly/:runId/cancel',
    { schema: { params: idParams('runId') } },
    async (request, reply) => guard(reply, () => {
      const run = cancelRun(db, request.params.runId);
      if (!run) return reply.status(404).send({ error: 'No such assembly run.' });
      return { run };
    }),
  );
}
