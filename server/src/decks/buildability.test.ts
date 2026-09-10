import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, setSetting } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { TradeListStore } from '../tradelists/store.ts';
import { pushEntriesToWantList } from '../collection/shopping.ts';
import { DeckStore } from './store.ts';
import {
  ALLOCATION_IGNORES_BASICS, TRADELIST_REDUCES_AVAILABLE,
} from './allocation.ts';
import {
  buildabilityDetail, buildabilityForDecks, compareBuildability, missingForWantList,
} from './buildability.ts';

/**
 * Phase 24 — the figure that decides whether you buy cards this week.
 *
 * Every assertion here is about a number being *honestly* wrong-proof rather
 * than merely present: a confident 94% computed against dishonest availability
 * is worse than no percentage at all.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

/** A card, its price, and whether it is a basic land. */
interface CardSpec { id: string; name: string; price: number | null; basic?: boolean }

function fixture(cards: CardSpec[]) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();

  for (const [index, card] of cards.entries()) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,is_basic_land)
                VALUES (?,?,?,1,?,'x','normal',?)`)
      .run(card.id, card.name, card.name.toLowerCase(),
        card.basic ? 'Basic Land' : 'Artifact', card.basic ? 1 : 0);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
                VALUES (?,?,'tst',?,?)`).run(`p-${card.id}`, card.id, String(index), card.price);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${card.id}`, card.id);
  }

  const locationId = (db.prepare('SELECT id FROM storage_locations LIMIT 1')
    .get() as { id: number }).id;

  return {
    db,
    decks: new DeckStore(db),
    collection: new CollectionStore(db),
    tradeLists: new TradeListStore(db),
    locationId,
  };
}

const own = (
  collection: CollectionStore, locationId: number, oracleId: string, quantity: number,
): number => collection.addLot({ printingId: `p-${oracleId}`, locationId, quantity });

const summaryFor = (db: Database.Database, deckId: number) =>
  buildabilityForDecks(db, [deckId]).get(deckId)!;

const cardId = (decks: DeckStore, deckId: number, oracleId: string) =>
  decks.get(deckId)!.cards.find((card) => card.oracleId === oracleId)!.id;

// --------------------------------------------------------------- the figure

/**
 * Ten cards, seven of them on the shelf, three of them priced.
 *
 * Deliberately built without ticking "from my collection" on anything: the
 * whole point of computed coverage is that a deck nobody marked up still reads
 * as buildable when the cards are sitting in a binder.
 */
function tenCardDeck() {
  const cards: CardSpec[] = Array.from({ length: 10 }, (_, i) => ({
    id: `o-${i}`, name: `Card ${i}`, price: [3, 5, 12][i - 7] ?? 1,
  }));
  const env = fixture(cards);
  const deckId = env.decks.create({ name: 'Ten', formatCode: 'modern' });

  for (let i = 0; i < 10; i += 1) {
    env.decks.addCard(deckId, `o-${i}`, { board: 'main', quantity: 1 });
    // Cards 0-6 are owned; 7, 8 and 9 are not, and cost 3, 5 and 12.
    if (i < 7) own(env.collection, env.locationId, `o-${i}`, 1);
  }
  return { ...env, deckId };
}

test('a ten-card deck with seven covered reads 70% and names its exact cost', () => {
  const { db, deckId } = tenCardDeck();
  const summary = summaryFor(db, deckId);

  assert.equal(summary.requiredCards, 10);
  assert.equal(summary.coveredCards, 7);
  assert.equal(summary.buildablePct, 0.7);
  assert.equal(summary.missingCards, 3);
  assert.equal(summary.costToCompleteUsd, 20, '3 + 5 + 12');
  assert.equal(summary.unpricedCount, 0);
  assert.equal(summary.contestedCount, 0);
});

test('proxying a missing card covers the slot and drops the cost by its price', () => {
  const { db, decks, deckId } = tenCardDeck();

  // Card 9 is the $12 one.
  decks.setSlotAllocation(deckId, cardId(decks, deckId, 'o-9'), { proxied: 1 });

  const summary = summaryFor(db, deckId);
  assert.equal(summary.coveredCards, 8);
  assert.equal(summary.missingCards, 2);
  assert.equal(summary.buildablePct, 0.8);
  assert.equal(summary.costToCompleteUsd, 8, 'the $12 proxy is no longer bought');
});

test('an empty deck reads empty rather than finished', () => {
  const { db, decks } = tenCardDeck();
  const empty = decks.create({ name: 'Nothing yet', formatCode: 'modern' });

  const summary = summaryFor(db, empty);
  assert.equal(summary.buildablePct, null, 'null, never 1 — an empty deck is not a built one');
  assert.equal(summary.requiredCards, 0);
  assert.equal(summary.missingCards, 0);
});

// ------------------------------------------------------- what other decks do

test('another reserving deck lowers coverage; demoting it to a brew restores it', () => {
  const { db, decks, collection, locationId } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
  ]);
  own(collection, locationId, 'o-ring', 1);

  const mine = decks.create({ name: 'Mine', formatCode: 'modern' });
  const theirs = decks.create({ name: 'Theirs', formatCode: 'modern' });
  decks.addCard(mine, 'o-ring', { board: 'main', quantity: 1 });
  decks.addCard(theirs, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });

  assert.equal(summaryFor(db, mine).coveredCards, 1, 'a brew claims nothing');

  decks.update(theirs, { status: 'assembled' });
  const contested = summaryFor(db, mine);
  assert.equal(contested.coveredCards, 0);
  assert.equal(contested.missingCards, 1);
  assert.equal(contested.buildablePct, 0);
  assert.equal(contested.contestedCount, 1, 'short, and someone else is holding it');

  decks.update(theirs, { status: 'brew' });
  assert.equal(summaryFor(db, mine).coveredCards, 1, 'the copy comes back');
});

test('a deck never competes with itself, however it is marked up', () => {
  const { db, decks, collection, locationId } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
  ]);
  own(collection, locationId, 'o-ring', 1);

  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });
  decks.update(deckId, { status: 'assembled' });

  const summary = summaryFor(db, deckId);
  assert.equal(summary.coveredCards, 1, 'its own reservation is not competition');
  assert.equal(summary.buildablePct, 1);
});

test('the detail rows name who is holding the rest', () => {
  const { db, decks, collection, locationId } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
  ]);
  own(collection, locationId, 'o-ring', 1);

  const mine = decks.create({ name: 'Mine', formatCode: 'modern' });
  const theirs = decks.create({ name: 'Atraxa', formatCode: 'modern' });
  decks.addCard(mine, 'o-ring', { board: 'main', quantity: 1 });
  decks.addCard(theirs, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });
  decks.update(theirs, { status: 'assembled' });

  const detail = buildabilityDetail(db, mine)!;
  const row = detail.rows[0];
  assert.equal(row.missing, 1);
  assert.equal(row.owned, 1, 'you do own one — it is just spoken for');
  assert.equal(row.available, 0);
  assert.deepEqual(row.holdingDecks, [
    { deckId: theirs, deckName: 'Atraxa', status: 'assembled', quantity: 1 },
  ]);
});

// -------------------------------------------------------------- trade lists

test('a copy promised on a trade list is not a copy you can build with', () => {
  const { db, decks, collection, tradeLists, locationId } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
  ]);
  const lotId = own(collection, locationId, 'o-ring', 1);

  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });
  assert.equal(summaryFor(db, deckId).coveredCards, 1);

  // The schema seeds a default trade list; use it rather than a second one.
  const listId = (db.prepare('SELECT id FROM trade_lists ORDER BY is_default DESC, id LIMIT 1')
    .get() as { id: number }).id;
  tradeLists.addItem(listId, lotId, 1);

  assert.equal(summaryFor(db, deckId).coveredCards, 0, 'promised away');
  assert.equal(summaryFor(db, deckId).costToCompleteUsd, 2);

  // The setting is Phase 22's, and buildability follows it for free.
  setSetting(db, TRADELIST_REDUCES_AVAILABLE, '0');
  assert.equal(summaryFor(db, deckId).coveredCards, 1);
});

// ------------------------------------------------------------------- prices

test('a missing card with no priced printing is counted, not costed as free', () => {
  const { db, decks } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 4 },
    { id: 'o-odd', name: 'Unpriced Oddity', price: null },
  ]);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });
  decks.addCard(deckId, 'o-odd', { board: 'main', quantity: 1 });

  const summary = summaryFor(db, deckId);
  assert.equal(summary.missingCards, 2);
  assert.equal(summary.costToCompleteUsd, 4, 'the unknown adds 0 rather than a guess');
  assert.equal(summary.unpricedCount, 1, '...and says so, so the UI can read "$4 + 1 unpriced"');

  const row = buildabilityDetail(db, deckId)!.rows.find((r) => r.oracleId === 'o-odd')!;
  assert.equal(row.unitPriceUsd, null);
  assert.equal(row.extendedUsd, null, 'null, not 0 — the difference is the whole point');
});

test('the cheapest non-digital printing sets the price, and digital ones never do', () => {
  const { db, decks } = fixture([{ id: 'o-ring', name: 'Sol Ring', price: 9 }]);
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
              VALUES ('p-cheap','o-ring','tst','99',3)`).run();
  db.prepare(`INSERT INTO card_printings
                (id,oracle_id,set_code,collector_number,price_usd,is_digital)
              VALUES ('p-arena','o-ring','tst','98',1,1)`).run();

  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });

  assert.equal(summaryFor(db, deckId).costToCompleteUsd, 3, 'the $1 digital printing is not a card');
});

