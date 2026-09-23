import { money as formatMoney } from './format.ts';
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
  return formatMoney(value, { wholeDollars: true });
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
      text: `${money(figures.costToCompleteUsd)}${unpriced} to finish`,
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

/** Rows worth showing in a "what is this deck missing" list, worst first. */
export function missingRows(rows: BuildabilityRow[]): BuildabilityRow[] {
  return rows.filter((row) => row.missing > 0);
}

/**
 * One missing card's story in want / free terms — `wants 1, 0 free — The
 * Swarmlord holds it`.
 *
 * Not "claims 1 … 0 are free", which is how the Legality section used to put
 * it: the claim is derived, so a deck short of a card claims none of it, and
 * the sentence contradicted the number it was about.
 */
export function shortfallLine(row: BuildabilityRow): string {
  const proxied = row.proxied > 0 ? `, ${row.proxied} proxied` : '';
  const head = `wants ${row.required}${proxied}, ${row.available} free`;

  const reasons: string[] = [];
  // "holds it" only when "it" can mean one thing: the single copy a
  // one-of deck wants.
  if (row.required === 1 && row.holdingDecks.length === 1 && row.holdingDecks[0].quantity === 1) {
    reasons.push(`${row.holdingDecks[0].deckName} holds it`);
  } else if (row.holdingDecks.length > 0) {
    reasons.push(row.holdingDecks.map((deck) => `${deck.deckName} holds ${deck.quantity}`).join(', '));
  }
  if (row.tradeListed > 0) reasons.push(`${row.tradeListed} on a trade list`);
  if (reasons.length === 0) reasons.push(row.owned === 0 ? 'you own none' : `you own ${row.owned}`);

  return `${head} — ${reasons.join(' · ')}`;
}

export type MissingGroupKey = 'buy' | 'held' | 'listed';

export interface MissingGroup {
  key: MissingGroupKey;
  title: string;
  rows: BuildabilityRow[];
}

const GROUP_TITLE: Record<MissingGroupKey, string> = {
  buy: 'Buy',
  held: 'Held by another deck — reassign or buy',
  listed: 'On a trade list — take it off, or buy',
};

/**
 * The missing rows, sorted by what you would do about each: buy it, win it back
 * from another deck, or take it off a trade list. A row lands under its first
 * applicable reason; its line says the rest. Every row in every group is part
 * of the one missing count and the one cost to finish — the groups divide the
 * list, they do not re-count it.
 */
export function missingGroups(rows: BuildabilityRow[]): MissingGroup[] {
  const groups: Record<MissingGroupKey, BuildabilityRow[]> = { buy: [], held: [], listed: [] };
  for (const row of missingRows(rows)) {
    const key: MissingGroupKey = row.holdingDecks.length > 0
      ? 'held'
      : row.tradeListed > 0 ? 'listed' : 'buy';
    groups[key].push(row);
  }
  return (['buy', 'held', 'listed'] as const)
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, title: GROUP_TITLE[key], rows: groups[key] }));
}
