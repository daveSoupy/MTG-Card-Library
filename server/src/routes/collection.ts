import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  ACQUISITION_KINDS, CONDITIONS, COST_METHODS, FINISHES, LOCATION_REFERENCES, LocationInUseError,
  LocationNameTakenError,
  type AcquisitionKind, type CollectionSort, type CollectionStore, type Condition,
  type CostMethod, type Finish, type LocationRestore,
} from '../collection/store.ts';
import { pushToWantList, shoppingList, wantList } from '../collection/shopping.ts';
import { reconcileWants } from '../collection/wants.ts';
import { AlertStore } from '../alerts/store.ts';
import {
  ID, ID_OR_NULL, LOT_COUNT, MONEY, MONEY_OR_NULL, NAME, TEXT, TEXT_OR_NULL, FLAG, DATE_OR_NULL,
  body as bodySchema, idParams,
} from './schema.ts';

const SORTS: CollectionSort[] = ['name', 'value', 'quantity', 'recent', 'setNumber'];

/** The CHECK lists behind these fields, as schema enums. */
const FINISH = { type: 'string', enum: FINISHES } as const;
const CONDITION = { type: 'string', enum: CONDITIONS } as const;
const ACQUISITION_KIND = { type: 'string', enum: ACQUISITION_KINDS } as const;
const COST_METHOD = { type: 'string', enum: COST_METHODS } as const;
const LOCATION_KIND = {
  type: 'string', enum: ['binder', 'box', 'deck_box', 'shoebox', 'shelf', 'other'],
} as const;

/** Query strings stay hand-parsed; only bodies and path params get schemas. */
function asInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

const oneOf = <T extends string>(allowed: T[], value: unknown): T | undefined =>
  allowed.includes(value as T) ? (value as T) : undefined;

/** What every lot-shaped body carries, whether adding or editing. */
const LOT_FIELDS = {
  finish: FINISH,
  condition: CONDITION,
  language: TEXT,
  priceOverride: MONEY_OR_NULL,
  acquiredAt: DATE_OR_NULL,
  acquiredUnitCost: MONEY_OR_NULL,
  acquisitionKind: ACQUISITION_KIND,
  acquiredFrom: TEXT_OR_NULL,
  notes: TEXT_OR_NULL,
};

interface LotBody {
  finish?: Finish;
  condition?: Condition;
  language?: string;
  priceOverride?: number | null;
  acquiredAt?: string | null;
  acquiredUnitCost?: number | null;
  acquisitionKind?: AcquisitionKind;
  acquiredFrom?: string | null;
  notes?: string | null;
}

