import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  CardNotFoundError, DeckNotFoundError, UnknownFormatError, type DeckStore,
} from '../decks/store.ts';
import { DECK_STATUSES, SlotOverfilledError, type DeckStatus } from '../decks/allocation.ts';
import {
  buildabilityDetail, buildabilityForDecks, compareBuildability, isBuildabilitySort,
} from '../decks/buildability.ts';
import { pushToWantList } from '../collection/shopping.ts';
import { BOARDS, type Board, type CommanderRole } from '../decks/types.ts';
import {
  takeSnapshot, listSnapshots, diffSnapshot, restoreSnapshot, deleteSnapshot,
} from '../decks/snapshots.ts';
import { ID, ID_OR_NULL, COUNT, NAME, TEXT, TEXT_OR_NULL, FLAG, body, enumOrNull, idParams, CATEGORY_LIST } from './schema.ts';

const COMMANDER_ROLES: CommanderRole[] = [
  'commander', 'partner', 'background', 'companion', 'signature_spell',
];

const BOARD = { type: 'string', enum: BOARDS } as const;
const STATUS = { type: 'string', enum: [...DECK_STATUSES] } as const;

export function registerDeckRoutes(
  app: FastifyInstance,
  decks: DeckStore,
  db: Database.Database,
): void {
  /**
   * Turns a missing deck or card into a 404 and an impossible slot or unknown
   * format into a 400, rather than any into a 500. An over-filled slot is
   * rejected outright — clamping it would leave the client showing a number
   * the user never asked for.
   */
  const guard = async <T>(reply: any, run: () => T) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof DeckNotFoundError) return reply.status(404).send({ error: error.message });
      if (error instanceof CardNotFoundError) return reply.status(404).send({ error: error.message });
      if (error instanceof UnknownFormatError) return reply.status(400).send({ error: error.message });
      if (error instanceof SlotOverfilledError) return reply.status(400).send({ error: error.message });
      throw error;
    }
  };

  /**
   * The deck list, optionally with the figure that decides whether you buy
   * cards this week.
   *
   * Buildability is opt-in because it is a real computation over the whole
   * collection, and most callers of this endpoint (the deck picker, the import
   * dialog) only want names. Asking for one of the buildability sorts implies
   * it — sorting by a number the response does not carry would leave the client
   * unable to explain its own ordering.
   *
   * All decks are computed in one pass. A loop calling this per deck would be
   * correct and still wrong: this screen is the deliverable.
   */
  app.get<{ Querystring: { include?: string; sort?: string } }>(
    '/api/v1/decks',
    async (request) => {
      const sort = request.query?.sort;
      const sorted = isBuildabilitySort(sort) ? sort : null;
      const wanted = request.query?.include?.split(',').includes('buildability') || sorted !== null;

      const list = decks.list();
      if (!wanted) return { decks: list };

      const figures = buildabilityForDecks(db, list.map((deck) => deck.id));
      const withFigures = list.map((deck) => ({
        ...deck,
        buildability: figures.get(deck.id) ?? null,
      }));

      if (sorted) {
        // A stable sort over the store's own ordering, so decks that tie on the
        // figure stay in the order the rest of the app shows them in.
        withFigures.sort((a, b) => compareBuildability(sorted, figures.get(a.id), figures.get(b.id)));
      }
      return { decks: withFigures };
    },
  );

  // -- buildability ------------------------------------------------------------

  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/buildability',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const detail = buildabilityDetail(db, request.params.id);
      if (!detail) return reply.status(404).send({ error: 'No deck with that id.' });
      return detail;
    },
  );

  /**
   * Everything this deck is short of, onto a want list.
   *
   * The *computed* missing set, not the declared one the shopping list pushes:
   * these are copies your collection could not supply, whether or not you ever
   * ticked "need to buy". Basics are already absent and proxied copies already
   * count as covered, so neither reaches the list.
   */
  app.post<{ Params: { id: number }; Body: { wantListId?: number; oracleIds?: string[] } }>(
    '/api/v1/decks/:id/buildability/want',
    {
      schema: {
        params: idParams('id'),
        body: body({ wantListId: ID, oracleIds: { type: 'array', items: NAME } }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!decks.get(id)) return reply.status(404).send({ error: 'No deck with that id.' });
      try {
        // Every missing card, or only the ones named — one row's "Want".
        return pushToWantList(db, id, {
          wantListId: request.body?.wantListId, oracleIds: request.body?.oracleIds,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({ error: 'Could not add to the want list.', detail: message });
      }
    },
  );

  app.post<{ Body: { name: string; formatCode?: string | null; description?: string | null } }>(
    '/api/v1/decks',
    { schema: { body: body({ name: NAME, formatCode: TEXT_OR_NULL, description: TEXT_OR_NULL }, ['name']) } },
    async (request, reply) => guard(reply, () => {
      const id = decks.create({
        name: request.body.name,
        formatCode: request.body.formatCode ?? null,
        description: request.body.description ?? null,
      });
      return reply.status(201).send({ deck: decks.get(id) });
    }),
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
      status?: DeckStatus; homeLocationId?: number | null;
    };
  }>(
    '/api/v1/decks/:id',
    {
      schema: {
        params: idParams('id'),
        body: body({
          name: NAME, formatCode: TEXT_OR_NULL, description: TEXT_OR_NULL,
          notes: TEXT_OR_NULL, isArchived: FLAG, templateId: ID_OR_NULL,
          // Where the physical deck lives — the destination an assembly run
          // moves lots into, and where a disassembly takes them back from.
          homeLocationId: ID_OR_NULL,
          // Whether the deck reserves its copies. The store stamps
          // status_changed_at and leaves every slot's claim untouched, so
          // assembled → brew → assembled is lossless.
          status: STATUS,
        }),
      },
    },
    async (request, reply) => guard(reply, () => {
      const {
        name, formatCode, description, notes, isArchived, templateId, status, homeLocationId,
      } = request.body;
      decks.update(request.params.id, {
        name, formatCode, description, notes, isArchived, templateId, status, homeLocationId,
      });
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
      commanderRole?: CommanderRole | null; printingId?: string | null;
    };
  }>(
    '/api/v1/decks/:id/cards',
    {
      schema: {
        params: idParams('id'),
        body: body(
          {
            oracleId: NAME, board: BOARD, fromCollection: COUNT,
            // Adding zero copies is not an addition. Rejected rather than
            // rounded up to one, which the store would otherwise do silently.
            quantity: { ...COUNT, minimum: 1 },
            // The printing the client was looking at. Pins a new slot's art,
            // and is the printing a limited deck's add puts in the collection.
            printingId: TEXT_OR_NULL,
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
      const { oracleId, board, quantity, fromCollection, commanderRole, printingId } = request.body;
      return guard(reply, () => {
        decks.addCard(id, oracleId, {
          board, quantity: quantity ?? 1, fromCollection, commanderRole, printingId,
        });
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
      quantity?: number; fromCollection?: number; quantityProxied?: number; board?: Board;
      commanderRole?: CommanderRole | null;
      category?: string | null; preferredPrintingId?: string | null;
    };
  }>(
    '/api/v1/decks/:id/cards/:cardId',
    {
      schema: {
        params: idParams('id', 'cardId'),
        body: body({
          quantity: COUNT, fromCollection: COUNT, quantityProxied: COUNT, board: BOARD,
          commanderRole: enumOrNull(COMMANDER_ROLES),
          category: CATEGORY_LIST, preferredPrintingId: TEXT_OR_NULL,
        }),
      },
    },
    async (request, reply) => {
      const { id, cardId } = request.params;
      const {
        quantity, fromCollection, quantityProxied, board, category, preferredPrintingId,
      } = request.body;

      // Captured before the edit: a quantity of 0 removes the slot, after which
      // its oracle id can no longer be looked up.
      const editedOracle = decks.oracleForCard(id, cardId);

      if (category !== undefined) decks.setCategory(id, cardId, category);
      if (preferredPrintingId !== undefined) {
        decks.setPreferredPrinting(id, cardId, preferredPrintingId || null);
      }
      if (quantity !== undefined) decks.setQuantity(id, cardId, quantity);
      // Both allocation fields go in one call, so swapping two proxies for two
      // owned copies is never judged against a half-applied state that only
      // existed between two writes.
      if (fromCollection !== undefined || quantityProxied !== undefined) {
        try {
          decks.setSlotAllocation(id, cardId, { fromCollection, proxied: quantityProxied });
        } catch (error) {
          if (!(error instanceof SlotOverfilledError)) throw error;
          return reply.status(400).send({ error: error.message });
        }
      }
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
