import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, setSetting } from '../db/index.ts';
import { AlertStore } from '../alerts/store.ts';
import { CollectionStore } from '../collection/store.ts';
import { TradeListStore } from '../tradelists/store.ts';
import { TradeStore } from '../trades/store.ts';
import { DeckStore } from './store.ts';
import { buildabilityForDecks } from './buildability.ts';
import { openAssemblyRun, setItemPicked, completeRun } from './assembly.ts';
import {
  ALLOCATION_IGNORES_BASICS, BREWS_RESERVE_COPIES, TRADELIST_REDUCES_AVAILABLE,
} from './allocation.ts';
import {
  cardHolders, contestedCards, reassign, reconcileAlerts, reconcileAllAlerts, whatIf,
} from './contention.ts';

/**
 * Phase 26 — which decks are fighting over which copies.
 *
 * Two things are proved here. That the contested set is *right* under the
 * derived claim — a fight that reconciliation settled first-come-first-served
 * is still a fight, and a deck that is merely unfinished is not one. And that
 * the alert tracks it at every write that can change it: a trigger missing
 * from `reconcileAlerts`'s list is a stale alert, so each row of that list is
 * a test below.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

interface CardSpec { id: string; name: string; price?: number | null; basic?: boolean }

function fixture(cards: CardSpec[] = [{ id: 'a', name: 'Alpha', price: 10 }]) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  for (const [index, card] of cards.entries()) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,is_basic_land)
                VALUES (?,?,?,1,?,'x','normal',?)`)
      .run(card.id, card.name, card.name.toLowerCase(),
        card.basic ? 'Basic Land' : 'Artifact', card.basic ? 1 : 0);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
                VALUES (?,?,'tst',?,?)`).run(`p-${card.id}`, card.id, String(index + 1), card.price ?? 1);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${card.id}`, card.id);
  }
  const binder = Number(db.prepare(
    "INSERT INTO storage_locations (name, kind, sort_order) VALUES ('Binder','binder',1)",
  ).run().lastInsertRowid);

  const collection = new CollectionStore(db);
  const alerts = new AlertStore(db);
  return {
    db,
    binder,
    collection,
    alerts,
    decks: new DeckStore(db),
    tradeLists: new TradeListStore(db),
    trades: new TradeStore(db, collection, alerts),
  };
}

type Fixture = ReturnType<typeof fixture>;

/** A deck in a reserving status, listing the cards given. */
function built(f: Fixture, name: string, cards: Array<[string, number]>, status = 'assembled') {
  const id = f.decks.create({ name, formatCode: null, description: null });
  f.decks.update(id, { status: status as any });
  for (const [oracleId, quantity] of cards) f.decks.addCard(id, oracleId, { quantity });
  return id;
}

const own = (f: Fixture, oracleId: string, quantity: number) =>
  f.collection.addLot({ printingId: `p-${oracleId}`, locationId: f.binder, quantity });

const claim = (f: Fixture, deckId: number, oracleId: string) =>
  f.decks.get(deckId)!.cards.find((c) => c.oracleId === oracleId)!.quantityFromCollection;

const activeAlerts = (f: Fixture) =>
  f.alerts.list({ state: 'active' }).filter((a) => a.kind === 'allocation_conflict');

const contestedIds = (f: Fixture) => contestedCards(f.db).map((c) => c.oracleId);

// -- the contested set ----------------------------------------------------------

test('one copy, two built decks: contested with shortfall 1; demote one and it leaves', () => {
  const f = fixture();
  own(f, 'a', 1);
  const first = built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);

  // First come first served: the second deck's claim reconciled to 0. That is
  // not the end of the fight, it is what the fight looks like now.
  assert.equal(claim(f, first, 'a'), 1);
  assert.equal(claim(f, second, 'a'), 0);

  const [card] = contestedCards(f.db);
  assert.equal(card.oracleId, 'a');
  assert.equal(card.shortfall, 1);
  assert.equal(card.overAllocated, false, 'nothing is over-claimed — one deck simply lost');
  assert.deepEqual(card.holders.map((h) => [h.deckName, h.quantity]), [['First', 1]]);
  assert.deepEqual(card.shortDecks.map((d) => [d.deckName, d.missing]), [['Second', 1]]);
  assert.equal(card.wanted, 2);

  f.decks.update(first, { status: 'brew' });
  assert.deepEqual(contestedIds(f), [], 'a brew holds nothing, so there is nothing to fight over');
  assert.equal(claim(f, second, 'a'), 1, 'and the copy went to the deck that was waiting');
  f.db.close();
});

