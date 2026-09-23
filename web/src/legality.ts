import type { DeckIssue, DeckValidation } from './api.ts';

/**
 * What the deck header's verdict chip and the stats pane's Legality section
 * both say, worked out once so the two cannot disagree.
 *
 * They used to: the chip counted only errors ("2 problems") while the section
 * listed errors, warnings and allocation shortfalls underneath it — four
 * messages under a verdict of two. The shortfalls have moved out of legality
 * altogether (they are buildability's); the warnings that remain are named as
 * notes, in the same words in both places. Chooses words only — `isLegal` and
 * the issues themselves are the server's.
 */
export interface LegalityVerdict {
  ok: boolean;
  /** `Legal`, `Legal · 1 note`, or `2 problems`. */
  text: string;
  errors: DeckIssue[];
  notes: DeckIssue[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function legalityVerdict(validation: DeckValidation): LegalityVerdict {
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  const notes = validation.issues.filter((issue) => issue.severity === 'warning');
  const text = !validation.isLegal
    ? plural(errors.length, 'problem')
    : notes.length > 0 ? `Legal · ${plural(notes.length, 'note')}` : 'Legal';
  return { ok: validation.isLegal, text, errors, notes };
}
