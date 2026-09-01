/**
 * Magic primitives shared by the importer and the search layer.
 *
 * Colours are stored as a bitmask so the Commander colour-identity rule is a
 * single indexable SQL expression — `(color_identity_mask & ~?) = 0` — rather
 * than string matching per card.
 */

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export type Color = (typeof COLORS)[number];

/** WUBRG order, which is how Magic always writes colour combinations. */
const COLOR_BITS: Record<Color, number> = { W: 1, U: 2, B: 4, R: 8, G: 16 };

export const COLOR_NAMES: Record<Color, string> = {
  W: 'White',
  U: 'Blue',
  B: 'Black',
  R: 'Red',
  G: 'Green',
};

/** Guild and shard shorthand players actually type into a search box. */
const COLOR_ALIASES: Record<string, Color[]> = {
  c: [], colorless: [], colourless: [],
  white: ['W'], blue: ['U'], black: ['B'], red: ['R'], green: ['G'],
  azorius: ['W', 'U'], dimir: ['U', 'B'], rakdos: ['B', 'R'], gruul: ['R', 'G'],
  selesnya: ['G', 'W'], orzhov: ['W', 'B'], izzet: ['U', 'R'], golgari: ['B', 'G'],
  boros: ['R', 'W'], simic: ['G', 'U'],
  bant: ['G', 'W', 'U'], esper: ['W', 'U', 'B'], grixis: ['U', 'B', 'R'],
  jund: ['B', 'R', 'G'], naya: ['R', 'G', 'W'], abzan: ['W', 'B', 'G'],
  jeskai: ['U', 'R', 'W'], sultai: ['B', 'G', 'U'], mardu: ['R', 'W', 'B'],
  temur: ['G', 'U', 'R'],
  wubrg: ['W', 'U', 'B', 'R', 'G'], five: ['W', 'U', 'B', 'R', 'G'], '5c': ['W', 'U', 'B', 'R', 'G'],
};

export function colorMask(symbols: readonly string[]): number {
  let mask = 0;
  for (const symbol of symbols) {
    const bit = COLOR_BITS[symbol.toUpperCase() as Color];
    if (bit) mask |= bit;
  }
  return mask;
}

/** "WUB" display form, always in WUBRG order regardless of input order. */
export function canonicalColors(symbols: readonly string[]): string {
  const mask = colorMask(symbols);
  return COLORS.filter((c) => mask & COLOR_BITS[c]).join('');
}

export function colorsFromMask(mask: number): Color[] {
  return COLORS.filter((c) => mask & COLOR_BITS[c]);
}

/** The spellings that mean "no colour at all" rather than "no colours given". */
const COLORLESS_WORDS = new Set(['c', 'colorless', 'colourless']);

export const isColorlessSpec = (text: string): boolean =>
  COLORLESS_WORDS.has(text.toLowerCase().trim());

/** Parses "wu", "azorius" or "colorless" into a set of colours. */
export function parseColors(text: string): Color[] {
  const lower = text.toLowerCase().trim();
  const alias = COLOR_ALIASES[lower];
  if (alias) return alias;
  const found = new Set<Color>();
  for (const char of lower) {
    const upper = char.toUpperCase() as Color;
    if (COLOR_BITS[upper]) found.add(upper);
  }
  return COLORS.filter((c) => found.has(c));
}

/**
 * Precomposed letters that NFD will not decompose, so they would otherwise be
 * deleted outright by the punctuation strip. Current Scryfall names no longer
 * use \u00c6 \u2014 Wizards de-ligatured them \u2014 but old decklists pasted into import and
 * OCR of older printings still say "\u00c6ther Vial", and silently failing to match
 * those is worse than five lines of mapping.
 */
const LIGATURES: ReadonlyArray<[RegExp, string]> = [
  [/\u00e6/g, 'ae'], [/\u0153/g, 'oe'], [/\u00df/g, 'ss'],
  [/\u00f8/g, 'o'], [/\u0111/g, 'd'], [/\u00f0/g, 'd'], [/\u0142/g, 'l'], [/\u00fe/g, 'th'],
];

/**
 * Folds a card name into a matching form: lowercase, no accents, no
 * punctuation. Lets "Jötun Grunt", "jotun grunt" and "Jotun  Grunt" all resolve
 * to the same card during import, search and OCR.
 */
export function normalizeName(text: string): string {
  // Decompose, then strip the combining marks NFD leaves behind.
  let folded = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [pattern, replacement] of LIGATURES) folded = folded.replace(pattern, replacement);
  // Separators become spaces, but punctuation is *removed* rather than spaced:
  // "Jace's" has to fold to "jaces", not "jace s", or typing the name without
  // the apostrophe stops matching.
  const spaced = folded.replace(/[\s\-_]+/g, ' ');
  const cleaned = spaced.replace(/[^a-z0-9 ]/g, '');
  return cleaned.trim().replace(/\s+/g, ' ');
}

/**
 * Splits "100a" into { number: 100, suffix: "a" } so collector numbers sort the
 * way they sit in a binder rather than lexically, where "10" precedes "9".
 */
export function splitCollectorNumber(value: string): { number: number | null; suffix: string | null } {
  const match = /^(\D*)(\d+)(.*)$/.exec(value);
  if (!match) return { number: null, suffix: value || null };
  const [, prefix, digits, rest] = match;
  const suffix = `${prefix}${rest}`;
  return { number: Number.parseInt(digits, 10), suffix: suffix.length > 0 ? suffix : null };
}

/** Splits a mana cost like "{2}{W}{U}" into its symbols for display. */
export function manaSymbols(cost: string | null | undefined): string[] {
  if (!cost) return [];
  return [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

export const RARITIES = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'] as const;
export type Rarity = (typeof RARITIES)[number];

/** Single-letter rarity shorthand, as used in Scryfall queries. */
export function expandRarity(value: string): string {
  const lower = value.toLowerCase();
  switch (lower) {
    case 'c': return 'common';
    case 'u': return 'uncommon';
    case 'r': return 'rare';
    case 'm': return 'mythic';
    case 's': return 'special';
    default: return lower;
  }
}
