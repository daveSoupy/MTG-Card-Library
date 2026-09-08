import type { FastifyInstance } from 'fastify';
import { TradeListStore, type TradeListItemUpdate } from '../tradelists/store.ts';
import { ListNameTakenError } from '../collection/wants.ts';
import {
  ID, MONEY_OR_NULL, NAME, TEXT_OR_NULL, body as bodySchema, idParams,
} from './schema.ts';

/** A drag-reorder payload: the ids of the rows, in their new order. */
const REORDER = bodySchema({ orderedIds: { type: 'array', items: ID } }, ['orderedIds']);

/** Quantity has a CHECK (quantity > 0) behind it, so zero is not an option. */
const POSITIVE = { type: 'integer', minimum: 1 } as const;

/** Trade lists: owned copies flagged for trade, with plaintext export. */
export function registerTradeListRoutes(app: FastifyInstance, lists: TradeListStore): void {
  const nameGuard = async <T>(reply: any, run: () => T) => {
    try { return run(); }
    catch (error) {
      if (error instanceof ListNameTakenError) return reply.status(409).send({ error: error.message });
      throw error;
    }
  };

  app.get('/api/v1/trade-lists', async () => ({ lists: lists.lists() }));

  app.get<{ Params: { id: number } }>(
    '/api/v1/trade-lists/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const list = lists.get(request.params.id);
      if (!list) return reply.status(404).send({ error: 'No trade list with that id.' });
      return list;
    },
  );

  app.post<{ Body: { name: string; description?: string | null } }>(
    '/api/v1/trade-lists',
    { schema: { body: bodySchema({ name: NAME, description: TEXT_OR_NULL }, ['name']) } },
    async (request, reply) => {
      const { name, description } = request.body;
      if (!name.trim()) return reply.status(400).send({ error: 'name is required.' });
      return nameGuard(reply, () => {
        const id = lists.createList(name, description ?? null);
        return { id, lists: lists.lists() };
      });
    },
  );

  app.patch<{ Params: { id: number }; Body: { name?: string } }>(
    '/api/v1/trade-lists/:id',
    { schema: { params: idParams('id'), body: bodySchema({ name: NAME }) } },
    async (request, reply) => nameGuard(reply, () => {
      const { name } = request.body;
      if (name !== undefined) lists.renameList(request.params.id, name);
      return { lists: lists.lists() };
    }),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/trade-lists/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      try { lists.deleteList(request.params.id); return { lists: lists.lists() }; }
      catch (error) { return reply.status(409).send({ error: (error as Error).message }); }
    },
  );

  app.post<{ Body: { orderedIds: number[] } }>(
    '/api/v1/trade-lists/reorder',
    { schema: { body: REORDER } },
    async (request) => {
      lists.reorderLists(request.body.orderedIds);
      return { lists: lists.lists() };
    },
  );

  app.post<{
    Params: { id: number };
    Body: TradeListItemUpdate & { collectionItemId: number };
  }>(
    '/api/v1/trade-lists/:id/items',
    {
      schema: {
        params: idParams('id'),
        body: bodySchema(
          {
            collectionItemId: ID, quantity: POSITIVE,
            askingPriceUsd: MONEY_OR_NULL, notes: TEXT_OR_NULL,
          },
          ['collectionItemId'],
        ),
      },
    },
    async (request) => {
      const { collectionItemId, quantity, askingPriceUsd, notes } = request.body;
      lists.addItem(request.params.id, collectionItemId, {
        quantity,
        askingPriceUsd: askingPriceUsd ?? null,
        notes: notes ?? null,
      });
      return lists.get(request.params.id);
    },
  );

  app.patch<{ Params: { id: number; itemId: number }; Body: TradeListItemUpdate }>(
    '/api/v1/trade-lists/:id/items/:itemId',
    {
      schema: {
        params: idParams('id', 'itemId'),
        body: bodySchema({
          quantity: POSITIVE, askingPriceUsd: MONEY_OR_NULL, notes: TEXT_OR_NULL,
        }),
      },
    },
    async (request) => {
      lists.updateItem(request.params.itemId, request.body);
      return lists.get(request.params.id);
    },
  );

  app.delete<{ Params: { id: number; itemId: number } }>(
    '/api/v1/trade-lists/:id/items/:itemId',
    { schema: { params: idParams('id', 'itemId') } },
    async (request) => {
      lists.removeItem(request.params.itemId);
      return lists.get(request.params.id);
    },
  );

  app.post<{ Params: { id: number }; Body: { orderedIds: number[] } }>(
    '/api/v1/trade-lists/:id/reorder',
    { schema: { params: idParams('id'), body: REORDER } },
    async (request) => {
      lists.reorderItems(request.params.id, request.body.orderedIds);
      return lists.get(request.params.id);
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/v1/trade-lists/:id/export',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      reply.type('text/plain; charset=utf-8');
      return lists.exportText(request.params.id);
    },
  );
}
