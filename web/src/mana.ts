import { parseManaCost } from './playtest.ts';

/**
 * A mana cost you can read at a glance.
 *
 * `{3}{W}{W}` printed literally is four pairs of braces and five symbols to
 * decode, on every row of a list you are scanning rather than studying. The
 * two things worth seeing at that size are how much it costs and what colour
 * it is — so the cost becomes its mana value, and the colours become dots.
 *
 * One dot per coloured pip, not per colour: `{W}{W}` is a harder commitment
 * than `{1}{W}`, and collapsing them would hide the difference exactly where a
 * curve is being read.
 *
 * Nothing is thrown away. The exact printed cost rides along as the tooltip,
 * which is what makes the lossy cases safe — an `{X}` spell, a hybrid, or the
 * back half of a split card.
 */

/** WUBRG, or 'H' where a hybrid pip could be paid more than one way. */
export interface ManaDisplay {
  /** The mana value. Null when the card has no cost at all, such as a land. */
  value: string | null;
  /** One entry per coloured pip; a hybrid pip carries each colour it accepts. */
  dots: string[][];
  /** The cost exactly as printed, both faces included. */
  title: string | null;
}

const EMPTY: ManaDisplay = { value: null, dots: [], title: null };

export function manaDisplay(manaCost: string | null, cmc: number): ManaDisplay {
  if (!manaCost || manaCost.trim() === '') return EMPTY;

  // The front face only. A split or modal card prints both halves in one
  // string, but `cmc` is the front face's — parsing the whole thing would show
  // two blue dots against a value of three.
  const front = manaCost.split('//')[0];
  const { dots } = { dots: parseManaCost(front).symbols };

  return {
    // Printed as-is rather than rounded: `cmc` is a REAL, and the only cards
    // with a fractional one meant it.
    value: String(cmc),
    dots,
    title: manaCost,
  };
}

/** The class for one pip: a colour letter, or 'H' when it takes either. */
export function dotClass(colors: string[]): string {
  if (colors.length === 0) return 'C';
  return colors.length === 1 ? colors[0] : 'H';
}