test('brews_reserve_copies puts brews back in the fight, with no status list of its own', () => {
  const f = fixture();
  own(f, 'a', 1);
  const brew = built(f, 'Idea', [['a', 1]], 'brew');
  const real = built(f, 'Real', [['a', 1]]);
  assert.deepEqual(contestedIds(f), [], 'a brew is not a competitor');

  setSetting(f.db, BREWS_RESERVE_COPIES, '1');
  const [card] = contestedCards(f.db);
  assert.equal(card.oracleId, 'a');
  assert.ok(
    [brew, real].every((id) => card.holders.some((h) => h.deckId === id)
      || card.shortDecks.some((d) => d.deckId === id)),
    'both decks are now in it',
  );
  f.db.close();
});

test('a trade-listed copy contests only while the setting says it is unavailable', () => {
  const f = fixture();
  const lot = own(f, 'a', 2);
  built(f, 'First', [['a', 1]]);
  built(f, 'Second', [['a', 1]]);
  assert.deepEqual(contestedIds(f), [], 'two copies, two decks, no fight');

  const listId = (f.tradeLists.lists()[0] as { id: number }).id;
  f.tradeLists.addItem(listId, lot, { quantity: 1 });
  const [card] = contestedCards(f.db);
  assert.equal(card?.oracleId, 'a', 'one copy is promised away; two decks want the other');
  assert.equal(card.shortfall, 1);
  assert.equal(card.tradeListed, 1);

  setSetting(f.db, TRADELIST_REDUCES_AVAILABLE, '0');
  assert.deepEqual(contestedIds(f), [], 'with the subtraction off the listing is only a badge');
  f.db.close();
});

test('a deck that is merely unfinished is not a fight', () => {
  const f = fixture();
  own(f, 'a', 2);
  built(f, 'Wants four', [['a', 4]]);
  assert.deepEqual(contestedIds(f), [], 'short of two, but nobody else has them — that is a buy');
  f.db.close();
});

test('a maybeboard claim never contests', () => {
  const f = fixture();
  own(f, 'a', 1);
  built(f, 'Real', [['a', 1]]);
  const maybe = f.decks.create({ name: 'Maybe', formatCode: null, description: null });
  f.decks.update(maybe, { status: 'assembled' });
  f.decks.addCard(maybe, 'a', { quantity: 1, board: 'maybe' });
  assert.deepEqual(contestedIds(f), []);
  f.db.close();
});

test('an exempt basic land is never contested', () => {
  const f = fixture([{ id: 'i', name: 'Island', basic: true }]);
  own(f, 'i', 1);
  built(f, 'Blue', [['i', 20]]);
  built(f, 'Bluer', [['i', 20]]);
  assert.deepEqual(contestedIds(f), []);
  setSetting(f.db, ALLOCATION_IGNORES_BASICS, '0');
  assert.deepEqual(contestedIds(f), ['i'], 'with the exemption off, Islands are cards like any other');
  f.db.close();
});

test('over-allocation is the other face: a copy that left after a deck claimed it', () => {
  const f = fixture();
  own(f, 'a', 1);
  const deck = built(f, 'Only', [['a', 1]]);
  assert.equal(claim(f, deck, 'a'), 1);

  const away = f.trades.create({ counterpartyName: 'Dave' });
  f.trades.addItem(away, { direction: 'out', printingId: 'p-a', quantity: 1, condition: 'NM' });
  f.trades.complete(away, { conflictMode: 'alert' });

  const [card] = contestedCards(f.db);
  assert.equal(card?.oracleId, 'a');
  assert.equal(card.overAllocated, true, 'the deck still claims a copy that is gone');
  assert.equal(card.owned, 0);
  assert.equal(card.held, 1);
  assert.equal(card.shortfall, 1);
  f.db.close();
});

test('the worst fights come first: shortfall, then price', () => {
  const f = fixture([
    { id: 'cheap', name: 'Cheap', price: 1 },
    { id: 'dear', name: 'Dear', price: 40 },
    { id: 'bad', name: 'Badly short', price: 2 },
  ]);
  own(f, 'cheap', 1); own(f, 'dear', 1); own(f, 'bad', 1);
  built(f, 'A', [['cheap', 1], ['dear', 1], ['bad', 1]]);
  built(f, 'B', [['cheap', 1], ['dear', 1], ['bad', 2]]);
  assert.deepEqual(contestedCards(f.db).map((c) => c.name), ['Badly short', 'Dear', 'Cheap']);
  f.db.close();
});

// -- reassignment ------------------------------------------------------------

