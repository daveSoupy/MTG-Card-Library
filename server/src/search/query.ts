import { colorMask, expandRarity, isColorlessSpec, normalizeName, parseColors } from '../model/mtg.ts';
import {
  BARE_COLLECTION_PREDICATES, COLLECTION_KEYS, DEFAULT_SEARCH_CONTEXT,
  collectionFragment, ownedAtLeast, type SearchContext,
} from './collection.ts';

/**
 * Parses Scryfall-style search syntax into SQL.
 *
 * Players already know this syntax, so supporting it beats inventing another
 * filter language. Anything unrecognised falls back to plain text matching
 * rather than erroring, so typing a card name always does something sensible.
 */

export type Comparison = '=' | '!=' | '<=' | '>=' | '<' | '>' | ':';

export interface Term {
  key: string;
  comparison: Comparison;
  value: string;
  negated: boolean;
}

export interface CompiledQuery {
  where: string[];
  params: (string | number)[];
  /** FTS5 MATCH expression built from the bare words, if any. */
  ftsMatch: string | null;
  /** The bare words joined, for name-relevance ranking. */
  freeText: string;
  /**
   * Things the query said that could not be honoured — an unknown storage
   * location, a count that was not a number. Returned to the client rather
   * than raised: a typo should explain itself, not 500 and not blank the
   * screen with no reason given.
   */
  warnings: string[];
}

const KNOWN_KEYS = new Set([
  'name', 'n', 'oracle', 'o', 'text', 'type', 't', 'color', 'c', 'colour',
  'identity', 'id', 'ci', 'commander', 'cmc', 'mv', 'manavalue',
  'set', 's', 'e', 'edition', 'rarity', 'r', 'power', 'pow', 'toughness', 'tou',
  'loyalty', 'loy', 'artist', 'a', 'legal', 'f', 'format', 'banned', 'restricted',
  'is', 'not', 'layout', 'year', 'lang', 'category', 'cat',
  // Phase 23 — the collection half. Compiled in ./collection.ts.
  ...COLLECTION_KEYS,
]);

/**
 * Terms that are a whole word on their own: `owned`, `-indeck`, `fortrade`.
 *
 * Checked before a token falls through to free text, which is the cost — the
 * word `owned` no longer searches rules text. `o:owned` still does.
 */
const BARE_KEYS = new Set<string>(BARE_COLLECTION_PREDICATES);

/** Longest operators first so ">=" is not read as ">". */
const OPERATORS: Comparison[] = ['<=', '>=', '!=', ':', '=', '<', '>'];

/** Splits on whitespace but keeps quoted phrases together. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (/\s/.test(char) && !inQuotes) {
      if (current) { tokens.push(current); current = ''; }
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseTerm(token: string, negated: boolean): Term | null {
  for (const op of OPERATORS) {
    const index = token.indexOf(op);
    if (index <= 0) continue;
    const key = token.slice(0, index).toLowerCase();
    if (!KNOWN_KEYS.has(key)) continue;
    let value = token.slice(index + op.length);
    if (!value) continue;
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      value = value.slice(1, -1);
    }
    return { key, comparison: op, value, negated };
  }
  return null;
}

export function parseQuery(text: string): { terms: Term[]; words: string[] } {
  const terms: Term[] = [];
  const words: string[] = [];

  for (const token of tokenize(text)) {
    let body = token;
    let negated = false;
    if (body.startsWith('-') && body.length > 1) {
      negated = true;
      body = body.slice(1);
    }
    const term = parseTerm(body, negated);
    if (term) { terms.push(term); continue; }

    const bare = body.toLowerCase();
    if (BARE_KEYS.has(bare)) {
      // An empty value is what tells the compiler this was the bare form —
      // `owned` means "at least one", `owned>=2` means what it says.
      terms.push({ key: bare, comparison: ':', value: '', negated });
      continue;
    }
    words.push(body.replace(/"/g, ''));
  }
  return { terms, words };
}

function sqlOperator(comparison: Comparison): string {
  switch (comparison) {
    case '=': case ':': return '=';
    case '!=': return '<>';
    default: return comparison;
  }
}

interface Fragment {
  sql: string;
  params: (string | number)[];
}

/** What `clauseFor` returns: a Fragment that may also have something to say. */
type CollectionFragment = Fragment & { warning?: string };

