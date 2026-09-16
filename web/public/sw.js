/*
 * MTG Library — service worker (Phase 31).
 *
 * THIS IS NOT AN OFFLINE MODE, and must not become one. It caches the app's
 * static bundle for exactly one reason: so that a home-screen icon tapped
 * while the server is unreachable renders the app's own reconnect screen
 * instead of the browser's error page. Nothing of the collection, the decks,
 * or any setting is ever stored here. The four rules:
 *
 *  1. NETWORK-FIRST, ALWAYS. Every request goes to the server. The cache is
 *     read only when the network *fails* — never to skip a round-trip, never
 *     for speed. A successful response replaces the cached copy, so a new
 *     build reaches the phone on its next successful load exactly as it does
 *     without a worker. (This is the mitigation for the one real hazard of
 *     shell caching: a stale bundle calling an API whose shape changed.)
 *
 *  2. STATIC BUNDLE ONLY. Same-origin GET for the page, /assets/*, the
 *     manifest and the icons. `/api/*` is never intercepted — not cached, not
 *     observed, not passed through a handler: the fetch listener returns
 *     before anything else happens. No write is ever queued.
 *
 *  3. VERSIONED CACHE, FILLED ON INSTALL, OLD ONES DELETED ON ACTIVATE.
 *     Installing fetches the page and the bundles it names so the shell
 *     exists from the first load; bumping CACHE below drops every earlier
 *     cache once the new one is filled. Within a version, assets no longer
 *     referenced by the cached index.html are pruned after each successful
 *     page load, so hashed bundles from old builds do not pile up.
 *
 *  4. THIS FILE IS SERVED UNCACHED. The server sends Cache-Control: no-cache
 *     for /sw.js (routes/webClient.ts), so an edited worker is picked up on
 *     the next load rather than after the browser's 24-hour ceiling.
 */

const CACHE = 'mtg-library-shell-v3';

/** The page itself, under one key whatever route it was loaded at. */
const PAGE = '/index.html';

/** The /assets/* paths a page names, source maps excluded. */
function assetsIn(html) {
  const paths = new Set();
  for (const match of html.matchAll(/\/assets\/[^"'\s)]+/g)) {
    if (!match[0].endsWith('.map')) paths.add(match[0]);
  }
  return [...paths];
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Fill the cache now, from the network, rather than waiting for the next
    // load to do it as a side effect. Without this the first load (and the
    // first load after every worker update, since activate drops the old
    // cache) leaves nothing behind, and a home-screen launch with the server
    // unreachable is a white screen — iOS standalone apps have no error
    // page. Still the static bundle only, and still only what the server
    // just sent; a failure here leaves the cache as it was and the worker
    // still installs, because a cache is never a reason the app cannot run.
    try {
      const page = await fetch(PAGE, { cache: 'no-cache' });
      if (!page.ok || !(page.headers.get('content-type') || '').includes('text/html')) return;
      const html = await page.clone().text();
      const cache = await caches.open(CACHE);
      await cache.put(PAGE, page);
      const extras = ['/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];
      await Promise.all([...assetsIn(html), ...extras].map(async (path) => {
        try {
          const response = await fetch(path, { cache: 'no-cache' });
          if (response.ok && response.status === 200) await cache.put(path, response);
        } catch {
          // One missing icon is not a reason to have no shell.
        }
      }));
    } catch {
      // Offline at install time: nothing to fill from. Rule 1 applies from
      // the next successful load.
    }
    // Take over on the next load rather than waiting for every tab to close;
    // network-first means there is nothing stale to protect.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

/** Rule 2: what may be cached. Everything else falls through untouched. */
function isShellRequest(request, url) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  if (request.mode === 'navigate') return true;
  const path = url.pathname;
  // Source maps are only ever fetched with DevTools open, and are the
  // largest files in the build; they have no place in a phone's cache.
  if (path.endsWith('.map')) return false;
  return path.startsWith('/assets/')
    || path.startsWith('/icons/')
    || path === PAGE
    || path === '/manifest.webmanifest';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Rule 2, first thing: the API is not this worker's business.
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;
  if (!isShellRequest(event.request, url)) return;
  event.respondWith(networkFirst(event));
});

/** Rule 1. */
async function networkFirst(event) {
  const { request } = event;
  const isPage = request.mode === 'navigate';
  const key = isPage ? PAGE : request;
  try {
    const response = await fetch(request);
    // Only a real, complete 200 of the kind asked for replaces the cached
    // copy — never the server's 404 JSON, a redirect, a partial response, or
    // HTML under a bundle's name (a stale page asking for a bundle that no
    // longer exists). The write happens after the response is handed back,
    // not in front of it.
    if (response.ok && response.status === 200 && response.type === 'basic' && kindMatches(request, response)) {
      const copy = response.clone();
      event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await cache.put(key, isPage ? copy.clone() : copy);
        if (isPage) await pruneAssets(cache, copy);
      })());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(key);
    if (cached) return cached;
    throw error;
  }
}

/** An HTML body belongs to a navigation and to nothing else. */
function kindMatches(request, response) {
  const isHtml = (response.headers.get('content-type') || '').includes('text/html');
  return request.mode === 'navigate' ? isHtml : !isHtml;
}

/**
 * Rule 3's prune: forget /assets/* entries the freshly fetched page no longer
 * references. Vite writes every hashed bundle name into index.html, and this
 * app has no lazy chunks; if it ever gains some, a pruned chunk merely loses
 * its fallback copy — network-first means nothing else changes.
 */
async function pruneAssets(cache, pageResponse) {
  let html;
  try {
    html = await pageResponse.text();
  } catch {
    return;
  }
  const referenced = new Set(assetsIn(html));
  const keys = await cache.keys();
  await Promise.all(keys.map((cachedRequest) => {
    const path = new URL(cachedRequest.url).pathname;
    if (path.startsWith('/assets/') && !referenced.has(path)) return cache.delete(cachedRequest);
    return undefined;
  }));
}
