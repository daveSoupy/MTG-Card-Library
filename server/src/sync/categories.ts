import type Database from 'better-sqlite3';
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

/** One row from the oracle_tags bulk file. */
export interface TagRecord {
  id: string;
  slug: string;
  label: string;
  type: string;
  childIds: string[];
  taggings: Array<{ oracleId: string | null; weight: string }>;
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
  const taggings = Array.isArray(raw.taggings)
    ? raw.taggings.map((t: any) => ({
        oracleId: typeof t?.oracle_id === 'string' ? t.oracle_id : null,
        weight: typeof t?.weight === 'string' ? t.weight : 'median',
      }))
    : [];
  return {
    id: String(raw.id),
    slug: String(raw.slug ?? ''),
    label: String(raw.label ?? ''),
    type: raw.type,
    childIds: Array.isArray(raw.child_ids) ? raw.child_ids.map(String) : [],
    taggings,
  };
}

/** Looks up the oracle_tags bulk entry, same listing as the card bulk files. */
async function fetchOracleTagsEntry(): Promise<{ downloadUrl: string }> {
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
  return { downloadUrl };
}

/** Streams and parses every oracle tag from the bulk file. */
export async function fetchOracleTags(): Promise<TagRecord[]> {
  const entry = await fetchOracleTagsEntry();
  const response = await fetch(entry.downloadUrl, { headers: { 'User-Agent': USER_AGENT } });
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
        for (const tagging of tag.taggings) {
          if (tagging.oracleId) oracleIds.add(tagging.oracleId);
        }
        queue.push(...tag.childIds);
      }
    }
    result.set(category, oracleIds);
  }

  return result;
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

/**
 * Fetches, resolves and writes Phase 7's card categories. Never throws —
 * category tracking is a nice-to-have layered on top of the card database,
 * and a card sync that succeeded must not be reported as failed because a
 * community tag file 404s or changes shape. Callers that want to know
 * whether it actually worked get that back as a boolean.
 */
export async function syncCardCategories(db: Database.Database): Promise<boolean> {
  try {
    const tags = await fetchOracleTags();
    const closures = resolveCategoryClosures(tags);
    writeCardCategories(db, closures);
    return true;
  } catch {
    return false;
  }
}
