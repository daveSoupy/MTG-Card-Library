import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

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

  app.post('/api/v1/filter-presets', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.status(400).send({ error: 'A preset needs a name.' });
    if (body.filters !== undefined && (typeof body.filters !== 'object' || body.filters === null)) {
      return reply.status(400).send({ error: 'filters must be an object.' });
    }

    const filters = JSON.stringify(body.filters ?? {});
    const queryText = typeof body.queryText === 'string' && body.queryText.trim()
      ? body.queryText.trim() : null;

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
  });

  app.patch('/api/v1/filter-presets/:id', async (request, reply) => {
    const id = Number((request.params as any).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: 'Invalid preset id.' });
    const body = (request.body ?? {}) as any;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof body.name === 'string' && body.name.trim()) {
      sets.push('name = ?'); params.push(body.name.trim());
    }
    if (body.filters !== undefined) {
      sets.push('filters = ?'); params.push(JSON.stringify(body.filters ?? {}));
    }
    if (body.queryText !== undefined) {
      sets.push('query_text = ?');
      params.push(typeof body.queryText === 'string' && body.queryText.trim() ? body.queryText.trim() : null);
    }
    if (Number.isInteger(body.sortOrder)) {
      sets.push('sort_order = ?'); params.push(body.sortOrder);
    }
    if (sets.length === 0) return { presets: list() };

    sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    const result = db.prepare(`UPDATE filter_presets SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
    if (result.changes === 0) return reply.status(404).send({ error: 'No preset with that id.' });
    return { presets: list() };
  });

  app.delete('/api/v1/filter-presets/:id', async (request, reply) => {
    const id = Number((request.params as any).id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: 'Invalid preset id.' });
    const result = db.prepare('DELETE FROM filter_presets WHERE id = ?').run(id);
    if (result.changes === 0) return reply.status(404).send({ error: 'No preset with that id.' });
    return reply.status(200).send({ presets: list() });
  });
}
