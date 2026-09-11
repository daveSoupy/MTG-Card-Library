import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  ContentionError, cardHolders, contestedCards, reassign, whatIf,
} from '../decks/contention.ts';
import { ID, COUNT, NAME, body } from './schema.ts';

/**
 * Phase 26: which decks are fighting over which copies, and what to do about it.
 *
 * Every rule lives in `decks/contention.ts`; these handlers only turn a URL
 * into a call and a `ContentionError` into a 400.
 */
export function registerAllocationRoutes(app: FastifyInstance, db: Database.Database): void {
  /** The contested set, worst first. */
  app.get('/api/v1/allocation/contention', async () => ({ cards: contestedCards(db) }));

  /** Moves a claim between two decks. Both decks' figures come back with it. */
  app.post<{ Body: { oracleId: string; fromDeckId: number; toDeckId: number; quantity: number } }>(
    '/api/v1/allocation/reassign',
    {
      schema: {
        body: body(
          { oracleId: NAME, fromDeckId: ID, toDeckId: ID, quantity: COUNT },
          ['oracleId', 'fromDeckId', 'toDeckId', 'quantity'],
        ),
      },
    },
    async (request, reply) => {
      try {
        return reassign(db, request.body);
      } catch (error) {
        if (error instanceof ContentionError) return reply.status(400).send({ error: error.message });
        throw error;
      }
    },
  );

  /** What breaking a deck up would free. Reads only — nothing is written. */
  app.get<{ Querystring: { disassemble: number } }>(
    '/api/v1/allocation/what-if',
    {
      schema: {
        querystring: {
          type: 'object', required: ['disassemble'],
          properties: { disassemble: ID }, additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const result = whatIf(db, request.query.disassemble);
      if (!result) return reply.status(404).send({ error: 'No deck with that id.' });
      return result;
    },
  );

  /** Who holds a card and where its copies physically live. */
  app.get<{ Params: { oracleId: string } }>(
    '/api/v1/allocation/holders/:oracleId',
    {
      schema: {
        params: {
          type: 'object', required: ['oracleId'],
          properties: { oracleId: NAME }, additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const result = cardHolders(db, request.params.oracleId);
      if (!result) return reply.status(404).send({ error: 'No card with that id.' });
      return result;
    },
  );
}
