import { CATEGORY_LABELS } from '../sync/categories.ts';

/**
 * The manual category on a deck slot, which is a *list*.
 *
 * `deck_cards.category` stays one TEXT column holding a comma-separated list
 * rather than becoming its own table: the real membership set already lives in
 * `card_categories`, and this is an occasional override on top of it. A second
 * table would buy nothing and cost a migration plus fan-out through
 * `deck_snapshot_cards`, deck duplication and the history/restore path.
 *
 * Everything that reads or writes the column goes through here, so the stored
 * form is canonical and every later comparison — including the undo stack's
 * equality check — is against one spelling.
 */

/** Enough to say "ramp, draw, protection" without becoming a notes field. */
const MAX_ENTRIES = 6;
const MAX_ENTRY_LENGTH = 40;

/**
 * Splits the stored form into entries: trimmed, blank-free, and deduplicated
 * case-insensitively with the first spelling winning, so "Ramp, ramp" is one
 * category rather than two datalist suggestions for the same thing.
 */
export function parseCategoryList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim().slice(0, MAX_ENTRY_LENGTH);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length === MAX_ENTRIES) break;
  }
  return out;
}

/** The stored form. Null rather than an empty string, so "no override" is one
 *  value and `IS NULL` keeps meaning what it means. */
export function formatCategoryList(values: string[]): string | null {
  return values.length === 0 ? null : values.join(', ');
}

/** Round-trips a user-typed value into the canonical stored form. */
export function normalizeCategoryInput(raw: string | null | undefined): string | null {
  return formatCategoryList(parseCategoryList(raw));
}

/**
 * Whether a manual list claims a given template category, by either its key
 * ('sweeper') or its display label ('Board wipes') — the two spellings a user
 * plausibly types for the same row.
 */
export function categoryListMatches(
  values: string[],
  category: string,
  labelFor: (category: string) => string,
): boolean {
  const wanted = new Set([category.toLowerCase(), labelFor(category).toLowerCase()]);
  return values.some((value) => wanted.has(value.toLowerCase()));
}

/** The canonical category names, offered alongside whatever a deck already
 *  uses so the eight that templates actually count are always one click away. */
export const CANONICAL_CATEGORIES = Object.values(CATEGORY_LABELS);
