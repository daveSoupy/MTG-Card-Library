import type { DeckCard } from './api.ts';

/**
 * Opening hands, for sanity-checking a curve and a mana base.
 *
 * Not a game engine: no casting, no stack, no board. The question this answers
 * is "do I keep drawing three-land no-spell hands", which is exactly what the
 * curve and mana base panels cannot tell you on their own.
 */

export interface DrawnCard {
  oracleId: string;
  name: string;
  manaCost: string | null;
  cmc: number;
  typeLine: string;
  printingId: string | null;
  imageSmall: string | null;
}

export interface HandState {
  hand: DrawnCard[];
  library: DrawnCard[];
  /** How many mulligans have been taken; London puts this many on the bottom. */
  mulligans: number;
  deckSize: number;
}

const OPENING_HAND = 7;

/** Expands a decklist into one entry per physical copy. */
export function buildLibrary(cards: DeckCard[]): DrawnCard[] {
  const library: DrawnCard[] = [];
  for (const card of cards) {
    // You draw from the deck, not the sideboard, maybeboard or command zone.
    if (card.board !== 'main') continue;
    for (let copy = 0; copy < card.quantity; copy += 1) {
      library.push({
        oracleId: card.oracleId,
        name: card.name,
        manaCost: card.manaCost,
        cmc: card.cmc,
        typeLine: card.typeLine,
        printingId: card.printingId,
        imageSmall: card.imageSmall,
      });
    }
  }
  return library;
}

/**
 * Fisher-Yates, which is the shuffle that actually produces a uniform
 * permutation — `sort(() => Math.random() - 0.5)` does not, and biases the
 * result toward the original order.
 */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function openingHand(cards: DeckCard[], random?: () => number): HandState {
  const library = shuffle(buildLibrary(cards), random);
  return {
    hand: library.slice(0, OPENING_HAND),
    library: library.slice(OPENING_HAND),
    mulligans: 0,
    deckSize: library.length,
  };
}

/**
 * London mulligan: always draw a fresh seven, then put N cards on the bottom,
 * where N is the number of mulligans taken. The choice of which to bottom is
 * the player's, so this hands back all seven and reports how many must go.
 */
export function mulligan(cards: DeckCard[], previous: HandState, random?: () => number): HandState {
  const next = openingHand(cards, random);
  return { ...next, mulligans: previous.mulligans + 1 };
}

/** Puts a card from the hand on the bottom of the library. */
export function bottomCard(state: HandState, index: number): HandState {
  if (index < 0 || index >= state.hand.length) return state;
  const card = state.hand[index];
  return {
    ...state,
    hand: state.hand.filter((_, i) => i !== index),
    library: [...state.library, card],
  };
}

export function drawCard(state: HandState): HandState {
  if (state.library.length === 0) return state;
  const [next, ...rest] = state.library;
  return { ...state, hand: [...state.hand, next], library: rest };
}

/** How many cards still have to be bottomed for the current mulligan count. */
export const cardsToBottom = (state: HandState): number =>
  Math.max(0, state.hand.length - (OPENING_HAND - state.mulligans));

const isLand = (card: DrawnCard) => card.typeLine.toLowerCase().includes('land');

export interface HandSummary {
  lands: number;
  spells: number;
  averageManaValue: number | null;
}

export function summarizeHand(hand: DrawnCard[]): HandSummary {
  const lands = hand.filter(isLand).length;
  const spells = hand.filter((c) => !isLand(c));
  return {
    lands,
    spells: spells.length,
    averageManaValue: spells.length === 0
      ? null
      : Math.round((spells.reduce((total, c) => total + c.cmc, 0) / spells.length) * 100) / 100,
  };
}
