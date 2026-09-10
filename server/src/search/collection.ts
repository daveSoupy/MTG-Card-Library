import type Database from 'better-sqlite3';
import {
  ALLOCATION_DEFAULTS, allocationSqlRefs, ownedSemiJoinSql, type AllocationSqlRefs,
} from '../decks/allocation.ts';
import type { Comparison, Term } from './query.ts';

/**
 * Phase 23 — the half of the search syntax that knows about your shelf.
 *
 * Search knew the Scryfall catalog and nothing else, so "do I own this?" was
 * answered per card, after the fact, by eye. These terms make the collection a
 * filter: `available>=1 c:ur t:instant cmc<=2` is the query the phase exists
 * for.
 *
 * Two boundaries are crossed here and both matter.
 *
 * The catalog is oracle-grained and the collection is printing-grained, so
 * every one of these predicates joins through `card_printings.oracle_id`.
 *
 * And availability is not defined in this file. `owned` and `available` are
 * expressions handed over by `server/src/decks/allocation.ts` — the single
 * source of truth Phase 22 established — spliced in rather than re-derived.
 * Getting that wrong would not break visibly; it would return numbers that are
 * confidently wrong.
 */

/** Things a named term can point at, for the "no such name" warning. */
export type NameKind = 'location' | 'deck' | 'want' | 'tradelist';

export interface SearchContext {
  /** Availability expressions, from allocation.ts. Never rebuilt here. */
  allocation: AllocationSqlRefs;
  /**
   * Whether a location / deck / list of that name exists. Optional: without it
   * a typo still returns nothing, it just does so without saying why.
   */
  nameExists?: (kind: NameKind, name: string) => boolean;
}

/**
 * The context a bare `compileQuery(text)` gets.
 *
 * Only the parser's own tests run without a real one — every path that reaches
 * a database passes settings read from it, because a default that disagrees
 * with the user's settings would produce plausible, wrong numbers.
 */
export const DEFAULT_SEARCH_CONTEXT: SearchContext = {
  allocation: allocationSqlRefs(ALLOCATION_DEFAULTS),
};

export interface CollectionFragment {
  sql: string;
  params: (string | number)[];
  /** Surfaced in the response. A typo should explain itself, not blank the screen. */
  warning?: string;
}

/** Keys that take a value: `loc:"Blue Tackle Box"`, `owned>=2`, `deck:Atraxa`. */
export const COLLECTION_KEYS = [
  'owned', 'available', 'loc', 'location', 'deck', 'want', 'tradelist',
] as const;

/**
 * Predicates that are a whole term on their own — `owned`, `-indeck`.
 *
 * These cost a word: typing `owned` no longer searches the rules text for it.
 * That is the trade Scryfall makes for `is:`-style bare terms too, and no card
 * is named any of these; `o:owned` still reaches the text.
 */
export const BARE_COLLECTION_PREDICATES = [
  'owned', 'available', 'indeck', 'fortrade', 'want',
] as const;

function sqlOperator(comparison: Comparison): string {
  switch (comparison) {
    case '=': case ':': return '=';
    case '!=': return '<>';
    default: return comparison;
  }
}

/**
 * The lower bound on *owned* that a count comparison implies, if any.
 *
 * Used only to add allocation.ts's semi-join, which is what keeps `owned>=1`
 * from costing a full scan of the catalog. It has to be genuinely implied by
 * the comparison or it would narrow the results: `owned<=2` is satisfied by
 * every card you have never heard of, so it gets no bound at all.
 *
 * `available` gets the same bounds because availability can never exceed
 * owned — except for equality, which weakens to `>=`: available exactly 2 means
 * you own at least 2, not exactly 2.
 */
function impliedOwnedBound(
  kind: 'owned' | 'available', operator: string, quantity: number,
): { operator: string; quantity: number } | null {
  if (operator === '>=' && quantity >= 1) return { operator: '>=', quantity };
  if (operator === '>' && quantity >= 0) return { operator: '>', quantity };
  if (operator === '=' && quantity >= 1) {
    return { operator: kind === 'owned' ? '=' : '>=', quantity };
  }
  return null;
}

