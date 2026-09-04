import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  ACQUISITION_KINDS, CONDITIONS, COST_METHODS, FINISHES, LocationInUseError,
  type CollectionSort, type CollectionStore,
} from '../collection/store.ts';
import { pushToWantList, shoppingList, wantList } from '../collection/shopping.ts';
import { reconcileWants } from '../collection/wants.ts';
import { AlertStore } from '../alerts/store.ts';

const SORTS: CollectionSort[] = ['name', 'value', 'quantity', 'recent', 'setNumber'];

function asInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function asMoney(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const oneOf = <T extends string>(allowed: T[], value: unknown): T | undefined =>
  allowed.includes(value as T) ? (value as T) : undefined;

export function registerCollectionRoutes(
  app: FastifyInstance,
  db: Database.Database,
  collection: CollectionStore,
): void {
  // -- storage locations -----------------------------------------------------

  app.get('/api/v1/locations', async () => ({ locations: collection.locations() }));

  app.post('/api/v1/locations', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return reply.status(400).send({ error: 'A location needs a name.' });
    }
    try {
      collection.createLocation({ name: body.name, kind: body.kind, notes: body.notes ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The unique index on name is the likely cause, and the user can fix it.
      return reply.status(400).send({ error: 'Could not create that location.', detail: message });
    }
    return reply.status(201).send({ locations: collection.locations() });
  });

  app.patch('/api/v1/locations/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid location id.' });
    const body = (request.body ?? {}) as any;
    try {
      collection.updateLocation(id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        kind: typeof body.kind === 'string' ? body.kind : undefined,
        notes: body.notes === null || typeof body.notes === 'string' ? body.notes : undefined,
        isArchived: typeof body.isArchived === 'boolean' ? body.isArchived : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'Could not update that location.', detail: message });
    }
    return { locations: collection.locations() };
  });

  app.delete('/api/v1/locations/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid location id.' });

    const moveTo = asInt((request.query as any).moveTo);
    try {
      if (moveTo !== undefined) collection.moveLocationContents(id, moveTo);
      collection.deleteLocation(id);
    } catch (error) {
      if (error instanceof LocationInUseError) {
        // 409, not 400: the request is well formed, the state forbids it.
        return reply.status(409).send({ error: error.message, cardCount: error.cardCount });
      }
      throw error;
    }
    return { locations: collection.locations() };
  });

  // -- browsing --------------------------------------------------------------

  app.get('/api/v1/collection', async (request) => {
    const q = request.query as Record<string, unknown>;
    return collection.browse(
      {
        locationId: asInt(q.location),
        setCode: typeof q.set === 'string' && q.set ? q.set.toLowerCase() : undefined,
        query: typeof q.q === 'string' && q.q ? q.q.toLowerCase() : undefined,
        unallocatedOnly: q.unallocatedOnly === 'true',
      },
      oneOf(SORTS, q.sort) ?? 'name',
      Math.min(Math.max(asInt(q.limit) ?? 100, 1), 300),
      Math.max(asInt(q.offset) ?? 0, 0),
    );
  });

  app.get('/api/v1/collection/cards/:oracleId', async (request, reply) => {
    const { oracleId } = request.params as { oracleId: string };
    const detail = collection.cardDetail(oracleId);
    if (detail.lots.length === 0 && detail.printings.length === 0) {
      return reply.status(404).send({ error: 'You do not own any copies of that card.' });
    }
    return detail;
  });

  // -- editing ---------------------------------------------------------------

  app.post('/api/v1/collection/items', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const printingId = typeof body.printingId === 'string' ? body.printingId : '';
    const locationId = asInt(body.locationId);
    const quantity = asInt(body.quantity) ?? 1;

    if (!printingId) return reply.status(400).send({ error: 'printingId is required.' });
    if (locationId === undefined) return reply.status(400).send({ error: 'locationId is required.' });
    if (quantity < 1) return reply.status(400).send({ error: 'Quantity must be at least 1.' });

    try {
      const id = collection.addLot({
        printingId,
        locationId,
        quantity,
        finish: oneOf(FINISHES, body.finish),
        condition: oneOf(CONDITIONS, body.condition),
        language: typeof body.language === 'string' ? body.language : undefined,
        priceOverride: asMoney(body.priceOverride) ?? null,
        acquiredAt: typeof body.acquiredAt === 'string' && body.acquiredAt ? body.acquiredAt : null,
        acquiredUnitCost: asMoney(body.acquiredUnitCost) ?? null,
        acquisitionKind: oneOf(ACQUISITION_KINDS, body.acquisitionKind),
        acquiredFrom: typeof body.acquiredFrom === 'string' && body.acquiredFrom ? body.acquiredFrom : null,
        notes: typeof body.notes === 'string' && body.notes ? body.notes : null,
        costMethod: oneOf(COST_METHODS, body.costMethod),
        fixedAmount: asMoney(body.fixedAmount) ?? null,
        importBatchId: asInt(body.batchId),
      });
      // Acquiring copies directly can satisfy a want — same reconcile a trade runs.
      const oracle = db.prepare('SELECT oracle_id FROM card_printings WHERE id = ?')
        .get(printingId) as { oracle_id: string } | undefined;
      if (oracle) reconcileWants(db, new AlertStore(db), oracle.oracle_id);
      return reply.status(201).send({ id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'Could not add those cards.', detail: message });
    }
  });

  // Opens a cost pool for the 'box' method: a lump sum spread evenly across the
  // copies later added with this batch id. Returns the id to pass as `batchId`.
  app.post('/api/v1/collection/cost-pools', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const totalCostUsd = asMoney(body.totalCostUsd);
    if (totalCostUsd === undefined || totalCostUsd === null) {
      return reply.status(400).send({ error: 'totalCostUsd is required.' });
    }
    const batchId = collection.openCostPool({
      totalCostUsd,
      notes: typeof body.notes === 'string' && body.notes ? body.notes : null,
    });
    return reply.status(201).send({ batchId });
  });

  app.patch('/api/v1/collection/items/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid item id.' });
    const body = (request.body ?? {}) as any;

    try {
      collection.updateLot(id, {
        quantity: asInt(body.quantity),
        locationId: asInt(body.locationId),
        finish: oneOf(FINISHES, body.finish),
        condition: oneOf(CONDITIONS, body.condition),
        language: typeof body.language === 'string' ? body.language : undefined,
        priceOverride: asMoney(body.priceOverride),
        acquiredAt: body.acquiredAt === null || typeof body.acquiredAt === 'string' ? body.acquiredAt : undefined,
        acquiredUnitCost: asMoney(body.acquiredUnitCost),
        acquisitionKind: oneOf(ACQUISITION_KINDS, body.acquisitionKind),
        acquiredFrom: body.acquiredFrom === null || typeof body.acquiredFrom === 'string' ? body.acquiredFrom : undefined,
        notes: body.notes === null || typeof body.notes === 'string' ? body.notes : undefined,
      });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'Could not update those cards.', detail: message });
    }
  });

  app.delete('/api/v1/collection/items/:id', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid item id.' });
    collection.removeLot(id);
    return reply.status(204).send();
  });

  // Undo a tap-to-add: remove one copy of the plainly-added card.
  app.post('/api/v1/collection/items/decrement', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    if (typeof body.printingId !== 'string') return reply.status(400).send({ error: 'printingId is required.' });
    const locationId = asInt(body.locationId);
    if (locationId === undefined) return reply.status(400).send({ error: 'locationId is required.' });

    const owned = collection.decrementCopy({
      printingId: body.printingId,
      locationId,
      finish: oneOf(FINISHES, body.finish),
      condition: oneOf(CONDITIONS, body.condition),
    });
    return { removed: owned !== null, owned };
  });

  // -- value and sets --------------------------------------------------------

  app.get('/api/v1/collection/value', async () => ({
    value: collection.value(),
    history: collection.history(),
  }));

  app.post('/api/v1/collection/snapshot', async () => ({ snapshot: collection.takeSnapshot() }));

  app.get('/api/v1/collection/sets', async (request) => {
    const q = request.query as Record<string, unknown>;
    return { sets: collection.setCompletion(Math.min(asInt(q.limit) ?? 60, 300), q.all !== 'true') };
  });

  app.get('/api/v1/collection/sets/:setCode', async (request) => {
    const { setCode } = request.params as { setCode: string };
    return { cards: collection.setChecklist(setCode.toLowerCase()) };
  });

  // -- shopping list ---------------------------------------------------------

  app.get('/api/v1/decks/:id/shopping-list', async (request, reply) => {
    const id = asInt((request.params as any).id);
    const list = id === undefined ? null : shoppingList(db, id);
    if (!list) return reply.status(404).send({ error: 'No deck with that id.' });
    return list;
  });

  app.post('/api/v1/decks/:id/shopping-list/want', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid deck id.' });
    const body = (request.body ?? {}) as any;

    try {
      const result = pushToWantList(db, id, {
        wantListId: asInt(body.wantListId),
        oracleIds: Array.isArray(body.oracleIds)
          ? body.oracleIds.filter((v: unknown) => typeof v === 'string') : undefined,
      });
      return { ...result, wantList: wantList(db, asInt(body.wantListId)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'Could not add to the want list.', detail: message });
    }
  });

}
