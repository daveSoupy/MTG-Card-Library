import type { FastifyInstance } from 'fastify';
import { TradeListStore } from '../tradelists/store.ts';
import { ListNameTakenError } from '../collection/wants.ts';

const asInt = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

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

  app.get('/api/v1/trade-lists/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const list = lists.get(id);
    if (!list) return reply.status(404).send({ error: 'No trade list with that id.' });
    return list;
  });

  app.post('/api/v1/trade-lists', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.status(400).send({ error: 'name is required.' });
    }
    return nameGuard(reply, () => {
      const id = lists.createList(body.name, body.description ?? null);
      return { id, lists: lists.lists() };
    });
  });

  app.patch('/api/v1/trade-lists/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    const body = (request.body ?? {}) as any;
    return nameGuard(reply, () => {
      if (typeof body.name === 'string') lists.renameList(id, body.name);
      return { lists: lists.lists() };
    });
  });

  app.delete('/api/v1/trade-lists/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    try { lists.deleteList(id); return { lists: lists.lists() }; }
    catch (error) { return reply.status(409).send({ error: (error as Error).message }); }
  });

  app.post('/api/v1/trade-lists/reorder', async (request) => {
    const ids = ((request.body as any)?.orderedIds ?? []).map(asInt).filter((n: unknown) => n !== undefined);
    lists.reorderLists(ids);
    return { lists: lists.lists() };
  });

  app.post('/api/v1/trade-lists/:id/items', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    const body = (request.body ?? {}) as any;
    const collectionItemId = asInt(body.collectionItemId);
    if (collectionItemId === undefined) return reply.status(400).send({ error: 'collectionItemId is required.' });
    lists.addItem(id, collectionItemId, {
      quantity: asInt(body.quantity),
      askingPriceUsd: typeof body.askingPriceUsd === 'number' ? body.askingPriceUsd : null,
      notes: body.notes ?? null,
    });
    return lists.get(id);
  });

  app.patch('/api/v1/trade-lists/:id/items/:itemId', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const itemId = asInt((request.params as any).itemId);
    if (id === undefined || itemId === undefined) return reply.status(400).send({ error: 'Invalid id.' });
    lists.updateItem(itemId, (request.body ?? {}) as any);
    return lists.get(id);
  });

  app.delete('/api/v1/trade-lists/:id/items/:itemId', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const itemId = asInt((request.params as any).itemId);
    if (id === undefined || itemId === undefined) return reply.status(400).send({ error: 'Invalid id.' });
    lists.removeItem(itemId);
    return lists.get(id);
  });

  app.post('/api/v1/trade-lists/:id/reorder', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    const ids = ((request.body as any)?.orderedIds ?? []).map(asInt).filter((n: unknown) => n !== undefined);
    lists.reorderItems(id, ids);
    return lists.get(id);
  });

  app.get('/api/v1/trade-lists/:id/export', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    reply.type('text/plain; charset=utf-8');
    return lists.exportText(id);
  });
}
