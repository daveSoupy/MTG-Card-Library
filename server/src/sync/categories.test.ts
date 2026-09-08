import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { resolveCategoryClosures, writeCardCategories, syncCardCategories, type TagRecord } from './categories.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function tag(id: string, slug: string, childIds: string[], oracleIds: string[]): TagRecord {
  return {
    id, slug, label: slug, type: 'oracle', childIds,
    taggings: oracleIds.map((oracleId) => ({ oracleId, weight: 'median' })),
  };
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
    const ok = await syncCardCategories(db);
    assert.equal(ok, false);
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
