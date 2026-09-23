import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createReadStream, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DeckStore } from '../decks/store.ts';
import { CONDITIONS, FINISHES, type CollectionStore } from '../collection/store.ts';
import { formatDecklist, tcgplayerMassEntryUrl, CARD_KINGDOM_DECKBUILDER,
         type ExportCard, type ExportFormat, type ParsedBoard } from '../porting/decklist.ts';
import { previewDecklist, commitDecklist, previewCollectionCsv, commitCollectionCsv,
         importBatches, undoImport } from '../porting/importer.ts';
import { backupToTemp, restoreFrom, InvalidBackupError, USER_TABLES } from '../porting/backup.ts';
import type { ColumnRole } from '../porting/csv.ts';
import type { BackupSchedule } from '../porting/schedule.ts';
import {
  ID, COUNT, NAME, TEXT, TEXT_OR_NULL, MONEY_OR_NULL,
  body as bodySchema, idParams,
} from './schema.ts';

const EXPORT_FORMATS: ExportFormat[] = ['simple', 'withSet', 'arena', 'mtgo'];

const FINISH = { type: 'string', enum: FINISHES } as const;
const CONDITION = { type: 'string', enum: CONDITIONS } as const;

/** The boards a parsed decklist line can land on. */
const PARSED_BOARD = { type: 'string', enum: ['main', 'side', 'command', 'maybe'] } as const;

/**
 * One line of a parsed decklist, as the preview endpoint hands it back and the
 * user has confirmed it. Quantity is allowed to be zero here and filtered out
 * below rather than rejected: a pasted list with a stray "0 Island" should
 * import the rest, not fail whole.
 */
const DECK_ENTRIES = {
  type: 'array', minItems: 1,
  items: bodySchema(
    { oracleId: NAME, quantity: COUNT, board: PARSED_BOARD },
    ['oracleId', 'quantity'],
  ),
} as const;

/** One row of a parsed collection CSV, already normalised by the preview. */
const CSV_ROWS = {
  type: 'array', minItems: 1,
  items: bodySchema(
    {
      printingId: NAME, quantity: COUNT, finish: FINISH,
      condition: CONDITION, language: TEXT, acquiredUnitCost: MONEY_OR_NULL,
    },
    ['printingId', 'quantity'],
  ),
} as const;

const COLUMN_ROLE = {
  type: 'string',
  enum: ['name', 'setCode', 'setName', 'collectorNumber', 'quantity',
         'finish', 'condition', 'language', 'price', 'scryfallId', 'ignore'],
} as const;

interface DeckEntry { oracleId: string; quantity: number; board?: ParsedBoard }
interface CsvRow {
  printingId: string; quantity: number;
  finish?: 'nonfoil' | 'foil' | 'etched'; condition?: string;
  language?: string; acquiredUnitCost?: number | null;
}