test('reassigning moves the claim and returns both decks’ figures', () => {
  const f = fixture();
  own(f, 'a', 1);
  const first = built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);

  const result = reassign(f.db, { oracleId: 'a', fromDeckId: first, toDeckId: second, quantity: 1 });
  assert.equal(claim(f, first, 'a'), 0);
  assert.equal(claim(f, second, 'a'), 1);
  assert.equal(result.from.coveredCards, 0);
  assert.equal(result.to.coveredCards, 1);
  assert.equal(result.from.missingCards, 1, 'the loser drops, and the response says so');
  f.db.close();
});

test('a reassignment survives later edits to both decks', () => {
  const f = fixture([{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Filler' }]);
  own(f, 'a', 1); own(f, 'z', 9);
  const first = built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);
  reassign(f.db, { oracleId: 'a', fromDeckId: first, toDeckId: second, quantity: 1 });

  // Reconciliation is first come first served: the winner now holds the copy,
  // so the loser's next pass finds nothing spare and leaves its 0 alone.
  f.decks.addCard(first, 'z', { quantity: 1 });
  f.decks.addCard(second, 'z', { quantity: 1 });
  assert.equal(claim(f, first, 'a'), 0);
  assert.equal(claim(f, second, 'a'), 1);
  f.db.close();
});

test('reassigning more than the target can hold is rejected, and nothing is written', () => {
  const f = fixture();
  own(f, 'a', 2);
  const first = built(f, 'First', [['a', 2]]);
  const second = built(f, 'Second', [['a', 2]]);
  // The target has room for one: a proxy fills the other half of its slot.
  const slot = f.decks.get(second)!.cards[0];
  f.decks.setSlotAllocation(second, slot.id, { proxied: 1, fromCollection: 0 });
  const before = f.db.prepare('SELECT id, quantity_from_collection FROM deck_cards ORDER BY id').all();

  assert.throws(
    () => reassign(f.db, { oracleId: 'a', fromDeckId: first, toDeckId: second, quantity: 2 }),
    /room for 1 more/,
  );
  assert.deepEqual(f.db.prepare('SELECT id, quantity_from_collection FROM deck_cards ORDER BY id').all(), before);
  f.db.close();
});

test('you can only give what you hold, and only between decks that hold', () => {
  const f = fixture();
  own(f, 'a', 1);
  const first = built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);
  const brew = built(f, 'Idea', [['a', 1]], 'brew');

  assert.throws(
    () => reassign(f.db, { oracleId: 'a', fromDeckId: second, toDeckId: first, quantity: 1 }),
    /holds 0/,
    'the loser does not hold the copy',
  );
  assert.throws(
    () => reassign(f.db, { oracleId: 'a', fromDeckId: first, toDeckId: brew, quantity: 1 }),
    /not holding cards/,
    'a brew cannot take one — the loser would just reclaim it',
  );
  assert.throws(
    () => reassign(f.db, { oracleId: 'a', fromDeckId: first, toDeckId: first, quantity: 1 }),
    /same deck/,
  );
  f.db.close();
});

// -- alerts: the trigger table --------------------------------------------------

test('one alert per contested card; resolving resolves it; recurring re-raises it', () => {
  const f = fixture();
  own(f, 'a', 1);
  const first = built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);          // trigger: deck_cards insert

  assert.equal(activeAlerts(f).length, 1, 'one alert, not one per deck');
  const [alert] = activeAlerts(f);
  const key = f.db.prepare('SELECT dedupe_key AS k FROM alerts WHERE id = ?').get(alert.id) as { k: string };
  assert.equal(key.k, 'allocation_conflict:a');
  assert.match(alert.message ?? '', /First has it; Second is short/);

  f.decks.removeCard(second, f.decks.get(second)!.cards[0].id); // trigger: deck_cards delete
  assert.equal(activeAlerts(f).length, 0, 'the fight is over');
  assert.equal(f.alerts.list({ state: 'resolved' }).filter((a) => a.kind === 'allocation_conflict').length, 1);

  f.decks.addCard(second, 'a', { quantity: 1 });
  assert.equal(activeAlerts(f).length, 1, 'a fresh alert, not one swallowed by the dedupe key');
  assert.notEqual(first, second);
  f.db.close();
});

test('trigger: a slot leaving the reserving boards, or dropping to zero', () => {
  const f = fixture();
  own(f, 'a', 1);
  built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);
  assert.equal(activeAlerts(f).length, 1);

  const slot = f.decks.get(second)!.cards[0].id;
  f.decks.setBoard(second, slot, 'maybe', null);
  assert.equal(activeAlerts(f).length, 0, 'a maybeboard slot wants nothing');
  f.decks.setBoard(second, slot, 'main', null);
  assert.equal(activeAlerts(f).length, 1);

  f.decks.setQuantity(second, slot, 0);
  assert.equal(activeAlerts(f).length, 0, 'a slot at zero is no slot');
  f.db.close();
});

