import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db/index.ts';
import { USER_AGENT } from './scryfall.ts';

/**
 * Phase 8 rulings, from Scryfall's official 'rulings' bulk file — one of the
 * five official bulk-data types (https://scryfall.com/docs/api/bulk-data),
 * so this needs no third-party source and no "may go away" caveat, unlike
 * Phase 7's oracle-tags source.
 *
 * Rulings tracking is best-effort layered on top of the card database: a
 * failure here must never fail the card sync, so every entry point swallows
 * its own errors, the same shape as categories.ts's syncCardCategories.
 */

export interface RulingRecord {
  oracleId: string;
  source: 'wotc' | 'scryfall';
  publishedAt: string;
  comment: string;
}

function normalizeRuling(raw: any): RulingRecord | null {
  const oracleId = typeof raw?.oracle_id === 'string' ? raw.oracle_id : null;
  const source = raw?.source === 'wotc' || raw?.source === 'scryfall' ? raw.source : null;
  const publishedAt = typeof raw?.published_at === 'string' ? raw.published_at : null;
  const comment = typeof raw?.comment === 'string' ? raw.comment : null;
  if (!oracleId || !source || !publishedAt || !comment) return null;
  return { oracleId, source, publishedAt, comment };
}

/** Looks up the rulings bulk entry, same listing as the card bulk files. */
async function fetchRulingsEntry(): Promise<{ downloadUrl: string; updatedAt: string }> {
  const response = await fetch('https://api.scryfall.com/bulk-data', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Scryfall returned HTTP ${response.status} for the bulk-data listing.`);
  }
  const body: any = await response.json();
  const entry = Array.isArray(body?.data) ? body.data.find((e: any) => e?.type === 'rulings') : null;
  if (!entry) throw new Error('Scryfall is not currently publishing a "rulings" bulk file.');
  // Rulings, like oracle_tags, is only published as .jsonl — there is no
  // plain download_uri for this bulk type, unlike the card files.
  const downloadUrl = entry.jsonl_download_uri ?? entry.download_uri;
  if (!downloadUrl) throw new Error('The "rulings" bulk entry had no download URI.');
  return { downloadUrl, updatedAt: String(entry.updated_at ?? '') };
}

/**
 * Streams and parses every ruling from the bulk file — same one-object-per-line
 * gzipped format as the card bulk files, read the same way streamBulkCards does.
 */
export async function fetchRulings(entry?: { downloadUrl: string }): Promise<RulingRecord[]> {
  const resolved = entry ?? await fetchRulingsEntry();
  const response = await fetch(resolved.downloadUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`Downloading the rulings file failed with HTTP ${response.status}.`);
  }

  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const decode = new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>;
  const lines = response.body.pipeThrough(gunzip).pipeThrough(decode);

  const rulings: RulingRecord[] = [];
  const consume = (line: string) => {
    const trimmed = line.trim().replace(/,$/, '');
    if (trimmed.length === 0 || trimmed === '[' || trimmed === ']') return;
    const ruling = normalizeRuling(JSON.parse(trimmed));
    if (ruling) rulings.push(ruling);
  };

  let buffer = '';
  for await (const chunk of lines as unknown as AsyncIterable<string>) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer.trim().length > 0) consume(buffer);
  return rulings;
}

/**
 * Rewrites card_rulings in one transaction, replacing all rows with the
 * file's contents rather than diffing. Only rows whose oracle_id exists in
 * oracle_cards are inserted — the rulings file covers cards default_cards
 * omits, and one orphan would otherwise fail the whole transaction on the FK.
 * Returns { written, skipped }.
 */
export function writeCardRulings(
  db: Database.Database,
  rulings: RulingRecord[],
): { written: number; skipped: number } {
  return db.transaction(() => {
    db.exec('DELETE FROM card_rulings');
    const insert = db.prepare(`
      INSERT INTO card_rulings (oracle_id, source, published_at, comment)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM oracle_cards WHERE oracle_id = ?)`);
    let written = 0;
    let skipped = 0;
    for (const r of rulings) {
      const outcome = insert.run(r.oracleId, r.source, r.publishedAt, r.comment, r.oracleId);
      if (outcome.changes > 0) written += 1;
      else skipped += 1;
    }
    return { written, skipped };
  })();
}

const LOADED_RULINGS_KEY = 'loaded_rulings_updated_at';

/**
 * Fetches and writes Phase 8's card rulings. Never throws — a card sync that
 * otherwise succeeded must not be reported as failed because the rulings
 * file 404s or times out. Logs its own row to sync_log, independent of the
 * card sync's row, so the skipped count has somewhere to live.
 *
 * Skipped when the published file is the one already loaded and there are
 * rulings to show for it. This became load-bearing when the side-loads
 * started running on the card sync's "already up to date" path too: without
 * it, every no-op sync re-downloaded and rewrote all ~79,000 rulings.
 */
export async function syncCardRulings(
  db: Database.Database,
  { force = false }: { force?: boolean } = {},
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  try {
    const entry = await fetchRulingsEntry();
    const hasRulings =
      (db.prepare('SELECT EXISTS(SELECT 1 FROM card_rulings) AS n').get() as { n: number }).n === 1;
    if (!force && entry.updatedAt !== '' && getSetting(db, LOADED_RULINGS_KEY) === entry.updatedAt
        && hasRulings) {
      return true;
    }
    const rulings = await fetchRulings(entry);
    const { written, skipped } = writeCardRulings(db, rulings);
    db.prepare(`
      INSERT INTO sync_log (bulk_type, started_at, finished_at, status, printings_upserted, error_message)
      VALUES ('rulings', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'success', ?, ?)`)
      .run(startedAt, written, skipped > 0 ? `Skipped ${skipped} ruling(s) for unknown oracle_id.` : null);
    setSetting(db, LOADED_RULINGS_KEY, entry.updatedAt);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`
      INSERT INTO sync_log (bulk_type, started_at, finished_at, status, error_message)
      VALUES ('rulings', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'failed', ?)`)
      .run(startedAt, message);
    return false;
  }
}
