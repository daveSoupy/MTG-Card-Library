import { COLORS, COLOR_NAMES, type Color } from '../model/mtg.ts';
import type { DeckCard } from './types.ts';

/**
 * Mana base analysis.
 *
 * The colour distribution in the stats panel answers "how many cards are
 * green". That is not the question a deck builder has, which is whether the
 * lands can actually cast the spells. This compares what the deck *demands*
 * (coloured pips in mana costs) against what it *supplies* (permanents that
 * produce that colour).
 */

export interface ColorRequirement {
  color: Color;
  colorName: string;
  /** Coloured mana symbols in costs, weighted by copies. */
  pips: number;
  /** Share of all coloured pips in the deck, 0..1. */
  pipShare: number;
  /** Cards producing this colour, weighted by copies. */
  sources: number;
  /** Share of all mana sources that produce this colour, 0..1. */
  sourceShare: number;
  /** True when supply lags demand by more than the tolerance below. */
  isShort: boolean;
}

export interface ManaBase {
  requirements: ColorRequirement[];
  totalPips: number;
  /** Cards that produce any mana at all, weighted by copies. */
  totalSources: number;
  landCount: number;
  /** Sources that are not lands — rocks, dorks, rituals. */
  nonLandSources: number;
  colorlessSources: number;
}

/**
 * How far a colour's share of sources may fall below its share of pips before
 * it is called short.
 *
 * Deliberately a plain, statable rule rather than an imitation of a
 * probability model: the panel tells the user exactly what it means, so a flag
 * is a prompt to look rather than an oracle to obey.
 */
const SHORTFALL_TOLERANCE = 0.1;

/** A colour needs a meaningful presence before a shortfall means anything. */
const MIN_PIPS_TO_FLAG = 3;

/**
 * Counts coloured pips in a mana cost.
 *
 * Hybrid symbols count for *both* halves, because either colour can pay them,
 * so both are genuinely wanted. Phyrexian ({W/P}) and monocoloured hybrid
 * ({2/W}) count for their one colour. Generic, {X} and {C} contribute nothing.
 */
export function countPips(manaCost: string | null | undefined): Partial<Record<Color, number>> {
  const pips: Partial<Record<Color, number>> = {};
  if (!manaCost) return pips;

  for (const match of manaCost.matchAll(/\{([^}]+)\}/g)) {
    const symbol = match[1].toUpperCase();
    // A symbol may hold several parts: W, W/U, 2/W, W/P.
    for (const part of symbol.split('/')) {
      if ((COLORS as readonly string[]).includes(part)) {
        const color = part as Color;
        pips[color] = (pips[color] ?? 0) + 1;
      }
    }
  }
  return pips;
}

const isLand = (card: DeckCard) => card.typeLine.toLowerCase().includes('land');

export function analyseManaBase(cards: DeckCard[]): ManaBase {
  // The maybeboard and sideboard are not what you draw from, so neither the
  // demand nor the supply side counts them.
  const counted = cards.filter((c) => c.board === 'main' || c.board === 'command');

  const pipTotals = new Map<Color, number>(COLORS.map((c) => [c, 0]));
  const sourceTotals = new Map<Color, number>(COLORS.map((c) => [c, 0]));
  let landCount = 0;
  let nonLandSources = 0;
  let colorlessSources = 0;
  let totalSourceCards = 0;

  for (const card of counted) {
    for (const [color, count] of Object.entries(countPips(card.manaCost))) {
      pipTotals.set(color as Color, (pipTotals.get(color as Color) ?? 0) + count * card.quantity);
    }

    const produced = card.producedMana ?? [];
    if (isLand(card)) landCount += card.quantity;

    if (produced.length === 0) continue;
    totalSourceCards += card.quantity;
    if (!isLand(card)) nonLandSources += card.quantity;

    let producesColor = false;
    for (const symbol of produced) {
      const color = symbol.toUpperCase();
      if ((COLORS as readonly string[]).includes(color)) {
        producesColor = true;
        sourceTotals.set(color as Color, (sourceTotals.get(color as Color) ?? 0) + card.quantity);
      }
    }
    if (!producesColor) colorlessSources += card.quantity;
  }

  const totalPips = [...pipTotals.values()].reduce((a, b) => a + b, 0);

  const requirements: ColorRequirement[] = COLORS
    .map((color) => {
      const pips = pipTotals.get(color) ?? 0;
      const sources = sourceTotals.get(color) ?? 0;
      const pipShare = totalPips > 0 ? pips / totalPips : 0;
      const sourceShare = totalSourceCards > 0 ? sources / totalSourceCards : 0;
      return {
        color,
        colorName: COLOR_NAMES[color],
        pips,
        pipShare,
        sources,
        sourceShare,
        // A colour with no sources at all is short whenever it has any pips.
        isShort: pips >= MIN_PIPS_TO_FLAG && sourceShare < pipShare - SHORTFALL_TOLERANCE,
      };
    })
    // Only colours the deck actually touches are worth showing.
    .filter((requirement) => requirement.pips > 0 || requirement.sources > 0);

  return {
    requirements,
    totalPips,
    totalSources: totalSourceCards,
    landCount,
    nonLandSources,
    colorlessSources,
  };
}
