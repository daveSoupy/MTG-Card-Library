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

export function registerCardRoutes(app: FastifyInstance, store: CardSearchStore): void {
  app.get('/api/v1/cards', async (request, reply) => {
    const q = request.query as Record<string, unknown>;

    const filters: SearchFilters = {
      ownedOnly: asBool(q.ownedOnly),
      colors: asList(q.colors),
      colorsExact: asBool(q.colorsExact),
      rarities: asList(q.rarities),
      setCode: typeof q.set === 'string' && q.set ? q.set.toLowerCase() : undefined,
      format: typeof q.format === 'string' && q.format ? q.format.toLowerCase() : undefined,
      minCmc: asNumber(q.minCmc),
      maxCmc: asNumber(q.maxCmc),
      includeDigital: asBool(q.includeDigital),
      includeExtras: asBool(q.includeExtras),
    };

    const sortParam = String(q.sort ?? 'relevance') as SortOrder;
    const sort = SORT_ORDERS.has(sortParam) ? sortParam : 'relevance';
    const limit = Math.min(Math.max(asNumber(q.limit) ?? 60, 1), 200);
    const offset = Math.max(asNumber(q.offset) ?? 0, 0);
    const text = typeof q.q === 'string' ? q.q : '';

    try {
      return store.search(text, filters, sort, limit, offset);
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

  app.get('/api/v1/sets', async () => ({ sets: store.sets() }));
  app.get('/api/v1/formats', async () => ({ formats: store.formats() }));
}