/**
 * Colour comparisons run against the bitmask, so each variant is a single
 * integer expression rather than string matching.
 */
function colorFragment(column: string, term: Term, defaultToSubset: boolean): Fragment {
  // "colorless" is a value, not an empty selection. Without this, `c:c` builds
  // `(colors_mask & 0) = 0`, which is true of every card in the database.
  if (isColorlessSpec(term.value)) {
    return term.comparison === '!='
      ? { sql: `${column} <> 0`, params: [] }
      : { sql: `${column} = 0`, params: [] };
  }

  const mask = colorMask(parseColors(term.value));
  let comparison = term.comparison;
  // Deck building asks "does this fit in my commander's colours", so identity
  // defaults to a subset test while colour defaults to a superset one.
  if (comparison === ':') comparison = defaultToSubset ? '<=' : '>=';

  switch (comparison) {
    case '=':  return { sql: `${column} = ?`, params: [mask] };
    case '!=': return { sql: `${column} <> ?`, params: [mask] };
    case '<=': return { sql: `(${column} & ~?) = 0`, params: [mask] };
    case '>=': return { sql: `(${column} & ?) = ?`, params: [mask, mask] };
    case '<':  return { sql: `(${column} & ~?) = 0 AND ${column} <> ?`, params: [mask, mask] };
    case '>':  return { sql: `(${column} & ?) = ? AND ${column} <> ?`, params: [mask, mask, mask] };
    default:   return { sql: `(${column} & ?) = ?`, params: [mask, mask] };
  }
}

function isFragment(value: string, context: SearchContext): Fragment | null {
  switch (value) {
    // Delegated to allocation.ts rather than counting lots directly: since
    // Phase 22 a lot in an archived location is not owned, and `is:owned`
    // saying otherwise would put two answers on the same screen.
    case 'owned':
      return ownedAtLeast(context, 1);
    case 'commander':  return { sql: 'o.can_be_commander = 1', params: [] };
    case 'legendary':  return { sql: 'o.is_legendary = 1', params: [] };
    case 'reserved':   return { sql: 'o.is_reserved = 1', params: [] };
    case 'background': return { sql: 'o.can_be_background = 1', params: [] };
    case 'partner':    return { sql: 'o.can_be_partner = 1', params: [] };
    // "A deck can have any number of cards named ..." — the Relentless Rats
    // family. Answers "which cards are exempt from the 4-of rule right now"
    // without anyone maintaining a list of names.
    case 'anynumber': case 'unlimited':
      return { sql: 'o.deck_copy_limit = -1', params: [] };
    // Those plus the ones with a printed cap of their own (Nazgûl, Seven Dwarves).
    case 'copylimit':
      return { sql: 'o.deck_copy_limit IS NOT NULL', params: [] };
    case 'land':       return { sql: `o.type_line LIKE '%Land%'`, params: [] };
    case 'creature':   return { sql: `o.type_line LIKE '%Creature%'`, params: [] };
    case 'digital':    return { sql: 'dp.is_digital = 1', params: [] };
    case 'paper':      return { sql: 'dp.is_digital = 0', params: [] };
    case 'ub': case 'universesbeyond': {
      // Scryfall marks these in promo_types, including on the Secret Lair
      // crossover drops that live outside the crossover sets themselves.
      return { sql: `NOT EXISTS (SELECT 1 FROM card_printings ubp
                                 WHERE ubp.oracle_id = o.oracle_id
                                   AND COALESCE(ubp.promo_types,'') NOT LIKE '%universesbeyond%')`,
               params: [] };
    }
    case 'playable': case 'unplayable': {
      // "Legal somewhere", the same test the format filter uses without
      // naming a format. Banned is not playable, which is why Chaos Orb
      // answers to is:unplayable.
      const legalSomewhere = `EXISTS (SELECT 1 FROM card_legalities cl
                                     WHERE cl.oracle_id = o.oracle_id
                                       AND cl.legality IN ('legal','restricted'))`;
      return value === 'playable'
        ? { sql: legalSomewhere, params: [] }
        : { sql: `NOT ${legalSomewhere}`, params: [] };
    }
    case 'permanent':
      return { sql: `NOT (o.type_line LIKE '%Instant%' OR o.type_line LIKE '%Sorcery%')`, params: [] };
    case 'spell':
      return { sql: `(o.type_line LIKE '%Instant%' OR o.type_line LIKE '%Sorcery%')`, params: [] };
    case 'dfc': case 'transform': case 'doublefaced':
      return { sql: `o.layout IN ('transform','modal_dfc','double_faced_token','reversible_card')`, params: [] };
    case 'split':      return { sql: `o.layout = 'split'`, params: [] };
    case 'colorless':  return { sql: 'o.colors_mask = 0', params: [] };
    case 'multicolor': case 'multicolour': case 'gold':
      // Two or more colour bits set. Clearing the lowest set bit leaves
      // something behind only when there was more than one.
      return { sql: '(o.colors_mask & (o.colors_mask - 1)) <> 0', params: [] };
    case 'hybrid':
      // {G/W} and friends. A hybrid card may be mono-coloured by identity, so
      // this is deliberately independent of colors_mask.
      return { sql: `o.mana_cost LIKE '%/%'`, params: [] };
    case 'foil':
      return { sql: `EXISTS (SELECT 1 FROM card_printings fp WHERE fp.oracle_id = o.oracle_id
                             AND fp.finishes LIKE '%foil%')`, params: [] };
    default: return null;
  }
}

