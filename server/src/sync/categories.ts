import type Database from 'better-sqlite3';
import { getSetting, setSetting } from '../db/index.ts';
import { USER_AGENT } from './scryfall.ts';

/**
 * Phase 7 category resolution, from Scryfall's official 'oracle_tags' bulk
 * file — a first-party export of the community-run Tagger project's
 * functional tags, added to the same /bulk-data listing oracle_cards and
 * default_cards already come from (https://api.scryfall.com/bulk-data,
 * type "oracle_tags"; see https://scryfall.com/docs/api/tags). The phase
 * doc originally scoped this as a raw third-party scrape with no export
 * guarantee; by the time this was built Scryfall had folded it into bulk
 * data proper, so it is fetched with the same fetch/stream machinery as the
 * card sync rather than a separately-pinned URL.
 *
 * Even so, category resolution stays a best-effort step: a failure here must
 * never fail the card sync, which is why every entry point swallows its own
 * errors (see runSync.ts).
 */

/**
 * One row from the oracle_tags bulk file.
 *
 * `taggings` in the file is an array of objects carrying an oracle id and a
 * `weight`; only the id is kept. The weight was parsed into an object per
 * tagging and then read by nothing — 236,260 objects and 236,260 extra
 * strings held for the length of the sideload, measured against the live
 * file. If a weight is ever wanted (ranking a card's fit to a category, say),
 * it comes back as a parallel array or a richer type, not as a field nobody
 * asked for.
 */
export interface TagRecord {
  id: string;
  slug: string;
  label: string;
  type: string;
  childIds: string[];
  /** Oracle ids this tag is applied to; nulls in the file are dropped. */
  oracleIds: string[];
}

/**
 * category -> the root tag's slug. Matched by slug exactly once per
 * category; every card thereafter is resolved by walking tag ids, never by
 * re-matching a label — labels are inconsistent ('removal-creature' with a
 * hyphen, 'spot removal' with a space) in a way ids are not.
 */
export const CATEGORY_ROOTS: Record<string, string> = {
  removal: 'removal',
  draw: 'draw',
  ramp: 'ramp',
  recursion: 'recursion',
  protection: 'protection',
  tutor: 'tutor',
  sweeper: 'sweeper',
  counterspell: 'counterspell',
};

/** Human labels for the categories above, for anywhere the UI shows one. */
export const CATEGORY_LABELS: Record<string, string> = {
  removal: 'Removal',
  draw: 'Card draw',
  ramp: 'Ramp',
  recursion: 'Recursion',
  protection: 'Protection',
  tutor: 'Tutor',
  sweeper: 'Board wipes',
  counterspell: 'Counterspell',
};

function normalizeTag(raw: any): TagRecord | null {
  if (!raw || raw.object !== 'tag' || raw.type !== 'oracle') return null;
  const oracleIds: string[] = [];
  if (Array.isArray(raw.taggings)) {
    for (const t of raw.taggings) if (typeof t?.oracle_id === 'string') oracleIds.push(t.oracle_id);
  }
  return {
    id: String(raw.id),
    slug: String(raw.slug ?? ''),
    label: String(raw.label ?? ''),
    type: raw.type,
    childIds: Array.isArray(raw.child_ids) ? raw.child_ids.map(String) : [],
    oracleIds,
  };
}