test('a pinned printing prices the slot, and an unpriced pin falls back rather than reading free', () => {
  const { db, decks } = fixture([{ id: 'o-ring', name: 'Sol Ring', price: 3 }]);
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
              VALUES ('p-fancy','o-ring','tst','99',40)`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
              VALUES ('p-promo','o-ring','tst','98',NULL)`).run();

  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });
  const slot = cardId(decks, deckId, 'o-ring');

  decks.setPreferredPrinting(deckId, slot, 'p-fancy');
  assert.equal(summaryFor(db, deckId).costToCompleteUsd, 40, 'you said you wanted that one');

  decks.setPreferredPrinting(deckId, slot, 'p-promo');
  const summary = summaryFor(db, deckId);
  assert.equal(summary.costToCompleteUsd, 3, 'an unpriced pin is about art, not budget');
  assert.equal(summary.unpricedCount, 0);
});

// ------------------------------------------------------------- what is counted

test('basics never reach the missing count while the exemption is on', () => {
  const { db, decks } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
    { id: 'o-island', name: 'Island', price: 1, basic: true },
  ]);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });
  decks.addCard(deckId, 'o-island', { board: 'main', quantity: 38 });

  const summary = summaryFor(db, deckId);
  assert.equal(summary.requiredCards, 1, '38 Islands are not 38 missing cards');
  assert.equal(summary.missingCards, 1);
  assert.equal(summary.costToCompleteUsd, 2);
  assert.ok(!buildabilityDetail(db, deckId)!.rows.some((row) => row.oracleId === 'o-island'));

  // Turn the exemption off and they are ordinary cards again.
  setSetting(db, ALLOCATION_IGNORES_BASICS, '0');
  assert.equal(summaryFor(db, deckId).missingCards, 39);
});

