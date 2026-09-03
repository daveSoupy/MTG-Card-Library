import type { DeckCard } from './api.ts';

/**
 * Opening hands and goldfishing, for sanity-checking a curve and a mana base.
 *
 * Still not a rules engine — no stack, no combat, no abilities, no opponent.
 * It answers two questions the curve and mana base panels cannot: "do I keep
 * drawing three-land no-spell hands", and "can I actually cast my things on
 * time". Everything here is pure so the awkward parts — mulligans, paying a
 * hybrid cost — are testable without a browser.
 */

export interface DrawnCard {
  oracleId: string;
  name: string;
  manaCost: string | null;
  cmc: number;
  typeLine: string;
  printingId: string | null;
  imageSmall: string | null;
  /** Colours this permanent can tap for, from Scryfall's produced_mana. */
  producedMana: string[];
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
        producedMana: card.producedMana ?? [],
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

/**
 * Puts a card from the hand on the bottom of the library.
 *
 * Generic over the state so it works on a game in progress as well as an
 * opening hand, without discarding the board.
 */
export function bottomCard<T extends HandState>(state: T, index: number): T {
  if (index < 0 || index >= state.hand.length) return state;
  const card = state.hand[index];
  return {
    ...state,
    hand: state.hand.filter((_, i) => i !== index),
    library: [...state.library, card],
  };
}

export function drawCard<T extends HandState>(state: T): T {
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


// -- goldfishing ---------------------------------------------------------------

export interface GameState extends HandState {
  turn: number;
  battlefield: DrawnCard[];
  /** Indices into `battlefield` whose mana has been spent this turn. */
  tapped: number[];
  landPlayedThisTurn: boolean;
}

export function startGame(state: HandState): GameState {
  return { ...state, turn: 1, battlefield: [], tapped: [], landPlayedThisTurn: false };
}

export const isLandCard = (card: DrawnCard) => card.typeLine.toLowerCase().includes('land');

/** A permanent that taps for mana — lands, but also rocks and dorks. */
export const producesMana = (card: DrawnCard) =>
  card.producedMana.length > 0 || isLandCard(card);

/**
 * Untaps, advances the turn and draws.
 *
 * Always draws, including on turn one: goldfishing is about whether the deck
 * functions, not about simulating the play/draw coin flip.
 */
export function nextTurn(state: GameState): GameState {
  const drawn = drawCard(state);
  return {
    ...state,
    hand: drawn.hand,
    library: drawn.library,
    turn: state.turn + 1,
    tapped: [],
    landPlayedThisTurn: false,
  };
}

export function playLand(state: GameState, handIndex: number): GameState {
  const card = state.hand[handIndex];
  if (!card || !isLandCard(card) || state.landPlayedThisTurn) return state;
  return {
    ...state,
    hand: state.hand.filter((_, i) => i !== handIndex),
    battlefield: [...state.battlefield, card],
    landPlayedThisTurn: true,
  };
}

/** What each untapped permanent could produce, as a list of colour sets. */
function availableSources(state: GameState): Array<{ index: number; colors: string[] }> {
  const tapped = new Set(state.tapped);
  return state.battlefield
    .map((card, index) => ({ index, colors: card.producedMana }))
    .filter(({ index }) => !tapped.has(index) && producesMana(state.battlefield[index]));
}

export interface ManaCost {
  generic: number;
  /** One entry per coloured symbol, listing the colours that can pay it. */
  symbols: string[][];
}

/**
 * Reads a mana cost into something payable.
 *
 * Hybrid `{U/R}` is one symbol payable by either colour. `{2/W}` and Phyrexian
 * `{W/P}` are simplified to their coloured half — treating them as always
 * payable would make the goldfish more optimistic than the real deck. `{X}`
 * counts as zero, since there is no opponent to aim it at.
 */
export function parseManaCost(cost: string | null): ManaCost {
  const result: ManaCost = { generic: 0, symbols: [] };
  if (!cost) return result;

  for (const [, body] of cost.matchAll(/\{([^}]+)\}/g)) {
    const upper = body.toUpperCase();
    if (/^\d+$/.test(upper)) { result.generic += Number.parseInt(upper, 10); continue; }
    if (upper === 'X' || upper === 'Y' || upper === 'Z') continue;
    if (upper === 'C') { result.generic += 1; continue; }

    const parts = upper.split('/').filter((p) => p !== 'P');
    const colors = parts.filter((p) => 'WUBRG'.includes(p));
    if (colors.length > 0) result.symbols.push(colors);
    else result.generic += 1;
  }
  return result;
}

/**
 * Can these sources pay this cost?
 *
 * Coloured symbols are matched to sources properly rather than greedily: two
 * green pips and one dual that makes green is not payable, and a greedy pass
 * that spent the dual on the first pip would wrongly say it is. This is Kuhn's
 * algorithm, which is small enough to be worth it for an answer that is right.
 *
 * Returns the source indices to tap, or null when the cost cannot be paid.
 */
export function payFor(cost: ManaCost, sources: Array<{ index: number; colors: string[] }>): number[] | null {
  const matchOf = new Array<number>(sources.length).fill(-1);   // source -> symbol

  const assign = (symbol: number, seen: Set<number>): boolean => {
    for (let s = 0; s < sources.length; s += 1) {
      if (seen.has(s)) continue;
      const canPay = cost.symbols[symbol].some((color) => sources[s].colors.includes(color));
      if (!canPay) continue;
      seen.add(s);
      if (matchOf[s] === -1 || assign(matchOf[s], seen)) { matchOf[s] = symbol; return true; }
    }
    return false;
  };

  for (let symbol = 0; symbol < cost.symbols.length; symbol += 1) {
    if (!assign(symbol, new Set())) return null;
  }

  const used = matchOf.map((symbol, s) => (symbol === -1 ? -1 : s)).filter((s) => s !== -1);
  const spare = sources.filter((_, s) => matchOf[s] === -1);
  if (spare.length < cost.generic) return null;

  return [
    ...used.map((s) => sources[s].index),
    ...spare.slice(0, cost.generic).map((s) => s.index),
  ];
}

export function canCast(state: GameState, handIndex: number): boolean {
  const card = state.hand[handIndex];
  if (!card || isLandCard(card)) return false;
  return payFor(parseManaCost(card.manaCost), availableSources(state)) !== null;
}

/** Casts a card, tapping what it costs. Lands are played, not cast. */
export function castCard(state: GameState, handIndex: number): GameState {
  const card = state.hand[handIndex];
  if (!card || isLandCard(card)) return state;

  const payment = payFor(parseManaCost(card.manaCost), availableSources(state));
  if (!payment) return state;

  return {
    ...state,
    hand: state.hand.filter((_, i) => i !== handIndex),
    // Instants and sorceries would go to a graveyard; there is no graveyard, and
    // for a goldfish "it resolved" is the whole of the information.
    battlefield: [...state.battlefield, card],
    tapped: [...state.tapped, ...payment],
  };
}

export interface ManaSummary {
  total: number;
  available: number;
  colors: string[];
}

export function summarizeMana(state: GameState): ManaSummary {
  const tapped = new Set(state.tapped);
  const producers = state.battlefield
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => producesMana(card));
  const untapped = producers.filter(({ index }) => !tapped.has(index));

  return {
    total: producers.length,
    available: untapped.length,
    colors: [...new Set(untapped.flatMap(({ card }) => card.producedMana))].sort(),
  };
}
