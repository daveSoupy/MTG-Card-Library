import type { FastifyInstance } from 'fastify';
import type { AlertStore, AlertState } from '../alerts/store.ts';
import { idParams } from './schema.ts';

/** The in-app alert inbox: list, count, acknowledge, resolve. */
export function registerAlertRoutes(app: FastifyInstance, alerts: AlertStore): void {
  app.get('/api/v1/alerts', async (request) => {
    const state = (request.query as any)?.state as AlertState | undefined;
    return { alerts: alerts.list(state ? { state } : {}), activeCount: alerts.activeCount() };
  });

  app.post<{ Params: { id: number } }>(
    '/api/v1/alerts/:id/acknowledge',
    { schema: { params: idParams('id') } },
    async (request) => {
      alerts.acknowledge(request.params.id);
      return { activeCount: alerts.activeCount() };
    },
  );

  app.post<{ Params: { id: number } }>(
    '/api/v1/alerts/:id/resolve',
    { schema: { params: idParams('id') } },
    async (request) => {
      alerts.resolve(request.params.id);
      return { activeCount: alerts.activeCount() };
    },
  );
}
