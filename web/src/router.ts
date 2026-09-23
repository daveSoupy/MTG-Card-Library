/**
 * The URL as the app's top-level view, and back again.
 *
 * History-based (real paths, not `#/…`) because the server already answers
 * every non-/api path with index.html, and Vite's dev server does the same —
 * so `/decks/12` survives a hard refresh and can be pasted to someone on the
 * tailnet. The parse and format halves are pure and know nothing about
 * `window`; only the three wrappers at the bottom do, so `node --test` can
 * exercise the mapping with no DOM.
 *
 * Every route round-trips: `parseRoute(formatRoute(r))` is `r`. Anything the
 * parser does not recognise lands on Collection, the same place the app used
 * to start unconditionally, rather than on a 404 page there is no design for;
 * `isUnknownPath` lets the app add a one-line note that it did.
 */

export const COLLECTION_TABS = ['browse', 'add', 'sets', 'value', 'wants', 'tradelists'] as const;
export type CollectionTab = typeof COLLECTION_TABS[number];

export type Route =
  | { name: 'collection'; tab?: CollectionTab }
  | { name: 'decks' }
  | { name: 'deck'; id: number }
  | { name: 'browse'; q?: string }
  | { name: 'trades'; id?: number }
  | { name: 'games' }
  | { name: 'data' };

export const DEFAULT_ROUTE: Route = { name: 'collection' };

/** A positive integer id from a path segment, or null for anything else —
 *  `/decks/abc` and `/decks/0` are not deck links. */
function parseId(segment: string | undefined): number | null {
  if (segment === undefined || !/^\d+$/.test(segment)) return null;
  const id = Number(segment);
  return id > 0 && Number.isSafeInteger(id) ? id : null;
}

export function parseRoute(pathname: string, search = ''): Route {
  const segments = pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  const [head, second, ...rest] = segments;
  // A trailing segment nothing below expects (`/decks/12/extra`) is not a
  // route we know; treat the whole path as unknown rather than guess.
  const extra = rest.length > 0;

  switch (head) {
    case undefined:
      // Bare `/`, which is where a bookmark from before routing points.
      return DEFAULT_ROUTE;
    case 'collection': {
      if (extra) return DEFAULT_ROUTE;
      if (second === undefined) return { name: 'collection' };
      const tab = COLLECTION_TABS.find((t) => t === second);
      return tab ? { name: 'collection', tab } : DEFAULT_ROUTE;
    }
    case 'decks': {
      if (extra) return DEFAULT_ROUTE;
      if (second === undefined) return { name: 'decks' };
      const id = parseId(second);
      return id === null ? DEFAULT_ROUTE : { name: 'deck', id };
    }
    case 'browse': {
      if (second !== undefined) return DEFAULT_ROUTE;
      const q = new URLSearchParams(search).get('q');
      return q ? { name: 'browse', q } : { name: 'browse' };
    }
    case 'trades': {
      if (extra) return DEFAULT_ROUTE;
      if (second === undefined) return { name: 'trades' };
      const id = parseId(second);
      return id === null ? DEFAULT_ROUTE : { name: 'trades', id };
    }
    case 'games':
      return second === undefined ? { name: 'games' } : DEFAULT_ROUTE;
    case 'data':
      return second === undefined ? { name: 'data' } : DEFAULT_ROUTE;
    default:
      return DEFAULT_ROUTE;
  }
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'collection':
      return route.tab ? `/collection/${route.tab}` : '/collection';
    case 'decks':
      return '/decks';
    case 'deck':
      return `/decks/${route.id}`;
    case 'browse': {
      if (!route.q) return '/browse';
      const params = new URLSearchParams({ q: route.q });
      return `/browse?${params.toString()}`;
    }
    case 'trades':
      return route.id === undefined ? '/trades' : `/trades/${route.id}`;
    case 'games':
      return '/games';
    case 'data':
      return '/data';
  }
}

/** True for a path the parser did not recognise and sent to Collection —
 *  `/deck/6`, `/collection/nope` — as opposed to a bare `/`, which is a
 *  deliberate way in. Lets the app say so instead of silently redirecting. */
export function isUnknownPath(pathname: string, search = ''): boolean {
  if (pathname.split('/').filter(Boolean).length === 0) return false;
  return parseRoute(pathname, search) === DEFAULT_ROUTE;
}

// ---------------------------------------------------------------- window

/** The route the address bar currently names. */
export function readRoute(): Route {
  return parseRoute(window.location.pathname, window.location.search);
}

/** Adds a history entry, so Back returns to where the user was. Skipped when
 *  the URL would not change — clicking the tab you are already on must not
 *  leave a duplicate entry that makes Back appear to do nothing. */
export function pushRoute(route: Route): void {
  const url = formatRoute(route);
  if (url === window.location.pathname + window.location.search) return;
  window.history.pushState(null, '', url);
}

/** Rewrites the current entry. For corrections the user did not ask for —
 *  canonicalising `/` on load, a query typed into the search box, the Games
 *  tab being switched off underneath the page — where a Back stop would be
 *  a stop at something they never chose. */
export function replaceRoute(route: Route): void {
  const url = formatRoute(route);
  if (url === window.location.pathname + window.location.search) return;
  window.history.replaceState(null, '', url);
}

/** Runs `listener` with the new route each time the user presses Back or
 *  Forward. Returns the unsubscribe. */
export function onRouteChange(listener: (route: Route) => void): () => void {
  const handler = () => listener(readRoute());
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
}