test('the maybeboard affects no figure', () => {
  const { db, decks } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
    { id: 'o-bolt', name: 'Lightning Bolt', price: 500 },
  ]);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });

  const before = summaryFor(db, deckId);
  decks.addCard(deckId, 'o-bolt', { board: 'maybe', quantity: 4 });
  assert.deepEqual(summaryFor(db, deckId), before, 'a maybeboard is a notepad');
});

test('the sideboard counts only where the format has one', () => {
  const cards: CardSpec[] = [
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
    { id: 'o-bolt', name: 'Lightning Bolt', price: 7 },
  ];
  const { db, decks } = fixture(cards);

  const modern = decks.create({ name: 'Modern', formatCode: 'modern' });
  decks.addCard(modern, 'o-ring', { board: 'main', quantity: 1 });
  decks.addCard(modern, 'o-bolt', { board: 'side', quantity: 1 });
  assert.equal(summaryFor(db, modern).requiredCards, 2);
  assert.equal(summaryFor(db, modern).costToCompleteUsd, 9);

  // Commander has no sideboard, so a 'side' slot there is a scratchpad.
  const edh = decks.create({ name: 'EDH', formatCode: 'commander' });
  decks.addCard(edh, 'o-ring', { board: 'main', quantity: 1 });
  decks.addCard(edh, 'o-bolt', { board: 'side', quantity: 1 });
  assert.equal(summaryFor(db, edh).requiredCards, 1);
  assert.equal(summaryFor(db, edh).costToCompleteUsd, 2);
});