function clauseFor(term: Term, context: SearchContext): CollectionFragment | null {
  const numeric = Number.parseFloat(term.value);

  // Phase 23's collection terms compile in ./collection.ts, beside the
  // allocation expressions they are built from.
  const collection = collectionFragment(term, context);
  if (collection) return collection;

  switch (term.key) {
    case 'name': case 'n':
      return { sql: 'o.name_normalized LIKE ?', params: [`%${normalizeName(term.value)}%`] };
    case 'oracle': case 'o': case 'text':
      return { sql: 'o.oracle_text_all LIKE ?', params: [`%${term.value}%`] };
    case 'type': case 't':
      return { sql: 'o.type_line LIKE ?', params: [`%${term.value}%`] };

    case 'color': case 'c': case 'colour':
      return colorFragment('o.colors_mask', term, false);
    case 'identity': case 'id': case 'ci': case 'commander':
      return colorFragment('o.color_identity_mask', term, true);

    case 'cmc': case 'mv': case 'manavalue':
      return Number.isFinite(numeric)
        ? { sql: `o.cmc ${sqlOperator(term.comparison)} ?`, params: [numeric] } : null;

    // Power and toughness can be '*' or '1+*'; the GLOB keeps those out of a
    // numeric comparison rather than silently casting them to zero.
    case 'power': case 'pow':
      return Number.isFinite(numeric)
        ? { sql: `CAST(o.power AS REAL) ${sqlOperator(term.comparison)} ? AND o.power GLOB '*[0-9]*'`,
            params: [numeric] } : null;
    case 'toughness': case 'tou':
      return Number.isFinite(numeric)
        ? { sql: `CAST(o.toughness AS REAL) ${sqlOperator(term.comparison)} ? AND o.toughness GLOB '*[0-9]*'`,
            params: [numeric] } : null;
    case 'loyalty': case 'loy':
      return Number.isFinite(numeric)
        ? { sql: `CAST(o.loyalty AS REAL) ${sqlOperator(term.comparison)} ?`, params: [numeric] } : null;

    case 'set': case 's': case 'e': case 'edition':
      return { sql: `EXISTS (SELECT 1 FROM card_printings sp WHERE sp.oracle_id = o.oracle_id
                             AND sp.set_code = ?)`, params: [term.value.toLowerCase()] };
    case 'rarity': case 'r':
      return { sql: `EXISTS (SELECT 1 FROM card_printings rp WHERE rp.oracle_id = o.oracle_id
                             AND rp.rarity = ?)`, params: [expandRarity(term.value)] };
    case 'artist': case 'a':
      return { sql: `EXISTS (SELECT 1 FROM card_printings ap WHERE ap.oracle_id = o.oracle_id
                             AND ap.artist LIKE ?)`, params: [`%${term.value}%`] };
    // Phase 7's functional tags. An unrecognised value simply matches nothing,
    // the same as set:zzz — dropping the term instead would return the whole
    // library and read as though the filter had been applied.
    case 'category': case 'cat':
      return { sql: `EXISTS (SELECT 1 FROM card_categories cc WHERE cc.oracle_id = o.oracle_id
                             AND cc.category = ?)`, params: [term.value.toLowerCase()] };
    case 'layout':
      return { sql: 'o.layout = ?', params: [term.value.toLowerCase()] };

    case 'legal': case 'f': case 'format':
      return { sql: `EXISTS (SELECT 1 FROM card_legalities cl WHERE cl.oracle_id = o.oracle_id
                             AND cl.format_code = ? AND cl.legality IN ('legal','restricted'))`,
               params: [term.value.toLowerCase()] };
    case 'banned':
      return { sql: `EXISTS (SELECT 1 FROM card_legalities cl WHERE cl.oracle_id = o.oracle_id
                             AND cl.format_code = ? AND cl.legality = 'banned')`,
               params: [term.value.toLowerCase()] };
    case 'restricted':
      return { sql: `EXISTS (SELECT 1 FROM card_legalities cl WHERE cl.oracle_id = o.oracle_id
                             AND cl.format_code = ? AND cl.legality = 'restricted')`,
               params: [term.value.toLowerCase()] };

    case 'year':
      return Number.isFinite(numeric)
        ? { sql: `CAST(substr(dp.released_at, 1, 4) AS INTEGER) ${sqlOperator(term.comparison)} ?`,
            params: [numeric] } : null;
    case 'lang':
      return { sql: 'dp.lang = ?', params: [term.value.toLowerCase()] };

    case 'is': case 'not': {
      const fragment = isFragment(term.value.toLowerCase(), context);
      if (!fragment) return null;
      return term.key === 'not'
        ? { sql: `NOT (${fragment.sql})`, params: fragment.params }
        : fragment;
    }
    default:
      return null;
  }
}

