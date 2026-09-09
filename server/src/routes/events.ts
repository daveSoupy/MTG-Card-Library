import type { FastifyInstance } from 'fastify';
import {
  EventStore, EventNotFoundError, GameNotFoundError, GAME_RESULTS,
  type EventUpdate, type GameFilters, type GameInput, type GameUpdate,
} from '../events/store.ts';
import {
  ID, ID_OR_NULL, NAME, TEXT_OR_NULL, DATE_OR_NULL,
  body as bodySchema, idParams,
} from './schema.ts';

const RESULT = { type: 'string', enum: GAME_RESULTS } as const;
/** A Bo3 sub-count, or null to clear it. */
const COUNT_OR_NULL = { type: ['integer', 'null'], minimum: 0 } as const;
/** played_at is a full timestamp, not a date — a night holds several games. */
const TIMESTAMP_OR_NULL = { type: ['string', 'null'] } as const;

const EVENT_FIELDS = {
  name: NAME,
  formatCode: TEXT_OR_NULL,
  eventDate: DATE_OR_NULL,
  deckId: ID_OR_NULL,
  importBatchId: ID_OR_NULL,
  notes: TEXT_OR_NULL,
};

const GAME_FIELDS = {
  deckId: ID,
  eventId: ID_OR_NULL,
  playedAt: TIMESTAMP_OR_NULL,
  opponents: TEXT_OR_NULL,
  result: RESULT,
  gamesWon: COUNT_OR_NULL,
  gamesLost: COUNT_OR_NULL,
  gamesDrawn: COUNT_OR_NULL,
  roundNumber: COUNT_OR_NULL,
  notes: TEXT_OR_NULL,
};

/** The record view's filters, read from the query string. */
function filtersFrom(query: any): GameFilters {
  const number = (value: unknown) =>
    value === undefined || value === '' ? undefined : Number(value);
  return {
    deckId: number(query?.deckId),
    eventId: number(query?.eventId),
    formatCode: typeof query?.format === 'string' && query.format ? query.format : undefined,
    from: typeof query?.from === 'string' && query.from ? query.from : undefined,
    to: typeof query?.to === 'string' && query.to ? query.to : undefined,
    limit: number(query?.limit),
  };
}

/**
 * Events and the game log. The store owns every rule; these routes only shuttle
 * JSON and turn a missing row into a 404.
 */
export function registerEventRoutes(app: FastifyInstance, events: EventStore): void {
  const guard = async <T>(reply: any, run: () => T) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof EventNotFoundError || error instanceof GameNotFoundError) {
        return reply.status(404).send({ error: error.message });
      }
      throw error;
    }
  };

  app.get('/api/v1/events', async () => ({ events: events.list() }));

  app.get<{ Params: { id: number } }>(
    '/api/v1/events/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const event = events.get(request.params.id);
      if (!event) return reply.status(404).send({ error: 'No event with that id.' });
      return { event };
    },
  );

  app.post<{ Body: EventUpdate & { name: string } }>(
    '/api/v1/events',
    { schema: { body: bodySchema(EVENT_FIELDS, ['name']) } },
    async (request, reply) => {
      if (!request.body.name.trim()) {
        return reply.status(400).send({ error: 'An event needs a name.' });
      }
      const id = events.create({ ...request.body, name: request.body.name });
      return reply.status(201).send({ event: events.get(id) });
    },
  );

  app.patch<{ Params: { id: number }; Body: EventUpdate }>(
    '/api/v1/events/:id',
    { schema: { params: idParams('id'), body: bodySchema(EVENT_FIELDS) } },
    async (request, reply) => guard(reply, () => {
      events.update(request.params.id, request.body);
      return { event: events.get(request.params.id) };
    }),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/events/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => {
      events.delete(request.params.id);
      return reply.status(204).send();
    }),
  );

  // -- games -----------------------------------------------------------------

  // The record view: the same filters drive the list and the tally beside it.
  app.get('/api/v1/games', async (request) => {
    const filters = filtersFrom(request.query);
    return { games: events.games(filters), record: events.record(filters) };
  });

  app.post<{ Body: GameInput }>(
    '/api/v1/games',
    { schema: { body: bodySchema(GAME_FIELDS, ['deckId', 'result']) } },
    async (request, reply) => {
      try {
        const id = events.logGame(request.body);
        return reply.status(201).send({ game: events.getGame(id) });
      } catch (error) {
        // The only way logGame refuses is a deck that is not there.
        return reply.status(404).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  app.patch<{ Params: { id: number }; Body: GameUpdate }>(
    '/api/v1/games/:id',
    { schema: { params: idParams('id'), body: bodySchema(GAME_FIELDS) } },
    async (request, reply) => guard(reply, () => {
      events.updateGame(request.params.id, request.body);
      return { game: events.getGame(request.params.id) };
    }),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/games/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => {
      events.deleteGame(request.params.id);
      return reply.status(204).send();
    }),
  );

  // A deck's own page: its lifetime record and the games behind it, event
  // games and kitchen-table games alike.
  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/games',
    { schema: { params: idParams('id') } },
    async (request) => {
      const deckId = request.params.id;
      return { games: events.games({ deckId }), record: events.record({ deckId }) };
    },
  );
}