test('one card across two boards competes for one pool of copies', () => {
  const { db, decks, collection, locationId } = fixture([
    { id: 'o-bolt', name: 'Lightning Bolt', price: 7 },
  ]);
  own(collection, locationId, 'o-bolt', 1);

  const deckId = decks.create({ name: 'Modern', formatCode: 'modern' });
  decks.addCard(deckId, 'o-bolt', { board: 'main', quantity: 1 });
  decks.addCard(deckId, 'o-bolt', { board: 'side', quantity: 1 });

  const summary = summaryFor(db, deckId);
  assert.equal(summary.requiredCards, 2);
  assert.equal(summary.coveredCards, 1, 'the single copy cannot cover both slots');
  assert.equal(summary.missingCards, 1);
});

// --------------------------------------------------------- status overrides

test('a status override answers exactly what changing the status would answer', () => {
  const { db, decks, collection, locationId } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
  ]);
  own(collection, locationId, 'o-ring', 1);

  const mine = decks.create({ name: 'Mine', formatCode: 'modern' });
  const theirs = decks.create({ name: 'Theirs', formatCode: 'modern' });
  decks.addCard(mine, 'o-ring', { board: 'main', quantity: 1 });
  decks.addCard(theirs, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });
  decks.update(theirs, { status: 'assembled' });

  // What if that deck were torn down? Asked without writing anything.
  const simulated = buildabilityForDecks(db, [mine], new Map([[theirs, 'disassembled']]))
    .get(mine)!;

  decks.update(theirs, { status: 'disassembled' });
  const actual = summaryFor(db, mine);

  assert.deepEqual(simulated, actual);
  assert.equal(actual.coveredCards, 1);
});

test('an override on the measured deck itself is honoured too', () => {
  const { db, decks, collection, locationId } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
  ]);
  own(collection, locationId, 'o-ring', 1);

  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1, fromCollection: 1 });

  // Reserving or not, a deck never competes with itself — so the answer is the
  // same either way, which is the property that keeps Phase 26's simulation
  // from quietly double-counting.
  const asBrew = buildabilityForDecks(db, [deckId], new Map([[deckId, 'brew']])).get(deckId)!;
  const asBuilt = buildabilityForDecks(db, [deckId], new Map([[deckId, 'assembled']])).get(deckId)!;
  assert.deepEqual(asBrew, asBuilt);
  assert.equal(asBuilt.coveredCards, 1);
});

// ------------------------------------------------------------------ sorting

test('the deck-list orders resolve server-side, with empty decks last', () => {
  const rich = { deckId: 1, buildablePct: 0.9, requiredCards: 10, coveredCards: 9,
    missingCards: 1, costToCompleteUsd: 50, unpricedCount: 0, contestedCount: 0 };
  const poor = { deckId: 2, buildablePct: 0.2, requiredCards: 10, coveredCards: 2,
    missingCards: 8, costToCompleteUsd: 5, unpricedCount: 0, contestedCount: 0 };
  const empty = { deckId: 3, buildablePct: null, requiredCards: 0, coveredCards: 0,
    missingCards: 0, costToCompleteUsd: 0, unpricedCount: 0, contestedCount: 0 };

  const order = (sort: 'buildable_desc' | 'cost_to_complete_asc' | 'missing_asc') =>
    [poor, empty, rich].sort((a, b) => compareBuildability(sort, a, b)).map((d) => d.deckId);

  assert.deepEqual(order('buildable_desc'), [1, 2, 3]);
  assert.deepEqual(order('cost_to_complete_asc'), [2, 1, 3], 'cheapest to finish first');
  assert.deepEqual(order('missing_asc'), [1, 2, 3], 'closest to done first');
});

// ---------------------------------------------------------------- want lists