test('trigger: a deck status change', () => {
  const f = fixture();
  own(f, 'a', 1);
  built(f, 'First', [['a', 1]]);
  const idea = built(f, 'Idea', [['a', 1]], 'brew');
  assert.equal(activeAlerts(f).length, 0);

  f.decks.update(idea, { status: 'building' });
  assert.equal(activeAlerts(f).length, 1, 'a promoted brew joins the fight');
  f.decks.update(idea, { status: 'brew' });
  assert.equal(activeAlerts(f).length, 0);
  f.db.close();
});

test('trigger: a deck delete', () => {
  const f = fixture();
  own(f, 'a', 1);
  const first = built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);
  assert.equal(activeAlerts(f).length, 1);

  f.decks.delete(first);
  assert.equal(activeAlerts(f).length, 0);
  assert.equal(claim(f, second, 'a'), 1, 'and the freed copy landed with the deck that was waiting');
  f.db.close();
});

test('trigger: a collection change', () => {
  const f = fixture();
  const lot = own(f, 'a', 1);
  built(f, 'First', [['a', 1]]);
  built(f, 'Second', [['a', 1]]);
  assert.equal(activeAlerts(f).length, 1);

  f.collection.updateLot(lot, { quantity: 2 });
  assert.equal(activeAlerts(f).length, 0, 'a second copy ends the fight');
  f.collection.updateLot(lot, { quantity: 1 });
  assert.equal(activeAlerts(f).length, 1, 'and losing it starts it again');
  f.db.close();
});

test('trigger: a trade that ships a claimed copy away', () => {
  const f = fixture();
  own(f, 'a', 1);
  built(f, 'Only', [['a', 1]]);
  assert.equal(activeAlerts(f).length, 0);

  const away = f.trades.create({ counterpartyName: 'Dave' });
  f.trades.addItem(away, { direction: 'out', printingId: 'p-a', quantity: 1, condition: 'NM' });
  const result = f.trades.complete(away, { conflictMode: 'alert' });
  assert.equal(activeAlerts(f).length, 1);
  assert.equal(result.allocationAlerts?.[0].short, 1, 'Phase 0’s shape still comes back');

  // A trade bringing one in resolves it — through the collection path.
  const back = f.trades.create({ counterpartyName: 'Dave' });
  f.trades.addItem(back, { direction: 'in', printingId: 'p-a', quantity: 1, condition: 'NM' });
  f.trades.complete(back, { conflictMode: 'alert' });
  assert.equal(activeAlerts(f).length, 0);
  f.db.close();
});

test('trigger: a trade-list change', () => {
  const f = fixture();
  const lot = own(f, 'a', 2);
  built(f, 'First', [['a', 1]]);
  built(f, 'Second', [['a', 1]]);
  assert.equal(activeAlerts(f).length, 0);

  const listId = (f.tradeLists.lists()[0] as { id: number }).id;
  const item = f.tradeLists.addItem(listId, lot, { quantity: 1 });
  assert.equal(activeAlerts(f).length, 1, 'offering a copy leaves one deck short');
  f.tradeLists.removeItem(item);
  assert.equal(activeAlerts(f).length, 0);
  f.db.close();
});

test('trigger: completing an assembly run', () => {
  const f = fixture();
  own(f, 'a', 1);
  built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]], 'brew');
  assert.equal(activeAlerts(f).length, 0, 'a brew is not in the fight');

  // Assembling the brew promotes it — the run is the write that starts the fight.
  const sheet = openAssemblyRun(f.db, second);
  for (const line of sheet.groups.flatMap((g) => g.lines)) setItemPicked(f.db, sheet.run.id, line.id, true);
  completeRun(f.db, sheet.run.id);
  assert.equal(f.decks.get(second)!.status, 'assembled');
  assert.equal(activeAlerts(f).length, 1);
  f.db.close();
});

test('trigger: a reassignment', () => {
  const f = fixture();
  own(f, 'a', 1);
  const first = built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);
  const before = activeAlerts(f)[0];
  assert.match(before.message ?? '', /First has it/);

  reassign(f.db, { oracleId: 'a', fromDeckId: first, toDeckId: second, quantity: 1 });
  const after = activeAlerts(f)[0];
  assert.match(after.message ?? '', /Second has it; First is short/, 'still one alert, now the other way round');
  f.db.close();
});

