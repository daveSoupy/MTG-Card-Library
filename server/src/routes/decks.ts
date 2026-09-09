import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { DeckNotFoundError, type DeckStore } from '../decks/store.ts';
import { BOARDS, type Board, type CommanderRole } from '../decks/types.ts';
import {
  takeSnapshot, listSnapshots, diffSnapshot, restoreSnapshot, deleteSnapshot,
} from '../decks/snapshots.ts';
import { ID, ID_OR_NULL, COUNT, NAME, TEXT, TEXT_OR_NULL, FLAG, body, enumOrNull, idParams, CATEGORY_LIST } from './schema.ts';

const COMMANDER_ROLES: CommanderRole[] = [
  'commander', 'partner', 'background', 'companion', 'signature_spell',
];

const BOARD = { type: 'string', enum: BOARDS } as const;

export function registerDeckRoutes(
  app: FastifyInstance,
  decks: DeckStore,
  db: Database.Database,
): void {
  /** Turns a missing deck into a 404 rather than a 500. */
  const guard = async <T>(reply: any, run: () => T) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof DeckNotFoundError) return reply.status(404).send({ error: error.message });
      throw error;
    }
  };

  app.get('/api/v1/decks', async () => ({ decks: decks.list() }));

  app.post<{ Body: { name: string; formatCode?: string | null; description?: string | null } }>(
    '/api/v1/decks',
    { schema: { body: body({ name: NAME, formatCode: TEXT_OR_NULL, description: TEXT_OR_NULL }, ['name']) } },
    async (request, reply) => {
      const id = decks.create({
        name: request.body.name,
        formatCode: request.body.formatCode ?? null,
        description: request.body.description ?? null,
      });
      return reply.status(201).send({ deck: decks.get(id) });
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const deck = decks.get(request.params.id);
      if (!deck) return reply.status(404).send({ error: 'No deck with that id.' });
      return { deck };
    },
  );

  app.patch<{
    Params: { id: number };
    Body: {
      name?: string; formatCode?: string | null; description?: string | null;
      notes?: string | null; isArchived?: boolean; templateId?: number | null;
    };
  }>(
    '/api/v1/decks/:id',
    {
      schema: {
        params: idParams('id'),
        body: body({
          name: NAME, formatCode: TEXT_OR_NULL, description: TEXT_OR_NULL,
          notes: TEXT_OR_NULL, isArchived: FLAG, templateId: ID_OR_NULL,
        }),
      },
    },
    async (request, reply) => guard(reply, () => {
      const { name, formatCode, description, notes, isArchived, templateId } = request.body;
      decks.update(request.params.id, { name, formatCode, description, notes, isArchived, templateId });
      return { deck: decks.get(request.params.id) };
    }),
  );

  app.post<{ Params: { id: number }; Body: { name?: string } }>(
    '/api/v1/decks/:id/duplicate',
    { schema: { params: idParams('id'), body: body({ name: NAME }) } },
    async (request, reply) => guard(reply, () => {
      const newId = decks.duplicate(request.params.id, request.body?.name);
      return reply.status(201).send({ deck: decks.get(newId) });
    }),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/decks/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => {
      decks.delete(request.params.id);
      return reply.status(204).send();
    }),
  );

  // -- cards within a deck ---------------------------------------------------

  app.post<{
    Params: { id: number };
    Body: {
      oracleId: string; board?: Board; quantity?: number; fromCollection?: number;
      commanderRole?: CommanderRole | null;
    };
  }>(
    '/api/v1/decks/:id/cards',
    {
      schema: {
        params: idParams('id'),
        body: body(
          {
            oracleId: NAME, board: BOARD, quantity: COUNT, fromCollection: COUNT,
            // Only meaningful alongside board 'command'; the store ignores it
            // otherwise. Undo sends it so restoring a signature spell does not
            // come back as a plain commander.
            commanderRole: enumOrNull(COMMANDER_ROLES),
          },
          ['oracleId'],
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { oracleId, board, quantity, fromCollection, commanderRole } = request.body;
      return guard(reply, () => {
        decks.addCard(id, oracleId, { board, quantity: quantity ?? 1, fromCollection, commanderRole });
        // Keep basics in step when the user enabled it — never for a basic-land
        // add, which would fight a deliberate manual change.
        decks.autoMaintainLands(id, oracleId);
        return { deck: decks.get(id) };
      });
    },
  );

  // Fill the deck up to a recommended land count with basics, split by colour.
  app.post<{ Params: { id: number } }>(
    '/api/v1/decks/:id/recommended-lands',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => {
      decks.applyRecommendedLands(request.params.id);
      return { deck: decks.get(request.params.id) };
    }),
  );

  app.patch<{
    Params: { id: number; cardId: number };
    Body: {
      quantity?: number; fromCollection?: number; board?: Board;
      commanderRole?: CommanderRole | null;
      category?: string | null; preferredPrintingId?: string | null;
    };
  }>(
    '/api/v1/decks/:id/cards/:cardId',
    {
      schema: {
        params: idParams('id', 'cardId'),
        body: body({
          quantity: COUNT, fromCollection: COUNT, board: BOARD,
          commanderRole: enumOrNull(COMMANDER_ROLES),
          category: CATEGORY_LIST, preferredPrintingId: TEXT_OR_NULL,
        }),
      },
    },
    async (request, reply) => {
      const { id, cardId } = request.params;
      const { quantity, fromCollection, board, category, preferredPrintingId } = request.body;

      // Captured before the edit: a quantity of 0 removes the slot, after which
      // its oracle id can no longer be looked up.
      const editedOracle = decks.oracleForCard(id, cardId);

      if (category !== undefined) decks.setCategory(id, cardId, category);
      if (preferredPrintingId !== undefined) {
        decks.setPreferredPrinting(id, cardId, preferredPrintingId || null);
      }
      if (quantity !== undefined) decks.setQuantity(id, cardId, quantity);
      if (fromCollection !== undefined) decks.setFromCollection(id, cardId, fromCollection);
      if (board !== undefined) decks.setBoard(id, cardId, board, request.body.commanderRole ?? null);

      // A quantity or board change alters the mana base; rebalance basics if on.
      if (quantity !== undefined || board !== undefined) {
        decks.autoMaintainLands(id, editedOracle);
      }

      const deck = decks.get(id);
      if (!deck) return reply.status(404).send({ error: 'No deck with that id.' });
      return { deck };
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/categories',
    { schema: { params: idParams('id') } },
    async (request) => ({ categories: decks.categories(request.params.id) }),
  );

  app.delete<{ Params: { id: number; cardId: number } }>(
    '/api/v1/decks/:id/cards/:cardId',
    { schema: { params: idParams('id', 'cardId') } },
    async (request, reply) => {
      const { id, cardId } = request.params;
      const editedOracle = decks.oracleForCard(id, cardId);
      decks.removeCard(id, cardId);
      decks.autoMaintainLands(id, editedOracle);
      const deck = decks.get(id);
      if (!deck) return reply.status(404).send({ error: 'No deck with that id.' });
      return { deck };
    },
  );

  // -- cover art ---------------------------------------------------------------

  app.put<{ Params: { id: number }; Body: { printingId?: string | null } }>(
    '/api/v1/decks/:id/cover',
    { schema: { params: idParams('id'), body: body({ printingId: TEXT_OR_NULL }) } },
    async (request, reply) => {
      const { id } = request.params;
      if (!decks.get(id)) return reply.status(404).send({ error: 'No such deck.' });
      decks.setCover(id, request.body?.printingId ?? null);
      return { decks: decks.list() };
    },
  );

  // -- tags --------------------------------------------------------------------

  app.get('/api/v1/deck-tags', async () => ({ tags: decks.allTags() }));

  app.post<{ Params: { id: number }; Body: { tag: string } }>(
    '/api/v1/decks/:id/tags',
    { schema: { params: idParams('id'), body: body({ tag: NAME }, ['tag']) } },
    async (request, reply) => {
      const { id } = request.params;
      if (!decks.get(id)) return reply.status(404).send({ error: 'No such deck.' });
      if (!request.body.tag.trim()) return reply.status(400).send({ error: 'A tag needs a name.' });
      decks.addTag(id, request.body.tag);
      return { tags: decks.tags(id), allTags: decks.allTags() };
    },
  );

  app.delete<{ Params: { id: number; tag: string } }>(
    '/api/v1/decks/:id/tags/:tag',
    {
      schema: {
        params: {
          type: 'object', required: ['id', 'tag'],
          properties: { id: ID, tag: NAME }, additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { id, tag } = request.params;
      decks.removeTag(id, decodeURIComponent(tag));
      return { tags: decks.tags(id), allTags: decks.allTags() };
    },
  );

  // -- snapshots ---------------------------------------------------------------

  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/snapshots',
    { schema: { params: idParams('id') } },
    async (request) => ({ snapshots: listSnapshots(db, request.params.id) }),
  );

  app.post<{ Params: { id: number }; Body: { name?: string; note?: string | null } }>(
    '/api/v1/decks/:id/snapshots',
    { schema: { params: idParams('id'), body: body({ name: TEXT, note: TEXT_OR_NULL }) } },
    async (request, reply) => {
      const { id } = request.params;
      if (!decks.get(id)) return reply.status(404).send({ error: 'No such deck.' });

      const name = request.body?.name?.trim()
        ? request.body.name.trim()
        : new Date().toISOString().slice(0, 16).replace('T', ' ');
      takeSnapshot(db, id, name, request.body?.note ?? null);
      return reply.status(201).send({ snapshots: listSnapshots(db, id) });
    },
  );

  app.get<{ Params: { snapshotId: number } }>(
    '/api/v1/snapshots/:snapshotId/diff',
    { schema: { params: idParams('snapshotId') } },
    async (request, reply) => {
      const diff = diffSnapshot(db, request.params.snapshotId);
      if (!diff) return reply.status(404).send({ error: 'No such snapshot.' });
      return diff;
    },
  );

  app.post<{ Params: { snapshotId: number } }>(
    '/api/v1/snapshots/:snapshotId/restore',
    { schema: { params: idParams('snapshotId') } },
    async (request, reply) => {
      const result = restoreSnapshot(db, request.params.snapshotId);
      if (!result) return reply.status(404).send({ error: 'No such snapshot.' });
      return { deck: decks.get(result.deckId), snapshots: listSnapshots(db, result.deckId) };
    },
  );

  app.delete<{ Params: { snapshotId: number } }>(
    '/api/v1/snapshots/:snapshotId',
    { schema: { params: idParams('snapshotId') } },
    async (request, reply) => {
      deleteSnapshot(db, request.params.snapshotId);
      return reply.status(204).send();
    },
  );
}
