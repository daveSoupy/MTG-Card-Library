import type { FastifyInstance } from 'fastify';
import { TemplateNotFoundError, TemplateStore, type TemplateTargetInput } from '../decks/templates.ts';
import { COUNT, NAME, TEXT_OR_NULL, body as bodySchema, idParams } from './schema.ts';

const TARGET = {
  type: 'object',
  required: ['category', 'ideal'],
  properties: {
    category: { type: 'string', minLength: 1 },
    ideal: COUNT,
    minCount: { type: ['integer', 'null'], minimum: 0 },
    maxCount: { type: ['integer', 'null'], minimum: 0 },
    note: TEXT_OR_NULL,
  },
} as const;

const TARGETS = { type: 'array', items: TARGET } as const;

export function registerTemplateRoutes(app: FastifyInstance, templates: TemplateStore): void {
  const guard = async <T>(reply: any, run: () => T) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof TemplateNotFoundError) return reply.status(404).send({ error: error.message });
      throw error;
    }
  };

  app.get('/api/v1/deck-templates', async () => ({ templates: templates.list() }));

  app.get<{ Params: { id: number } }>(
    '/api/v1/deck-templates/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
      const template = templates.get(request.params.id);
      if (!template) return reply.status(404).send({ error: 'No template with that id.' });
      return { template };
    },
  );

  app.post<{
    Body: {
      name: string; formatCode?: string | null; archetype?: string | null;
      description?: string | null; targets?: TemplateTargetInput[];
    };
  }>(
    '/api/v1/deck-templates',
    {
      schema: {
        body: bodySchema({
          name: NAME, formatCode: TEXT_OR_NULL, archetype: TEXT_OR_NULL,
          description: TEXT_OR_NULL, targets: TARGETS,
        }, ['name']),
      },
    },
    async (request, reply) => {
      const id = templates.create(request.body);
      return reply.status(201).send({ template: templates.get(id) });
    },
  );

  app.post<{ Params: { id: number }; Body: { name?: string } }>(
    '/api/v1/deck-templates/:id/clone',
    { schema: { params: idParams('id'), body: bodySchema({ name: NAME }) } },
    async (request, reply) => guard(reply, () => {
      const id = templates.clone(request.params.id, request.body?.name);
      return reply.status(201).send({ template: templates.get(id) });
    }),
  );

  app.patch<{
    Params: { id: number };
    Body: {
      name?: string; formatCode?: string | null; archetype?: string | null;
      description?: string | null; targets?: TemplateTargetInput[];
    };
  }>(
    '/api/v1/deck-templates/:id',
    {
      schema: {
        params: idParams('id'),
        body: bodySchema({
          name: NAME, formatCode: TEXT_OR_NULL, archetype: TEXT_OR_NULL,
          description: TEXT_OR_NULL, targets: TARGETS,
        }),
      },
    },
    async (request, reply) => guard(reply, () => {
      templates.update(request.params.id, request.body);
      return { template: templates.get(request.params.id) };
    }),
  );

  app.delete<{ Params: { id: number } }>(
    '/api/v1/deck-templates/:id',
    { schema: { params: idParams('id') } },
    async (request, reply) => guard(reply, () => {
      templates.delete(request.params.id);
      return reply.status(204).send();
    }),
  );
}
