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
  // `preCompressed` serves `<file>.br` or `<file>.gz` when the browser accepts
  // one and the file exists, falling back to the original when it does not —
  // so a dist built without `web/scripts/precompress.mjs` still works, just
  // uncompressed. The bundle measured 487KB raw against 144KB gzipped, and
  // this way that 343KB is saved without the server spending any CPU per
  // request. @fastify/compress sees the encoding is already set and leaves it
  // alone; it only handles the dynamic JSON responses.
  await app.register(fastifyStatic, { root: webDist, preCompressed: true });

  // Two files must be revalidated on every load; `no-cache` means exactly
  // that, not "never store". The service worker, which the browser may
  // otherwise hold for up to 24 hours before checking for a new version.
  // And the page itself: every build renames the hashed bundle it points
  // at, so a browser that reuses a stale index.html (an iOS home-screen
  // launch will) asks for a bundle that is gone and shows a white screen.
  // Hashed /assets/* need nothing — a new build is a new name. An onSend
  // hook rather than the plugin's `setHeaders` option, which writes to the
  // raw response and is then overwritten by the plugin's own Cache-Control.
  app.addHook('onSend', (request, reply, payload, done) => {
    const path = request.url.split('?')[0];
    const isPage = path === '/sw.js' || String(reply.getHeader('content-type')).startsWith('text/html');
    if (isPage) reply.header('Cache-Control', 'no-cache');
    done(null, payload);
  });

  // Client-side routing: anything not under /api falls back to index.html.
  // A missing *file* must not: a bundle from an earlier build that a stale
  // page still names would come back as HTML with a 200, which the browser
  // refuses to run as a module and the service worker would happily cache
  // under the bundle's name. Client routes never live under these prefixes.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/')) {
      return reply.status(404).send({ error: 'No such endpoint.' });
    }
    if (path.startsWith('/assets/') || path.startsWith('/icons/')) {
      return reply.status(404).type('text/plain').send('Not found');
    }
    return reply.sendFile('index.html');
  });
}
