import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * Serves the built web client from `webDist`, with the HTML fallback that
 * client-side routing needs and the one header Phase 31's service worker
 * depends on.
 *
 * `index.ts` calls this only when `web/dist` exists: in development Vite
 * serves the UI on its own port and proxies `/api` here, so a missing build
 * is not an error there. Its own module so `app.inject` can prove the
 * headers without booting the whole server.
 */
export async function registerWebClient(app: FastifyInstance, webDist: string): Promise<void> {
  // Wildcard on purpose: with it disabled, @fastify/static enumerates the
  // directory once at registration, so a rebuild's new hashed filenames are
  // unknown and fall through to the HTML fallback — which the browser then
  // rejects as a module script.
  await app.register(fastifyStatic, { root: webDist });

  // The service worker is the one file the browser may otherwise hold for up
  // to 24 hours before checking for a new version. `no-cache` means
  // "revalidate every time", not "never store": a changed worker is picked
  // up on the next load. Hashed /assets/* need nothing — a new build is a
  // new name. An onSend hook rather than the plugin's `setHeaders` option,
  // which writes to the raw response and is then overwritten by the
  // plugin's own computed Cache-Control.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.url.split('?')[0] === '/sw.js') reply.header('Cache-Control', 'no-cache');
    done(null, payload);
  });

  // Client-side routing: anything not under /api falls back to index.html.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'No such endpoint.' });
    }
    return reply.sendFile('index.html');
  });
}
