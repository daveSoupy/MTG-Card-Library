import type { FastifyInstance } from 'fastify';
import type { AlertStore, AlertState } from '../alerts/store.ts';

const asInt = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

/** The in-app alert inbox: list, count, acknowledge, resolve. */
export function registerAlertRoutes(app: FastifyInstance, alerts: AlertStore): void {
  app.get('/api/v1/alerts', async (request) => {
    const state = (request.query as any)?.state as AlertState | undefined;
    return { alerts: alerts.list(state ? { state } : {}), activeCount: alerts.activeCount() };
  });

  app.post('/api/v1/alerts/:id/acknowledge', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid alert id.' });
    alerts.acknowledge(id);
    return { activeCount: alerts.activeCount() };
  });

  app.post('/api/v1/alerts/:id/resolve', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Invalid alert id.' });
    alerts.resolve(id);
    return { activeCount: alerts.activeCount() };
  });
}
