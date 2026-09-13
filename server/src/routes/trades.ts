import type { FastifyInstance } from 'fastify';
import {
  TradeStore, TradeNotFoundError, TradeNotDraftError, TradeShortfallError,
  type Direction, type TradeItemUpdate, type TradeUpdate,
} from '../trades/store.ts';
import { CONDITIONS, FINISHES } from '../collection/store.ts';
import {
  ID, ID_OR_NULL, MONEY_OR_NULL, NAME, TEXT, TEXT_OR_NULL, FLAG, DATE_OR_NULL,
  body as bodySchema, idParams,
} from './schema.ts';

const DIRECTION = { type: 'string', enum: ['out', 'in'] } as const;
const FINISH = { type: 'string', enum: FINISHES } as const;
const CONDITION = { type: 'string', enum: CONDITIONS } as const;

/** Everything a trade item carries beyond which card it is. */
const ITEM_FIELDS = {
  quantity: { type: 'integer', minimum: 1 },
  finish: FINISH,
  condition: CONDITION,
  language: TEXT,
  // Nullable: clearing the chosen lot or destination is a real edit.
  sourceCollectionItemId: ID_OR_NULL,
  destinationLocationId: ID_OR_NULL,
  unitValueUsd: MONEY_OR_NULL,
  notes: TEXT_OR_NULL,
};

/** The mutable fields of the trade itself. */
const TRADE_FIELDS = {
  counterpartyName: NAME,
  counterpartyContact: TEXT_OR_NULL,
  tradeDate: DATE_OR_NULL,
  locationNote: TEXT_OR_NULL,
  notes: TEXT_OR_NULL,
};

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
      if (error instanceof TradeShortfallError) {
        return reply.status(409).send({ error: error.message, shortfalls: error.shortfalls });
      }
      throw error;
    }
  };

  app.get('/api/v1/trades', async (request) => {
    const status = (request.query as any)?.status;
    return { trades: trades.list(status ? { status } : {}) };
  });

  app.post<{ Body: TradeUpdate & { counterpartyName: string } }>(
    '/api/v1/trades',
    { schema: { body: bodySchema(TRADE_FIELDS, ['counterpartyName']) } },
    async (request, reply) => {
      const body = request.body;
      if (!body.counterpartyName.trim()) {
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
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/v1/trades/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => ({ trade: trades.get(request.params.id) })),
  );

  app.patch<{ Params: { id: number }; Body: TradeUpdate }>(
    '/api/v1/trades/:id',
    { schema: { params: idParams('id'), body: bodySchema(TRADE_FIELDS) } },
    async (request, reply) => guard(reply, () => {
      trades.update(request.params.id, request.body);
      return { trade: trades.get(request.params.id) };
    }),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/trades/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => {
      trades.delete(request.params.id);
      return reply.status(204).send();
    }),
  );

  app.post<{ Params: { id: number } }>(
    '/api/v1/trades/:id/cancel',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => {
      trades.cancel(request.params.id);
      return { trade: trades.get(request.params.id) };
    }),
  );

  app.post<{ Params: { id: number }; Body: TradeItemUpdate & { direction: Direction; printingId: string } }>(
    '/api/v1/trades/:id/items',
    {
      schema: {
        params: idParams('id'),
        body: bodySchema(
          { direction: DIRECTION, printingId: NAME, ...ITEM_FIELDS },
          ['direction', 'printingId'],
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      return guard(reply, () => {
        trades.addItem(id, { ...body, quantity: body.quantity ?? 1 });
        return { trade: trades.get(id) };
      });
    },
  );

  app.patch<{
    Params: { id: number; itemId: number };
    Body: TradeItemUpdate;
  }>(
    '/api/v1/trades/:id/items/:itemId',
    {
      schema: {
        params: idParams('id', 'itemId'),
        body: bodySchema({ printingId: NAME, ...ITEM_FIELDS }),
      },
    },
    async (request, reply) => {
      const { id, itemId } = request.params;
      return guard(reply, () => {
        trades.updateItem(id, itemId, request.body);
        return { trade: trades.get(id) };
      });
    },
  );

  app.delete<{ Params: { id: number; itemId: number } }>(
    '/api/v1/trades/:id/items/:itemId',
    { schema: { params: idParams('id', 'itemId') } },
    async (request, reply) => {
      const { id, itemId } = request.params;
      return guard(reply, () => {
        trades.removeItem(id, itemId);
        return { trade: trades.get(id) };
      });
    },
  );

  // The web UI always takes the 'prompt' path: it can show the conflict and ask.
  // The non-interactive 'alert' mode is for Phase 13 and Phase 20, which call
  // the store directly.
  app.post<{ Params: { id: number }; Body: { force?: boolean } }>(
    '/api/v1/trades/:id/complete',
    { schema: { params: idParams('id'), body: bodySchema({ force: FLAG }) } },
    async (request, reply) => {
      const { id } = request.params;
      const force = request.body?.force === true;
      return guard(reply, () => {
        const result = trades.complete(id, { force });
        return { result, trade: trades.get(id) };
      });
    },
  );
}
