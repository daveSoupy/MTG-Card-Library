import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createReadStream, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DeckStore } from '../decks/store.ts';
import type { CollectionStore } from '../collection/store.ts';
import { formatDecklist, tcgplayerMassEntryUrl, CARD_KINGDOM_DECKBUILDER,
         type ExportCard, type ExportFormat, type ParsedBoard } from '../porting/decklist.ts';
import { previewDecklist, commitDecklist, previewCollectionCsv, commitCollectionCsv,
         importBatches, undoImport } from '../porting/importer.ts';
import { backupToTemp, restoreFrom, InvalidBackupError, USER_TABLES } from '../porting/backup.ts';
import type { ColumnRole } from '../porting/csv.ts';
import type { BackupSchedule } from '../porting/schedule.ts';

const EXPORT_FORMATS: ExportFormat[] = ['simple', 'withSet', 'arena', 'mtgo'];

const asInt = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
};

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

  app.get('/api/v1/decks/:id/export', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad deck id.' });

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
  });

  /** The same list as a file, for people who would rather download it. */
  app.get('/api/v1/decks/:id/export.txt', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad deck id.' });
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
  });

  // -- deck import ------------------------------------------------------------

  app.post('/api/v1/decks/import/preview', async (request, reply) => {
    const text = (request.body as any)?.text;
    if (typeof text !== 'string') return reply.status(400).send({ error: 'Paste a decklist first.' });
    return previewDecklist(db, text);
  });

  app.post('/api/v1/decks/:id/import', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad deck id.' });
    if (!decks.get(id)) return reply.status(404).send({ error: 'No such deck.' });

    const entries = (request.body as any)?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return reply.status(400).send({ error: 'Nothing to import.' });
    }

    const clean = entries
      .filter((entry: any) => typeof entry?.oracleId === 'string' && Number(entry.quantity) > 0)
      .map((entry: any) => ({
        oracleId: entry.oracleId as string,
        quantity: Math.trunc(Number(entry.quantity)),
        board: (['main', 'side', 'command', 'maybe'].includes(entry.board)
          ? entry.board : 'main') as ParsedBoard,
      }));
    if (clean.length === 0) return reply.status(400).send({ error: 'No usable entries.' });

    const result = commitDecklist(db, decks, id, clean);
    return { ...result, deck: decks.get(id) };
  });

  /** Import into a brand-new deck, which is how a pasted list usually arrives. */
  app.post('/api/v1/decks/import', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Imported deck';
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (entries.length === 0) return reply.status(400).send({ error: 'Nothing to import.' });

    const deckId = decks.create({
      name,
      formatCode: typeof body.formatCode === 'string' ? body.formatCode : null,
    });
    const clean = entries
      .filter((entry: any) => typeof entry?.oracleId === 'string' && Number(entry.quantity) > 0)
      .map((entry: any) => ({
        oracleId: entry.oracleId as string,
        quantity: Math.trunc(Number(entry.quantity)),
        board: (['main', 'side', 'command', 'maybe'].includes(entry.board)
          ? entry.board : 'main') as ParsedBoard,
      }));
    commitDecklist(db, decks, deckId, clean);
    return reply.status(201).send({ deck: decks.get(deckId) });
  });

  // -- collection CSV ---------------------------------------------------------

  app.post('/api/v1/collection/import/preview', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    if (typeof body.text !== 'string') return reply.status(400).send({ error: 'Upload a CSV first.' });
    const mapping = Array.isArray(body.mapping) ? (body.mapping as ColumnRole[]) : undefined;
    return previewCollectionCsv(db, body.text, mapping);
  });

  app.post('/api/v1/collection/import', async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const locationId = asInt(body.locationId);
    if (locationId === undefined) {
      return reply.status(400).send({ error: 'Choose where these cards live.' });
    }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length === 0) return reply.status(400).send({ error: 'Nothing to import.' });

    const clean = rows
      .filter((row: any) => typeof row?.printingId === 'string' && Number(row.quantity) > 0)
      .map((row: any) => ({
        printingId: row.printingId as string,
        quantity: Math.trunc(Number(row.quantity)),
        finish: row.finish, condition: row.condition, language: row.language,
        acquiredUnitCost: row.acquiredUnitCost ?? null,
      }));
    if (clean.length === 0) return reply.status(400).send({ error: 'No usable rows.' });

    const result = commitCollectionCsv(db, collection, {
      locationId,
      rows: clean,
      fileName: typeof body.fileName === 'string' ? body.fileName : null,
      unmatched: asInt(body.unmatched) ?? 0,
    });
    return { ...result, value: collection.value() };
  });

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

  app.post('/api/v1/imports/:id/undo', async (request, reply) => {
    const id = asInt((request.params as any).id);
    if (id === undefined) return reply.status(400).send({ error: 'Bad import id.' });
    const result = undoImport(db, id);
    return { ...result, batches: importBatches(db), value: collection.value() };
  });

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