export function registerPortingRoutes(
  app: FastifyInstance,
  db: Database.Database,
  decks: DeckStore,
  collection: CollectionStore,
  schedule?: BackupSchedule,
): void {
  /**
   * A restore uploads a whole SQLite file, so the body is taken raw rather than
   * parsed. Streaming it to a temp file keeps a large library off the heap.
   */
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' },
    (_request, body, done) => done(null, body));

  // -- deck export ------------------------------------------------------------

  /** Collector numbers are not on DeckCard, and `withSet` needs them. */
  const collectorNumbers = (printingIds: string[]): Map<string, string> => {
    if (printingIds.length === 0) return new Map();
    const rows = db.prepare(
      `SELECT id, collector_number FROM card_printings WHERE id IN (${printingIds.map(() => '?').join(',')})`,
    ).all(...printingIds) as Array<{ id: string; collector_number: string }>;
    return new Map(rows.map((row) => [row.id, row.collector_number]));
  };

  const exportCards = (deckId: number): ExportCard[] | null => {
    const deck = decks.get(deckId);
    if (!deck) return null;
    const numbers = collectorNumbers(
      deck.cards.map((card) => card.printingId).filter((id): id is string => Boolean(id)),
    );
    return deck.cards.map((card) => ({
      quantity: card.quantity,
      name: card.name,
      setCode: card.setCode,
      collectorNumber: card.printingId ? numbers.get(card.printingId) ?? null : null,
      board: card.board as ParsedBoard,
    }));
  };

  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/export',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
    const { id } = request.params;
    const requested = (request.query as any)?.format;
    const format: ExportFormat = EXPORT_FORMATS.includes(requested) ? requested : 'simple';

    const cards = exportCards(id);
    if (!cards) return reply.status(404).send({ error: 'No such deck.' });

    const text = formatDecklist(cards, format);
    const tcgplayer = tcgplayerMassEntryUrl(cards);
    return {
      format,
      text,
      tcgplayerUrl: tcgplayer.tooLong ? null : tcgplayer.url,
      // The list is too long for a URL; the UI offers copy-and-paste instead.
      tcgplayerTooLong: tcgplayer.tooLong,
      cardKingdomUrl: CARD_KINGDOM_DECKBUILDER,
    };
  },
  );

  /** The same list as a file, for people who would rather download it. */
  app.get<{ Params: { id: number } }>(
    '/api/v1/decks/:id/export.txt',
    { schema: { params: idParams('id') } },
    async (request, reply) => {
    const { id } = request.params;
    const deck = decks.get(id);
    const cards = exportCards(id);
    if (!deck || !cards) return reply.status(404).send({ error: 'No such deck.' });

    const requested = (request.query as any)?.format;
    const format: ExportFormat = EXPORT_FORMATS.includes(requested) ? requested : 'simple';
    const safeName = deck.name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'deck';

    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="${safeName}.txt"`)
      .send(formatDecklist(cards, format));
  },
  );

  // -- deck import ------------------------------------------------------------

  /** Drops the zero-quantity lines the schema deliberately lets through. */
  const usable = (entries: DeckEntry[]) => entries
    .filter((entry) => entry.quantity > 0)
    .map((entry) => ({
      oracleId: entry.oracleId,
      quantity: Math.trunc(entry.quantity),
      board: (entry.board ?? 'main') as ParsedBoard,
    }));

  app.post<{ Body: { text: string } }>(
    '/api/v1/decks/import/preview',
    { schema: { body: bodySchema({ text: TEXT }, ['text']) } },
    async (request) => previewDecklist(db, request.body.text),
  );

  app.post<{ Params: { id: number }; Body: { entries: DeckEntry[] } }>(
    '/api/v1/decks/:id/import',
    { schema: { params: idParams('id'), body: bodySchema({ entries: DECK_ENTRIES }, ['entries']) } },
    async (request, reply) => {
      const { id } = request.params;
      if (!decks.get(id)) return reply.status(404).send({ error: 'No such deck.' });

      const clean = usable(request.body.entries);
      if (clean.length === 0) return reply.status(400).send({ error: 'No usable entries.' });

      const result = commitDecklist(db, decks, id, clean);
      return { ...result, deck: decks.get(id) };
    },
  );

  /** Import into a brand-new deck, which is how a pasted list usually arrives. */
  app.post<{ Body: { name?: string; formatCode?: string | null; entries: DeckEntry[] } }>(
    '/api/v1/decks/import',
    {
      schema: {
        body: bodySchema(
          { name: TEXT, formatCode: TEXT_OR_NULL, entries: DECK_ENTRIES },
          ['entries'],
        ),
      },
    },
    async (request, reply) => {
      const { name, formatCode, entries } = request.body;
      const deckId = decks.create({
        name: name?.trim() || 'Imported deck',
        formatCode: formatCode ?? null,
      });
      commitDecklist(db, decks, deckId, usable(entries));
      return reply.status(201).send({ deck: decks.get(deckId) });
    },
  );

  // -- collection CSV ---------------------------------------------------------

  app.post<{ Body: { text: string; mapping?: ColumnRole[] } }>(
    '/api/v1/collection/import/preview',
    {
      schema: {
        body: bodySchema({ text: TEXT, mapping: { type: 'array', items: COLUMN_ROLE } }, ['text']),
      },
    },
    async (request) => previewCollectionCsv(db, request.body.text, request.body.mapping),
  );

  app.post<{
    Body: { locationId: number; rows: CsvRow[]; fileName?: string | null; unmatched?: number };
  }>(
    '/api/v1/collection/import',
    {
      schema: {
        body: bodySchema(
          { locationId: ID, rows: CSV_ROWS, fileName: TEXT_OR_NULL, unmatched: COUNT },
          ['locationId', 'rows'],
        ),
      },
    },
    async (request, reply) => {
      const { locationId, rows, fileName, unmatched } = request.body;
      const clean = rows
        .filter((row) => row.quantity > 0)
        .map((row) => ({
          printingId: row.printingId,
          quantity: Math.trunc(row.quantity),
          finish: row.finish, condition: row.condition, language: row.language,
          acquiredUnitCost: row.acquiredUnitCost ?? null,
        }));
      if (clean.length === 0) return reply.status(400).send({ error: 'No usable rows.' });

      const result = commitCollectionCsv(db, collection, {
        locationId,
        rows: clean,
        fileName: fileName ?? null,
        unmatched: unmatched ?? 0,
      });
      return { ...result, value: collection.value() };
    },
  );

  /**
   * The collection as CSV — one row per lot, not per card, because the lots are
   * what carry cost basis and condition, and flattening them would lose that.
   */
  app.get('/api/v1/collection/export.csv', async (_request, reply) => {
    const rows = db.prepare(`
      SELECT o.name, p.set_code, s.name AS set_name, p.collector_number,
             c.quantity, c.finish, c.condition, c.language,
             c.acquired_unit_cost, c.acquired_at, c.price_override,
             COALESCE(c.price_override, p.price_usd) AS unit_value,
             l.name AS location
      FROM collection_items c
      JOIN card_printings p ON p.id = c.printing_id
      JOIN oracle_cards o ON o.oracle_id = p.oracle_id
      JOIN storage_locations l ON l.id = c.location_id
      LEFT JOIN sets s ON s.code = p.set_code
      ORDER BY o.name COLLATE NOCASE, p.set_code, p.collector_number`).all() as any[];

    const header = ['Name', 'Set Code', 'Set Name', 'Collector Number', 'Quantity', 'Finish',
                    'Condition', 'Language', 'Purchase Price', 'Acquired', 'Price Override',
                    'Unit Value', 'Location'];
    const body = rows.map((row) => csvLine([
      row.name, row.set_code, row.set_name, row.collector_number, row.quantity, row.finish,
      row.condition, row.language, row.acquired_unit_cost, row.acquired_at, row.price_override,
      row.unit_value, row.location,
    ]));

    const today = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="collection-${today}.csv"`)
      // The BOM is what makes Excel read UTF-8 card names correctly.
      .send('﻿' + [csvLine(header), ...body].join('\r\n') + '\r\n');
  });

  // -- import history ---------------------------------------------------------

  app.get('/api/v1/imports', async () => ({ batches: importBatches(db) }));

  app.post<{ Params: { id: number } }>(
    '/api/v1/imports/:id/undo',
    { schema: { params: idParams('id') } },
    async (request) => {
      const result = undoImport(db, request.params.id);
      return { ...result, batches: importBatches(db), value: collection.value() };
    },
  );

  // -- backup -----------------------------------------------------------------

  app.get('/api/v1/backup', async (_request, reply) => {
    const backup = backupToTemp(db);
    const today = new Date().toISOString().slice(0, 10);

    // The temp copy is removed once the response has finished with it.
    const stream = createReadStream(backup.path);
    stream.on('close', backup.cleanup);

    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(backup.bytes))
      .header('content-disposition', `attachment; filename="mtg-library-${today}.sqlite"`)
      .send(stream);
  });

  /** The automatic local backups, and a way to take one on demand. */
  app.get('/api/v1/backup/scheduled', async () =>
    schedule ? { directory: schedule.directory, backups: schedule.list() }
             : { directory: null, backups: [] });

  app.post('/api/v1/backup/scheduled', async (_request, reply) => {
    if (!schedule) return reply.status(503).send({ error: 'Scheduled backups are not running.' });
    schedule.runNow();
    return { backups: schedule.list() };
  });

  app.post('/api/v1/backup/restore', async (request, reply) => {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.status(400).send({ error: 'Send the backup file as the request body.' });
    }

    const dir = join(tmpdir(), 'mtg-library-restore');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `upload-${Date.now()}.sqlite`);
    writeFileSync(path, body);

    try {
      const report = restoreFrom(db, path);
      return { ...report, tables: USER_TABLES.length };
    } catch (error) {
      if (error instanceof InvalidBackupError) {
        return reply.status(400).send({ error: error.message });
      }
      throw error;
    } finally {
      rmSync(path, { force: true });
    }
  });
}

/** Quotes a CSV field only when it needs it, which keeps the file readable. */
function csvLine(values: unknown[]): string {
  return values.map((value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',');
}
