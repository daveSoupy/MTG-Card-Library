import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { AlertStore } from '../alerts/store.ts';
import { TradeStore, TradeNotDraftError } from './store.ts';

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
  db.prepare(`INSERT INTO decks (name, format_code) VALUES ('Jund','modern')`).run();
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