/** Looks up the oracle_tags bulk entry, same listing as the card bulk files. */
async function fetchOracleTagsEntry(): Promise<{ downloadUrl: string; updatedAt: string }> {
  const response = await fetch('https://api.scryfall.com/bulk-data', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Scryfall returned HTTP ${response.status} for the bulk-data listing.`);
  }
  const body: any = await response.json();
  const entry = Array.isArray(body?.data) ? body.data.find((e: any) => e?.type === 'oracle_tags') : null;
  if (!entry) throw new Error('Scryfall is not currently publishing an "oracle_tags" bulk file.');
  const downloadUrl = entry.jsonl_download_uri ?? entry.download_uri;
  if (!downloadUrl) throw new Error('The "oracle_tags" bulk entry had no download URI.');
  // The tag file is republished on its own schedule, independent of the card
  // bulk files, so its own updated_at is the only thing that can say whether
  // this download would be a no-op.
  return { downloadUrl, updatedAt: String(entry.updated_at ?? '') };
}

/** Streams and parses every oracle tag from the bulk file. */
export async function fetchOracleTags(entry?: { downloadUrl: string }): Promise<TagRecord[]> {
  const resolved = entry ?? await fetchOracleTagsEntry();
  const response = await fetch(resolved.downloadUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`Downloading the oracle tags file failed with HTTP ${response.status}.`);
  }

  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const decode = new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>;
  const lines = response.body.pipeThrough(gunzip).pipeThrough(decode);

  const tags: TagRecord[] = [];
  let buffer = '';
  for await (const chunk of lines as unknown as AsyncIterable<string>) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const tag = normalizeTag(JSON.parse(line));
      if (tag) tags.push(tag);
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) {
    const tag = normalizeTag(JSON.parse(tail));
    if (tag) tags.push(tag);
  }
  return tags;
}

/**
 * Walks each category's root tag transitively through child_ids and unions
 * every descendant tag's taggings. Pure and network-free, so the closure
 * logic is directly testable against a small fixture.
 */
export function resolveCategoryClosures(tags: TagRecord[]): Map<string, Set<string>> {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const bySlug = new Map(tags.map((t) => [t.slug, t]));
  const result = new Map<string, Set<string>>();

  for (const [category, rootSlug] of Object.entries(CATEGORY_ROOTS)) {
    const root = bySlug.get(rootSlug);
    const oracleIds = new Set<string>();
    if (root) {
      const seen = new Set<string>();
      const queue = [root.id];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const tag = byId.get(id);
        if (!tag) continue;
        for (const tagged of tag.oracleIds) oracleIds.add(tagged);
        queue.push(...tag.childIds);
      }
    }
    result.set(category, oracleIds);
  }

  return result;
}

/**
 * Sync bookkeeping, alongside loaded_bulk_updated_at / last_bulk_sync_at.
 * Machine-written, so deliberately not registered in the settings route's
 * allowlists — there is nothing here for a client to set.
 */
const LOADED_KEY = 'loaded_oracle_tags_updated_at';
const SYNCED_AT_KEY = 'last_category_sync_at';
const ERROR_KEY = 'last_category_sync_error';

/** Its own sync_log row, independent of the card sync's, the same way
 *  rulings.ts records its run — so "did this ever work?" has an answer. */
function logRun(
  db: Database.Database,
  startedAt: string,
  status: 'success' | 'failed',
  rows: number | null,
  error: string | null,
): void {
  db.prepare(`
    INSERT INTO sync_log (bulk_type, started_at, finished_at, status, printings_upserted, error_message)
    VALUES ('oracle_tags', ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), ?, ?, ?)`)
    .run(startedAt, status, rows, error);
}

/** Rewrites card_categories in one transaction, dropping unknown oracle ids. */
export function writeCardCategories(db: Database.Database, closures: Map<string, Set<string>>): number {
  const known = new Set(
    (db.prepare('SELECT oracle_id FROM oracle_cards').pluck().all() as string[]),
  );

  return db.transaction(() => {
    db.exec('DELETE FROM card_categories');
    const insert = db.prepare('INSERT INTO card_categories (oracle_id, category) VALUES (?, ?)');
    let written = 0;
    for (const [category, oracleIds] of closures) {
      for (const oracleId of oracleIds) {
        if (!known.has(oracleId)) continue;
        insert.run(oracleId, category);
        written += 1;
      }
    }
    return written;
  })();
}

/** What a category resolution actually did, so a caller can say so. */
export interface CategorySyncResult {
  status: 'done' | 'skipped' | 'failed';
  /** Rows written. Zero for a skip, and for a failure that wrote nothing. */
  rows: number;
  /** The tag file's own updated_at, when the listing was reachable. */
  updatedAt: string | null;
  error: string | null;
}

/** Whether any card has ever been categorised — the difference between "this
 *  deck has no ramp" and "nothing has been resolved yet". */
export function hasCardCategories(db: Database.Database): boolean {
  return (db.prepare('SELECT EXISTS(SELECT 1 FROM card_categories) AS n').get() as { n: number }).n === 1;
}

/**
 * Fetches, resolves and writes Phase 7's card categories.
 *
 * Never throws — category tracking is a nice-to-have layered on top of the
 * card database, and a card sync that succeeded must not be reported as
 * failed because a tag file 404s or changes shape. What it does now do is
 * record what it swallowed: a settings key, a sync_log row and a returned
 * result, because a silently empty card_categories reads downstream as
 * "your deck contains no removal" rather than as a broken sync.
 *
 * Skips only when the published file is one this database has already loaded
 * *and* there are rows to show for it. Both halves matter: the row check is
 * what catches a database populated before this feature existed, and the
 * timestamp is what catches a tag file that was republished while the card
 * bulk file stood still. The listing is small, so a skip costs one JSON
 * fetch rather than the multi-megabyte download.
 */
export async function syncCardCategories(
  db: Database.Database,
  { force = false }: { force?: boolean } = {},
): Promise<CategorySyncResult> {
  const startedAt = new Date().toISOString();
  try {
    const entry = await fetchOracleTagsEntry();
    if (!force
        && entry.updatedAt !== ''
        && getSetting(db, LOADED_KEY) === entry.updatedAt
        && hasCardCategories(db)) {
      return { status: 'skipped', rows: 0, updatedAt: entry.updatedAt, error: null };
    }

    const tags = await fetchOracleTags(entry);
    const rows = writeCardCategories(db, resolveCategoryClosures(tags));

    setSetting(db, LOADED_KEY, entry.updatedAt);
    setSetting(db, SYNCED_AT_KEY, new Date().toISOString());
    setSetting(db, ERROR_KEY, '');
    logRun(db, startedAt, 'success', rows, null);
    return { status: 'done', rows, updatedAt: entry.updatedAt, error: null };
  } catch (error) {
    // Deliberately swallowed, but no longer silent. Any rows already written
    // by an earlier run are left exactly as they were.
    const message = error instanceof Error ? error.message : String(error);
    setSetting(db, ERROR_KEY, message);
    logRun(db, startedAt, 'failed', null, message);
    return { status: 'failed', rows: 0, updatedAt: null, error: message };
  }
}
