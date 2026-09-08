import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { COUNT, NAME, TEXT_OR_NULL, body as bodySchema, idParams } from './schema.ts';

/** The saved search itself: an opaque JSON object nothing ever queries inside. */
const FILTERS = { type: 'object' } as const;

export interface FilterPreset {
  id: number;
  name: string;
  filters: Record<string, unknown>;
  queryText: string | null;
  sortOrder: number;
  updatedAt: string;
}

/** Rows store the filter payload as JSON; nothing ever queries inside it. */
function toPreset(row: any): FilterPreset {
  let filters: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.filters);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) filters = parsed;
  } catch {
    // A preset saved by an older build, or hand-edited. An empty filter set is
    // a better outcome than failing the whole list.
  }
  return {
    id: row.id,
    name: row.name,
    filters,
    queryText: row.query_text,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  };
}

export function registerPresetRoutes(app: FastifyInstance, db: Database.Database): void {
  const listStatement = db.prepare(
    'SELECT * FROM filter_presets ORDER BY sort_order, name COLLATE NOCASE',
  );
  const list = () => (listStatement.all() as any[]).map(toPreset);

  app.get('/api/v1/filter-presets', async () => ({ presets: list() }));

  app.post<{
    Body: { name: string; filters?: Record<string, unknown>; queryText?: string | null };
  }>(
    '/api/v1/filter-presets',
    {
      schema: {
        body: bodySchema({ name: NAME, filters: FILTERS, queryText: TEXT_OR_NULL }, ['name']),
      },
    },
    async (request, reply) => {
    const name = request.body.name.trim();
    if (!name) return reply.status(400).send({ error: 'A preset needs a name.' });

    const filters = JSON.stringify(request.body.filters ?? {});
    const queryText = request.body.queryText?.trim() || null;

    try {
      // Saving over an existing name updates it, which is what "save" means
      // when you have tweaked a preset and want to keep the same name.
      db.prepare(`
        INSERT INTO filter_presets (name, filters, query_text)
        VALUES (?,?,?)
        ON CONFLICT(name) DO UPDATE SET
          filters = excluded.filters,
          query_text = excluded.query_text,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
        .run(name, filters, queryText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: 'Could not save that preset.', detail: message });
    }

    return reply.status(201).send({ presets: list() });
  },
  );

  app.patch<{
    Params: { id: number };
    Body: {
      name?: string; filters?: Record<string, unknown>;
      queryText?: string | null; sortOrder?: number;
    };
  }>(
    '/api/v1/filter-presets/:id',
    {
      schema: {
        params: idParams('id'),
        body: bodySchema({
          name: NAME, filters: FILTERS, queryText: TEXT_OR_NULL, sortOrder: COUNT,
        }),
      },
    },
    async (request, reply) => {
    const { id } = request.params;
    const body = request.body;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name?.trim()) {
      sets.push('name = ?'); params.push(body.name.trim());
    }
    if (body.filters !== undefined) {
      sets.push('filters = ?'); params.push(JSON.stringify(body.filters));
    }
    if (body.queryText !== undefined) {
      sets.push('query_text = ?'); params.push(body.queryText?.trim() || null);
    }
    if (body.sortOrder !== undefined) {
      sets.push('sort_order = ?'); params.push(body.sortOrder);
    }
    if (sets.length === 0) return { presets: list() };

    sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    const result = db.prepare(`UPDATE filter_presets SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
    if (result.changes === 0) return reply.status(404).send({ error: 'No preset with that id.' });
    return { presets: list() };
  },
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/filter-presets/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const result = db.prepare('DELETE FROM filter_presets WHERE id = ?').run(request.params.id);
      if (result.changes === 0) return reply.status(404).send({ error: 'No preset with that id.' });
      return reply.status(200).send({ presets: list() });
    },
  );
}
