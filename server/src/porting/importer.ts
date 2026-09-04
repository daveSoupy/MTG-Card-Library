import type Database from 'better-sqlite3';
import type { DeckStore } from '../decks/store.ts';
import type { CollectionStore } from '../collection/store.ts';
import { parseDecklist, type ParsedBoard } from './decklist.ts';
import { parseCsv, guessMapping, applyMapping, type ColumnRole } from './csv.ts';
import { CardResolver, resolvePrinting, type ResolvedCard } from './resolve.ts';
import { normalizeName } from '../model/mtg.ts';

/**
 * Importing, in two steps: preview, then commit.
 *
 * Nothing is written until the user has seen what the text resolved to. A
 * decklist pasted from a website is full of names this database may spell
 * differently, and silently dropping — or worse, silently guessing — those is
 * how an import quietly corrupts a collection. The preview is the whole point;
 * the commit is deliberately dumb, taking ids the client confirmed.
 */

export interface PreviewLine {
  lineNumber: number;
  raw: string;
  quantity: number;
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  board: ParsedBoard;
  /** Null when nothing matched confidently; `candidates` is then the offer. */
  match: ResolvedCard | null;
  candidates: ResolvedCard[];
}

export interface DecklistPreview {
  lines: PreviewLine[];
  unparsed: Array<{ lineNumber: number; raw: string }>;
  counts: { total: number; resolved: number; uncertain: number; unresolved: number };
}

export function previewDecklist(db: Database.Database, text: string): DecklistPreview {
  const parsed = parseDecklist(text);
  const resolver = new CardResolver(db);

  const lines: PreviewLine[] = parsed.entries.map((entry) => {
    const resolution = resolver.resolve(entry.name, entry.setCode);
    return {
      lineNumber: entry.lineNumber,
      raw: entry.raw,
      quantity: entry.quantity,
      name: entry.name,
      setCode: entry.setCode,
      collectorNumber: entry.collectorNumber,
      board: entry.board,
      match: resolution.match,
      candidates: resolution.candidates,
    };
  });

  return {
    lines,
    unparsed: parsed.unparsed,
    counts: {
      total: lines.length,
      resolved: lines.filter((l) => l.match && l.match.confidence === 1).length,
      // Matched, but by similarity rather than certainty — worth a glance.
      uncertain: lines.filter((l) => l.match && l.match.confidence < 1).length,
      unresolved: lines.filter((l) => !l.match).length,
    },
  };
}

export interface DecklistCommitEntry {
  oracleId: string;
  quantity: number;
  board: ParsedBoard;
}

/**
 * Adds confirmed entries to a deck, in one transaction so a partial import
 * cannot leave a half-built deck behind.
 */
export function commitDecklist(
  db: Database.Database,
  decks: DeckStore,
  deckId: number,
  entries: DecklistCommitEntry[],
): { added: number; cards: number } {
  let cards = 0;
  let commandZone = 0;

  db.transaction(() => {
    for (const entry of entries) {
      // 'maybe' is a real board, but a pasted list never means to fill it.
      const board = entry.board === 'maybe' ? 'main' : entry.board;
      decks.addCard(deckId, entry.oracleId, { board, quantity: entry.quantity });
      cards += entry.quantity;

      // Landing on the command board is not the same as *being* the commander:
      // without a role the colour-identity rule has nothing to check against,
      // and every imported Commander deck would validate as if it had none.
      if (board === 'command') {
        const row = db.prepare(
          'SELECT id FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND board = ?',
        ).get(deckId, entry.oracleId, board) as { id: number } | undefined;
        if (row) {
          // A second card in the zone is a partner or background; the validator
          // decides whether that pairing is actually legal.
          decks.setBoard(deckId, row.id, 'command', commandZone === 0 ? 'commander' : 'partner');
          commandZone += 1;
        }
      }
    }
  })();
  return { added: entries.length, cards };
}

// -- collection CSV -----------------------------------------------------------

export interface CsvPreviewRow {
  lineNumber: number;
  name: string;
  quantity: number;
  setCode: string | null;
  collectorNumber: string | null;
  finish: 'nonfoil' | 'foil' | 'etched';
  condition: string;
  language: string;
  price: number | null;
  match: ResolvedCard | null;
  candidates: ResolvedCard[];
  /** The printing chosen, and whether the set/number actually pinned it. */
  printingId: string | null;
  printingExact: boolean;
}

export interface CsvPreview {
  headers: string[];
  mapping: ColumnRole[];
  rows: CsvPreviewRow[];
  skipped: Array<{ lineNumber: number; reason: string }>;
  counts: { total: number; resolved: number; uncertain: number; unresolved: number; cards: number };
}

