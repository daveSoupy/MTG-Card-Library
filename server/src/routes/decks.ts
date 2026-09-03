import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { DeckNotFoundError, type DeckStore } from '../decks/store.ts';
import { BOARDS, type Board, type CommanderRole } from '../decks/types.ts';
import {
  takeSnapshot, listSnapshots, diffSnapshot, restoreSnapshot, deleteSnapshot,
} from '../decks/snapshots.ts';

const COMMANDER_ROLES: CommanderRole[] = [
  'commander', 'partner', 'background', 'companion', 'signature_spell',
];

const asBoard = (value: unknown): Board | undefined =>
  BOARDS.includes(value as Board) ? (value as Board) : undefined;

const asRole = (value: unknown): CommanderRole | null =>
  COMMANDER_ROLES.includes(value as CommanderRole) ? (value as CommanderRole) : null;

function asInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

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

  app.post('/api/v1/decks', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return reply.status(400).send({ error: 'A deck needs a name.' });
    }
    const id = decks.create({
      name: body.name,
      formatCode: typeof body.formatCode === 'string' ? body.formatCode : null,
      description: typeof body.description === 'string' ? body.description : null,
    });
    return reply.status(201).send({ deck: decks.get(id) });
  });

  app.get('/api/v1/decks/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const deck = id === undefined ? null : decks.get(id);
    if (!deck) return reply.status(404).send({ error: 'No deck with that id.' });
    return { deck };
  });

  app.patch('/api/v1/decks/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid deck id.' });
    const body = (request.body ?? {}) as any;

    return guard(reply, () => {
      decks.update(id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        formatCode: body.formatCode === null || typeof body.formatCode === 'string'
          ? body.formatCode : undefined,
        description: body.description === null || typeof body.description === 'string'
          ? body.description : undefined,
        notes: body.notes === null || typeof body.notes === 'string' ? body.notes : undefined,
        isArchived: typeof body.isArchived === 'boolean' ? body.isArchived : undefined,
      });
      return { deck: decks.get(id) };
    });
  });

  app.post('/api/v1/decks/:id/duplicate', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid deck id.' });
    const body = (request.body ?? {}) as any;

    return guard(reply, () => {
      const newId = decks.duplicate(id, typeof body.name === 'string' ? body.name : undefined);
      return reply.status(201).send({ deck: decks.get(newId) });
    });
  });

  app.delete('/api/v1/decks/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid deck id.' });
    return guard(reply, () => {
      decks.delete(id);
      return reply.status(204).send();
    });
  });

  // -- cards within a deck ---------------------------------------------------

  app.post('/api/v1/decks/:id/cards', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid deck id.' });
    const body = (request.body ?? {}) as any;
    if (typeof body.oracleId !== 'string' || !body.oracleId) {
      return reply.status(400).send({ error: 'oracleId is required.' });
    }

    return guard(reply, () => {
      decks.addCard(id, body.oracleId, {
        board: asBoard(body.board),
        quantity: asInt(body.quantity) ?? 1,
        fromCollection: asInt(body.fromCollection),
      });
      return { deck: decks.get(id) };
    });
  });

  app.patch('/api/v1/decks/:id/cards/:cardId', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const cardId = asInt((request.params as any).cardId);
    if (id === undefined || cardId === undefined) {
      return reply.status(400).send({ error: 'Invalid deck or card id.' });
    }
    const body = (request.body ?? {}) as any;

    const quantity = asInt(body.quantity);
    const fromCollection = asInt(body.fromCollection);
    const board = asBoard(body.board);

    if (body.category !== undefined) {
      decks.setCategory(id, cardId, typeof body.category === 'string' ? body.category : null);
    }
    if (body.preferredPrintingId !== undefined) {
      decks.setPreferredPrinting(
        id, cardId,
        typeof body.preferredPrintingId === 'string' && body.preferredPrintingId
          ? body.preferredPrintingId : null,
      );
    }
    if (quantity !== undefined) decks.setQuantity(id, cardId, quantity);
    if (fromCollection !== undefined) decks.setFromCollection(id, cardId, fromCollection);
    if (board !== undefined) decks.setBoard(id, cardId, board, asRole(body.commanderRole));

    const deck = decks.get(id);
    if (!deck) return reply.status(404).send({ error: 'No deck with that id.' });
    return { deck };
  });

  app.get('/api/v1/decks/:id/categories', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid deck id.' });
    return { categories: decks.categories(id) };
  });

  app.delete('/api/v1/decks/:id/cards/:cardId', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const cardId = asInt((request.params as any).cardId);
    if (id === undefined || cardId === undefined) {
      return reply.status(400).send({ error: 'Invalid deck or card id.' });
    }
    decks.removeCard(id, cardId);
    const deck = decks.get(id);
    if (!deck) return reply.status(404).send({ error: 'No deck with that id.' });
    return { deck };
  });

  // -- cover art ---------------------------------------------------------------

  app.put('/api/v1/decks/:id/cover', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad deck id.' });
    if (!decks.get(id)) return reply.status(404).send({ error: 'No such deck.' });

    const printingId = (request.body as any)?.printingId ?? null;
    if (printingId !== null && typeof printingId !== 'string') {
      return reply.status(400).send({ error: 'printingId must be a string or null.' });
    }
    decks.setCover(id, printingId);
    return { decks: decks.list() };
  });

  // -- tags --------------------------------------------------------------------

  app.get('/api/v1/deck-tags', async () => ({ tags: decks.allTags() }));

  app.post('/api/v1/decks/:id/tags', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad deck id.' });
    if (!decks.get(id)) return reply.status(404).send({ error: 'No such deck.' });

    const tag = (request.body as any)?.tag;
    if (typeof tag !== 'string' || tag.trim() === '') {
      return reply.status(400).send({ error: 'A tag needs a name.' });
    }
    decks.addTag(id, tag);
    return { tags: decks.tags(id), allTags: decks.allTags() };
  });

  app.delete('/api/v1/decks/:id/tags/:tag', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad deck id.' });
    const { tag } = request.params as any;
    decks.removeTag(id, decodeURIComponent(tag));
    return { tags: decks.tags(id), allTags: decks.allTags() };
  });

  // -- snapshots ---------------------------------------------------------------

  app.get('/api/v1/decks/:id/snapshots', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad deck id.' });
    return { snapshots: listSnapshots(db, id) };
  });

  app.post('/api/v1/decks/:id/snapshots', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad deck id.' });
    if (!decks.get(id)) return reply.status(404).send({ error: 'No such deck.' });

    const body = (request.body ?? {}) as any;
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : new Date().toISOString().slice(0, 16).replace('T', ' ');
    takeSnapshot(db, id, name, typeof body.note === 'string' ? body.note : null);
    return reply.status(201).send({ snapshots: listSnapshots(db, id) });
  });

  app.get('/api/v1/snapshots/:snapshotId/diff', async (request, reply) => {
    const snapshotId = asInt((request.params as any).snapshotId);
    if (snapshotId === undefined) return reply.status(400).send({ error: 'Bad snapshot id.' });
    const diff = diffSnapshot(db, snapshotId);
    if (!diff) return reply.status(404).send({ error: 'No such snapshot.' });
    return diff;
  });

  app.post('/api/v1/snapshots/:snapshotId/restore', async (request, reply) => {
    const snapshotId = asInt((request.params as any).snapshotId);
    if (snapshotId === undefined) return reply.status(400).send({ error: 'Bad snapshot id.' });
    const result = restoreSnapshot(db, snapshotId);
    if (!result) return reply.status(404).send({ error: 'No such snapshot.' });
    return { deck: decks.get(result.deckId), snapshots: listSnapshots(db, result.deckId) };
  });

  app.delete('/api/v1/snapshots/:snapshotId', async (request, reply) => {
    const snapshotId = asInt((request.params as any).snapshotId);
    if (snapshotId === undefined) return reply.status(400).send({ error: 'Bad snapshot id.' });
    deleteSnapshot(db, snapshotId);
    return reply.status(204).send();
  });
}