/**
 * A count comparison against one of allocation.ts's expressions.
 *
 * The bare form means "at least one", which is what someone typing `owned`
 * means every time. `owned:0` is the other end — the explicit "none of these",
 * and the same thing as `-owned`.
 */
function countFragment(
  kind: 'owned' | 'available', expression: string, term: Term, label: string,
): CollectionFragment | null {
  const bare = term.value === '';
  const quantity = bare ? 1 : Number.parseInt(term.value, 10);

  if (!Number.isFinite(quantity)) {
    // Dropped rather than matched-as-nothing, which is how `cmc:abc` already
    // behaves — but said out loud, because a silently dropped term widens the
    // results and reads as though the filter had been applied.
    return { sql: '', params: [], warning: `${label} needs a number, so "${term.key}:${term.value}" was ignored.` };
  }

  const operator = bare ? '>=' : sqlOperator(term.comparison);
  const comparison = `${expression} ${operator} ?`;

  const bound = impliedOwnedBound(kind, operator, quantity);
  if (!bound) return { sql: comparison, params: [quantity] };

  // The semi-join goes first so the planner meets it before the left-joined
  // expression. It adds nothing to the meaning — see ownedSemiJoinSql.
  return {
    sql: `(${ownedSemiJoinSql(bound.operator)} AND ${comparison})`,
    params: [bound.quantity, quantity],
  };
}

/** `owned >= n` on its own, for `is:owned` and the owned-only filter. */
export function ownedAtLeast(context: SearchContext, minimum: number): CollectionFragment {
  return {
    sql: `(${ownedSemiJoinSql('>=')} AND ${context.allocation.owned} >= ?)`,
    params: [minimum, minimum],
  };
}

/**
 * Every predicate below is written as `o.oracle_id IN (SELECT oracle_id ...)`
 * rather than as a correlated `EXISTS`.
 *
 * Same reason as the semi-join in allocation.ts, and the same measurement: a
 * correlated EXISTS makes the catalog the outer loop, so the query costs a scan
 * of 117k oracle rows whatever the collection holds. The IN form lets SQLite
 * drive from the small side — the handful of lots, deck slots or want rows that
 * actually match. Search runs per keystroke, so this is the difference between
 * a filter that feels instant and one that does not.
 *
 * Safe under `-` because `oracle_id` is NOT NULL in every table below; the
 * usual `NOT IN` trap needs a NULL in the subquery to spring.
 */

/**
 * Lots of a card in a named storage location.
 *
 * Archived locations are *not* excluded here, unlike `owned`: naming a location
 * is asking about that location, and answering "nothing" for a box you named
 * yourself would be the wrong kind of clever.
 */
const LOCATION_SQL = `
  o.oracle_id IN (SELECT lcp.oracle_id FROM collection_items lci
                  JOIN card_printings lcp    ON lcp.id = lci.printing_id
                  JOIN storage_locations lsl ON lsl.id = lci.location_id
                  WHERE lsl.name = ? COLLATE NOCASE)`;

/**
 * Used by a deck — any deck, any board, any status.
 *
 * Deliberately not the allocation question. A card sitting in a brew's
 * maybeboard reserves no cardboard, but it is still spoken for by an idea, and
 * `-indeck owned>=1` is asking which cards no list has ever mentioned. The
 * badge on a result row reads from this same definition, so the filter and the
 * badge cannot tell different stories.
 */
const IN_DECK_SQL = `
  o.oracle_id IN (SELECT oracle_id FROM deck_cards)`;

const DECK_NAMED_SQL = `
  o.oracle_id IN (SELECT ddc.oracle_id FROM deck_cards ddc
                  JOIN decks dd ON dd.id = ddc.deck_id
                  WHERE dd.name = ? COLLATE NOCASE)`;

