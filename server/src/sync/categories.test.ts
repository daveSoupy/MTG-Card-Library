import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { resolveCategoryClosures, writeCardCategories, syncCardCategories, type TagRecord } from './categories.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function tag(id: string, slug: string, childIds: string[], oracleIds: string[]): TagRecord {
  return { id, slug, label: slug, type: 'oracle', childIds, oracleIds };
}

test('a root tag with no direct taggings resolves through its children', () => {
  // 'removal' itself tags nothing directly — only its subtags ('destroy',
  // 'exile') carry taggings. A closure that returns 0 here means child_ids
  // were never walked.
  const tags: TagRecord[] = [
    tag('t-removal', 'removal', ['t-destroy', 't-exile'], []),
    tag('t-destroy', 'destroy', [], ['o-doom-blade']),
    tag('t-exile', 'exile', ['t-path'], ['o-swords']),
    tag('t-path', 'path', [], ['o-path-to-exile']),
  ];

  const closures = resolveCategoryClosures(tags);
  assert.deepEqual(
    [...closures.get('removal')!].sort(),
    ['o-doom-blade', 'o-path-to-exile', 'o-swords'],
  );
});

test('a card tagged under two different roots counts toward both categories', () => {
  const tags: TagRecord[] = [
    tag('t-ramp', 'ramp', [], ['o-cultivate']),
    tag('t-draw', 'draw', [], ['o-cultivate']),
  ];
  const closures = resolveCategoryClosures(tags);
  assert.ok(closures.get('ramp')!.has('o-cultivate'));
  assert.ok(closures.get('draw')!.has('o-cultivate'));
});

test('a category with no matching root tag resolves empty rather than throwing', () => {
  const closures = resolveCategoryClosures([]);
  for (const category of ['removal', 'ramp', 'draw', 'recursion', 'protection', 'tutor', 'sweeper', 'counterspell']) {
    assert.equal(closures.get(category)?.size ?? 0, 0);
  }
});

test('writeCardCategories drops oracle ids the card database does not know', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, oracle_text_all)
              VALUES ('o-known', 'Known Card', 'known card', '')`).run();

  const closures = new Map([['ramp', new Set(['o-known', 'o-unknown'])]]);
  const written = writeCardCategories(db, closures);

  assert.equal(written, 1);
  const rows = db.prepare('SELECT oracle_id, category FROM card_categories').all() as any[];
  assert.deepEqual(rows, [{ oracle_id: 'o-known', category: 'ramp' }]);
  db.close();
});

test('syncCardCategories never throws — a card sync must survive the tag source going away', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('DNS failure, or a 404, or anything else'); }) as typeof fetch;
  try {
    const db = new Database(':memory:');
    db.exec(SCHEMA);
    const result = await syncCardCategories(db);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /DNS failure/);
    // No rows written, but no throw either — the caller's card sync is untouched.
    assert.equal((db.prepare('SELECT count(*) AS n FROM card_categories').get() as any).n, 0);
    db.close();
  } finally {
    globalThis.fetch = original;
  }
});

test('writeCardCategories replaces the whole table rather than accumulating', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, oracle_text_all)
              VALUES ('o-a', 'A', 'a', '')`).run();

  writeCardCategories(db, new Map([['ramp', new Set(['o-a'])]]));
  writeCardCategories(db, new Map([['draw', new Set(['o-a'])]]));

  const rows = db.prepare('SELECT category FROM card_categories').all() as Array<{ category: string }>;
  assert.deepEqual(rows.map((r) => r.category), ['draw']);
  db.close();
});

// ------------------------------------------------ Phase 7 revival: gating

import { gzipSync } from 'node:zlib';
import { getSetting, setSetting } from '../db/index.ts';

/** A fake Scryfall: the small bulk listing, then a gzipped JSONL tag file. */
function stubScryfall(updatedAt: string, tags: TagRecord[]) {
  return (async (url: string | URL) => {
    const href = String(url);
    if (href.includes('/bulk-data')) {
      return new Response(JSON.stringify({
        data: [{
          object: 'bulk_data', type: 'oracle_tags', updated_at: updatedAt,
          jsonl_download_uri: 'https://example.test/oracle-tags.jsonl.gz',
        }],
      }), { status: 200 });
    }
    const body = tags.map((t) => JSON.stringify({
      object: 'tag', type: 'oracle', id: t.id, slug: t.slug, label: t.label,
      child_ids: t.childIds,
      // The real file's taggings carry a weight the parser ignores; emit one
      // so "ignores it" is what this exercises rather than "never saw one".
      taggings: t.oracleIds.map((oracleId) => ({ oracle_id: oracleId, weight: 'median' })),
    })).join('\n');
    return new Response(gzipSync(Buffer.from(body)), { status: 200 });
  }) as unknown as typeof fetch;
}

