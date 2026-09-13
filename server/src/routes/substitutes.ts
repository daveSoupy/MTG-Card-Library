import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { SubstituteError, substitutesFor } from '../decks/substitutes.ts';
import { ID, NAME } from './schema.ts';

/**
 * Phase 27: cards you own that could stand in for one you are short of.
 *
 * Read-only, both of them. Accepting a suggestion goes through the ordinary
 * deck card routes — one DELETE or PATCH, one POST — so there is nothing here
 * that writes and no second allocation path.
 */
export function registerSubstituteRoutes(app: FastifyInstance, db: Database.Database): void {
  const guard = async <T>(reply: any, run: () => T) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof SubstituteError) return reply.status(error.status).send({ error: error.message });
      throw error;
    }
  };

  /** Substitutes for a slot, in the deck's colour identity and format. */
  app.get<{ Params: { id: number; oracleId: string } }>(
    '/api/v1/decks/:id/cards/:oracleId/substitutes',
    {
      schema: {
        params: {
          type: 'object', required: ['id', 'oracleId'],
          properties: { id: ID, oracleId: NAME }, additionalProperties: false,
        },
      },
    },
    async (request, reply) => guard(reply, () =>
      substitutesFor(db, request.params.oracleId, request.params.id)),
  );

  /**
   * The same for a want-list item. `deckId` is optional: with one, the deck
   * supplies colour and format; without, every owned free card is fair game.
   */
  app.get<{ Querystring: { oracleId: string; deckId?: number } }>(
    '/api/v1/substitutes',
    {
      schema: {
        querystring: {
          type: 'object', required: ['oracleId'],
          properties: { oracleId: NAME, deckId: ID }, additionalProperties: false,
        },
      },
    },
    async (request, reply) => guard(reply, () =>
      substitutesFor(db, request.query.oracleId, request.query.deckId ?? null)),
  );
}
