import type {
  CardHolders, ContestedCard, DeckBuildability, WhatIfResult,
} from './api.ts';
import { money, percent } from './buildability.ts';

/**
 * How contention reads.
 *
 * Every number here arrives from the server's `decks/contention.ts`, which
 * read it from `buildability.ts` and `allocation.ts`. This file chooses
 * sentences; it computes no figure of its own.
 */

/**
 * `Deck A ×2 (home: Blue Tackle Box) · Binder 3 ×2, Blue Tackle Box ×2 · 2 available`
 *
 * The line CLAUDE.md asks for, in pieces the pane can lay out. Locations are
 * reported as they are, not as "available per location": a claim is a count,
 * not a lot, so which physical copy a deck "has" is not knowable until an
 * assembly run moves it — and a sentence that guessed would read as fact.
 */
export interface HoldersLine {
  /** `Deck A ×2 (home: Blue Tackle Box)` per deck, reserving decks first. */
  decks: string[];
  /** `Binder 3 ×2` per location, in shelf order. */
  locations: string[];
  /** `2 available`, `1 on a trade list`, or nothing when there is nothing to say. */
  figures: string[];
}

export function holdersLine(holders: CardHolders): HoldersLine | null {
  if (holders.owned === 0 && holders.decks.length === 0) return null;

  const decks = [...holders.decks]
    .sort((a, b) => Number(b.reserving) - Number(a.reserving) || b.quantity - a.quantity)
    .map((deck) => {
      const home = deck.homeLocationName ? ` (home: ${deck.homeLocationName})` : '';
      // A non-reserving deck's claim is inert — say so rather than list it as
      // though it were holding the card.
      const idle = deck.reserving ? '' : `, ${deck.status}`;
      return `${deck.deckName} ×${deck.quantity}${home}${idle}`;
    });

  const locations = holders.locations.map((location) => `${location.name} ×${location.quantity}`);

  const figures: string[] = [];
  if (holders.tracked) {
    figures.push(`${holders.available} available`);
    if (holders.tradeListed > 0) figures.push(`${holders.tradeListed} on a trade list`);
  } else {
    figures.push('basic land — outside allocation');
  }

  return { decks, locations, figures };
}

/** `owned 1 · wanted 3` — the row's one-line figure. */
export function contestedFigures(card: ContestedCard): string {
  const parts = [`owned ${card.owned}`];
  if (card.tradeListed > 0) parts.push(`${card.tradeListed} on a trade list`);
  parts.push(`wanted ${card.wanted}`);
  return parts.join(' · ');
}

/** What the row says is wrong, in the words a person would use. */
export function contestedReason(card: ContestedCard): string {
  if (card.overAllocated && card.shortDecks.length === card.holders.length
      && card.shortDecks.every((d) => card.holders.some((h) => h.deckId === d.deckId))) {
    // Every deck both holds and is short — the copy left after they claimed.
    return `Decks claim ${card.held} but you own ${card.owned - card.tradeListed}`
      + `${card.tradeListed > 0 ? ' that are not on a trade list' : ''}.`;
  }
  const holders = card.holders.map((h) => h.deckName);
  const short = card.shortDecks
    .filter((d) => !card.holders.some((h) => h.deckId === d.deckId))
    .map((d) => d.deckName);
  if (holders.length > 0 && short.length > 0) {
    return `${list(holders)} ${holders.length === 1 ? 'has' : 'have'} it; `
      + `${list(short)} ${short.length === 1 ? 'is' : 'are'} short.`;
  }
  return `${card.shortfall} short.`;
}

const list = (names: string[]): string =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * `Breaking up Mono-Red finishes Goblins and moves Slivers from 88% to 94%.`
 *
 * One sentence, because that is the question being asked. Decks that would
 * finish come first, then the ones that merely improve; nothing changing is
 * said in as many words rather than left as an empty list to misread.
 */
export function whatIfSentence(result: WhatIfResult): string {
  if (result.changed.length === 0) {
    return `Breaking up ${result.deckName} would free nothing another deck is waiting for.`;
  }
  const finishes = result.changed.filter((d) => d.after.missingCards === 0 && d.before.missingCards > 0);
  const improves = result.changed.filter((d) => !finishes.includes(d));

  const parts: string[] = [];
  if (finishes.length > 0) {
    parts.push(`finishes ${list(finishes.map((d) => d.deckName))}`);
  }
  for (const delta of improves) {
    const from = delta.before.buildablePct === null ? '—' : percent(delta.before.buildablePct);
    const to = delta.after.buildablePct === null ? '—' : percent(delta.after.buildablePct);
    parts.push(`moves ${delta.deckName} from ${from} to ${to}`);
  }
  return `Breaking up ${result.deckName} ${list(parts)}.`;
}

/** `96% · 2 missing · $8` before, and the same after — for the reassign confirmation. */
export function figuresLine(figures: DeckBuildability): string {
  if (figures.buildablePct === null) return 'empty';
  const parts = [percent(figures.buildablePct)];
  if (figures.missingCards > 0) {
    parts.push(`${figures.missingCards} missing`);
    parts.push(money(figures.costToCompleteUsd));
  } else {
    parts.push('complete');
  }
  return parts.join(' · ');
}

/**
 * The contested cards one deck is in — holding a copy another built deck is
 * short of, or short of one another built deck holds.
 *
 * The deck header's "1 contested" used to open every contested card in the
 * collection (~125 in the audit) with this deck's first. Selection only: the
 * set itself is the server's.
 */
export function cardsInScope(cards: ContestedCard[], deckId: number): ContestedCard[] {
  return cards.filter((card) =>
    card.holders.some((deck) => deck.deckId === deckId)
    || card.shortDecks.some((deck) => deck.deckId === deckId));
}