function libraryWithOneCard() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, oracle_text_all)
              VALUES ('o-a', 'A', 'a', '')`).run();
  return db;
}

async function withStub<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('an empty card_categories re-runs even when the tag file has not moved', async () => {
  // The Phase 7 bug in miniature: this database was populated before card
  // categories existed, so the "already loaded" timestamp is no reason to
  // skip — there is nothing to skip past.
  const db = libraryWithOneCard();
  setSetting(db, 'loaded_oracle_tags_updated_at', '2026-09-08T21:00:00Z');

  const result = await withStub(
    stubScryfall('2026-09-08T21:00:00Z', [tag('t1', 'ramp', [], ['o-a'])]),
    () => syncCardCategories(db),
  );

  assert.equal(result.status, 'done');
  assert.equal(result.rows, 1);
  db.close();
});

test('an unchanged tag file with rows already written is skipped', async () => {
  const db = libraryWithOneCard();
  const stub = stubScryfall('2026-09-08T21:00:00Z', [tag('t1', 'ramp', [], ['o-a'])]);

  await withStub(stub, () => syncCardCategories(db));
  const second = await withStub(stub, () => syncCardCategories(db));

  assert.equal(second.status, 'skipped');
  assert.equal(second.rows, 0);
  // The rows the first run wrote are still there.
  assert.equal((db.prepare('SELECT count(*) AS n FROM card_categories').get() as any).n, 1);
  db.close();
});

test('a republished tag file re-runs even with rows already written', async () => {
  const db = libraryWithOneCard();
  await withStub(stubScryfall('2026-09-08T21:00:00Z', [tag('t1', 'ramp', [], ['o-a'])]),
                 () => syncCardCategories(db));

  const result = await withStub(
    stubScryfall('2026-09-09T21:00:00Z', [tag('t1', 'draw', [], ['o-a'])]),
    () => syncCardCategories(db),
  );

  assert.equal(result.status, 'done');
  assert.equal(getSetting(db, 'loaded_oracle_tags_updated_at'), '2026-09-09T21:00:00Z');
  const rows = db.prepare('SELECT category FROM card_categories').pluck().all();
  assert.deepEqual(rows, ['draw']);
  db.close();
});

test('force resolves even when nothing has changed', async () => {
  const db = libraryWithOneCard();
  const stub = stubScryfall('2026-09-08T21:00:00Z', [tag('t1', 'ramp', [], ['o-a'])]);
  await withStub(stub, () => syncCardCategories(db));

  const forced = await withStub(stub, () => syncCardCategories(db, { force: true }));
  assert.equal(forced.status, 'done');
  db.close();
});

test('a run records what it did, so a silent failure can never look like an empty deck', async () => {
  const db = libraryWithOneCard();
  await withStub(stubScryfall('2026-09-08T21:00:00Z', [tag('t1', 'ramp', [], ['o-a'])]),
                 () => syncCardCategories(db));

  const ok = db.prepare("SELECT * FROM sync_log WHERE bulk_type = 'oracle_tags'").get() as any;
  assert.equal(ok.status, 'success');
  assert.equal(ok.printings_upserted, 1);
  assert.ok(getSetting(db, 'last_category_sync_at'));
  assert.equal(getSetting(db, 'last_category_sync_error'), '');

  // A later failure is recorded too, and leaves the existing rows alone.
  const failed = await withStub(
    (async () => { throw new Error('the tag file went away'); }) as unknown as typeof fetch,
    () => syncCardCategories(db, { force: true }),
  );
  assert.equal(failed.status, 'failed');
  assert.match(getSetting(db, 'last_category_sync_error') ?? '', /went away/);
  const rows = db.prepare("SELECT status FROM sync_log WHERE bulk_type = 'oracle_tags' ORDER BY id").pluck().all();
  assert.deepEqual(rows, ['success', 'failed']);
  assert.equal((db.prepare('SELECT count(*) AS n FROM card_categories').get() as any).n, 1);
  db.close();
});
