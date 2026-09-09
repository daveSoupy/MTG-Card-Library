import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { EventStore } from './store.ts';

/**
 * Events tie a night's spend, deck and results together without copying any of
 * it onto themselves, and the game log stands on its own for the constructed
 * game that belongs to no event at all.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const deckId = Number(db.prepare(
    `INSERT INTO decks (name, format_code) VALUES ('FDN Pool', 'draft')`,
  ).run().lastInsertRowid);
  const otherDeck = Number(db.prepare(
    `INSERT INTO decks (name, format_code) VALUES ('Atraxa', 'commander')`,
  ).run().lastInsertRowid);
  return { db, events: new EventStore(db), deckId, otherDeck };
}

/** A closed cost pool holding `quantity` copies bought for `total`. */
function costPool(db: Database.Database, total: number, quantity: number): number {
  const batchId = Number(db.prepare(
    `INSERT INTO import_batches (source, file_name, total_cost_usd, split_method)
     VALUES ('manual', 'Draft', ?, 'even')`,
  ).run(total).lastInsertRowid);

  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('o','Bolt','bolt',1,'Instant','x','normal')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number)
              VALUES ('p','o','tst','1')`).run();
  const location = (db.prepare('SELECT id FROM storage_locations LIMIT 1').get() as { id: number }).id;
  db.prepare(`INSERT INTO collection_items (printing_id, location_id, quantity, import_batch_id)
              VALUES ('p', ?, ?, ?)`).run(location, quantity, batchId);
  return batchId;
}

test('an event reads its spend and card counts back through its links', () => {
  const { db, events, deckId } = fixture();
  const batchId = costPool(db, 12, 43);
  db.prepare(`INSERT INTO deck_cards (deck_id, oracle_id, board, quantity)
              VALUES (?, 'o', 'main', 40)`).run(deckId);

  const id = events.create({
    name: 'FDN Draft Night', formatCode: 'draft', eventDate: '2026-03-05',
    deckId, importBatchId: batchId,
  });

  const event = events.get(id)!;
  assert.equal(event.spendUsd, 12);
  assert.equal(event.poolCardCount, 43);
  assert.equal(event.deckCardCount, 40);
  assert.equal(event.deckName, 'FDN Pool');
  assert.equal(event.formatName, 'Draft');
  db.close();
});

test('editing the linked pool moves the event with it', () => {
  const { db, events, deckId } = fixture();
  const batchId = costPool(db, 12, 43);
  const id = events.create({ name: 'Draft', deckId, importBatchId: batchId });

  db.prepare('UPDATE import_batches SET total_cost_usd = 15 WHERE id = ?').run(batchId);
  assert.equal(events.get(id)!.spendUsd, 15, 'nothing was copied onto the event to go stale');
  db.close();
});

test('deleting a linked deck detaches it and leaves the event and its games', () => {
  const { db, events, deckId } = fixture();
  const id = events.create({ name: 'Draft night', deckId });
  events.logGame({ deckId, eventId: id, result: 'win' });

  db.prepare('DELETE FROM decks WHERE id = ?').run(deckId);

  const event = events.get(id)!;
  assert.equal(event.deckId, null, 'the link is cleared, not cascaded');
  assert.equal(event.name, 'Draft night');
  // The games went with the deck — they are that deck's record — but the
  // event itself is still a queryable row.
  assert.equal(event.record.games, 0);
  db.close();
});

test('deleting an event keeps its games, on their deck', () => {
  const { db, events, deckId } = fixture();
  const id = events.create({ name: 'Draft night', deckId });
  events.logGame({ deckId, eventId: id, result: 'win' });
  events.delete(id);

  const record = events.record({ deckId });
  assert.equal(record.wins, 1, 'the game was still played');
  assert.equal(events.games({ deckId })[0].eventId, null);
  db.close();
});

test('a multiplayer game with three opponents is exactly one row', () => {
  const { db, events, deckId } = fixture();
  events.logGame({ deckId, opponents: 'Dave,  Sam , Priya', result: 'loss' });

  const games = events.games({ deckId });
  assert.equal(games.length, 1);
  assert.equal(games[0].opponents, 'Dave, Sam, Priya', 'tidied, not split into rows');
  db.close();
});

test("a deck's lifetime record counts event and kitchen-table games alike", () => {
  const { db, events, deckId } = fixture();
  const eventId = events.create({ name: 'Draft night', deckId });
  events.logGame({ deckId, eventId, result: 'win', roundNumber: 1 });
  events.logGame({ deckId, eventId, result: 'win', roundNumber: 2 });
  events.logGame({ deckId, eventId, result: 'loss', roundNumber: 3 });
  events.logGame({ deckId, result: 'win', opponents: 'Sam' });
  events.logGame({ deckId, result: 'draw', opponents: 'Sam' });

  assert.deepEqual(events.record({ deckId }), { wins: 3, losses: 1, draws: 1, games: 5 });
  assert.deepEqual(events.record({ eventId }), { wins: 2, losses: 1, draws: 0, games: 3 });
  assert.equal(events.get(eventId)!.record.wins, 2);
  db.close();
});

test('a record with no games at all is zeroes, not nulls', () => {
  const { db, events, deckId } = fixture();
  assert.deepEqual(events.record({ deckId }), { wins: 0, losses: 0, draws: 0, games: 0 });
  db.close();
});

test('the record view narrows by format, deck and date range', () => {
  const { db, events, deckId, otherDeck } = fixture();
  events.logGame({ deckId, result: 'win', playedAt: '2026-03-05T20:00:00Z' });
  events.logGame({ deckId, result: 'loss', playedAt: '2026-04-01T20:00:00Z' });
  events.logGame({ deckId: otherDeck, result: 'win', playedAt: '2026-03-05T21:30:00Z' });

  assert.equal(events.record({ formatCode: 'draft' }).games, 2);
  assert.equal(events.record({ formatCode: 'commander' }).games, 1);
  assert.equal(events.record({ deckId }).games, 2);
  // Inclusive at both ends, and on the date part — the 21:30 game belongs to
  // the 5th rather than to the day the range stops.
  assert.equal(events.record({ from: '2026-03-05', to: '2026-03-05' }).games, 2);
  assert.equal(events.record({ from: '2026-03-06' }).games, 1);
  db.close();
});

test('a Bo3 breakdown rides along beneath the match result', () => {
  const { db, events, deckId } = fixture();
  const id = events.logGame({
    deckId, result: 'win', gamesWon: 2, gamesLost: 1, opponents: 'Sam', notes: 'mull to 5',
  });
  const game = events.getGame(id)!;
  assert.equal(game.result, 'win');
  assert.equal(game.gamesWon, 2);
  assert.equal(game.gamesLost, 1);
  assert.equal(game.gamesDrawn, null);
  assert.equal(game.notes, 'mull to 5');
  db.close();
});

test('editing and deleting a game', () => {
  const { db, events, deckId } = fixture();
  const id = events.logGame({ deckId, result: 'loss' });
  events.updateGame(id, { result: 'win', opponents: 'Priya' });

  const game = events.getGame(id)!;
  assert.equal(game.result, 'win');
  assert.equal(game.opponents, 'Priya');

  events.deleteGame(id);
  assert.equal(events.getGame(id), null);
  assert.throws(() => events.deleteGame(id), /No game with id/);
  db.close();
});

test('a missing event or deck is refused rather than silently ignored', () => {
  const { db, events } = fixture();
  assert.equal(events.get(999), null);
  assert.throws(() => events.update(999, { name: 'x' }), /No event with id/);
  assert.throws(() => events.delete(999), /No event with id/);
  assert.throws(() => events.logGame({ deckId: 999, result: 'win' }), /No deck with id/);
  db.close();
});

test('events list newest night first, dated or not', () => {
  const { db, events, deckId } = fixture();
  events.create({ name: 'March', eventDate: '2026-03-05', deckId });
  events.create({ name: 'April', eventDate: '2026-04-02', deckId });
  const undated = events.create({ name: 'Undated', deckId });

  const names = events.list().map((e) => e.name);
  assert.equal(names[0], 'Undated', 'created today, so it sorts by its creation date');
  assert.deepEqual(names.slice(1), ['April', 'March']);
  assert.equal(events.get(undated)!.eventDate, null);
  db.close();
});

test('an event lists its rounds in playing order, the log lists newest first', () => {
  const { db, events, deckId } = fixture();
  const eventId = events.create({ name: 'Draft night', deckId });
  // Logged out of order, the way a forgotten round gets typed in afterwards.
  events.logGame({ deckId, eventId, result: 'win', roundNumber: 3, playedAt: '2026-03-05T21:00:00Z' });
  events.logGame({ deckId, eventId, result: 'win', roundNumber: 1, playedAt: '2026-03-05T19:00:00Z' });
  events.logGame({ deckId, eventId, result: 'loss', roundNumber: 2, playedAt: '2026-03-05T20:00:00Z' });
  events.logGame({ deckId, result: 'draw', playedAt: '2026-04-01T20:00:00Z' });

  assert.deepEqual(
    events.get(eventId)!.games.map((g) => g.roundNumber),
    [1, 2, 3],
    'a night reads from round 1 down',
  );
  assert.deepEqual(
    events.games({ deckId }).map((g) => g.playedAt.slice(0, 10)),
    ['2026-04-01', '2026-03-05', '2026-03-05', '2026-03-05'],
    'the log reads most recent first',
  );
  db.close();
});
