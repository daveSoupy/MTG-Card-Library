import type { FastifyInstance } from 'fastify';
import { WantStore, ListNameTakenError, type WantItemUpdate } from '../collection/wants.ts';
import { FINISHES } from '../collection/store.ts';
import {
  ID, MONEY_OR_NULL, NAME, TEXT_OR_NULL, body as bodySchema, enumOrNull, idParams,
} from './schema.ts';

/** A drag-reorder payload: the ids of the rows, in their new order. */
const REORDER = bodySchema({ orderedIds: { type: 'array', items: ID } }, ['orderedIds']);

/** The editable fields of a wanted card, matching the column CHECKs. */
const ITEM_FIELDS = {
  // CHECK (quantity > 0) on the column.
  quantity: { type: 'integer', minimum: 1 },
  targetPriceUsd: MONEY_OR_NULL,
  // 0 = none, 1 = low ... 3 = high.
  priority: { type: 'integer', minimum: 0, maximum: 3 },
  notes: TEXT_OR_NULL,
  preferredPrintingId: TEXT_OR_NULL,
  preferredFinish: enumOrNull(FINISHES),
  status: { type: 'string', enum: ['active', 'fulfilled', 'archived'] },
};

/** Want lists: named lists, manual items, per-list ordering. */
export function registerWantRoutes(app: FastifyInstance, wants: WantStore): void {
  const nameGuard = async <T>(reply: any, run: () => T) => {
    try { return run(); }
    catch (error) {
      if (error instanceof ListNameTakenError) return reply.status(409).send({ error: error.message });
      throw error;
    }
  };

  app.get('/api/v1/want-lists', async () => ({ lists: wants.lists() }));

  // Every active want across every list for one card — lets a "remove from
  // want list" control clear an entry it didn't add itself (e.g. one added
  // through a non-default list), without guessing which list it's in.
  app.get('/api/v1/want-lists/items/by-oracle/:oracleId', async (request) => {
    const { oracleId } = request.params as { oracleId: string };
    return { items: wants.itemsForOracle(oracleId) };
  });

  app.get<{ Params: { id: number } }>(
    '/api/v1/want-lists/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const list = wants.get(request.params.id);
      if (!list) return reply.status(404).send({ error: 'No want list with that id.' });
      return list;
    },
  );

  app.post<{ Body: { name: string; description?: string | null } }>(
    '/api/v1/want-lists',
    { schema: { body: bodySchema({ name: NAME, description: TEXT_OR_NULL }, ['name']) } },
    async (request, reply) => {
      const { name, description } = request.body;
      if (!name.trim()) return reply.status(400).send({ error: 'name is required.' });
      return nameGuard(reply, () => {
        const id = wants.createList(name, description ?? null);
        return { id, lists: wants.lists() };
      });
    },
  );

  app.patch<{ Params: { id: number }; Body: { name?: string } }>(
    '/api/v1/want-lists/:id',
    { schema: { params: idParams('id'), body: bodySchema({ name: NAME }) } },
    async (request, reply) => nameGuard(reply, () => {
      const { name } = request.body;
      if (name !== undefined) wants.renameList(request.params.id, name);
      return { lists: wants.lists() };
    }),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/want-lists/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      try { wants.deleteList(request.params.id); return { lists: wants.lists() }; }
      catch (error) { return reply.status(409).send({ error: (error as Error).message }); }
    },
  );

  app.post<{ Body: { orderedIds: number[] } }>(
    '/api/v1/want-lists/reorder',
    { schema: { body: REORDER } },
    async (request) => {
      wants.reorderLists(request.body.orderedIds);
      return { lists: wants.lists() };
    },
  );

  app.post<{ Params: { id: number }; Body: WantItemUpdate & { oracleId: string } }>(
    '/api/v1/want-lists/:id/items',
    {
      schema: {
        params: idParams('id'),
        body: bodySchema({ oracleId: NAME, ...ITEM_FIELDS }, ['oracleId']),
      },
    },
    async (request) => {
      const { id } = request.params;
      const { oracleId, quantity, targetPriceUsd, priority, notes,
        preferredPrintingId, preferredFinish } = request.body;
      wants.addItem(id, oracleId, {
        quantity,
        targetPriceUsd: targetPriceUsd ?? null,
        priority,
        notes: notes ?? null,
        preferredPrintingId: preferredPrintingId ?? null,
        preferredFinish: preferredFinish ?? null,
      });
      return wants.get(id);
    },
  );

  app.patch<{ Params: { id: number; itemId: number }; Body: WantItemUpdate }>(
    '/api/v1/want-lists/:id/items/:itemId',
    { schema: { params: idParams('id', 'itemId'), body: bodySchema(ITEM_FIELDS) } },
    async (request) => {
      wants.updateItem(request.params.itemId, request.body);
      return wants.get(request.params.id);
    },
  );

  app.delete<{ Params: { id: number; itemId: number } }>(
    '/api/v1/want-lists/:id/items/:itemId',
    { schema: { params: idParams('id', 'itemId') } },
    async (request) => {
      wants.removeItem(request.params.itemId);
      return wants.get(request.params.id);
    },
  );

  app.post<{ Params: { id: number }; Body: { orderedIds: number[] } }>(
    '/api/v1/want-lists/:id/reorder',
    { schema: { params: idParams('id'), body: REORDER } },
    async (request) => {
      wants.reorderItems(request.params.id, request.body.orderedIds);
      return wants.get(request.params.id);
    },
  );
}
