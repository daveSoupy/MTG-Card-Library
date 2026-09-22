import type {
  AssemblyCompletion, AssemblySheet, AssemblyRun, DeckStatus, SheetLine,
} from './api.ts';
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
    // Recorded on the run, not on the deck's claim: the collection still says
    // you own them, so the deck still counts them. The header notice keeps
    // saying so until the deck is pulled again or put away.
    facts.push({
      key: 'notFound',
      text: `${cards(result.notFoundCards)} not found where the sheet said`,
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

export interface NotFoundNotice {
  text: string;
  title: string;
  run: AssemblyRun;
}

/**
 * The deck-header notice for cards the last pull could not find.
 *
 * Read from the run rather than from the deck, because the deck's claim is
 * recomputed from what the collection can spare and cannot remember that a
 * copy was not where the sheet said. Shown only while the deck is still
 * assembled off that run: once it is put away or pulled again, the shortfall
 * belongs to a run that is no longer the one on the table.
 */
export function notFoundNotice(runs: AssemblyRun[], deckStatus: DeckStatus): NotFoundNotice | null {
  if (deckStatus !== 'assembled') return null;
  // Newest first, as the server orders them; the latest completed assemble is
  // the one the deck was built from. Anything after it — a disassembly, a
  // cancelled run — means that pull is no longer what is on the table.
  const latest = runs.find((run) => run.status === 'completed');
  if (!latest || latest.kind !== 'assemble' || latest.notFoundCount === 0) return null;

  const count = latest.notFoundCount;
  const names = latest.notFound
    .map((line) => `${line.quantity}× ${line.name}`)
    .join(', ');
  return {
    text: `${count} not found on last pull`,
    title: `Not where the sheet said when this deck was assembled: ${names}. `
      + 'The collection still counts them as yours, so check where they went.',
    run: latest,
  };
}

/** `12 Mar, 14 cards` — one line of run history. */
export function runHistoryLabel(run: AssemblyRun): string {
  const when = new Date(run.completedAt ?? run.startedAt);
  const date = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const verb = run.kind === 'assemble' ? 'Assembled' : 'Put away';
  const shortfall = run.notFoundCount > 0 ? `, ${run.notFoundCount} not found` : '';
  const state = run.status === 'completed'
    ? `${run.pickedCount} of ${run.cardCount} cards${shortfall}`
    : run.status;
  return [date, `${verb} — ${state}`].filter(Boolean).join(' · ');
}
