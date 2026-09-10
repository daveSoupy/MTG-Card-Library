import type { BuildabilityRow, DeckBuildability } from './api.ts';

/**
 * How buildability reads.
 *
 * Every number here arrives from the server's `decks/buildability.ts`, which
 * got its availability from `decks/allocation.ts`. This file chooses words and
 * widths; it derives no figure. A percentage the client worked out for itself
 * is a percentage that can disagree with the deck it describes.
 */

/** `$23`, or `$23.50` when the cents matter. Whole dollars lose the `.00`. */
export function money(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

export function percent(fraction: number): string {
  // Rounded toward the honest end: 99.6% of a deck is not a finished deck, and
  // a row reading 100% that you cannot actually build is the whole failure this
  // phase exists to prevent.
  if (fraction >= 1) return '100%';
  return `${Math.min(99, Math.floor(fraction * 100))}%`;
}

export interface SummarySegment {
  key: 'buildable' | 'missing' | 'cost' | 'contested';
  text: string;
  title: string;
  /** Whether tapping it should go somewhere. */
  actionable: boolean;
}

/**
 * The deck-header strip — `94% • 6 missing • $23 • 2 contested`.
 *
 * Segments only appear when they have something to say: a deck with nothing
 * missing shows a percentage and stops, rather than padding the strip with
 * three zeroes.
 */
export function summarySegments(figures: DeckBuildability): SummarySegment[] {
  if (figures.buildablePct === null) {
    return [{
      key: 'buildable',
      text: 'Empty',
      title: 'No cards in this deck yet — nothing to count.',
      actionable: false,
    }];
  }

  const segments: SummarySegment[] = [{
    key: 'buildable',
    text: percent(figures.buildablePct),
    title: `${figures.coveredCards} of ${figures.requiredCards} cards covered by copies `
      + 'you own or have proxied.',
    actionable: false,
  }];

  if (figures.missingCards > 0) {
    segments.push({
      key: 'missing',
      text: `${figures.missingCards} missing`,
      title: 'Copies your collection cannot supply. Tap for the list.',
      actionable: true,
    });

    // The cost and the unpriced count travel together, always. Reporting the
    // total alone would quietly round every unknown price to zero, which is how
    // a deck that reads "$0 to finish" costs $80.
    const unpriced = figures.unpricedCount > 0
      ? ` + ${figures.unpricedCount} unpriced`
      : '';
    segments.push({
      key: 'cost',
      text: `${money(figures.costToCompleteUsd)}${unpriced}`,
      title: figures.unpricedCount > 0
        ? `About ${money(figures.costToCompleteUsd)} to finish, plus ${figures.unpricedCount} `
          + 'card(s) with no price — the real total is higher.'
        : `About ${money(figures.costToCompleteUsd)} to finish.`,
      actionable: true,
    });
  }

  if (figures.contestedCount > 0) {
    segments.push({
      key: 'contested',
      text: `${figures.contestedCount} contested`,
      title: 'Cards another built deck is holding copies of. Tap to see who.',
      actionable: true,
    });
  }

  return segments;
}

export interface CoverageChip {
  text: string;
  title: string;
}

/**
 * The chip on a deck slot — but only when the slot is actually short.
 *
 * A covered slot gets nothing: the row already carries the allocation control,
 * and a chip that says "fine" on every line is a chip nobody reads. When it does
 * appear it says where the rest live, because "0 available" on a card sitting in
 * your binder looks like a bug until something names the deck holding it.
 */
export function coverageChip(row: BuildabilityRow): CoverageChip | null {
  if (row.missing <= 0) return null;

  const text = row.covered > 0 ? `${row.covered}/${row.required}` : `need ${row.missing}`;

  const parts: string[] = [];
  if (row.owned > 0) {
    parts.push(`You own ${row.owned}`);
    if (row.tradeListed > 0) parts.push(`${row.tradeListed} on a trade list`);
    parts.push(`${row.available} free for this deck`);
  } else {
    parts.push('You do not own this one');
  }
  if (row.proxied > 0) parts.push(`${row.proxied} proxied`);

  const holders = row.holdingDecks
    .map((deck) => `${deck.deckName} x${deck.quantity}`)
    .join(', ');
  const where = holders ? ` Held by ${holders}.` : '';

  return { text, title: `${parts.join(' · ')}. Short ${row.missing}.${where}` };
}

/** Rows worth showing in a "what is this deck missing" list, worst first. */
export function missingRows(rows: BuildabilityRow[]): BuildabilityRow[] {
  return rows.filter((row) => row.missing > 0);
}
