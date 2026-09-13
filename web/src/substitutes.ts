import {
  addDeckCard, removeDeckCard, updateDeckCard,
  type Board, type Deck, type SubstituteCandidate, type SubstitutesResult,
} from './api.ts';

/**
 * Accepting a substitute (Phase 27).
 *
 * There is no swap endpoint, on purpose. A substitution is an ordinary deck
 * edit — the card you are short of comes down by the copies you are short,
 * and the card you own goes in — made through the same two routes the ± and
 * the picker already use. Allocation follows because those routes reconcile.
 * What this module adds is the arithmetic of *which* slot moves by how much,
 * and the words the sheet uses, both kept out of the component so they can
 * be tested flat.
 */

export interface SwapStep {
  cardId: number;
  board: Board;
  from: number;
  /** The slot's new quantity; 0 removes it. */
  to: number;
}

export interface SwapPlan {
  steps: SwapStep[];
  /** Copies of the substitute to add, on the board the first affected slot was on. */
  add: { board: Board; quantity: number };
}

/**
 * How to take `missing` copies of a card out of a deck and put a substitute in.
 *
 * Only the copies the deck cannot field move: a 4-of you own 3 of comes down
 * to 3, not to 0, and one copy of the substitute goes in beside it. Slots on
 * the maybeboard are left alone — they were never short of anything — and so
 * is the command zone: a commander is the deck, and there is no standing in
 * for it. When
 * `missing` is unknown or not positive, the whole card is swapped, which is
 * the only sensible reading of "swap" for a card the deck has no figures for.
 * A card that is not in the deck at all (a want that the deck list has since
 * dropped) gets one copy of the substitute added to the main deck.
 */
export function swapPlan(
  deck: Deck,
  oracleId: string,
  missing: number | null | undefined,
  preferredBoard?: Board,
): SwapPlan {
  const slots = deck.cards
    .filter((card) => card.oracleId === oracleId && card.board !== 'maybe' && card.board !== 'command')
    .sort((a, b) => Number(b.board === preferredBoard) - Number(a.board === preferredBoard));

  const inDeck = slots.reduce((sum, slot) => sum + slot.quantity, 0);
  let remaining = missing != null && missing > 0 ? Math.min(missing, inDeck) : inDeck;

  const steps: SwapStep[] = [];
  for (const slot of slots) {
    if (remaining <= 0) break;
    const take = Math.min(slot.quantity, remaining);
    steps.push({ cardId: slot.id, board: slot.board, from: slot.quantity, to: slot.quantity - take });
    remaining -= take;
  }

  const taken = steps.reduce((sum, step) => sum + (step.from - step.to), 0);
  return {
    steps,
    add: {
      board: steps[0]?.board ?? preferredBoard ?? 'main',
      quantity: Math.max(1, taken),
    },
  };
}

/** Whether a card sits anywhere a substitute could go — not only in the
 *  command zone or on the maybeboard. */
export const hasSwappableSlot = (deck: Deck, oracleId: string): boolean =>
  deck.cards.some((card) =>
    card.oracleId === oracleId && card.board !== 'maybe' && card.board !== 'command');

/** Runs a plan through the ordinary card routes. Resolves to the deck as left. */
export async function performSwap(
  deckId: number,
  plan: SwapPlan,
  substituteOracleId: string,
  printingId: string | null = null,
): Promise<Deck> {
  for (const step of plan.steps) {
    if (step.to <= 0) await removeDeckCard(deckId, step.cardId);
    else await updateDeckCard(deckId, step.cardId, { quantity: step.to });
  }
  return addDeckCard(deckId, substituteOracleId, {
    board: plan.add.board, quantity: plan.add.quantity, printingId,
  });
}

// -- copy ------------------------------------------------------------------------

/**
 * The one quiet line at the top of the sheet about *how* the match was made.
 * Null when it was made the good way — on role, from the Tagger data — because
 * then there is nothing to warn about.
 */
export function sourceNotice(result: SubstitutesResult): string | null {
  switch (result.categorySource) {
    case 'tagger': return null;
    case 'heuristic': return 'Card roles are guessed from rules text — the tag sync has not run yet.';
    case null: return 'Matching on type and cost only.';
  }
}

/** The honest empty state. */
export function emptyNotice(result: SubstitutesResult): string {
  const role = result.target.categories[0]?.label.toLowerCase();
  if (result.poolSize === 0) {
    return result.context.deckId == null
      ? 'You own nothing free that could stand in.'
      : `You own nothing free that fits ${result.context.deckName ?? 'this deck'}.`;
  }
  return role
    ? `Nothing you own fills this role (${role}).`
    : `Nothing you own is another ${result.target.primaryType?.toLowerCase() ?? 'card'} like this.`;
}

/** The reason line as one string. Server words, client punctuation. */
export const reasonLine = (candidate: SubstituteCandidate) => candidate.reasons.join(' · ');

/** "3 free" / "1 free" — the availability badge. */
export const availableBadge = (candidate: SubstituteCandidate) =>
  `${candidate.available} free`;
