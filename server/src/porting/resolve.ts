import type Database from 'better-sqlite3';
import { normalizeName, EXTRA_LAYOUTS } from '../model/mtg.ts';

/**
 * Turns a card name from a decklist or CSV into a card in the database.
 *
 * Three passes, cheapest and most certain first. `card_name_variants` already
 * holds every face and flip name normalised, and `card_name_trgm` is a trigram
 * index over it — both built during Phase 1 for exactly this.
 */

export interface ResolvedCard {
  oracleId: string;
  name: string;
  /** How the match was made, so the UI can decide whether to ask. */
  via: 'exact' | 'face' | 'fuzzy';
  /** 0..1, only meaningful for fuzzy matches. */
  confidence: number;
}

export interface Resolution {
  query: string;
  match: ResolvedCard | null;
  /** Ranked alternatives, shown when the match is uncertain or wrong. */
  candidates: ResolvedCard[];
}

/** Below this, a fuzzy match is offered as a suggestion rather than applied. */
const CONFIDENT = 0.72;

/**
 * Art cards, tokens and emblems share names with real cards, so importing a
 * decklist without this fills a deck with art cards. Search excludes the same
 * layouts; the list lives in the model so the two cannot drift apart.
 */
const PLAYABLE = `o.layout NOT IN (${EXTRA_LAYOUTS.map(() => '?').join(', ')})`;

export class CardResolver {
  private readonly db: Database.Database;
  private readonly cache = new Map<string, Resolution>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  resolve(rawName: string, setCode?: string | null): Resolution {
    const key = `${normalizeName(rawName)}|${setCode ?? ''}`;
    const cached = this.cache.get(key);
    // Decklists repeat names constantly (20 Mountain), and a CSV import can be
    // thousands of rows, so resolving each distinct name once matters.
    if (cached) return cached;

    const resolution = this.lookup(rawName, setCode ?? null);
    this.cache.set(key, resolution);
    return resolution;
  }

  private lookup(rawName: string, setCode: string | null): Resolution {
    const normalized = normalizeName(rawName);
    if (!normalized) return { query: rawName, match: null, candidates: [] };

    // 1. Exact name, preferring a card actually printed in the given set when
    //    one was supplied — reprints share a name across many sets.
    const exact = this.db.prepare(`
      SELECT v.oracle_id, o.name, v.kind,
             EXISTS (SELECT 1 FROM card_printings p
                     WHERE p.oracle_id = v.oracle_id AND p.set_code = ?) AS in_set
      FROM card_name_variants v
      JOIN oracle_cards o ON o.oracle_id = v.oracle_id
      WHERE v.variant_normalized = ? AND ${PLAYABLE}
      ORDER BY in_set DESC, v.kind = 'primary' DESC
      LIMIT 5`).all(setCode ?? '', normalized, ...EXTRA_LAYOUTS) as any[];

    if (exact.length > 0) {
      const best = exact[0];
      return {
        query: rawName,
        match: {
          oracleId: best.oracle_id,
          name: best.name,
          via: best.kind === 'primary' ? 'exact' : 'face',
          confidence: 1,
        },
        // Only genuinely ambiguous when several *different* cards share a name.
        candidates: dedupe(exact).slice(0, 5).map((row) => ({
          oracleId: row.oracle_id, name: row.name,
          via: row.kind === 'primary' ? 'exact' as const : 'face' as const, confidence: 1,
        })),
      };
    }

    // 2. Prefix, which catches truncated or partially typed names.
    const prefix = this.db.prepare(`
      SELECT DISTINCT v.oracle_id, o.name
      FROM card_name_variants v
      JOIN oracle_cards o ON o.oracle_id = v.oracle_id
      WHERE v.variant_normalized LIKE ? AND ${PLAYABLE}
      ORDER BY length(o.name), o.name COLLATE NOCASE
      LIMIT 8`).all(`${normalized}%`, ...EXTRA_LAYOUTS) as any[];

    // 3. Trigram, for typos.
    //
    //    MATCHing the whole string would be a substring search — "lightnig
    //    bolt" is not a substring of "lightning bolt", so it would find
    //    nothing, and typos are the entire point of this pass. Instead the
    //    query is broken into its own trigrams and ORed, which finds names
    //    sharing most of them; bm25 puts the biggest overlaps first, and the
    //    Dice score below does the final ranking.
    const grams = trigrams(normalized);
    const fuzzy = grams.length > 0
      ? this.db.prepare(`
          SELECT DISTINCT v.oracle_id, o.name
          FROM card_name_trgm t
          JOIN card_name_variants v ON v.id = t.rowid
          JOIN oracle_cards o ON o.oracle_id = v.oracle_id
          WHERE card_name_trgm MATCH ? AND ${PLAYABLE}
          ORDER BY bm25(card_name_trgm)
          LIMIT 50`).all(grams.map(quoteTrigram).join(' OR '), ...EXTRA_LAYOUTS) as any[]
      : [];

    const scored = dedupe([...prefix, ...fuzzy])
      .map((row) => ({
        oracleId: row.oracle_id as string,
        name: row.name as string,
        via: 'fuzzy' as const,
        confidence: similarity(normalized, normalizeName(row.name)),
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);

    const best = scored[0];
    return {
      query: rawName,
      // A weak best guess is offered as a candidate, never applied silently —
      // quietly importing the wrong card is worse than asking.
      match: best && best.confidence >= CONFIDENT ? best : null,
      candidates: scored,
    };
  }
}

function dedupe(rows: any[]): any[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.oracle_id)) return false;
    seen.add(row.oracle_id);
    return true;
  });
}

/**
 * The overlapping three-character windows of a string, which is exactly what
 * the trigram tokenizer indexed. Shorter than three characters yields none,
 * and such a query skips the fuzzy pass rather than erroring.
 */
function trigrams(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 3 <= value.length; i += 1) out.push(value.slice(i, i + 3));
  return [...new Set(out)];
}

/** FTS5 treats several characters as syntax, so each term is quoted. */
function quoteTrigram(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

/**
 * Dice coefficient over character bigrams — cheap, and forgiving of the
 * transpositions and dropped letters that typos actually produce.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) { bigrams.set(gram, count - 1); hits += 1; }
  }

  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/**
 * Picks the printing to attach a collection row to.
 *
 * Set and collector number together identify one exactly; set alone is usually
 * enough; otherwise the card's default printing is used, and the caller is told
 * the choice was approximate.
 */
export function resolvePrinting(
  db: Database.Database,
  oracleId: string,
  setCode: string | null,
  collectorNumber: string | null,
): { printingId: string | null; exact: boolean } {
  if (setCode && collectorNumber) {
    const row = db.prepare(`
      SELECT id FROM card_printings
      WHERE oracle_id = ? AND set_code = ? AND collector_number = ?`)
      .get(oracleId, setCode, collectorNumber) as { id: string } | undefined;
    if (row) return { printingId: row.id, exact: true };
  }

  if (setCode) {
    const row = db.prepare(`
      SELECT id FROM card_printings WHERE oracle_id = ? AND set_code = ?
      ORDER BY collector_number_num LIMIT 1`).get(oracleId, setCode) as { id: string } | undefined;
    if (row) return { printingId: row.id, exact: false };
  }

  const fallback = db.prepare('SELECT default_printing_id AS id FROM oracle_cards WHERE oracle_id = ?')
    .get(oracleId) as { id: string | null } | undefined;
  return { printingId: fallback?.id ?? null, exact: false };
}
