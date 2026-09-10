import type { CardSummary } from './api.ts';

/**
 * The owned / available badge on a search result.
 *
 * Three rules, all of them Phase 22's rather than this file's:
 *
 * A card outside allocation — a basic land while `allocation_ignores_basics`
 * is on — gets no badge at all. It has no reservation and no shortfall, so any
 * number here would be answering a question the app has decided not to ask, and
 * a blank badge beats a wrong one.
 *
 * When every copy is free, one number says everything. The split form only
 * appears when something has actually claimed a copy, which is exactly when it
 * is worth reading.
 *
 * And nothing is computed here. `availableQuantity` arrives from the server,
 * which got it from allocation.ts; the client subtracts nothing.
 */
export interface OwnedBadge {
  text: string;
  title: string;
}

export function ownedBadge(card: CardSummary): OwnedBadge | null {
  const owned = card.ownedQuantity ?? 0;
  if (owned <= 0) return null;
  if (card.allocationTracked === false) return null;

  const available = card.availableQuantity ?? owned;
  const copies = (n: number) => `${n} cop${n === 1 ? 'y' : 'ies'}`;

  if (available >= owned) {
    return { text: String(owned), title: `${copies(owned)}, all free` };
  }

  // Both numbers come from the server. The reason is assembled, not the
  // arithmetic — and it names only what actually applies, so a card held by a
  // deck does not also claim to be on a trade list.
  const reasons: string[] = [];
  const reserved = card.reservedQuantity ?? 0;
  const listed = card.tradeListedQuantity ?? 0;
  if (reserved > 0) reasons.push(`${reserved} in decks`);
  if (listed > 0) reasons.push(`${listed} on a trade list`);

  return {
    text: `${available}/${owned}`,
    title: reasons.length > 0
      ? `${available} of ${copies(owned)} free — ${reasons.join(', ')}`
      : `${available} of ${copies(owned)} free`,
  };
}

/** "In Atraxa, Rakdos" — the decks a card is already spoken for by. */
export function deckBadge(card: CardSummary): OwnedBadge | null {
  const count = card.deckCount ?? 0;
  if (count <= 0) return null;
  const names = card.deckNames ?? [];
  return {
    text: String(count),
    title: names.length > 0
      ? `In ${names.join(', ')}`
      : `In ${count} deck${count === 1 ? '' : 's'}`,
  };
}
