/**
 * The All / Owned / Available chips, as query text.
 *
 * A chip *adds a term to the query* rather than setting a filter of its own,
 * for two reasons. The first is discoverability: tapping Owned puts `owned>=1`
 * in the box where you can see it, edit it, and learn the syntax by using the
 * buttons. The second is correctness, and it is the one that matters — a chip
 * implemented as a query replacement silently drops whatever else the search
 * pane was applying, which in a Commander deck builder means quietly offering
 * off-identity cards the moment someone taps a chip. A term can only ever
 * narrow.
 *
 * The chips manage their own two terms and nothing else. A hand-typed
 * `owned>=2` is left alone — the chips read "All" beside it, because the query
 * box, not the chip row, is the truth.
 */

export type Scope = 'all' | 'owned' | 'available';

export const SCOPES: Scope[] = ['all', 'owned', 'available'];

export const SCOPE_LABEL: Record<Scope, string> = {
  all: 'All cards',
  owned: 'Owned',
  available: 'Available',
};

export const SCOPE_HINT: Record<Scope, string> = {
  all: 'Every card in the database',
  owned: 'Cards you have at least one copy of',
  available: 'Copies no deck has claimed and no trade list has promised away',
};

const SCOPE_TERM: Record<Exclude<Scope, 'all'>, string> = {
  owned: 'owned>=1',
  available: 'available>=1',
};

/** The exact tokens a chip writes, so only a chip's own terms get rewritten. */
const CHIP_TOKENS: Record<Exclude<Scope, 'all'>, RegExp> = {
  owned: /^owned(>=1)?$/i,
  available: /^available(>=1)?$/i,
};

const split = (query: string) => query.split(/\s+/).filter(Boolean);

/** Which chip the query currently reads as. `available` wins if both are there. */
export function scopeOf(query: string): Scope {
  const tokens = split(query);
  if (tokens.some((t) => CHIP_TOKENS.available.test(t))) return 'available';
  if (tokens.some((t) => CHIP_TOKENS.owned.test(t))) return 'owned';
  return 'all';
}

/**
 * The query with the chip's term swapped in — or, for `all`, taken out.
 *
 * The term goes first so it stays visible at the head of a long query rather
 * than scrolling out of the box.
 */
export function withScope(query: string, scope: Scope): string {
  const kept = split(query).filter(
    (token) => !CHIP_TOKENS.owned.test(token) && !CHIP_TOKENS.available.test(token),
  );
  if (scope === 'all') return kept.join(' ');
  return [SCOPE_TERM[scope], ...kept].join(' ');
}
