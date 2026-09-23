/**
 * Display density — how much of a card a tile shows.
 *
 * Four card grids render independently (browse results, the collection's owned
 * lots, add-by-set, and the deck builder's card view), so density is one piece
 * of shared state rather than four toggles. React-free on purpose: the storage
 * rules are the easy thing to get subtly wrong, and this way they can be tested
 * with plain `node --test` next to deckView.ts.
 */

export type Density = 'full' | 'lined' | 'compact' | 'ultra';

/** The pages that own a density of their own. Add-by-set is a collection tab. */
export type DensityPage = 'browse' | 'collection' | 'deck' | 'wants';

export const DENSITY_LABEL: Record<Density, string> = {
  full: 'Full',
  lined: 'Lined-up',
  compact: 'Compact',
  ultra: 'Ultra-compact',
};

/** Shown on the toggles, so the four levels are legible without trying them. */
export const DENSITY_HINT: Record<Density, string> = {
  full: 'Full-size art',
  lined: 'Overlapping cascade, one column per group',
  compact: 'Smaller art, name and cost on one line',
  ultra: 'No art — one text row per card',
};

/**
 * Lined-up is the deck builder's alone: a deck is 100–250 cards over a handful
 * of buckets, which cascades sensibly, while one Browse search or a real
 * collection can put thousands of cards in a single group.
 */
export const DENSITIES_FOR: Record<DensityPage, Density[]> = {
  browse: ['full', 'compact', 'ultra'],
  collection: ['full', 'compact', 'ultra'],
  deck: ['ultra', 'compact', 'lined', 'full'],
  // A want row has no art in Compact, and no meaningful mid-point between a
  // full card and a bare text line — Compact and Lined-up don't apply.
  wants: ['full', 'ultra'],
};

const ALL_DENSITIES: Density[] = ['full', 'lined', 'compact', 'ultra'];

const isDensity = (value: unknown): value is Density =>
  typeof value === 'string' && (ALL_DENSITIES as string[]).includes(value);

export function densityAllowed(density: Density, page: DensityPage): boolean {
  return DENSITIES_FOR[page].includes(density);
}

/** Lined-up outside the deck builder falls back to Full rather than rendering
 *  a cascade the page was never meant to show. */
export function coerceDensity(density: Density, page: DensityPage): Density {
  return densityAllowed(density, page) ? density : 'full';
}

export interface DensityPrefs {
  /** The topbar toggle's value — what a page with no override of its own uses. */
  global: Density;
  /** Whether `global` was ever chosen on this device, rather than defaulted.
   *  Until it is, a phone gets `PHONE_DEFAULT` where one is set. */
  globalChosen?: boolean;
  overrides: Partial<Record<DensityPage, Density>>;
}

/**
 * What a page starts at on a phone before anything was chosen. The deck
 * builder at Full is one card per screen — a 100-card deck was ~18,000px of
 * scrolling — so it starts at Compact there. Any choice, the topbar's or the
 * page's own, replaces it.
 */
export const PHONE_DEFAULT: Partial<Record<DensityPage, Density>> = { deck: 'compact' };

const GLOBAL_KEY = 'mtg.density';
const PAGE_KEY: Record<DensityPage, string> = {
  browse: 'mtg.density.browse',
  collection: 'mtg.density.collection',
  deck: 'mtg.density.deck',
  wants: 'mtg.density.wants',
};

const PAGES: DensityPage[] = ['browse', 'collection', 'deck', 'wants'];

/**
 * Per device, like the theme and the pane widths — a phone in a card shop wants
 * Ultra-compact for scanning while the desktop stays at Full, and neither is a
 * property of the collection itself. localStorage throws outright in some
 * privacy modes rather than returning null, so nothing here may be the thing
 * that stops the app rendering.
 */
export function loadDensity(): DensityPrefs {
  try {
    const global = localStorage.getItem(GLOBAL_KEY);
    const overrides: Partial<Record<DensityPage, Density>> = {};
    for (const page of PAGES) {
      const stored = localStorage.getItem(PAGE_KEY[page]);
      if (isDensity(stored) && densityAllowed(stored, page)) overrides[page] = stored;
    }
    return { global: isDensity(global) ? global : 'full', globalChosen: isDensity(global), overrides };
  } catch {
    return { global: 'full', globalChosen: false, overrides: {} };
  }
}

export function saveGlobalDensity(density: Density): void {
  try { localStorage.setItem(GLOBAL_KEY, density); } catch { /* private mode */ }
}

/** `null` clears the override, putting the page back on the global default. */
export function savePageDensity(page: DensityPage, density: Density | null): void {
  try {
    if (density === null) localStorage.removeItem(PAGE_KEY[page]);
    else localStorage.setItem(PAGE_KEY[page], density);
  } catch { /* private mode */ }
}

/**
 * What a page actually renders at: its own override, else the global default,
 * coerced to something that page can show.
 *
 * `page` is null on the views with no card grid at all (the deck list, trades,
 * data), where the global default is all there is to report.
 */
export function effectiveDensity(prefs: DensityPrefs, page: DensityPage | null, phone = false): Density {
  if (page === null) return prefs.global;
  const override = prefs.overrides[page];
  if (override) return coerceDensity(override, page);
  const phoneDefault = phone && !prefs.globalChosen ? PHONE_DEFAULT[page] : undefined;
  return coerceDensity(phoneDefault ?? prefs.global, page);
}

/** The topbar toggle cycles rather than opening a menu, the way the theme
 *  button next to it does. The cycle covers the active page's levels only. */
export function nextDensity(current: Density, page: DensityPage | null): Density {
  const options = page === null ? DENSITIES_FOR.browse : DENSITIES_FOR[page];
  const index = options.indexOf(current);
  return options[(index + 1) % options.length];
}
