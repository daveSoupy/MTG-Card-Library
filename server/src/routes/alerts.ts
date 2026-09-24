import type { FastifyInstance } from 'fastify';
import type { AlertStore, AlertState, AlertKind } from '../alerts/store.ts';
import { idParams } from './schema.ts';

/** The in-app alert inbox: list, count, acknowledge, resolve, and the same two in bulk. */
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

  /** Every active alert marked seen, optionally narrowed to one kind. */
  app.post('/api/v1/alerts/acknowledge-all', async (request) => {
    const kind = (request.query as any)?.kind as AlertKind | undefined;
    const changed = alerts.acknowledgeAll(kind);
    return { changed, activeCount: alerts.activeCount() };
  });

  /** Every unresolved alert dismissed for good, optionally narrowed to one kind. */
  app.post('/api/v1/alerts/resolve-all', async (request) => {
    const kind = (request.query as any)?.kind as AlertKind | undefined;
    const changed = alerts.resolveAll(kind);
    return { changed, activeCount: alerts.activeCount() };
  });
}
