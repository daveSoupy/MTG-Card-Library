import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { normalizeName } from '../model/mtg.ts';
import { CardSearchStore } from './store.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

/**
 * Card detail: promo/prerelease flags on printings (Phase 8) and rulings
 * (Phase 8), both surfaced through the same detail() call the client's
 * fetchCard() renders.
 */
function makeStore() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test Set')`).run();

  const name = 'Lightning Bolt';
  const oracleId = 'o-bolt';
  db.prepare(`
    INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all, mana_cost, layout)
    VALUES (?,?,?,1,'Instant','Deals 3 damage.','{R}','normal')`)
    .run(oracleId, name, normalizeName(name));

  db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number, is_digital, is_promo, promo_types)
    VALUES ('p-standard', ?, 'tst', '1', 0, 0, NULL)`).run(oracleId);
  db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number, is_digital, is_promo, promo_types)
    VALUES ('p-promo', ?, 'tst', '1p', 0, 1, '["prerelease"]')`).run(oracleId);
  db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?').run('p-standard', oracleId);

  db.prepare(`
    INSERT INTO card_rulings (oracle_id, source, published_at, comment)
    VALUES (?, 'wotc', '2020-01-01', 'Older ruling.')`).run(oracleId);
  db.prepare(`
    INSERT INTO card_rulings (oracle_id, source, published_at, comment)
    VALUES (?, 'scryfall', '2023-06-15', 'Newer ruling.')`).run(oracleId);

  return { store: new CardSearchStore(db), db, oracleId, close: () => db.close() };
}

test('a promo printing carries isPromo and promoTypes through detail()', () => {
  const { store, oracleId, close } = makeStore();
  const detail = store.detail(oracleId)!;
  const promo = detail.printings.find((p: any) => p.id === 'p-promo');
  const standard = detail.printings.find((p: any) => p.id === 'p-standard');
  assert.equal(promo.isPromo, true);
  assert.deepEqual(promo.promoTypes, ['prerelease']);
  assert.equal(standard.isPromo, false);
  assert.deepEqual(standard.promoTypes, []);
  close();
});

test('rulings come back newest first', () => {
  const { store, oracleId, close } = makeStore();
  const detail = store.detail(oracleId)!;
  assert.deepEqual(detail.rulings.map((r: any) => r.comment), ['Newer ruling.', 'Older ruling.']);
  close();
});

test('a card already on an active want list carries that through detail()', () => {
  const { store, db, oracleId, close } = makeStore();
  const listId = db.prepare(`SELECT id FROM want_lists WHERE is_default = 1`).pluck().get();
  db.prepare(`
    INSERT INTO want_list_items (want_list_id, oracle_id, quantity, status)
    VALUES (?, ?, 2, 'active')`).run(listId, oracleId);

  const detail = store.detail(oracleId)!;
  assert.equal(detail.wantedQuantity, 2);
  close();
});

test('a fulfilled want does not count toward wantedQuantity', () => {
  const { store, db, oracleId, close } = makeStore();
  const listId = db.prepare(`SELECT id FROM want_lists WHERE is_default = 1`).pluck().get();
  db.prepare(`
    INSERT INTO want_list_items (want_list_id, oracle_id, quantity, status)
    VALUES (?, ?, 1, 'fulfilled')`).run(listId, oracleId);

  const detail = store.detail(oracleId)!;
  assert.equal(detail.wantedQuantity, 0);
  close();
});

test('a card with no rulings gets an empty array, not undefined', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test Set')`).run();
  db.prepare(`
    INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all, layout)
    VALUES ('o-plain','Plain Card','plain card',1,'Sorcery','x','normal')`).run();
  db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number)
    VALUES ('p-plain','o-plain','tst','1')`).run();
  db.prepare(`UPDATE oracle_cards SET default_printing_id = 'p-plain' WHERE oracle_id = 'o-plain'`).run();

  const store = new CardSearchStore(db);
  const detail = store.detail('o-plain')!;
  assert.deepEqual(detail.rulings, []);
  db.close();
});
