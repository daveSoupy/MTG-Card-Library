/**
 * Search and sort for the want lists and trade lists.
 *
 * Both lists arrive whole — one request per list, every row — so finding a
 * card and putting the rows in another order are presentation over rows
 * already on screen, not figures: nothing here adds, prices or counts. The
 * totals above each list come from the server.
 *
 * Pure and React-free, like deckView.ts, so it is tested with `node --test`.
 * Every sort is stable and ends on the list's own order, so two rows that tie
 * keep the order you gave them rather than shuffling on each render.
 */

/** Case- and accent-insensitive "does the name contain this". */
export function nameMatches(name: string, query: string): boolean {
  const q = fold(query.trim());
  return q === '' || fold(name).includes(q);
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Highest first, with a missing figure after every present one. */
const desc = (a: number | null | undefined, b: number | null | undefined) =>
  (a == null ? 1 : 0) - (b == null ? 1 : 0) || (b ?? 0) - (a ?? 0);

/** Sorts a copy; `rest` breaks ties in turn, and the input order breaks the last. */
function sorted<T>(items: T[], ...compare: Array<(a: T, b: T) => number>): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      for (const c of compare) {
        const d = c(a.item, b.item);
        if (d !== 0) return d;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

// ---------------------------------------------------------------- wants

export const WANT_SORTS = ['manual', 'priority', 'price', 'name', 'recent'] as const;
export type WantSort = typeof WANT_SORTS[number];
export const WANT_SORT_LABEL: Record<WantSort, string> = {
  manual: 'Your order',
  priority: 'Priority',
  price: 'Price',
  name: 'Name',
  recent: 'Recently added',
};

export interface SortableWant {
  name: string; priority: number; priceUsd: number | null; addedAt?: string;
}

/**
 * `manual` is the list's own drag order, as the server returned it. Price
 * puts the dearest first — the ones worth watching — and a want with no price
 * (0 from the server) last; priority puts High first.
 */
export function sortWants<T extends SortableWant>(items: T[], sort: WantSort): T[] {
  switch (sort) {
    case 'manual': return items.slice();
    case 'priority': return sorted(items, (a, b) => b.priority - a.priority);
    case 'price': return sorted(items, (a, b) => desc(a.priceUsd || null, b.priceUsd || null), byName);
    case 'name': return sorted(items, byName);
    case 'recent': return sorted(items, (a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''));
  }
}

// ----------------------------------------------------------- trade lists

export const TRADE_LIST_SORTS = ['manual', 'name', 'ask', 'market'] as const;
export type TradeListSort = typeof TRADE_LIST_SORTS[number];
export const TRADE_LIST_SORT_LABEL: Record<TradeListSort, string> = {
  manual: 'List order',
  name: 'Name',
  ask: 'Your ask',
  market: 'Market price',
};

export interface SortableListing {
  name: string; askingPriceUsd: number | null; marketUsd: number | null;
}

/** Ask and market put the dearest first, and rows without that figure last. */
export function sortListings<T extends SortableListing>(items: T[], sort: TradeListSort): T[] {
  switch (sort) {
    case 'manual': return items.slice();
    case 'name': return sorted(items, byName);
    case 'ask': return sorted(items, (a, b) => desc(a.askingPriceUsd, b.askingPriceUsd), byName);
    case 'market': return sorted(items, (a, b) => desc(a.marketUsd, b.marketUsd), byName);
  }
}
