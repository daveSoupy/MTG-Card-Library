import { COLORS, type Color } from '../model/mtg.ts';
import { analyseManaBase } from './manabase.ts';
import type { DeckCard, FormatRules } from './types.ts';

/**
 * Recommending a basic-land base.
 *
 * The mana-base panel says whether the lands can cast the spells; this decides
 * what to *add* so they can. It reuses the same coloured-pip counting, splits a
 * budget of basics across colours by how much each colour is wanted, and counts
 * the lands already in the deck so a hand-placed shockland means one fewer basic.
 *
 * Kept pure and DB-free so the awkward parts — rounding a budget across five
 * colours, the colourless-only deck — are testable without a database. The store
 * resolves the actual basic-land cards and applies the plan.
 */

/** A basic land available to add, with the colour it makes. */
export interface BasicLand {
  /** 'C' is Wastes. */
  color: Color | 'C';
  oracleId: string;
}

/** How many of one basic the deck should hold. */
export interface BasicTarget {
  color: Color | 'C';
  oracleId: string;
  /** Absolute desired count of this basic in the mainboard. */
  desired: number;
}

const isLand = (card: DeckCard) => card.typeLine.toLowerCase().includes('land');
const counted = (cards: DeckCard[]) =>
  cards.filter((c) => c.board === 'main' || c.board === 'command');

/**
 * A sensible total land count for the format.
 *
 * The rules of thumb: ~24 lands in a 60-card deck, ~17 in 40-card limited, ~37
 * in a 100-card singleton deck. Expressed as a ratio off the format's own deck
 * size (singleton decks run slightly leaner), clamped to the deck size. A
 * starting point the user can add to or trim — not a hard rule, hence tunable.
 */
export function recommendedLandTotal(rules: FormatRules | null, cards: DeckCard[]): number {
  const declared = rules?.exactDeckSize ?? rules?.minDeckSize ?? null;
  const size = declared ?? counted(cards).reduce((n, c) => n + c.quantity, 0);
  if (size <= 0) return 0;
  const ratio = rules?.exactDeckSize ? 0.37 : 0.4;
  return Math.min(size, Math.round(size * ratio));
}

/**
 * Distributes `budget` whole items across weighted keys by the largest-remainder
 * method, so the parts sum to exactly `budget` and the rounding lands where it
 * is least unfair. Zero or negative weights get nothing.
 */
function allocate<K>(budget: number, weights: Array<{ key: K; weight: number }>): Map<K, number> {
  const result = new Map<K, number>();
  const total = weights.reduce((sum, w) => sum + Math.max(0, w.weight), 0);
  if (budget <= 0 || total <= 0) return result;

  const shares = weights
    .filter((w) => w.weight > 0)
    .map((w) => {
      const exact = (budget * w.weight) / total;
      const floor = Math.floor(exact);
      return { key: w.key, floor, remainder: exact - floor };
    });

  let assigned = 0;
  for (const share of shares) { result.set(share.key, share.floor); assigned += share.floor; }

  let leftover = budget - assigned;
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    if (leftover <= 0) break;
    result.set(share.key, (result.get(share.key) ?? 0) + 1);
    leftover -= 1;
  }
  return result;
}

/**
 * The basics the deck should hold to reach the recommended land count.
 *
 * The budget is the recommended total minus the non-basic lands already in the
 * deck — so adding a shockland shrinks it. It is split across colours by their
 * share of coloured pips; a deck with no coloured pips at all gets Wastes. Every
 * available basic appears in the result, `desired` 0 where it is not wanted, so
 * the caller can both add and (for live maintenance) trim.
 */
export function planBasics(
  cards: DeckCard[],
  rules: FormatRules | null,
  basics: BasicLand[],
): BasicTarget[] {
  const target = recommendedLandTotal(rules, cards);
  const inDeck = counted(cards);

  const nonBasicLands = inDeck
    .filter((c) => isLand(c) && !c.isBasicLand)
    .reduce((n, c) => n + c.quantity, 0);

  const budget = Math.max(0, target - nonBasicLands);

  const byColor = new Map<Color | 'C', string>();
  for (const basic of basics) if (!byColor.has(basic.color)) byColor.set(basic.color, basic.oracleId);

  const mana = analyseManaBase(cards);
  const pipWeights = COLORS
    .filter((color) => byColor.has(color))
    .map((color) => ({
      key: color as Color | 'C',
      weight: mana.requirements.find((r) => r.color === color)?.pips ?? 0,
    }));
  const totalPipWeight = pipWeights.reduce((sum, w) => sum + w.weight, 0);

  // No coloured pips anywhere — a colourless deck — so the budget is Wastes if
  // there is a Wastes to add, otherwise nothing.
  const allocation = totalPipWeight > 0
    ? allocate(budget, pipWeights)
    : byColor.has('C')
      ? new Map<Color | 'C', number>([['C', budget]])
      : new Map<Color | 'C', number>();

  const result: BasicTarget[] = [];
  for (const [color, oracleId] of byColor) {
    result.push({ color, oracleId, desired: allocation.get(color) ?? 0 });
  }
  return result;
}