export function registerCollectionRoutes(
  app: FastifyInstance,
  db: Database.Database,
  collection: CollectionStore,
): void {
  // -- storage locations -----------------------------------------------------

  app.get('/api/v1/locations', async () => ({ locations: collection.locations() }));

  app.post<{ Body: { name: string; kind?: string; notes?: string | null } }>(
    '/api/v1/locations',
    { schema: { body: bodySchema({ name: NAME, kind: LOCATION_KIND, notes: TEXT_OR_NULL }, ['name']) } },
    async (request, reply) => {
      const { name, kind, notes } = request.body;
      if (!name.trim()) return reply.status(400).send({ error: 'A location needs a name.' });
      try {
        collection.createLocation({ name, kind, notes: notes ?? null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The unique index on name is the likely cause, and the user can fix it.
        return reply.status(400).send({ error: 'Could not create that location.', detail: message });
      }
      return reply.status(201).send({ locations: collection.locations() });
    },
  );

  app.patch<{
    Params: { id: number };
    Body: { name?: string; kind?: string; notes?: string | null; isArchived?: boolean };
  }>(
    '/api/v1/locations/:id',
    {
      schema: {
        params: idParams('id'),
        body: bodySchema({ name: NAME, kind: LOCATION_KIND, notes: TEXT_OR_NULL, isArchived: FLAG }),
      },
    },
    async (request, reply) => {
      const { name, kind, notes, isArchived } = request.body;
      try {
        collection.updateLocation(request.params.id, { name, kind, notes, isArchived });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({ error: 'Could not update that location.', detail: message });
      }
      return { locations: collection.locations() };
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/locations/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const { id } = request.params;
      const moveTo = asInt((request.query as any).moveTo);
      // The store treats a missing location as nothing to do; at the edge that
      // would be a 200 for an id that was never here.
      if (!db.prepare('SELECT 1 FROM storage_locations WHERE id = ?').get(id)) {
        return reply.status(404).send({ error: 'No location with that id.' });
      }
      let restore: LocationRestore | null;
      try {
        restore = collection.deleteLocationRecorded(id, moveTo);
      } catch (error) {
        if (error instanceof LocationInUseError) {
          // 409, not 400: the request is well formed, the state forbids it.
          return reply.status(409).send({ error: error.message, cardCount: error.cardCount });
        }
        throw error;
      }
      // `restore` is the undo: handed back unchanged, it puts all of this back.
      return { locations: collection.locations(), restore };
    },
  );

  /** What a delete would do, so the confirm can say it before it happens. */
  app.get<{ Params: { id: number } }>(
    '/api/v1/locations/:id/impact',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const impact = collection.locationImpact(request.params.id);
      if (!impact) return reply.status(404).send({ error: 'No location with that id.' });
      return impact;
    },
  );

  /** Undoes a location delete from the record the delete returned. */
  app.post<{ Body: { restore: LocationRestore } }>(
    '/api/v1/locations/restore',
    {
      schema: {
        body: bodySchema({
          restore: {
            type: 'object',
            required: ['location', 'movedTo', 'lotIds', 'references'],
            properties: {
              location: {
                type: 'object',
                required: ['id', 'name', 'kind', 'notes', 'isArchived', 'sortOrder', 'createdAt'],
                properties: {
                  id: ID, name: NAME, kind: LOCATION_KIND, notes: TEXT_OR_NULL,
                  isArchived: { type: 'integer', enum: [0, 1] },
                  sortOrder: { type: 'integer' },
                  createdAt: TEXT,
                },
              },
              movedTo: ID_OR_NULL,
              lotIds: { type: 'array', items: ID },
              // Only the columns the store knows; anything else is refused.
              references: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(LOCATION_REFERENCES.map((key) => [key, { type: 'array', items: ID }])),
              },
            },
          },
        }, ['restore']),
      },
    },
    async (request, reply) => {
      try {
        const id = collection.restoreLocation(request.body.restore);
        return { locations: collection.locations(), id };
      } catch (error) {
        if (error instanceof LocationNameTakenError) return reply.status(409).send({ error: error.message });
        throw error;
      }
    },
  );

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

  app.post<{
    Body: LotBody & {
      printingId: string; locationId: number; quantity?: number;
      costMethod?: CostMethod; fixedAmount?: number | null; batchId?: number;
    };
  }>(
    '/api/v1/collection/items',
    {
      schema: {
        body: bodySchema(
          {
            printingId: NAME,
            locationId: ID,
            // At least one copy: adding zero cards is not an addition.
            quantity: { ...LOT_COUNT, minimum: 1 },
            ...LOT_FIELDS,
            costMethod: COST_METHOD,
            fixedAmount: MONEY_OR_NULL,
            batchId: ID,
          },
          ['printingId', 'locationId'],
        ),
      },
    },
    async (request, reply) => {
      const body = request.body;
      try {
        const id = collection.addLot({
          printingId: body.printingId,
          locationId: body.locationId,
          quantity: body.quantity ?? 1,
          finish: body.finish,
          condition: body.condition,
          language: body.language,
          priceOverride: body.priceOverride ?? null,
          acquiredAt: body.acquiredAt || null,
          acquiredUnitCost: body.acquiredUnitCost ?? null,
          acquisitionKind: body.acquisitionKind,
          acquiredFrom: body.acquiredFrom || null,
          notes: body.notes || null,
          costMethod: body.costMethod,
          fixedAmount: body.fixedAmount ?? null,
          importBatchId: body.batchId,
        });
        // Acquiring copies directly can satisfy a want — same reconcile a trade runs.
        const oracle = db.prepare('SELECT oracle_id FROM card_printings WHERE id = ?')
          .get(body.printingId) as { oracle_id: string } | undefined;
        if (oracle) reconcileWants(db, new AlertStore(db), oracle.oracle_id);
        return reply.status(201).send({ id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({ error: 'Could not add those cards.', detail: message });
      }
    },
  );

  // The cost pool currently accepting cards (box/draft), or null.
  app.get('/api/v1/collection/cost-pools/open', async () => ({ pool: collection.currentCostPool() }));

  // Opens a cost pool: a lump sum spread evenly across the copies later added
  // with this batch id, and marked the open pool so it resumes after a break.
  app.post<{ Body: { totalCostUsd: number; label?: string | null; setCode?: string | null } }>(
    '/api/v1/collection/cost-pools',
    {
      schema: {
        body: bodySchema(
          { totalCostUsd: MONEY, label: TEXT_OR_NULL, setCode: TEXT_OR_NULL },
          ['totalCostUsd'],
        ),
      },
    },
    async (request, reply) => {
      const { totalCostUsd, label, setCode } = request.body;
      const pool = collection.openCostPool({
        totalCostUsd,
        label: label || null,
        setCode: setCode ? setCode.toLowerCase() : null,
      });
      return reply.status(201).send({ batchId: pool.id, pool });
    },
  );

  // Adjusts an open pool: its lump sum (re-dividing it across the copies it
  // holds) and/or the set the session is working through (for resume).
  app.patch<{ Params: { id: number }; Body: { totalCostUsd?: number; setCode?: string | null } }>(
    '/api/v1/collection/cost-pools/:id',
    {
      schema: {
        params: idParams('id'),
        body: bodySchema({ totalCostUsd: MONEY, setCode: TEXT_OR_NULL }),
      },
    },
    async (request) => {
      const { totalCostUsd, setCode } = request.body;
      if (totalCostUsd !== undefined) collection.updateCostPoolTotal(request.params.id, totalCostUsd);
      // Present-and-null clears the set; absent leaves it alone.
      if ('setCode' in request.body) {
        collection.setOpenPoolSet(setCode ? setCode.toLowerCase() : null);
      }
      return { pool: collection.currentCostPool() };
    },
  );

  // Finishes the open pool (the batch stays in history; its lots keep their cost).
  app.post('/api/v1/collection/cost-pools/close', async () => {
    collection.closeCostPool();
    return { pool: null };
  });

  // Points the open pool back at a past batch — a draft entered across two
  // sittings. Cards added afterwards carry the same batch id, and bumping the
  // total re-divides it across the combined set.
  app.post<{ Params: { id: number } }>(
    '/api/v1/collection/cost-pools/:id/reopen',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const pool = collection.reopenCostPool(request.params.id);
      if (!pool) {
        return reply.status(404).send({ error: 'That import batch is not a cost pool.' });
      }
      return { pool };
    },
  );

  app.patch<{ Params: { id: number }; Body: LotBody & { quantity?: number; locationId?: number } }>(
    '/api/v1/collection/items/:id',
    {
      schema: {
        params: idParams('id'),
        // Quantity 0 is allowed and means "remove the lot".
        body: bodySchema({ quantity: LOT_COUNT, locationId: ID, ...LOT_FIELDS }),
      },
    },
    async (request, reply) => {
      try {
        collection.updateLot(request.params.id, { ...request.body });
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({ error: 'Could not update those cards.', detail: message });
      }
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/collection/items/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      collection.removeLot(request.params.id);
      return reply.status(204).send();
    },
  );

  // Undo a tap-to-add: remove one copy of the plainly-added card.
  app.post<{
    Body: { printingId: string; locationId: number; finish?: Finish; condition?: Condition };
  }>(
    '/api/v1/collection/items/decrement',
    {
      schema: {
        body: bodySchema(
          { printingId: NAME, locationId: ID, finish: FINISH, condition: CONDITION },
          ['printingId', 'locationId'],
        ),
      },
    },
    async (request) => {
      const owned = collection.decrementCopy(request.body);
      return { removed: owned !== null, owned };
    },
  );

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

  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/shopping-list',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const list = shoppingList(db, request.params.id);
      if (!list) return reply.status(404).send({ error: 'No deck with that id.' });
      return list;
    },
  );

  app.post<{ Params: { id: number }; Body: { wantListId?: number; oracleIds?: string[] } }>(
    '/api/v1/decks/:id/shopping-list/want',
    {
      schema: {
        params: idParams('id'),
        body: bodySchema({ wantListId: ID, oracleIds: { type: 'array', items: NAME } }),
      },
    },
    async (request, reply) => {
      const { wantListId, oracleIds } = request.body;
      try {
        const result = pushToWantList(db, request.params.id, { wantListId, oracleIds });
        return { ...result, wantList: wantList(db, wantListId) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(400).send({ error: 'Could not add to the want list.', detail: message });
      }
    },
  );
}
