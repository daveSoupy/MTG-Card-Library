import type { FastifyInstance } from 'fastify';
import type { CardSearchStore, SearchFilters, SortOrder } from '../search/store.ts';

const SORT_ORDERS = new Set<SortOrder>([
  'relevance', 'name', 'manaValue', 'newest', 'price', 'edhrec',
]);

function asBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

function asNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Repeated query params arrive as arrays; a single one arrives as a string. */
function asList(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = raw.map((v) => String(v).trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** The structured filters, as the search and random endpoints both take them. */
function filtersFrom(q: Record<string, unknown>): SearchFilters {
  return {
    ownedOnly: asBool(q.ownedOnly),
    colors: asList(q.colors),
    colorsExact: asBool(q.colorsExact),
    gold: asBool(q.gold),
    hybrid: asBool(q.hybrid),
    rarities: asList(q.rarities),
    setCode: typeof q.set === 'string' && q.set ? q.set.toLowerCase() : undefined,
    format: typeof q.format === 'string' && q.format ? q.format.toLowerCase() : undefined,
    minCmc: asNumber(q.minCmc),
    maxCmc: asNumber(q.maxCmc),
    includeDigital: asBool(q.includeDigital),
    includeExtras: asBool(q.includeExtras),
    includeUnplayable: asBool(q.includeUnplayable),
  };
}

export function registerCardRoutes(app: FastifyInstance, store: CardSearchStore): void {
  app.get('/api/v1/cards', async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const filters = filtersFrom(q);

    const sortParam = String(q.sort ?? 'relevance') as SortOrder;
    const sort = SORT_ORDERS.has(sortParam) ? sortParam : 'relevance';
    const limit = Math.min(Math.max(asNumber(q.limit) ?? 60, 1), 200);
    const offset = Math.max(asNumber(q.offset) ?? 0, 0);
    const text = typeof q.q === 'string' ? q.q : '';
    // Sent back by the client when paging, so the count is not recomputed for
    // every page of the same result set.
    const knownTotal = asNumber(q.knownTotal);

    try {
      return store.search(text, filters, sort, limit, offset, knownTotal);
    } catch (error) {
      // A malformed FTS expression (an unbalanced quote, say) is a user typo,
      // not a server fault — report it as such so the UI can show the message.
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'Could not run that search.', detail: message });
    }
  });

  app.get('/api/v1/cards/:oracleId', async (request, reply) => {
    const { oracleId } = request.params as { oracleId: string };
    const detail = store.detail(oracleId);
    if (!detail) return reply.status(404).send({ error: 'No card with that id.' });
    return detail;
  });

  /** A random card, honouring whatever the user has filtered to. */
  app.get('/api/v1/cards/random', async (request, reply) => {
    const query = request.query as any;
    const oracleId = store.random(String(query.q ?? ''), filtersFrom(query));
    if (!oracleId) return reply.status(404).send({ error: 'Nothing matches those filters.' });
    return store.detail(oracleId);
  });

  app.put('/api/v1/cards/:oracleId/art', async (request, reply) => {
    const { oracleId } = request.params as { oracleId: string };
    const printingId = (request.body as any)?.printingId ?? null;
    if (printingId !== null && typeof printingId !== 'string') {
      return reply.status(400).send({ error: 'printingId must be a string or null.' });
    }
    try {
      store.setArtPreference(oracleId, printingId);
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
    return store.detail(oracleId);
  });

  app.get('/api/v1/sets', async () => ({ sets: store.sets() }));
  app.get('/api/v1/formats', async () => ({ formats: store.formats() }));
}
