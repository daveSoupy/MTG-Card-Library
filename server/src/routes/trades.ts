import type { FastifyInstance } from 'fastify';
import { TradeStore, TradeNotFoundError, TradeNotDraftError, type Direction } from '../trades/store.ts';

const asInt = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

const asDirection = (v: unknown): Direction | undefined =>
  v === 'out' || v === 'in' ? v : undefined;

/**
 * Trades: draft build/edit, then completion applies the deltas to the
 * collection. The store owns every rule; the routes only shuttle JSON.
 */
export function registerTradeRoutes(app: FastifyInstance, trades: TradeStore): void {
  const guard = async <T>(reply: any, run: () => T) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof TradeNotFoundError) return reply.status(404).send({ error: error.message });
      if (error instanceof TradeNotDraftError) return reply.status(409).send({ error: error.message });
      throw error;
    }
  };

  app.get('/api/v1/trades', async (request) => {
    const status = (request.query as any)?.status;
    return { trades: trades.list(status ? { status } : {}) };
  });

  app.post('/api/v1/trades', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    if (typeof body.counterpartyName !== 'string' || !body.counterpartyName.trim()) {
      return reply.status(400).send({ error: 'counterpartyName is required.' });
    }
    const id = trades.create({
      counterpartyName: body.counterpartyName,
      counterpartyContact: body.counterpartyContact ?? null,
      tradeDate: body.tradeDate ?? null,
      locationNote: body.locationNote ?? null,
      notes: body.notes ?? null,
    });
    return { trade: trades.get(id) };
  });

  app.get('/api/v1/trades/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid trade id.' });
    return guard(reply, () => ({ trade: trades.get(id) }));
  });

  app.patch('/api/v1/trades/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid trade id.' });
    return guard(reply, () => { trades.update(id, (request.body ?? {}) as any); return { trade: trades.get(id) }; });
  });

  app.delete('/api/v1/trades/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid trade id.' });
    return guard(reply, () => { trades.delete(id); return reply.status(204).send(); });
  });

  app.post('/api/v1/trades/:id/cancel', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid trade id.' });
    return guard(reply, () => { trades.cancel(id); return { trade: trades.get(id) }; });
  });

  app.post('/api/v1/trades/:id/items', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid trade id.' });
    const body = (request.body ?? {}) as any;
    const direction = asDirection(body.direction);
    if (!direction) return reply.status(400).send({ error: 'direction must be "out" or "in".' });
    if (typeof body.printingId !== 'string') return reply.status(400).send({ error: 'printingId is required.' });
    return guard(reply, () => {
      trades.addItem(id, {
        direction,
        printingId: body.printingId,
        quantity: asInt(body.quantity) ?? 1,
        finish: body.finish, condition: body.condition, language: body.language,
        sourceCollectionItemId: asInt(body.sourceCollectionItemId),
        destinationLocationId: asInt(body.destinationLocationId),
        unitValueUsd: typeof body.unitValueUsd === 'number' ? body.unitValueUsd : null,
        notes: body.notes ?? null,
      });
      return { trade: trades.get(id) };
    });
  });

  app.patch('/api/v1/trades/:id/items/:itemId', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const itemId = asInt((request.params as any).itemId);
    if (id === undefined || itemId === undefined) return reply.status(400).send({ error: 'Invalid id.' });
    return guard(reply, () => { trades.updateItem(id, itemId, (request.body ?? {}) as any); return { trade: trades.get(id) }; });
  });

  app.delete('/api/v1/trades/:id/items/:itemId', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const itemId = asInt((request.params as any).itemId);
    if (id === undefined || itemId === undefined) return reply.status(400).send({ error: 'Invalid id.' });
    return guard(reply, () => { trades.removeItem(id, itemId); return { trade: trades.get(id) }; });
  });

  app.post('/api/v1/trades/:id/complete', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid trade id.' });
    const force = (request.body as any)?.force === true;
    return guard(reply, () => {
      const result = trades.complete(id, { force });
      return { result, trade: trades.get(id) };
    });
  });
}
