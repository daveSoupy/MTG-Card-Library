import type { AssemblyCompletion, AssemblySheet, AssemblyRun, SheetLine } from './api.ts';
import { money } from './buildability.ts';

/**
 * How a pull sheet reads.
 *
 * Every figure arrives from the server's `decks/assembly.ts`, which took its
 * budget from `decks/buildability.ts` and its availability from
 * `decks/allocation.ts`. This file chooses words; it counts nothing the sheet
 * did not already say. A progress figure the client worked out for itself is a
 * figure that can disagree with the checkboxes above it.
 */

/** `CMR 261` — the set and number you actually read off a card's bottom edge. */
export function printingLabel(line: SheetLine): string {
  if (!line.setCode) return '';
  return [line.setCode.toUpperCase(), line.collectorNumber].filter(Boolean).join(' ');
}

/** `2× Sol Ring (CMR 261)` — what a line says while you are looking for it. */
export function lineLabel(line: SheetLine): string {
  const printing = printingLabel(line);
  return `${line.quantity}× ${line.name}${printing ? ` (${printing})` : ''}`;
}

/** The finish and condition, when either is worth saying out loud. */
export function lineTraits(line: SheetLine): string[] {
  const traits: string[] = [];
  if (line.finish && line.finish !== 'nonfoil') traits.push(line.finish);
  // 'unknown' is the default for a card nobody has graded; printing it on every
  // line of a bulk collection would be noise.
  if (line.condition && line.condition !== 'unknown') traits.push(line.condition);
  if (line.language && line.language !== 'en') traits.push(line.language.toUpperCase());
  return traits;
}

/** `7 of 23 pulled` — the count you glance at while holding a binder. */
export function progressText(sheet: AssemblySheet): string {
  const { pickedCards, cardsToPull } = sheet.summary;
  if (cardsToPull === 0) return 'Nothing to pull';
  return `${pickedCards} of ${cardsToPull} pulled`;
}

export function progressFraction(sheet: AssemblySheet): number {
  if (sheet.summary.cardsToPull === 0) return 0;
  return sheet.summary.pickedCards / sheet.summary.cardsToPull;
}

/** What the two kinds of run are called everywhere they are named. */
export const RUN_VERB: Record<AssemblyRun['kind'], string> = {
  assemble: 'Assemble',
  disassemble: 'Put away',
};

export const RUN_NOUN: Record<AssemblyRun['kind'], string> = {
  assemble: 'pull sheet',
  disassemble: 'put-away sheet',
};

/**
 * The sentence above the checkboxes.
 *
 * It has to say whether finishing this run will move cardboard, because that is
 * the difference between a harmless checklist and an edit to the collection,
 * and it is not visible from the list of cards.
 */
export function runIntent(sheet: AssemblySheet): string {
  const home = sheet.deck.homeLocationName;
  if (!sheet.movesLots) {
    return 'A checklist only — nothing in your collection changes when you finish.';
  }
  return sheet.run.kind === 'assemble'
    ? `Finishing this moves every ticked copy into ${home ?? 'the deck’s home location'}.`
    : 'Finishing this puts every ticked copy back where it came from.';
}

/** Lines worth a warning triangle rather than a plain row. */
export function lineWarning(line: SheetLine): string | null {
  if (line.tradeListed > 0) {
    return `${line.tradeListed} of these are on a trade list — nothing else covers this slot.`;
  }
  return line.notes;
}

export interface CompletionFact {
  key: string;
  text: string;
  tone: 'good' | 'warn' | 'plain';
}

/**
 * The completion summary, as a short list of true things.
 *
 * Ordered by what a person actually wants to know on closing the sheet: what
 * they got, what they did not, what it moved, and what it cost them elsewhere.
 * A zero is left out rather than printed — a summary of four noughts is one
 * nobody reads twice.
 */
export function completionFacts(result: AssemblyCompletion): CompletionFact[] {
  const facts: CompletionFact[] = [];
  const cards = (count: number) => `${count} card${count === 1 ? '' : 's'}`;

  facts.push({
    key: 'pulled',
    text: result.kind === 'assemble'
      ? `${cards(result.pulledCards)} pulled`
      : `${cards(result.pulledCards)} put away`,
    tone: 'good',
  });

  if (result.notFoundCards > 0) {
    facts.push({
      key: 'notFound',
      text: `${cards(result.notFoundCards)} not found — the deck no longer claims them`,
      tone: 'warn',
    });
  }
  if (result.proxiedCards > 0) {
    facts.push({ key: 'proxied', text: `${cards(result.proxiedCards)} proxied`, tone: 'plain' });
  }
  if (result.movedLots) {
    facts.push({
      key: 'moved',
      text: `${result.copiesMoved} cop${result.copiesMoved === 1 ? 'y' : 'ies'} relocated`,
      tone: 'plain',
    });
  }
  if (result.stillMissingCards > 0) {
    // The unpriced count travels with the total, always: rounding an unknown
    // price to zero is how a deck that reads "$0 to finish" costs $80.
    const unpriced = result.unpricedCount > 0 ? ` + ${result.unpricedCount} unpriced` : '';
    facts.push({
      key: 'missing',
      text: `${cards(result.stillMissingCards)} still missing, about `
        + `${money(result.stillMissingCostUsd)}${unpriced} to finish`,
      tone: 'warn',
    });
  }
  for (const adjustment of result.tradeListAdjustments) {
    facts.push({
      key: `trade-${adjustment.listName}-${adjustment.cardName}`,
      text: adjustment.removed
        ? `${adjustment.cardName} removed from trade list “${adjustment.listName}”`
        : `${adjustment.cardName} on “${adjustment.listName}” reduced by ${adjustment.quantity}`,
      tone: 'warn',
    });
  }
  return facts;
}

/** `12 Mar, 14 cards` — one line of run history. */
export function runHistoryLabel(run: AssemblyRun): string {
  const when = new Date(run.completedAt ?? run.startedAt);
  const date = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const verb = run.kind === 'assemble' ? 'Assembled' : 'Put away';
  const state = run.status === 'completed'
    ? `${run.pickedCount} of ${run.cardCount} cards`
    : run.status;
  return [date, `${verb} — ${state}`].filter(Boolean).join(' · ');
}
