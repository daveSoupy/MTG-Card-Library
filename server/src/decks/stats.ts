import { COLORS, COLOR_NAMES, colorsFromMask } from '../model/mtg.ts';
import type { DeckCard, DeckStats, ManaCurveBucket } from './types.ts';

/** Curve buckets top out at 7, since 7+ drops are all "expensive" in practice. */
const MAX_CURVE_BUCKET = 7;

/** The card types worth breaking out, in the order players read a decklist. */
const TYPE_ORDER = [
  'Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment',
  'Planeswalker', 'Battle', 'Land',
] as const;

export function deckStats(cards: DeckCard[]): DeckStats {
  // The maybeboard is a scratch pad and is left out of every figure.
  const counted = cards.filter((c) => c.board !== 'maybe');
  const main = counted.filter((c) => c.board === 'main');
  const side = counted.filter((c) => c.board === 'side');
  const command = counted.filter((c) => c.board === 'command');
  const sum = (list: DeckCard[]) => list.reduce((total, c) => total + c.quantity, 0);

  return {
    totalCards: sum(counted),
    mainCount: sum(main),
    sideboardCount: sum(side),
    commandCount: sum(command),
    uniqueCards: new Set(counted.map((c) => c.oracleId)).size,
    averageManaValue: averageManaValue(counted),
    manaCurve: manaCurve(counted),
    colorDistribution: colorDistribution(counted),
    colorIdentity: deckColorIdentity(counted),
    typeDistribution: typeDistribution(counted),
    estimatedValueUsd: estimatedValue(counted),
    ownedCount: counted.reduce((total, c) => total + c.quantityFromCollection, 0),
    needToBuyCount: counted.reduce((total, c) => total + (c.quantity - c.quantityFromCollection), 0),
  };
}

const isLand = (card: DeckCard) => card.typeLine.toLowerCase().includes('land');

/**
 * Lands are excluded, which is the convention when players quote a deck's
 * average mana value — including 24 zero-cost lands would drag it meaningless.
 */
function averageManaValue(cards: DeckCard[]): number | null {
  const spells = cards.filter((c) => !isLand(c));
  const quantity = spells.reduce((total, c) => total + c.quantity, 0);
  if (quantity === 0) return null;
  const totalMana = spells.reduce((total, c) => total + c.cmc * c.quantity, 0);
  return Math.round((totalMana / quantity) * 100) / 100;
}

/** Counts by mana value, so the UI can draw bars rather than one average. */
function manaCurve(cards: DeckCard[]): ManaCurveBucket[] {
  const buckets = new Map<number, number>();
  for (let i = 0; i <= MAX_CURVE_BUCKET; i += 1) buckets.set(i, 0);

  for (const card of cards) {
    if (isLand(card)) continue;   // lands have no curve position
    const bucket = Math.min(Math.floor(card.cmc), MAX_CURVE_BUCKET);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + card.quantity);
  }

  return [...buckets.entries()].map(([cmc, count]) => ({
    cmc,
    label: cmc === MAX_CURVE_BUCKET ? `${MAX_CURVE_BUCKET}+` : String(cmc),
    count,
  }));
}

/**
 * How many cards contribute each colour. A two-colour card counts once in each,
 * so these deliberately sum to more than the deck size.
 */
function colorDistribution(cards: DeckCard[]): Array<{ color: string; count: number }> {
  const totals = new Map<string, number>(COLORS.map((c) => [c, 0]));
  let colorless = 0;

  for (const card of cards) {
    const colors = colorsFromMask(card.colorIdentityMask);
    if (colors.length === 0) {
      colorless += card.quantity;
      continue;
    }
    for (const color of colors) {
      totals.set(color, (totals.get(color) ?? 0) + card.quantity);
    }
  }

  const distribution = COLORS
    .map((color) => ({ color: COLOR_NAMES[color], count: totals.get(color) ?? 0 }))
    .filter((entry) => entry.count > 0);

  if (colorless > 0) distribution.push({ color: 'Colourless', count: colorless });
  return distribution;
}

/** The union of every card's colour identity — what a commander must cover. */
function deckColorIdentity(cards: DeckCard[]): string {
  const mask = cards.reduce((combined, card) => combined | card.colorIdentityMask, 0);
  return colorsFromMask(mask).join('');
}

function typeDistribution(cards: DeckCard[]): Array<{ type: string; count: number }> {
  const totals = new Map<string, number>();

  for (const card of cards) {
    // Take the first matching type so a "Artifact Creature" lands under
    // Creature, which is how a decklist is normally grouped.
    const type = TYPE_ORDER.find((candidate) => card.typeLine.includes(candidate)) ?? 'Other';
    totals.set(type, (totals.get(type) ?? 0) + card.quantity);
  }

  return [...TYPE_ORDER, 'Other']
    .filter((type) => totals.has(type))
    .map((type) => ({ type, count: totals.get(type)! }));
}

function estimatedValue(cards: DeckCard[]): number | null {
  let total = 0;
  let priced = false;
  for (const card of cards) {
    if (card.priceUsd == null) continue;
    priced = true;
    total += card.priceUsd * card.quantity;
  }
  return priced ? Math.round(total * 100) / 100 : null;
}
