/**
 * The picker's card-type chips, as query text.
 *
 * The same idea as the scope chips in `searchScope.ts`: a chip writes a `t:`
 * term into the query box rather than setting a filter of its own, so what the
 * chip does is visible, editable, and parsed by the server like anything else
 * typed there — and so it can only narrow the deck's identity and legality
 * filters, never replace them.
 *
 * Single-select. The chips manage only the terms they would write themselves;
 * a hand-typed `t:legendary` or `type:artifact` is left alone and no chip
 * lights up for it, because the query box is the truth, not the chip row.
 */

export const PICKER_TYPES = [
  'creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker', 'land',
] as const;

export type PickerType = (typeof PICKER_TYPES)[number];

export const PICKER_TYPE_LABEL: Record<PickerType, string> = {
  creature: 'Creature',
  instant: 'Instant',
  sorcery: 'Sorcery',
  artifact: 'Artifact',
  enchantment: 'Enchantment',
  planeswalker: 'Planeswalker',
  land: 'Land',
};

const split = (query: string) => query.split(/\s+/).filter(Boolean);

/** The exact token a chip writes, so only a chip's own term is rewritten. */
const CHIP_TOKEN = /^(?:t|type):([a-z]+)$/i;

/** Which type chip the query currently reads as, if any. */
export function typeOf(query: string): PickerType | null {
  for (const token of split(query)) {
    const match = CHIP_TOKEN.exec(token);
    if (!match) continue;
    const type = match[1].toLowerCase();
    if ((PICKER_TYPES as readonly string[]).includes(type)) return type as PickerType;
  }
  return null;
}

const isChipToken = (token: string) => typeOf(token) !== null;

/**
 * The query with the chip's term swapped in — or, for `null`, taken out.
 *
 * The term goes after a leading scope term (`owned>=1`, which `withScope`
 * keeps first) and before anything typed, so both chip terms stay visible at
 * the head of a long query rather than scrolling out of the box.
 */
export function withType(query: string, type: PickerType | null): string {
  const kept = split(query).filter((token) => !isChipToken(token));
  if (type === null) return kept.join(' ');
  const scopeFirst = kept.length > 0 && /^(?:owned|available)(>=1)?$/i.test(kept[0]);
  const at = scopeFirst ? 1 : 0;
  return [...kept.slice(0, at), `t:${type}`, ...kept.slice(at)].join(' ');
}