export function previewCollectionCsv(
  db: Database.Database,
  text: string,
  overrideMapping?: ColumnRole[],
): CsvPreview {
  const table = parseCsv(text);
  const mapping = overrideMapping ?? guessMapping(table.headers);
  const { rows, skipped } = applyMapping(table, mapping);
  const resolver = new CardResolver(db);
  const setCodes = setCodeLookup(db);

  const previewed: CsvPreviewRow[] = rows.map((row) => {
    // Deckbox and several others write the set's full name rather than its
    // code, and without translating it every card falls back to the default
    // printing — which is the wrong price and the wrong cost basis, silently.
    const setCode = row.setCode ?? (row.setName ? setCodes.get(normalizeName(row.setName)) ?? null : null);

    const resolution = resolver.resolve(row.name, setCode);
    const printing = resolution.match
      ? resolvePrinting(db, resolution.match.oracleId, setCode, row.collectorNumber)
      : { printingId: null, exact: false };

    return {
      lineNumber: row.lineNumber,
      name: row.name,
      quantity: row.quantity,
      setCode,
      collectorNumber: row.collectorNumber,
      finish: row.finish,
      condition: row.condition,
      language: row.language,
      price: row.price,
      match: resolution.match,
      candidates: resolution.candidates,
      printingId: printing.printingId,
      printingExact: printing.exact,
    };
  });

  return {
    headers: table.headers,
    mapping,
    rows: previewed,
    skipped,
    counts: {
      total: previewed.length,
      resolved: previewed.filter((r) => r.match && r.match.confidence === 1).length,
      uncertain: previewed.filter((r) => r.match && r.match.confidence < 1).length,
      unresolved: previewed.filter((r) => !r.match).length,
      cards: previewed.filter((r) => r.printingId).reduce((sum, r) => sum + r.quantity, 0),
    },
  };
}

export interface CsvCommitRow {
  printingId: string;
  quantity: number;
  finish?: 'nonfoil' | 'foil' | 'etched';
  condition?: string;
  language?: string;
  acquiredUnitCost?: number | null;
}

/**
 * Writes confirmed rows into the collection under one import batch, so the
 * whole import can be undone as a unit if it turns out to be wrong.
 */
export function commitCollectionCsv(
  db: Database.Database,
  collection: CollectionStore,
  input: {
    locationId: number;
    rows: CsvCommitRow[];
    fileName?: string | null;
    source?: string;
    unmatched?: number;
  },
): { batchId: number; lots: number; cards: number } {
  return db.transaction(() => {
    const batch = db.prepare(`
      INSERT INTO import_batches (source, file_name, rows_total, rows_imported, rows_unmatched)
      VALUES (?,?,?,?,?)`)
      .run(input.source ?? 'csv', input.fileName ?? null,
           input.rows.length + (input.unmatched ?? 0), input.rows.length, input.unmatched ?? 0);
    const batchId = Number(batch.lastInsertRowid);

    let cards = 0;
    for (const row of input.rows) {
      collection.addLot({
        printingId: row.printingId,
        locationId: input.locationId,
        quantity: row.quantity,
        finish: row.finish,
        condition: (row.condition ?? 'unknown') as any,
        language: row.language,
        acquiredUnitCost: row.acquiredUnitCost ?? null,
        acquisitionKind: 'purchase',
        importBatchId: batchId,
      });
      cards += row.quantity;
    }
    return { batchId, lots: input.rows.length, cards };
  })();
}

/** Set name -> code, so an export that names its sets can still pin printings. */
function setCodeLookup(db: Database.Database): Map<string, string> {
  const rows = db.prepare('SELECT code, name FROM sets').all() as Array<{ code: string; name: string }>;
  return new Map(rows.map((row) => [normalizeName(row.name), row.code]));
}

/** Import history, so a batch can be found and undone. */
export function importBatches(db: Database.Database, limit = 50) {
  return db.prepare(`
    SELECT b.id, b.source, b.file_name AS fileName, b.imported_at AS importedAt,
           b.rows_total AS rowsTotal, b.rows_imported AS rowsImported,
           b.rows_unmatched AS rowsUnmatched, b.total_cost_usd AS totalCostUsd,
           (SELECT COALESCE(sum(quantity), 0) FROM collection_items c WHERE c.import_batch_id = b.id)
             AS cardsRemaining
    FROM import_batches b
    ORDER BY b.imported_at DESC, b.id DESC
    LIMIT ?`).all(limit);
}

/**
 * Removes the rows an import added.
 *
 * Only rows still carrying the batch id go; anything the user has since edited
 * into a different lot is left alone rather than guessed at.
 */
export function undoImport(db: Database.Database, batchId: number): { removed: number } {
  return db.transaction(() => {
    const result = db.prepare('DELETE FROM collection_items WHERE import_batch_id = ?').run(batchId);
    db.prepare("UPDATE import_batches SET notes = COALESCE(notes || ' ', '') || 'undone' WHERE id = ?")
      .run(batchId);
    return { removed: result.changes };
  })();
}
