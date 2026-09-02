import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCHEMA_PATH } from '../db/index.ts';
import { cacheLimitBytes, cacheSizeBytes, evictImages, UsageRecorder } from './cache.ts';
import { FetchQueue } from './fetchQueue.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function seeded(dir: string, count: number, bytesEach: number) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('o1','C','c',1,'Instant','x','normal')`).run();

  const printing = db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number)
                               VALUES (?,'o1','tst',?)`);
  const cache = db.prepare(`INSERT INTO image_cache
    (printing_id, face_index, size, file_path, byte_size, downloaded_at, last_used_at)
    VALUES (?,0,'small',?,?,?,?)`);

  for (let i = 0; i < count; i += 1) {
    const path = join(dir, `img-${i}.jpg`);
    writeFileSync(path, Buffer.alloc(bytesEach));
    printing.run(`p-${i}`, String(i));
    // Ascending timestamps, so p-0 is the least recently used.
    const stamp = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`;
    cache.run(`p-${i}`, path, bytesEach, stamp, stamp);
  }
  return db;
}

test('the configured limit is read, not ignored', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  // Seeded in schema.sql since the beginning and, until now, read by nothing.
  assert.equal(cacheLimitBytes(db), 2 * 1024 * 1024 * 1024);
  db.prepare(`UPDATE app_settings SET value = '1048576' WHERE key = 'image_cache_max_bytes'`).run();
  assert.equal(cacheLimitBytes(db), 1048576);
  db.close();
});

test('eviction removes the least recently used first, and deletes the files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-img-'));
  const db = seeded(dir, 10, 1000);      // 10,000 bytes total
  assert.equal(cacheSizeBytes(db), 10000);

  const removed = await evictImages(db, 5000);
  assert.ok(removed > 0);
  assert.ok(cacheSizeBytes(db) <= 4500, `now ${cacheSizeBytes(db)}, should trim below 90% of 5000`);

  // p-0 was the oldest, so it goes; the newest must survive.
  const survivors = db.prepare('SELECT printing_id FROM image_cache').all().map((r: any) => r.printing_id);
  assert.ok(!survivors.includes('p-0'));
  assert.ok(survivors.includes('p-9'));

  // Files go too — a cascade would drop the row and orphan the file forever.
  assert.equal(existsSync(join(dir, 'img-0.jpg')), false);
  assert.equal(existsSync(join(dir, 'img-9.jpg')), true);

  db.close(); rmSync(dir, { recursive: true, force: true });
});

test('a cache under the limit is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-img-'));
  const db = seeded(dir, 5, 100);
  assert.equal(await evictImages(db, 10000), 0);
  assert.equal(cacheSizeBytes(db), 500);
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test('a missing file does not stop the row being evicted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-img-'));
  const db = seeded(dir, 4, 1000);
  rmSync(join(dir, 'img-0.jpg'));
  const removed = await evictImages(db, 1000);
  assert.ok(removed >= 3);
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test('usage stamps are batched, then written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-img-'));
  const db = seeded(dir, 3, 100);
  const before = db.prepare(`SELECT last_used_at FROM image_cache WHERE printing_id='p-0'`).get() as any;

  const recorder = new UsageRecorder(db, 10_000);
  recorder.touch('p-0', 0, 'small');
  recorder.touch('p-0', 0, 'small');   // same key twice collapses
  recorder.touch('p-1', 0, 'small');

  // Nothing written yet — that is the point of batching.
  const during = db.prepare(`SELECT last_used_at FROM image_cache WHERE printing_id='p-0'`).get() as any;
  assert.equal(during.last_used_at, before.last_used_at);

  recorder.flush();
  const after = db.prepare(`SELECT last_used_at FROM image_cache WHERE printing_id='p-0'`).get() as any;
  assert.notEqual(after.last_used_at, before.last_used_at, 'a hit must update the LRU stamp');

  db.close(); rmSync(dir, { recursive: true, force: true });
});

test('the queue fetches once per key however many ask at the same time', async () => {
  const queue = new FetchQueue(4);
  let calls = 0;
  const work = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return Buffer.from('x');
  };

  // Sixty tiles, one image — what a page of duplicate art actually looks like.
  const results = await Promise.all(Array.from({ length: 60 }, () => queue.run('same', work)));
  assert.equal(calls, 1, 'one download, not sixty');
  assert.equal(results.length, 60);
  assert.ok(results.every((r) => r.toString() === 'x'), 'every caller gets the bytes');
});

test('the queue never runs more than its limit at once', async () => {
  const queue = new FetchQueue(3);
  let active = 0;
  let peak = 0;
  const work = async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return Buffer.from('x');
  };

  await Promise.all(Array.from({ length: 20 }, (_, i) => queue.run(`k${i}`, work)));
  assert.ok(peak <= 3, `peak concurrency was ${peak}, cap is 3`);
});

test('a failed fetch is not cached as in-flight forever', async () => {
  const queue = new FetchQueue(2);
  await assert.rejects(queue.run('k', async () => { throw new Error('502'); }));
  // The key must be free again, or one blip would poison that image for the
  // lifetime of the process.
  const ok = await queue.run('k', async () => Buffer.from('y'));
  assert.equal(ok.toString(), 'y');
});
