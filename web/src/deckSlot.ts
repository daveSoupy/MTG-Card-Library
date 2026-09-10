import type { DeckCard } from './api.ts';

/**
 * How one deck slot reads: what it draws from, and — when it cannot draw from
 * anything — why not.
 *
 * "0 available" is the least useful thing an app can say about a card you own.
 * The server sends owned, available and trade-listed alongside each other
 * precisely so the difference between "another deck has it", "it is promised to
 * someone", and "you never had one" can be stated rather than left to guess.
 *
 * All four numbers come from the server's `decks/allocation.ts`. Nothing here
 * recomputes availability — this only chooses the words.
 */

export interface OwnedChip {
  /** Copies this slot claims from the collection. */
  claimed: number;
  /** Copies still to buy, once owned copies and proxies are accounted for. */
  toBuy: number;
  label: string;
  title: string;
  /** The slot claims more than is free — flagged, never blocked. */
  short: boolean;
}

export function ownedChip(card: DeckCard): OwnedChip {
  const claimed = card.quantityFromCollection;
  const toBuy = card.allocationTracked
    ? Math.max(0, card.quantity - claimed - card.quantityProxied)
    : 0;
  const short = card.allocationTracked && claimed > card.availableQuantity;

  return {
    claimed,
    toBuy,
    label: claimed > 0 ? `${claimed} owned` : toBuy > 0 ? 'to buy' : 'covered',
    short,
    title: reason(card, claimed),
  };
}

function reason(card: DeckCard, claimed: number): string {
  if (!card.allocationTracked) {
    return 'Basic lands are not tracked against your collection — grab as many as you need.';
  }
  if (card.ownedQuantity === 0) {
    return 'You do not own this card yet — counted as "need to buy".';
  }

  const parts = [`You own ${card.ownedQuantity}`];
  // The two reasons a card you own can still read as unavailable. Said out
  // loud, because "0 free" on a card sitting in your binder looks like a bug.
  if (card.tradeListedQuantity > 0) {
    parts.push(`${card.tradeListedQuantity} on a trade list`);
  }
  parts.push(`${card.availableQuantity} free for this deck`);
  if (claimed > card.availableQuantity) {
    parts.push('other decks are using the rest');
  }
  return `${parts.join(' · ')}.`;
}