test('trigger: an allocation setting changes', () => {
  const f = fixture();
  own(f, 'a', 1);
  built(f, 'First', [['a', 1]]);
  built(f, 'Idea', [['a', 1]], 'brew');
  assert.equal(activeAlerts(f).length, 0);

  setSetting(f.db, BREWS_RESERVE_COPIES, '1');
  reconcileAllAlerts(f.db);                       // what PUT /settings does
  assert.equal(activeAlerts(f).length, 1);
  setSetting(f.db, BREWS_RESERVE_COPIES, '0');
  reconcileAllAlerts(f.db);
  assert.equal(activeAlerts(f).length, 0);
  f.db.close();
});

test('reconcileAlerts only touches the cards it is asked about', () => {
  const f = fixture([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  own(f, 'a', 1); own(f, 'b', 1);
  built(f, 'First', [['a', 1], ['b', 1]]);
  built(f, 'Second', [['a', 1], ['b', 1]]);
  assert.equal(activeAlerts(f).length, 2);

  // Pretend the fight over 'a' is over and ask only about 'b'.
  own(f, 'a', 1);
  const touched = reconcileAlerts(f.db, ['b']);
  assert.deepEqual(touched.map((t) => t.oracleId), ['b']);
  f.db.close();
});

// -- teardown simulation --------------------------------------------------------

test('what-if writes nothing and raises nothing', () => {
  const f = fixture();
  own(f, 'a', 1);
  const first = built(f, 'First', [['a', 1]]);
  const second = built(f, 'Second', [['a', 1]]);
  const stamps = () => f.db.prepare('SELECT id, updated_at, status FROM decks ORDER BY id').all();
  const before = stamps();
  const alertsBefore = f.alerts.list().map((a) => [a.id, a.state]);

  const result = whatIf(f.db, first)!;
  assert.deepEqual(stamps(), before, 'no deck was touched');
  assert.deepEqual(f.alerts.list().map((a) => [a.id, a.state]), alertsBefore, 'no alert moved');
  assert.deepEqual(result.changed.map((d) => d.deckId), [second]);
  assert.equal(result.changed[0].before.missingCards, 1);
  assert.equal(result.changed[0].after.missingCards, 0, 'breaking up First finishes Second');
  assert.deepEqual(result.freedCards, [{ oracleId: 'a', name: 'Alpha', quantity: 1 }]);
  f.db.close();
});

test('what-if deltas match what actually happens', () => {
  const f = fixture([{ id: 'a', name: 'Alpha', price: 3 }, { id: 'b', name: 'Beta', price: 5 }]);
  own(f, 'a', 1); own(f, 'b', 2);
  const first = built(f, 'First', [['a', 1], ['b', 2]]);
  const second = built(f, 'Second', [['a', 1], ['b', 1]]);

  const predicted = whatIf(f.db, first)!.changed.find((d) => d.deckId === second)!.after;
  f.decks.update(first, { status: 'disassembled' });
  const actual = buildabilityForDecks(f.db, [second]).get(second)!;
  assert.deepEqual(actual, predicted);
  f.db.close();
});

// -- the "held by" line ----------------------------------------------------------

test('holders says who claims a card, where it lives, and what is free', () => {
  const f = fixture();
  const box = Number(f.db.prepare(
    "INSERT INTO storage_locations (name, kind, sort_order) VALUES ('Blue Tackle Box','deck_box',2)",
  ).run().lastInsertRowid);
  own(f, 'a', 2);
  f.collection.addLot({ printingId: 'p-a', locationId: box, quantity: 2 });
  const deck = built(f, 'Deck A', [['a', 2]]);
  f.decks.update(deck, { homeLocationId: box });
  const lot = (f.db.prepare("SELECT id FROM collection_items WHERE location_id = ?").get(f.binder) as { id: number }).id;
  f.tradeLists.addItem((f.tradeLists.lists()[0] as { id: number }).id, lot, { quantity: 1 });

  const held = cardHolders(f.db, 'a')!;
  assert.equal(held.owned, 4);
  assert.equal(held.reserved, 2);
  assert.equal(held.tradeListed, 1);
  assert.equal(held.available, 1);
  assert.deepEqual(held.decks.map((d) => [d.deckName, d.quantity, d.homeLocationName, d.reserving]),
    [['Deck A', 2, 'Blue Tackle Box', true]]);
  assert.deepEqual(held.locations.map((l) => [l.name, l.quantity]),
    [['Binder', 2], ['Blue Tackle Box', 2]]);
  assert.equal(cardHolders(f.db, 'nope'), null);
  f.db.close();
});
