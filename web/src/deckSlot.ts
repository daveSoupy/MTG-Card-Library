import type { BuildabilityRow, DeckCard } from './api.ts';

/**
 * What a deck slot needs you to do about it.
 *
 * This used to be two chips side by side that meant opposite things. One read
 * `${quantityFromCollection} owned` — the deck's *claim* on the collection,
 * labelled as if it were ownership, so a slot could say "1 owned" in green for
 * a card you owned none of. The other read `need 1`, the computed truth. Two
 * numbers, no labels, and only one of them honest.
 *
 * The claim is not shown any more, and is not the user's to set: the server
 * derives it (`server/src/decks/reconcile.ts`). What is left is the only
 * question the row was ever really asking — buy it, or is it already yours?
 *
 * Every figure comes from Phase 24's `BuildabilityRow`, which the server
 * computed from `allocation.ts`. Nothing here subtracts anything.
 */

export interface SlotAction {
  /** The chip's text. Short enough to sit in a dense row. */
  label: string;
  title: string;
  /**
   * `have` when the deck can field this card, `buy` when it cannot, and `held`
   * when the copies exist but another built deck has them — the one case where
   * there is a decision rather than a purchase.
   */
  kind: 'have' | 'buy' | 'held' | 'untracked';
}

const copies = (n: number) => `${n} cop${n === 1 ? 'y' : 'ies'}`;

/**
 * Whether the chip can open Phase 27's substitutes sheet. Exactly the two
 * cases where the deck cannot field the card: buy it, or another deck has it.
 * A card you have needs no stand-in, and a basic is outside all of this.
 */
export const canSwap = (action: SlotAction | null): boolean =>
  action !== null && (action.kind === 'buy' || action.kind === 'held');

/** The chip's tooltip once it is also a button. */
export const swapTitle = (action: SlotAction): string =>
  `${action.title} Click to swap for something you own.`;

/**
 * Null while the deck's figures are still loading, so the cell is briefly
 * blank rather than briefly wrong.
 */
export function slotAction(card: DeckCard, coverage?: BuildabilityRow | null): SlotAction | null {
  if (!card.allocationTracked) {
    return {
      label: 'basic',
      kind: 'untracked',
      title: 'Basic lands are not tracked against your collection — grab as many as you need.',
    };
  }
  if (!coverage) return null;

  const { required, covered, missing, owned, tradeListed, proxied, holdingDecks } = coverage;

  if (missing <= 0) {
    const how = proxied > 0 && proxied >= required
      ? 'Proxied.'
      : `You own ${copies(owned)}${proxied > 0 ? `, and ${proxied} are proxied` : ''}.`;
    return {
      label: required > 1 ? `Have all ${required}` : 'Have it',
      kind: 'have',
      title: `${how} Nothing to buy.`,
    };
  }

  // Said first, because it is the only one of these that is a decision rather
  // than a purchase: the cards exist, they are just in another deck.
  const holder = holdingDecks[0];
  if (holder) {
    const who = holdingDecks
      .map((deck) => `${deck.deckName} has ${deck.quantity}`)
      .join(', ');
    return {
      label: `${holder.deckName} has ${holder.quantity}`,
      kind: 'held',
      title: `You own ${copies(owned)}, but ${who}. `
        + `Take ${missing === 1 ? 'it' : 'them'} back, or buy ${missing}.`,
    };
  }

  const reasons: string[] = [];
  if (owned > 0) reasons.push(`You own ${copies(owned)}`);
  if (tradeListed > 0) reasons.push(`${tradeListed} promised on a trade list`);
  if (proxied > 0) reasons.push(`${proxied} proxied`);

  return {
    label: covered > 0 ? `Need ${missing} of ${required}` : `Need ${missing}`,
    kind: 'buy',
    title: reasons.length > 0
      ? `${reasons.join(' · ')}. Still short ${missing}.`
      : `You do not own this one. Short ${missing}.`,
  };
}
