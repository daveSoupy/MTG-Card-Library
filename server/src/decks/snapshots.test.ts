import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { DeckStore } from './store.ts';
import { takeSnapshot, listSnapshots, diffSnapshot, restoreSnapshot } from './snapshots.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

const CARDS = [
  { id: 'o-atraxa', name: "Atraxa, Praetors' Voice", type: 'Legendary Creature — Angel',
    mask: 1 | 2 | 4 | 16, legendary: 1, price: 20 },
  { id: 'o-bolt', name: 'Lightning Bolt', type: 'Instant', mask: 8, legendary: 0, price: 2 },
  { id: 'o-sol', name: 'Sol Ring', type: 'Artifact', mask: 0, legendary: 0, price: 3 },
  { id: 'o-krenko', name: 'Krenko, Mob Boss', type: 'Legendary Creature — Goblin',
    mask: 8, legendary: 1, price: 5 },
  { id: 'o-mountain', name: 'Mountain', type: 'Basic Land', mask: 8, legendary: 0, price: 0.1 },
  { id: 'o-jewel', name: 'Jeweled Lotus', type: 'Artifact', mask: 0, legendary: 0, price: 90 },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  CARDS.forEach((c, i) => {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,color_identity_mask,is_legendary)
                VALUES (?,?,?,1,?,'x','normal',?,?)`)
      .run(c.id, c.name, c.name.toLowerCase(), c.type, c.mask, c.legendary);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
                VALUES (?,?,'tst',?,?)`).run(`p-${i}`, c.id, String(i), c.price);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?').run(`p-${i}`, c.id);
  });
  return { db, decks: new DeckStore(db) };
}

test('a snapshot restores a deck exactly, allocation included', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Test', formatCode: 'commander' });
  decks.addCard(id, 'o-bolt', { quantity: 4 });
  decks.addCard(id, 'o-sol', { quantity: 1 });

  const snapshotId = takeSnapshot(db, id, 'Before rebuild');

  // Rebuild it into something else entirely.
  const before = decks.get(id)!;
  for (const card of before.cards) decks.removeCard(id, card.id);
  decks.addCard(id, 'o-krenko', { quantity: 1 });
  assert.equal(decks.get(id)!.cards.length, 1);

  restoreSnapshot(db, snapshotId);
  const after = decks.get(id)!;
  assert.deepEqual(
    after.cards.map((c) => [c.oracleId, c.quantity, c.board]).sort(),
    [['o-bolt', 4, 'main'], ['o-sol', 1, 'main']].sort(),
  );
  db.close();
});

test('restoring snapshots the current state first, so it is not lost', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Test' });
  decks.addCard(id, 'o-bolt', { quantity: 1 });
  const first = takeSnapshot(db, id, 'One');

  decks.addCard(id, 'o-sol', { quantity: 1 });
  restoreSnapshot(db, first);

  const snapshots = listSnapshots(db, id);
  // The automatic one has to exist, or "restore, then realise" loses the deck.
  assert.ok(snapshots.some((s) => s.name === 'Before restore'), JSON.stringify(snapshots));
  const auto = snapshots.find((s) => s.name === 'Before restore')!;
  assert.equal(auto.uniqueCards, 2, 'it captured the deck as it was, not as restored');
  db.close();
});

test('a diff names what was added, removed and changed', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Test' });
  decks.addCard(id, 'o-bolt', { quantity: 4 });
  decks.addCard(id, 'o-sol', { quantity: 1 });
  const snapshotId = takeSnapshot(db, id, 'Base');

  const cards = decks.get(id)!.cards;
  decks.setQuantity(id, cards.find((c) => c.oracleId === 'o-bolt')!.id, 2);   // changed
  decks.setQuantity(id, cards.find((c) => c.oracleId === 'o-sol')!.id, 0);    // removed
  decks.addCard(id, 'o-krenko', { quantity: 1 });                            // added

  const diff = diffSnapshot(db, snapshotId)!;
  assert.deepEqual(diff.added.map((d) => d.name), ['Krenko, Mob Boss']);
  assert.deepEqual(diff.removed.map((d) => d.name), ['Sol Ring']);
  assert.deepEqual(diff.changed.map((d) => [d.name, d.from, d.to]), [['Lightning Bolt', 4, 2]]);
  db.close();
});

test('moving a card between boards reads as a move, not as no change', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Test' });
  decks.addCard(id, 'o-bolt', { quantity: 2, board: 'main' });
  const snapshotId = takeSnapshot(db, id, 'Base');

  const card = decks.get(id)!.cards[0];
  decks.setBoard(id, card.id, 'side');

  const diff = diffSnapshot(db, snapshotId)!;
  assert.equal(diff.removed.length, 1, 'gone from main');
  assert.equal(diff.removed[0].board, 'main');
  assert.equal(diff.added.length, 1, 'arrived in the sideboard');
  assert.equal(diff.added[0].board, 'side');
  db.close();
});

test('an unchanged deck diffs to nothing', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Test' });
  decks.addCard(id, 'o-bolt', { quantity: 4 });
  const diff = diffSnapshot(db, takeSnapshot(db, id, 'Base'))!;
  assert.deepEqual([diff.added, diff.removed, diff.changed], [[], [], []]);
  assert.equal(diff.unchanged, 1);
  db.close();
});

test('deleting a deck takes its snapshots with it', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Test' });
  decks.addCard(id, 'o-bolt', { quantity: 1 });
  takeSnapshot(db, id, 'One');
  assert.equal(listSnapshots(db, id).length, 1);

  decks.delete(id);
  assert.equal(listSnapshots(db, id).length, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM deck_snapshot_cards').get() as any).n, 0,
    'the card rows go too, not just the snapshot header');
  db.close();
});