const WANT_ANY_SQL = `
  o.oracle_id IN (SELECT oracle_id FROM want_list_items WHERE status = 'active')`;

const WANT_NAMED_SQL = `
  o.oracle_id IN (SELECT wwi.oracle_id FROM want_list_items wwi
                  JOIN want_lists wwl ON wwl.id = wwi.want_list_id
                  WHERE wwi.status = 'active' AND wwl.name = ? COLLATE NOCASE)`;

/** Trade-list entries point at specific owned copies, so this goes through the lot. */
const FOR_TRADE_SQL = `
  o.oracle_id IN (SELECT fcp.oracle_id FROM trade_list_items fti
                  JOIN collection_items fci ON fci.id = fti.collection_item_id
                  JOIN card_printings fcp   ON fcp.id = fci.printing_id)`;

const TRADE_LIST_NAMED_SQL = `
  o.oracle_id IN (SELECT fcp.oracle_id FROM trade_list_items fti
                  JOIN trade_lists ftl      ON ftl.id = fti.trade_list_id
                  JOIN collection_items fci ON fci.id = fti.collection_item_id
                  JOIN card_printings fcp   ON fcp.id = fci.printing_id
                  WHERE ftl.name = ? COLLATE NOCASE)`;

const NAME_LABEL: Record<NameKind, string> = {
  location: 'storage location',
  deck: 'deck',
  want: 'want list',
  tradelist: 'trade list',
};

function named(
  sql: string, kind: NameKind, name: string, context: SearchContext,
): CollectionFragment {
  const fragment: CollectionFragment = { sql, params: [name] };
  // An unknown name returns nothing, which is correct — but silently, which is
  // not. `loc:Binderrr` should say so rather than blank the screen.
  if (context.nameExists && !context.nameExists(kind, name)) {
    fragment.warning = `No ${NAME_LABEL[kind]} called "${name}".`;
  }
  return fragment;
}

/**
 * Compiles one collection term, or returns null when the key is not one of
 * ours. Negation is applied by the caller, exactly as it is for every other
 * term, so `-loc:Binder` and `-indeck` need nothing special here.
 */
export function collectionFragment(
  term: Term, context: SearchContext,
): CollectionFragment | null {
  const value = term.value;

  switch (term.key) {
    case 'owned':
      return countFragment('owned', context.allocation.owned, term, 'Owned');
    case 'available':
      return countFragment('available', context.allocation.available, term, 'Available');

    case 'loc': case 'location':
      return named(LOCATION_SQL, 'location', value, context);

    case 'indeck':
      return { sql: IN_DECK_SQL, params: [] };
    case 'deck':
      return named(DECK_NAMED_SQL, 'deck', value, context);

    case 'want':
      return value === ''
        ? { sql: WANT_ANY_SQL, params: [] }
        : named(WANT_NAMED_SQL, 'want', value, context);

    case 'fortrade':
      return { sql: FOR_TRADE_SQL, params: [] };
    case 'tradelist':
      return named(TRADE_LIST_NAMED_SQL, 'tradelist', value, context);

    default:
      return null;
  }
}

/** Looks names up in the database, memoised for the life of one search. */
export function nameChecker(
  db: Database.Database,
): (kind: NameKind, name: string) => boolean {
  const QUERIES: Record<NameKind, string> = {
    location: 'SELECT 1 FROM storage_locations WHERE name = ? COLLATE NOCASE',
    deck: 'SELECT 1 FROM decks WHERE name = ? COLLATE NOCASE',
    want: 'SELECT 1 FROM want_lists WHERE name = ? COLLATE NOCASE',
    tradelist: 'SELECT 1 FROM trade_lists WHERE name = ? COLLATE NOCASE',
  };
  const cache = new Map<string, boolean>();
  return (kind, name) => {
    const key = `${kind}${name.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const exists = db.prepare(QUERIES[kind]).get(name) !== undefined;
    cache.set(key, exists);
    return exists;
  };
}
