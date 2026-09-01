import { colorMask, expandRarity, isColorlessSpec, normalizeName, parseColors } from '../model/mtg.ts';

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
}

const KNOWN_KEYS = new Set([
  'name', 'n', 'oracle', 'o', 'text', 'type', 't', 'color', 'c', 'colour',
  'identity', 'id', 'ci', 'commander', 'cmc', 'mv', 'manavalue',
  'set', 's', 'e', 'edition', 'rarity', 'r', 'power', 'pow', 'toughness', 'tou',
  'loyalty', 'loy', 'artist', 'a', 'legal', 'f', 'format', 'banned', 'restricted',
  'is', 'not', 'layout', 'year', 'lang',
]);

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
    if (term) terms.push(term);
    else words.push(body.replace(/"/g, ''));
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

function isFragment(value: string): Fragment | null {
  switch (value) {
    case 'owned':
      return { sql: `EXISTS (SELECT 1 FROM collection_items ci
                             JOIN card_printings cip ON cip.id = ci.printing_id
                             WHERE cip.oracle_id = o.oracle_id)`, params: [] };
    case 'commander':  return { sql: 'o.can_be_commander = 1', params: [] };
    case 'legendary':  return { sql: 'o.is_legendary = 1', params: [] };
    case 'reserved':   return { sql: 'o.is_reserved = 1', params: [] };
    case 'background': return { sql: 'o.can_be_background = 1', params: [] };
    case 'partner':    return { sql: 'o.can_be_partner = 1', params: [] };
    case 'land':       return { sql: `o.type_line LIKE '%Land%'`, params: [] };
    case 'creature':   return { sql: `o.type_line LIKE '%Creature%'`, params: [] };
    case 'digital':    return { sql: 'dp.is_digital = 1', params: [] };
    case 'paper':      return { sql: 'dp.is_digital = 0', params: [] };
    case 'permanent':
      return { sql: `NOT (o.type_line LIKE '%Instant%' OR o.type_line LIKE '%Sorcery%')`, params: [] };
    case 'spell':
      return { sql: `(o.type_line LIKE '%Instant%' OR o.type_line LIKE '%Sorcery%')`, params: [] };
    case 'dfc': case 'transform': case 'doublefaced':
      return { sql: `o.layout IN ('transform','modal_dfc','double_faced_token','reversible_card')`, params: [] };
    case 'split':      return { sql: `o.layout = 'split'`, params: [] };
    case 'colorless':  return { sql: 'o.colors_mask = 0', params: [] };
    case 'multicolor': case 'multicolour': case 'gold':
      return { sql: '(o.colors_mask & (o.colors_mask - 1)) <> 0', params: [] };
    case 'foil':
      return { sql: `EXISTS (SELECT 1 FROM card_printings fp WHERE fp.oracle_id = o.oracle_id
                             AND fp.finishes LIKE '%foil%')`, params: [] };
    default: return null;
  }
}

function clauseFor(term: Term): Fragment | null {
  const numeric = Number.parseFloat(term.value);

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
      const fragment = isFragment(term.value.toLowerCase());
      if (!fragment) return null;
      return term.key === 'not'
        ? { sql: `NOT (${fragment.sql})`, params: fragment.params }
        : fragment;
    }
    default:
      return null;
  }
}

export function compileQuery(text: string): CompiledQuery {
  const { terms, words } = parseQuery(text);
  const where: string[] = [];
  const params: (string | number)[] = [];

  for (const term of terms) {
    const fragment = clauseFor(term);
    if (!fragment) continue;
    where.push(term.negated ? `NOT (${fragment.sql})` : fragment.sql);
    params.push(...fragment.params);
  }

  const kept = words.filter((w) => w.length > 0);
  return {
    where,
    params,
    ftsMatch: kept.length > 0
      ? kept.map((w) => `"${w.replace(/"/g, '')}"`).join(' AND ')
      : null,
    freeText: kept.join(' '),
  };
}

/** True when the query explicitly asks about digital cards either way. */
export function mentionsDigital(text: string): boolean {
  return parseQuery(text).terms.some(
    (t) => (t.key === 'is' || t.key === 'not') &&
           (t.value.toLowerCase() === 'digital' || t.value.toLowerCase() === 'paper'),
  );
}