test('adding the missing set to a want list consolidates, and re-running is idempotent', () => {
  const { db, decks, deckId } = tenCardDeck();
  const listId = (db.prepare('SELECT id FROM want_lists ORDER BY is_default DESC LIMIT 1')
    .get() as { id: number } | undefined)?.id
    ?? Number(db.prepare(`INSERT INTO want_lists (name, is_default) VALUES ('Wants', 1)`)
      .run().lastInsertRowid);

  const push = () => pushEntriesToWantList(db, deckId, missingForWantList(db, deckId), listId);

  const first = push();
  assert.equal(first.added, 3);

  const items = db.prepare(
    'SELECT oracle_id, quantity FROM want_list_items WHERE want_list_id = ? ORDER BY oracle_id',
  ).all(listId) as Array<{ oracle_id: string; quantity: number }>;
  assert.deepEqual(items, [
    { oracle_id: 'o-7', quantity: 1 },
    { oracle_id: 'o-8', quantity: 1 },
    { oracle_id: 'o-9', quantity: 1 },
  ]);

  const needs = db.prepare(`
    SELECT wd.deck_id, wd.quantity FROM want_list_item_decks wd
    JOIN want_list_items w ON w.id = wd.want_list_item_id
    WHERE w.want_list_id = ?`).all(listId) as Array<{ deck_id: number; quantity: number }>;
  assert.equal(needs.length, 3);
  assert.ok(needs.every((need) => need.deck_id === deckId && need.quantity === 1));

  // The second push is an upsert, not a duplicate and not a constraint error.
  const second = push();
  assert.equal(second.added, 0);
  assert.equal(second.updated, 3);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM want_list_items WHERE want_list_id = ?')
      .get(listId) as { n: number }).n,
    3,
  );
});

test('neither basics nor proxied copies are ever shopped for', () => {
  const { db, decks, collection, locationId } = fixture([
    { id: 'o-ring', name: 'Sol Ring', price: 2 },
    { id: 'o-bolt', name: 'Lightning Bolt', price: 7 },
    { id: 'o-island', name: 'Island', price: 1, basic: true },
  ]);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });
  decks.addCard(deckId, 'o-bolt', { board: 'main', quantity: 1 });
  decks.addCard(deckId, 'o-island', { board: 'main', quantity: 20 });
  decks.setSlotAllocation(deckId, cardId(decks, deckId, 'o-bolt'), { proxied: 1 });

  assert.deepEqual(missingForWantList(db, deckId), [{ oracleId: 'o-ring', needed: 1 }]);
  // Nothing owned, but nothing to buy for the proxy or the lands either.
  assert.equal(own(collection, locationId, 'o-ring', 1) > 0, true);
  assert.deepEqual(missingForWantList(db, deckId), []);
});

// --------------------------------------------------------------- performance

test('twenty-five decks and a full-ish collection stay well inside the budget', () => {
  const cards: CardSpec[] = Array.from({ length: 400 }, (_, i) => ({
    id: `o-${i}`, name: `Card ${i}`, price: (i % 20) + 1,
  }));
  const { db, decks, collection, locationId } = fixture(cards);

  // Several printings per card, so the cheapest-printing lookup has real work.
  const extraPrinting = db.prepare(`
    INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
    VALUES (?,?,'tst',?,?)`);
  db.transaction(() => {
    for (const card of cards) {
      for (let n = 1; n <= 4; n += 1) {
        extraPrinting.run(
          `p-${card.id}-${n}`, card.id, `${card.id}-x${n}`, (card.price ?? 1) + n,
        );
      }
    }
  })();

  db.transaction(() => {
    for (const card of cards) own(collection, locationId, card.id, 2);
  })();

  const deckIds: number[] = [];
  db.transaction(() => {
    for (let d = 0; d < 25; d += 1) {
      const deckId = decks.create({ name: `Deck ${d}`, formatCode: 'modern' });
      deckIds.push(deckId);
      for (let c = 0; c < 60; c += 1) {
        const oracleId = `o-${(d * 7 + c) % 400}`;
        decks.addCard(deckId, oracleId, { board: 'main', quantity: 1, fromCollection: 1 });
      }
      if (d % 2 === 0) decks.update(deckId, { status: 'assembled' });
    }
  })();

  const started = performance.now();
  const figures = buildabilityForDecks(db);
  const elapsed = performance.now() - started;

  assert.equal(figures.size, 25);
  // The budget is ~100ms. A per-deck N+1 pattern lands an order of magnitude
  // past that on this fixture, which is the point of asserting it at all.
  assert.ok(elapsed < 100, `buildability for 25 decks took ${elapsed.toFixed(1)}ms`);
});
