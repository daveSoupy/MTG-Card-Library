import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { TradeListStore } from './store.ts';
import { checkPriceTargets } from '../pricing/alerts.ts';
import { AlertStore } from '../alerts/store.ts';
import { WantStore } from '../collection/wants.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('mh2','Modern Horizons 2')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('goyf','Tarmogoyf','tarmogoyf',2,'Creature','x','normal')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity,price_usd)
              VALUES ('p-goyf','goyf','mh2','168','mythic',30)`).run();
  db.prepare(`UPDATE oracle_cards SET default_printing_id='p-goyf' WHERE oracle_id='goyf'`).run();
  const loc = (db.prepare('SELECT id FROM storage_locations LIMIT 1').get() as { id: number }).id;
  const collection = new CollectionStore(db);
  const lot = collection.addLot({ printingId: 'p-goyf', locationId: loc, quantity: 2, condition: 'NM' });
  return { db, collection, lot, lists: new TradeListStore(db) };
}

test('a trade list holds owned copies, flags deck conflicts, and exports plaintext', () => {
  const { db, lists, lot } = fixture();
  const def = lists.lists().find((l) => l.is_default)!.id;
  lists.addItem(def, lot, { quantity: 2, askingPriceUsd: 28 });

  // A deck claims one copy, so listing 2 conflicts with the deck allocation.
  db.prepare(`INSERT INTO decks (name, format_code) VALUES ('Jund','modern')`).run();
  db.prepare(`INSERT INTO deck_cards (deck_id, oracle_id, board, quantity, quantity_from_collection)
              VALUES (1,'goyf','main',1,1)`).run();

  const list = lists.get(def)!;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].conflictsWithDeck, true);
  assert.equal(list.items[0].exceedsOwned, false);

  assert.equal(lists.exportText(def), '2 Tarmogoyf (MH2) - $28.00');
  db.close();
});

test('checkPriceTargets raises at/below target and re-arms above it', () => {
  const { db } = fixture();
  const wants = new WantStore(db);
  const alerts = new AlertStore(db);
  const def = wants.lists().find((l) => l.is_default)!.id;
  const item = wants.addItem(def, 'goyf', { targetPriceUsd: 25 });

  // Market is 30 > 25 target: no alert.
  assert.equal(checkPriceTargets(db), 0);
  assert.equal(alerts.list({ state: 'active' }).length, 0);

  // Price drops to 20 <= 25: one alert, deduped by item id.
  db.prepare(`UPDATE card_printings SET price_usd = 20 WHERE id = 'p-goyf'`).run();
  assert.equal(checkPriceTargets(db), 1);
  assert.equal(checkPriceTargets(db), 1, 'still one — deduped, not stacked');
  assert.equal(alerts.list({ state: 'active' }).filter((a) => a.kind === 'price_target').length, 1);

  // Price recovers above target: the alert resolves (re-armed for next drop).
  db.prepare(`UPDATE card_printings SET price_usd = 40 WHERE id = 'p-goyf'`).run();
  checkPriceTargets(db);
  assert.equal(alerts.list({ state: 'active' }).filter((a) => a.kind === 'price_target').length, 0);
  assert.ok(item > 0);
  db.close();
});
