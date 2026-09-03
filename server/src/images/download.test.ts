import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_PATH, setSetting } from '../db/index.ts';
import { FetchQueue } from './fetchQueue.ts';
import { fetchAndCacheImage } from './fetch.ts';
import { ImageDownloadManager, CacheLimitError } from './downloadManager.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

/** A stub Scryfall that hands back a fixed image and counts calls. */
function stubFetch() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(Buffer.from('fake-image-bytes'), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, get calls() { return calls; } };
}

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();

  // Three cards, each with one printing that carries both image sizes.
  for (let i = 1; i <= 3; i += 1) {
    const oid = `o${i}`;
    const pid = `p${i}`;
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout) VALUES (?,?,?,1,'Creature','x','normal')`)
      .run(oid, `Card ${i}`, `card ${i}`);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity,
                  image_small,image_normal)
                VALUES (?,?,'tst',?,'common',?,?)`)
      .run(pid, oid, String(i), `http://img/${pid}/small.jpg`, `http://img/${pid}/normal.jpg`);
    db.prepare('UPDATE oracle_cards SET default_printing_id=? WHERE oracle_id=?').run(pid, oid);
  }

  // A deck referencing card 1, and a collection lot referencing card 2. Card 3
  // is referenced by nothing.
  db.prepare(`INSERT INTO decks (name,format_code) VALUES ('D','modern')`).run();
  db.prepare(`INSERT INTO deck_cards (deck_id,oracle_id,board,quantity) VALUES (1,'o1','main',1)`).run();
  db.prepare(`INSERT INTO storage_locations (name) VALUES ('Box')`).run();
  db.prepare(`INSERT INTO collection_items (printing_id,location_id,quantity) VALUES ('p2',1,1)`).run();

  const imageDir = mkdtempSync(join(tmpdir(), 'mtg-img-'));
  return { db, imageDir };
}

const drain = async (mgr: ImageDownloadManager) => {
  while (mgr.isRunning) await new Promise((r) => setTimeout(r, 5));
};

test('fetchAndCacheImage writes once and is a no-op the second time', async () => {
  const { db, imageDir } = fixture();
  const stub = stubFetch();
  const queue = new FetchQueue(4);
  try {
    const first = await fetchAndCacheImage(db, imageDir, queue, 'p1', 0, 'small');
    assert.equal(first.status, 'downloaded');
    assert.ok(first.bytes > 0);
    assert.equal(stub.calls, 1);

    const row = db.prepare(
      `SELECT file_path, byte_size FROM image_cache WHERE printing_id='p1' AND face_index=0 AND size='small'`,
    ).get() as { file_path: string; byte_size: number };
    assert.ok(existsSync(row.file_path));
    assert.equal(row.byte_size, first.bytes);

    const second = await fetchAndCacheImage(db, imageDir, queue, 'p1', 0, 'small');
    assert.equal(second.status, 'cached');
    assert.equal(stub.calls, 1, 'no second network call for a cached image');
  } finally {
    stub.restore();
    db.close();
  }
});

test('the referenced scope covers only cards the user uses', async () => {
  const { db, imageDir } = fixture();
  const stub = stubFetch();
  const mgr = new ImageDownloadManager(db, imageDir);
  try {
    // Card 1 (deck) and card 2 (collection): 2 printings x small+normal = 4.
    const before = mgr.referencedCoverage();
    assert.equal(before.referenced, 4);
    assert.equal(before.cached, 0);

    mgr.start('referenced');
    await drain(mgr);
    const state = mgr.current;
    assert.equal(state.total, 4);
    assert.equal(state.downloaded, 4);
    assert.equal(state.failed, 0);

    // Card 3 was never referenced, so its art was not fetched.
    const cachedIds = (db.prepare('SELECT DISTINCT printing_id AS p FROM image_cache').all() as Array<{ p: string }>)
      .map((r) => r.p).sort();
    assert.deepEqual(cachedIds, ['p1', 'p2']);
    assert.equal(mgr.referencedCoverage().cached, 4);
  } finally {
    stub.restore();
    db.close();
  }
});

test('a re-run downloads nothing that is already cached', async () => {
  const { db, imageDir } = fixture();
  const stub = stubFetch();
  const mgr = new ImageDownloadManager(db, imageDir);
  try {
    mgr.start('referenced');
    await drain(mgr);
    const after = stub.calls;

    mgr.start('referenced');
    await drain(mgr);
    assert.equal(mgr.current.total, 0, 'nothing left to do');
    assert.equal(stub.calls, after, 'no further network calls');
  } finally {
    stub.restore();
    db.close();
  }
});

test('the full scope covers every printing', async () => {
  const { db, imageDir } = fixture();
  const stub = stubFetch();
  const mgr = new ImageDownloadManager(db, imageDir);
  try {
    mgr.start('all');
    await drain(mgr);
    // 3 printings x small+normal.
    assert.equal(mgr.current.total, 6);
    assert.equal(mgr.current.downloaded, 6);
    assert.equal(readdirSync(imageDir).length > 0, true);
  } finally {
    stub.restore();
    db.close();
  }
});

test('a full download is refused when it would not fit the cache cap', async () => {
  const { db, imageDir } = fixture();
  const stub = stubFetch();
  const mgr = new ImageDownloadManager(db, imageDir);
  try {
    setSetting(db, 'image_cache_max_bytes', '1'); // 1 byte cap
    assert.throws(() => mgr.start('all'), CacheLimitError);
    assert.equal(mgr.isRunning, false);

    // Raise the cap above the estimate and it starts.
    setSetting(db, 'image_cache_max_bytes', String(mgr.estimateFullBytes() + 1));
    const state = mgr.start('all');
    assert.equal(state.running, true);
    await drain(mgr);
  } finally {
    stub.restore();
    db.close();
  }
});
