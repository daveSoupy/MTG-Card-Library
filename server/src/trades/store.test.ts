import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { AlertStore } from '../alerts/store.ts';
import { TradeStore, TradeNotDraftError, TradeShortfallError } from './store.ts';

/**
 * Trades: a draft leaves the collection alone; completion moves cards, logs a
 * disposal, fulfils matching wants, reconciles trade lists, and warns before
 * trading away a card a deck is using.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

interface CardSpec { oid: string; name: string; pid: string; number: string; price?: number; }

const CARDS: CardSpec[] = [
  { oid: 'bolt', name: 'Lightning Bolt', pid: 'p-bolt', number: '1', price: 2.5 },
  { oid: 'goyf', name: 'Tarmogoyf', pid: 'p-goyf', number: '2', price: 30 },
  { oid: 'brainstorm', name: 'Brainstorm', pid: 'p-bs', number: '3', price: 1 },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  for (const c of CARDS) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout) VALUES (?,?,?,1,'Instant','x','normal')`)
      .run(c.oid, c.name, c.name.toLowerCase());
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity,price_usd)
                VALUES (?,?,'tst',?,'rare',?)`).run(c.pid, c.oid, c.number, c.price ?? null);
    db.prepare('UPDATE oracle_cards SET default_printing_id=? WHERE oracle_id=?').run(c.pid, c.oid);
  }
  // A non-default binder plus the seeded "Unsorted" default location.
  db.prepare(`INSERT INTO storage_locations (name, kind) VALUES ('Binder','binder')`).run();
  const collection = new CollectionStore(db);
  const alerts = new AlertStore(db);
  const trades = new TradeStore(db, collection, alerts);
  return { db, collection, alerts, trades };
}

const owned = (db: Database.Database, oracleId: string) =>
  (db.prepare(`SELECT COALESCE(SUM(ci.quantity),0) AS n FROM collection_items ci
               JOIN card_printings p ON p.id = ci.printing_id WHERE p.oracle_id = ?`)
    .get(oracleId) as { n: number }).n;

const binderId = (db: Database.Database) =>
  (db.prepare(`SELECT id FROM storage_locations WHERE name='Binder'`).get() as { id: number }).id;

test('a new trade defaults its date to today, but keeps an explicit one', () => {
  const { db, trades } = fixture();
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  const auto = trades.get(trades.create({ counterpartyName: 'Dave' }));
  assert.equal(auto.tradeDate, today);

  const explicit = trades.get(trades.create({ counterpartyName: 'Dave', tradeDate: '2020-01-01' }));
  assert.equal(explicit.tradeDate, '2020-01-01');
  db.close();
});

test('an outgoing quantity is capped at what you own', () => {
  const { db, collection, trades } = fixture();
  collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 3, condition: 'NM' });
  const id = trades.create({ counterpartyName: 'Dave' });

  // Asking for 10 of 3 owned clamps to 3.
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 10, condition: 'NM' });
  let item = trades.get(id).items.find((i) => i.direction === 'out')!;
  assert.equal(item.quantity, 3);
  assert.equal(item.ownedQuantity, 3);

  // Editing back up beyond owned re-clamps.
  trades.updateItem(id, item.id, { quantity: 99 });
  item = trades.get(id).items.find((i) => i.direction === 'out')!;
  assert.equal(item.quantity, 3);

  // A second row for the same card can't push the trade over what's owned.
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 5, condition: 'NM' });
  const outQty = trades.get(id).items.filter((i) => i.direction === 'out').reduce((n, i) => n + i.quantity, 0);
  assert.equal(outQty, 3, 'total outgoing never exceeds owned');

  // Incoming has no such cap — you can receive as many as you like.
  trades.addItem(id, { direction: 'in', printingId: 'p-bolt', quantity: 12 });
  assert.equal(trades.get(id).items.find((i) => i.direction === 'in')!.quantity, 12);
  db.close();
});

test('a draft does not touch the collection until completed', () => {
  const { db, collection, trades } = fixture();
  collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 2 });

  const id = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 1, condition: 'NM' });
  trades.addItem(id, { direction: 'in', printingId: 'p-bolt', quantity: 4 });

  assert.equal(owned(db, 'goyf'), 2, 'still owned while draft');
  assert.equal(owned(db, 'bolt'), 0, 'not yet received');
  db.close();
});

test('completing a trade moves cards and logs a disposal', () => {
  const { db, collection, trades } = fixture();
  collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 2, condition: 'NM', acquiredUnitCost: 20 });

  const id = trades.create({ counterpartyName: 'Dave', tradeDate: '2026-09-03' });
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 1, condition: 'NM' });
  trades.addItem(id, { direction: 'in', printingId: 'p-bolt', quantity: 4 });

  const result = trades.complete(id);
  assert.equal(result.completed, true);
  assert.equal(owned(db, 'goyf'), 1, 'one Goyf left');
  assert.equal(owned(db, 'bolt'), 4, 'four Bolts arrived');

  const trade = trades.get(id);
  assert.equal(trade.status, 'completed');
  assert.equal(trade.valueOutUsd, 30);   // 1 x 30
  assert.equal(trade.valueInUsd, 10);     // 4 x 2.5

  const disposal = db.prepare(`SELECT quantity, disposal_kind, unit_proceeds_usd, unit_cost_usd
                               FROM collection_disposals`).get() as any;
  assert.equal(disposal.quantity, 1);
  assert.equal(disposal.disposal_kind, 'trade');
  assert.equal(disposal.unit_proceeds_usd, 30);
  assert.equal(disposal.unit_cost_usd, 20);

  // Incoming Bolts landed in the default "Unsorted" location.
  const loc = db.prepare(`SELECT l.is_default FROM collection_items ci
                          JOIN storage_locations l ON l.id = ci.location_id
                          JOIN card_printings p ON p.id = ci.printing_id
                          WHERE p.oracle_id = 'bolt'`).get() as { is_default: number };
  assert.equal(loc.is_default, 1);

  // A completed trade is immutable.
  assert.throws(() => trades.addItem(id, { direction: 'in', printingId: 'p-bs', quantity: 1 }), TradeNotDraftError);
  db.close();
});

test('trading away a deck-allocated card asks for confirmation, then clamps', () => {
  const { db, collection, alerts, trades } = fixture();
  collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 1, condition: 'NM' });

  // A deck claims the single owned Goyf.
  // Assembled, so the claim is on real cardboard: only a reserving deck can
  // be in conflict with a trade (Phase 22).
  db.prepare(`INSERT INTO decks (name, format_code, status)
              VALUES ('Jund','modern','assembled')`).run();
  db.prepare(`INSERT INTO deck_cards (deck_id, oracle_id, board, quantity, quantity_from_collection)
              VALUES (1,'goyf','main',1,1)`).run();

  const id = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 1, condition: 'NM' });

  const first = trades.complete(id);
  assert.equal(first.completed, false);
  assert.equal(first.needsConfirmation, true);
  assert.equal(first.conflicts?.[0].name, 'Tarmogoyf');
  assert.equal(owned(db, 'goyf'), 1, 'nothing changed on the confirmation request');

  const forced = trades.complete(id, { force: true });
  assert.equal(forced.completed, true);
  assert.equal(owned(db, 'goyf'), 0);
  const claim = db.prepare(`SELECT quantity_from_collection AS q FROM deck_cards WHERE oracle_id='goyf'`)
    .get() as { q: number };
  assert.equal(claim.q, 0, 'deck claim clamped to what is still owned');
  assert.ok(alerts.list({ state: 'active' }).some((a) => a.kind === 'allocation_conflict'));
  db.close();
});

test('an incoming card fulfils a matching want', () => {
  const { db, alerts, trades } = fixture();
  // The schema seeds a default 'Wants' list (id 1).
  db.prepare(`INSERT INTO want_list_items (want_list_id, oracle_id, quantity) VALUES (1,'goyf',1)`).run();

  const id = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(id, { direction: 'in', printingId: 'p-goyf', quantity: 1 });
  const result = trades.complete(id);

  assert.equal(result.fulfilledWants?.length, 1);
  const want = db.prepare(`SELECT status, fulfilled_by_trade_id FROM want_list_items`).get() as any;
  assert.equal(want.status, 'fulfilled');
  assert.equal(want.fulfilled_by_trade_id, id);
  assert.ok(alerts.list({ state: 'active' }).some((a) => a.kind === 'want_fulfilled'));
  db.close();
});

test('completion clamps a trade list that now claims more than is owned', () => {
  const { db, collection, alerts, trades } = fixture();
  const lot = collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 2, condition: 'NM' });
  // The schema seeds a default 'Trades' list (id 1).
  db.prepare(`INSERT INTO trade_list_items (trade_list_id, collection_item_id, quantity) VALUES (1,?,2)`).run(lot);

  const id = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 1, condition: 'NM' });
  const result = trades.complete(id);

  assert.equal(result.clampedTradeListItems, 1);
  const listed = db.prepare(`SELECT quantity FROM trade_list_items`).get() as { quantity: number };
  assert.equal(listed.quantity, 1, 'listed quantity clamped to owned');
  assert.ok(alerts.list({ state: 'active' }).some((a) => a.kind === 'trade_list_clamped'));
  db.close();
});

test("conflictMode 'alert' completes without touching the deck, and alerts instead", () => {
  const { db, collection, alerts, trades } = fixture();
  collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 1, condition: 'NM' });

  // A deck claims the single owned Goyf.
  // Assembled, so the claim is on real cardboard: only a reserving deck can
  // be in conflict with a trade (Phase 22).
  db.prepare(`INSERT INTO decks (name, format_code, status)
              VALUES ('Jund','modern','assembled')`).run();
  db.prepare(`INSERT INTO deck_cards (deck_id, oracle_id, board, quantity, quantity_from_collection)
              VALUES (1,'goyf','main',1,1)`).run();

  const id = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 1, condition: 'NM' });

  const result = trades.complete(id, { conflictMode: 'alert' });
  assert.equal(result.completed, true, 'never blocks');
  assert.equal(result.needsConfirmation, undefined);
  assert.equal(owned(db, 'goyf'), 0, 'the copy left');

  const claim = db.prepare(`SELECT quantity_from_collection AS q FROM deck_cards WHERE oracle_id='goyf'`)
    .get() as { q: number };
  assert.equal(claim.q, 1, 'the deck is left exactly as it was');

  const raised = alerts.list({ state: 'active' }).filter((a) => a.kind === 'allocation_conflict');
  assert.equal(raised.length, 1, 'one alert per affected card');
  assert.equal(result.allocationAlerts?.[0].short, 1);
  const key = db.prepare(`SELECT dedupe_key AS k FROM alerts WHERE kind='allocation_conflict'`)
    .get() as { k: string };
  assert.equal(key.k, 'allocation_conflict:goyf');
  db.close();
});

test('an allocation alert resolves itself once availability catches up', () => {
  const { db, collection, alerts, trades } = fixture();
  collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 1, condition: 'NM' });
  // Assembled, so the claim is on real cardboard: only a reserving deck can
  // be in conflict with a trade (Phase 22).
  db.prepare(`INSERT INTO decks (name, format_code, status)
              VALUES ('Jund','modern','assembled')`).run();
  db.prepare(`INSERT INTO deck_cards (deck_id, oracle_id, board, quantity, quantity_from_collection)
              VALUES (1,'goyf','main',1,1)`).run();

  const away = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(away, { direction: 'out', printingId: 'p-goyf', quantity: 1, condition: 'NM' });
  trades.complete(away, { conflictMode: 'alert' });
  assert.equal(alerts.list({ state: 'active' }).filter((a) => a.kind === 'allocation_conflict').length, 1);

  // A later trade brings a replacement in; the shortfall is gone.
  const back = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(back, { direction: 'in', printingId: 'p-goyf', quantity: 1, condition: 'NM' });
  trades.complete(back, { conflictMode: 'alert' });

  assert.equal(
    alerts.list({ state: 'active' }).filter((a) => a.kind === 'allocation_conflict').length, 0,
    'resolved without anyone acknowledging it',
  );
  db.close();
});

test('disposeFromLot draws lots oldest-first and logs one disposal per lot', () => {
  const { db, collection, trades } = fixture();
  const old = collection.addLot({
    printingId: 'p-goyf', locationId: binderId(db), quantity: 2,
    condition: 'NM', acquiredAt: '2020-01-01', acquiredUnitCost: 10,
  });
  const recent = collection.addLot({
    printingId: 'p-goyf', locationId: binderId(db), quantity: 2,
    condition: 'NM', acquiredAt: '2024-06-01', acquiredUnitCost: 40,
  });

  const result = trades.disposeFromLot(
    [{ printingId: 'p-goyf', quantity: 3, condition: 'NM', unitProceedsUsd: 25 }],
    { kind: 'sale', disposedOn: '2026-09-08', counterparty: 'Card shop' },
  );

  assert.deepEqual(result.consumed.map((c) => [c.lotId, c.quantity]), [[old, 2], [recent, 1]]);
  const rows = db.prepare(`SELECT quantity, disposal_kind, unit_cost_usd, unit_proceeds_usd,
                                  counterparty, trade_id
                           FROM collection_disposals ORDER BY id`).all() as any[];
  assert.equal(rows.length, 2, 'one disposal row per lot consumed');
  assert.deepEqual(rows.map((r) => r.unit_cost_usd), [10, 40], 'cost basis copied off each lot');
  assert.equal(rows[0].disposal_kind, 'sale');
  assert.equal(rows[0].unit_proceeds_usd, 25);
  assert.equal(rows[0].counterparty, 'Card shop');
  assert.equal(rows[0].trade_id, null, 'a sale has no trade behind it');
  assert.equal(owned(db, 'goyf'), 1);
  db.close();
});

// -- shortfalls: the copies a trade says are leaving must actually be there ---

const lotRows = (db: Database.Database) =>
  db.prepare('SELECT id, quantity, finish, condition FROM collection_items ORDER BY id').all();
const disposalCount = (db: Database.Database) =>
  (db.prepare('SELECT COUNT(*) AS n FROM collection_disposals').get() as { n: number }).n;

test('completion takes from the chosen lot even when the item no longer matches its condition', () => {
  const { db, collection, trades } = fixture();
  // Two lots of the same printing; the trade names the LP one, then that lot
  // is regraded to NM before the trade completes. The item still says LP.
  const nm = collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 2, condition: 'NM', acquiredAt: '2020-01-01' });
  const chosen = collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 2, condition: 'LP', acquiredAt: '2024-01-01' });

  const id = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 1, sourceCollectionItemId: chosen });
  collection.updateLot(chosen, { condition: 'NM' });
  assert.equal(trades.get(id).items[0].condition, 'LP', 'the draft still describes the copies as drafted');

  const result = trades.complete(id);
  assert.equal(result.completed, true);
  assert.deepEqual(lotRows(db), [
    { id: nm, quantity: 2, finish: 'nonfoil', condition: 'NM' },
    { id: chosen, quantity: 1, finish: 'nonfoil', condition: 'NM' },
  ], 'the named lot was drawn down, not the older matching one');
  const disposal = db.prepare('SELECT source_lot_id, quantity, condition FROM collection_disposals').get() as any;
  assert.deepEqual(disposal, { source_lot_id: chosen, quantity: 1, condition: 'NM' },
    'the disposal records the copy that actually left, not the stale draft');
  db.close();
});

test('a lot deleted after drafting refuses to complete, and leaves everything as it was', () => {
  const { db, collection, trades } = fixture();
  const lot = collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 2, condition: 'NM' });
  collection.addLot({ printingId: 'p-bolt', locationId: binderId(db), quantity: 4, condition: 'NM' });

  const id = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 2, sourceCollectionItemId: lot });
  // A second outgoing card whose lot is fine — it must not leave either.
  trades.addItem(id, { direction: 'out', printingId: 'p-bolt', quantity: 1, condition: 'NM' });
  trades.addItem(id, { direction: 'in', printingId: 'p-bs', quantity: 1 });
  collection.removeLot(lot);
  const before = lotRows(db);

  const result = trades.complete(id);
  assert.equal(result.completed, false);
  assert.equal(result.needsConfirmation, undefined, 'not something confirmation can fix');
  assert.deepEqual(result.shortfalls, [{
    itemId: trades.get(id).items.find((i) => i.oracleId === 'goyf')!.id,
    oracleId: 'goyf', name: 'Tarmogoyf', requested: 2, found: 0,
  }]);
  assert.deepEqual(result.conflicts, [], 'no deck is involved, so this is not a conflict');

  assert.equal(trades.get(id).status, 'draft');
  assert.deepEqual(lotRows(db), before, 'nothing left the collection');
  assert.equal(owned(db, 'brainstorm'), 0, 'nothing arrived either');
  assert.equal(disposalCount(db), 0);
  db.close();
});

test('force does not complete a trade with a shortfall', () => {
  const { db, collection, trades } = fixture();
  const lot = collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 1, condition: 'NM' });
  const id = trades.create({ counterpartyName: 'Dave' });
  trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 1, sourceCollectionItemId: lot });
  collection.removeLot(lot);

  const forced = trades.complete(id, { force: true });
  assert.equal(forced.completed, false);
  assert.equal(forced.shortfalls?.length, 1);
  assert.equal(trades.get(id).status, 'draft');
  assert.equal(disposalCount(db), 0);

  // The non-interactive path has nobody to show the shortfall to, so it throws.
  assert.throws(() => trades.complete(id, { conflictMode: 'alert' }), TradeShortfallError);
  assert.equal(trades.get(id).status, 'draft');
  db.close();
});

test('disposeFromLot throws inside its transaction when a request cannot be met in full', () => {
  const { db, collection, trades } = fixture();
  collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 1, condition: 'NM' });
  collection.addLot({ printingId: 'p-bolt', locationId: binderId(db), quantity: 4, condition: 'NM' });
  const before = lotRows(db);

  // Bolt is fine and is processed first; Goyf is short by one. Neither leaves.
  assert.throws(
    () => trades.disposeFromLot([
      { printingId: 'p-bolt', quantity: 2, condition: 'NM' },
      { printingId: 'p-goyf', quantity: 2, condition: 'NM' },
    ], { kind: 'sale' }),
    (error: unknown) => error instanceof TradeShortfallError
      && error.message === '1 copy of Tarmogoyf is not in your collection.'
      && error.shortfalls[0].found === 1 && error.shortfalls[0].requested === 2,
  );
  assert.deepEqual(lotRows(db), before, 'the Bolt decrement rolled back with the Goyf failure');
  assert.equal(disposalCount(db), 0);
  db.close();
});

test('an item drafted from a lot describes that lot, not a default', () => {
  const { db, collection, trades } = fixture();
  const lot = collection.addLot({
    printingId: 'p-goyf', locationId: binderId(db), quantity: 3, finish: 'foil', condition: 'LP', language: 'ja',
  });
  const other = collection.addLot({ printingId: 'p-goyf', locationId: binderId(db), quantity: 1, condition: 'NM' });

  const id = trades.create({ counterpartyName: 'Dave' });
  const itemId = trades.addItem(id, { direction: 'out', printingId: 'p-goyf', quantity: 2, sourceCollectionItemId: lot });
  let item = trades.get(id).items[0];
  assert.equal(item.id, itemId);
  assert.deepEqual([item.finish, item.condition, item.language], ['foil', 'LP', 'ja']);
  assert.equal(item.ownedQuantity, 3, 'owned counts the copies the lot holds, not a phantom unknown row');

  // Re-pointing at another lot re-describes the item the same way.
  trades.updateItem(id, itemId, { sourceCollectionItemId: other });
  item = trades.get(id).items[0];
  assert.deepEqual([item.finish, item.condition, item.language], ['nonfoil', 'NM', 'en']);
  assert.equal(item.quantity, 1, 're-clamped to what the new lot holds');

  // An explicit field wins over the lot's.
  trades.updateItem(id, itemId, { sourceCollectionItemId: lot, condition: 'MP' });
  item = trades.get(id).items[0];
  assert.deepEqual([item.finish, item.condition, item.language], ['foil', 'MP', 'ja']);
  assert.equal(item.ownedQuantity, 3, 'still reaches the chosen lot through the id, whatever its condition');
  db.close();
});

test('the trade log searches by person, sorts, and totals exactly what it returns', () => {
  const { db, trades } = fixture();
  const make = (name: string, date: string, status: string, out: number | null, inn: number | null) => {
    const id = trades.create({ counterpartyName: name, tradeDate: date });
    db.prepare(`UPDATE trades SET status = ?, value_out_usd = ?, value_in_usd = ?,
                completed_at = CASE WHEN ? = 'completed' THEN ? END WHERE id = ?`)
      .run(status, out, inn, status, date, id);
    return id;
  };
  make('Alex', '2026-01-01', 'completed', 10, 12);
  make('alexandra', '2026-03-01', 'completed', 5, null);
  make('Bo', '2026-02-01', 'completed', 100, 90);
  make('Alex', '2026-04-01', 'cancelled', null, null);
  make('50%_off', '2026-05-01', 'draft', null, null);

  // Case-insensitive substring; the totals are over the matches only.
  const alex = trades.list({ query: 'ALEX' });
  assert.deepEqual(alex.trades.map((t) => t.counterpartyName), ['Alex', 'alexandra', 'Alex']);
  assert.deepEqual(alex.totals, {
    count: 3, completedCount: 2, valueOutUsd: 15, valueInUsd: 12, unvaluedCount: 1,
  });

  // LIKE's wildcards in the query are literal: "%" does not match everything.
  assert.deepEqual(trades.list({ query: '%_' }).trades.map((t) => t.counterpartyName), ['50%_off']);

  // Drafts lead the date orders when no status is chosen.
  assert.deepEqual(trades.list().trades.map((t) => t.tradeDate),
    ['2026-05-01', '2026-04-01', '2026-03-01', '2026-02-01', '2026-01-01']);
  assert.deepEqual(trades.list({ sort: 'oldest' }).trades.map((t) => t.tradeDate),
    ['2026-05-01', '2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  assert.deepEqual(trades.list({ status: 'completed', sort: 'person' }).trades.map((t) => t.counterpartyName),
    ['Alex', 'alexandra', 'Bo']);
  db.close();
});
