import type { FastifyInstance } from 'fastify';
import { WantStore, ListNameTakenError } from '../collection/wants.ts';

const asInt = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
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

  app.get('/api/v1/want-lists/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const list = wants.get(id);
    if (!list) return reply.status(404).send({ error: 'No want list with that id.' });
    return list;
  });

  app.post('/api/v1/want-lists', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.status(400).send({ error: 'name is required.' });
    }
    return nameGuard(reply, () => {
      const id = wants.createList(body.name, body.description ?? null);
      return { id, lists: wants.lists() };
    });
  });

  app.patch('/api/v1/want-lists/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    const body = (request.body ?? {}) as any;
    return nameGuard(reply, () => {
      if (typeof body.name === 'string') wants.renameList(id, body.name);
      return { lists: wants.lists() };
    });
  });

  app.delete('/api/v1/want-lists/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    try { wants.deleteList(id); return { lists: wants.lists() }; }
    catch (error) { return reply.status(409).send({ error: (error as Error).message }); }
  });

  app.post('/api/v1/want-lists/reorder', async (request) => {
    const ids = ((request.body as any)?.orderedIds ?? []).map(asInt).filter((n: unknown) => n !== undefined);
    wants.reorderLists(ids);
    return { lists: wants.lists() };
  });

  app.post('/api/v1/want-lists/:id/items', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    const body = (request.body ?? {}) as any;
    if (typeof body.oracleId !== 'string') return reply.status(400).send({ error: 'oracleId is required.' });
    wants.addItem(id, body.oracleId, {
      quantity: asInt(body.quantity),
      targetPriceUsd: typeof body.targetPriceUsd === 'number' ? body.targetPriceUsd : null,
      priority: asInt(body.priority),
      notes: body.notes ?? null,
      preferredPrintingId: body.preferredPrintingId ?? null,
      preferredFinish: body.preferredFinish ?? null,
    });
    return wants.get(id);
  });

  app.patch('/api/v1/want-lists/:id/items/:itemId', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const itemId = asInt((request.params as any).itemId);
    if (id === undefined || itemId === undefined) return reply.status(400).send({ error: 'Invalid id.' });
    wants.updateItem(itemId, (request.body ?? {}) as any);
    return wants.get(id);
  });

  app.delete('/api/v1/want-lists/:id/items/:itemId', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const itemId = asInt((request.params as any).itemId);
    if (id === undefined || itemId === undefined) return reply.status(400).send({ error: 'Invalid id.' });
    wants.removeItem(itemId);
    return wants.get(id);
  });

  app.post('/api/v1/want-lists/:id/reorder', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid list id.' });
    const ids = ((request.body as any)?.orderedIds ?? []).map(asInt).filter((n: unknown) => n !== undefined);
    wants.reorderItems(id, ids);
    return wants.get(id);
  });
}