/**
 * @param context Where the collection terms get their SQL. The store passes one
 *   built from the live settings; the default exists so the parser's own tests
 *   can run without a database, and is never what a real search uses.
 */
export function compileQuery(
  text: string, context: SearchContext = DEFAULT_SEARCH_CONTEXT,
): CompiledQuery {
  const { terms, words } = parseQuery(text);
  const where: string[] = [];
  const params: (string | number)[] = [];
  const warnings: string[] = [];

  for (const term of terms) {
    const fragment = clauseFor(term, context);
    if (!fragment) continue;
    if (fragment.warning) warnings.push(fragment.warning);
    // A term can warn *instead of* filtering — an unparseable count is
    // reported and dropped rather than silently narrowing to nothing.
    if (!fragment.sql) continue;
    where.push(term.negated ? `NOT (${fragment.sql})` : fragment.sql);
    params.push(...fragment.params);
  }

  const kept = words.filter((w) => w.length > 0);

  // Words are normalised before they reach FTS5 so free text folds accents and
  // ligatures the same way names do — typing "Aether" should find "Æther Vial".
  // The trailing `*` makes each word a prefix: without it FTS5 compares whole
  // tokens, so "waste" never matches the card "Wastes".
  const ftsWords = kept
    .map((word) => normalizeName(word))
    .filter((word) => word.length > 0);

  return {
    where,
    params,
    ftsMatch: ftsWords.length > 0
      ? ftsWords.map((w) => `"${w}"*`).join(' AND ')
      : null,
    freeText: kept.join(' '),
    warnings,
  };
}

/**
 * True when the query is explicitly about legality.
 *
 * Suppresses the "hide unplayable cards" default, which would otherwise make
 * `banned:vintage` return nothing at all: a card banned everywhere is legal
 * nowhere, so the default and the query cancel each other out.
 */
export function mentionsLegality(text: string): boolean {
  const LEGALITY_KEYS = new Set(['legal', 'f', 'format', 'banned', 'restricted']);
  return parseQuery(text).terms.some((t) => {
    if (LEGALITY_KEYS.has(t.key)) return true;
    const value = t.value.toLowerCase();
    return (t.key === 'is' || t.key === 'not') && (value === 'playable' || value === 'unplayable');
  });
}

/** True when the query explicitly asks about digital cards either way. */
export function mentionsDigital(text: string): boolean {
  return parseQuery(text).terms.some(
    (t) => (t.key === 'is' || t.key === 'not') &&
           (t.value.toLowerCase() === 'digital' || t.value.toLowerCase() === 'paper'),
  );
}
