import { test } from 'node:test';
import { CardImporter } from '../sync/importer.ts';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, setSetting } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { TradeListStore } from '../tradelists/store.ts';
import { WantStore } from '../collection/wants.ts';
import { DeckStore } from '../decks/store.ts';
import {
  ALLOCATION_IGNORES_BASICS, BREWS_RESERVE_COPIES, TRADELIST_REDUCES_AVAILABLE,
} from '../decks/allocation.ts';
import { CardSearchStore } from './store.ts';

/**
 * Phase 23 — the verification list from the phase doc, run against a real
 * database rather than asserted on generated SQL.
 *
 * These predicates are only worth having if they agree with what the deck rows
 * on the same screen say, and the way that breaks is silent: a number that is
 * confidently wrong rather than an error. So every case here owns real cards,
 * puts them in real decks, and compares.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

const CARDS = [
  { id: 'o-ring', name: 'Sol Ring', type: 'Artifact', basic: 0, colors: '', mask: 0 },
  { id: 'o-bolt', name: 'Lightning Bolt', type: 'Instant', basic: 0, colors: 'R', mask: 8 },
  { id: 'o-llan', name: 'Llanowar Elves', type: 'Creature — Elf Druid', basic: 0, colors: 'G', mask: 16 },
  { id: 'o-swan', name: 'Swan Song', type: 'Instant', basic: 0, colors: 'U', mask: 2 },
  { id: 'o-plains', name: 'Plains', type: 'Basic Land — Plains', basic: 1, colors: '', mask: 0 },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  for (const [index, card] of CARDS.entries()) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,is_basic_land,colors,color_identity,
                  colors_mask,color_identity_mask)
                VALUES (?,?,?,1,?,'x','normal',?,?,?,?,?)`)
      .run(card.id, card.name, card.name.toLowerCase(), card.type, card.basic,
           card.colors, card.colors, card.mask, card.mask);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
                VALUES (?,?,'tst',?,2)`).run(`p-${card.id}`, card.id, String(index));
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${card.id}`, card.id);
    // Legal somewhere, or the "hide unplayable cards" default eats every row.
    db.prepare(`INSERT INTO card_legalities (oracle_id,format_code,legality)
                VALUES (?, 'commander', 'legal')`).run(card.id);
  }
  const locationId = (db.prepare('SELECT id FROM storage_locations LIMIT 1')
    .get() as { id: number }).id;
  // is_playable is derived at sync from card_legalities, the same as any
  // other flag on oracle_cards, so a hand-built fixture derives it too.
  new CardImporter(db).assignPlayableFlags();
  return {
    db,
    search: new CardSearchStore(db),
    decks: new DeckStore(db),
    collection: new CollectionStore(db),
    tradeLists: new TradeListStore(db),
    wants: new WantStore(db),
    locationId,
  };
}

const own = (collection: CollectionStore, locationId: number, oracleId: string, quantity: number) =>
  collection.addLot({ printingId: `p-${oracleId}`, locationId, quantity });

/** Card names matching a query, sorted, so assertions read as sets. */
const names = (search: CardSearchStore, query: string, filters = {}) =>
  search.search(query, filters, 'name', 100).cards.map((c) => c.name).sort();

const rowFor = (search: CardSearchStore, query: string, name: string, filters = {}) =>
  search.search(query, filters, 'name', 100).cards.find((c) => c.name === name);

// ------------------------------------------------------------------- owned

test('owned>=1 is exactly the cards with a lot in a non-archived location', () => {
  const { db, search, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 2);
  own(collection, locationId, 'o-bolt', 1);

  assert.deepEqual(names(search, 'owned>=1'), ['Lightning Bolt', 'Sol Ring']);

  // Counted against a direct query on collection_items, as the phase asks.
  const direct = db.prepare(`
    SELECT COUNT(DISTINCT p.oracle_id) AS n
      FROM collection_items ci
      JOIN card_printings p     ON p.id  = ci.printing_id
      JOIN storage_locations sl ON sl.id = ci.location_id
     WHERE sl.is_archived = 0`).get() as { n: number };
  assert.equal(search.search('owned>=1', {}, 'name', 100).total, direct.n);
});

test('an archived location is not owned, and the badge agrees with the filter', () => {
  const { db, search, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 3);
  db.prepare('UPDATE storage_locations SET is_archived = 1 WHERE id = ?').run(locationId);

  assert.deepEqual(names(search, 'owned>=1'), []);
  // The row still exists in the catalog; its owned badge reads 0, not 3.
  assert.equal(rowFor(search, 'Sol Ring', 'Sol Ring')?.ownedQuantity, 0);
});

test('the bare form means at least one, and owned:0 is the other end', () => {
  const { search, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 2);

  assert.deepEqual(names(search, 'owned'), ['Sol Ring']);
  assert.deepEqual(names(search, 'owned>=2'), ['Sol Ring']);
  assert.deepEqual(names(search, 'owned>=3'), []);
  assert.ok(!names(search, 'owned:0').includes('Sol Ring'));
  assert.deepEqual(names(search, '-owned'), names(search, 'owned:0'));
});

// --------------------------------------------------------------- available

test('a copy an assembled deck holds is owned but not available', () => {
  const { search, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 2);
  const deckId = decks.create({ name: 'Atraxa', formatCode: 'commander' });
  decks.update(deckId, { status: 'assembled' });
  decks.addCard(deckId, 'o-ring', { quantity: 1 });

  assert.deepEqual(names(search, 'available>=1'), ['Sol Ring']);
  assert.deepEqual(names(search, 'available>=2'), []);
  assert.deepEqual(names(search, 'owned>=2'), ['Sol Ring']);
});

test('searched from inside that deck, its own reservation does not count', () => {
  const { search, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 2);
  const deckId = decks.create({ name: 'Atraxa', formatCode: 'commander' });
  decks.update(deckId, { status: 'assembled' });
  decks.addCard(deckId, 'o-ring', { quantity: 1 });

  const fromDeck = rowFor(search, 'Sol Ring', 'Sol Ring', { deckId });
  assert.equal(fromDeck?.availableQuantity, 2);
  assert.deepEqual(names(search, 'available>=2', { deckId }), ['Sol Ring']);

  // And a *different* deck still sees the claim.
  const other = decks.create({ name: 'Other', formatCode: 'commander' });
  assert.deepEqual(names(search, 'available>=2', { deckId: other }), []);
});

test('a brew reserves nothing', () => {
  const { search, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  const deckId = decks.create({ name: 'Idea', formatCode: 'commander' });
  decks.addCard(deckId, 'o-ring', { quantity: 1 });
  assert.equal(decks.get(deckId)!.status, 'brew');

  assert.deepEqual(names(search, 'available>=1'), ['Sol Ring']);
});

test('the brews_reserve_copies escape hatch reaches search too', () => {
  const { db, search, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  const deckId = decks.create({ name: 'Idea', formatCode: 'commander' });
  decks.addCard(deckId, 'o-ring', { quantity: 1 });

  setSetting(db, BREWS_RESERVE_COPIES, '1');
  assert.deepEqual(names(search, 'available>=1'), []);
});

test('a trade-listed copy leaves owned and fortrade but not available', () => {
  const { db, search, collection, tradeLists, locationId } = fixture();
  const lot = own(collection, locationId, 'o-bolt', 1);
  const listId = tradeLists.createList('Bulk trades');
  tradeLists.addItem(listId, lot, { quantity: 1 });

  assert.deepEqual(names(search, 'available>=1'), []);
  assert.deepEqual(names(search, 'owned>=1'), ['Lightning Bolt']);
  assert.deepEqual(names(search, 'fortrade'), ['Lightning Bolt']);
  assert.deepEqual(names(search, 'tradelist:"Bulk trades"'), ['Lightning Bolt']);

  // With the setting off, the same copy is available again — and still listed.
  setSetting(db, TRADELIST_REDUCES_AVAILABLE, '0');
  assert.deepEqual(names(search, 'available>=1'), ['Lightning Bolt']);
  assert.equal(rowFor(search, 'Lightning Bolt', 'Lightning Bolt')?.tradeListedQuantity, 1);
});

test('an exempt basic land is never reserved and never short', () => {
  const { db, search, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-plains', 4);
  const deckId = decks.create({ name: 'Mono W', formatCode: 'commander' });
  decks.update(deckId, { status: 'assembled' });
  decks.addCard(deckId, 'o-plains', { quantity: 4 });

  const row = rowFor(search, 'Plains', 'Plains');
  assert.equal(row?.availableQuantity, 4);
  assert.equal(row?.allocationTracked, false);

  // Switch the exemption off and the same four copies are spoken for.
  setSetting(db, ALLOCATION_IGNORES_BASICS, '0');
  const tracked = rowFor(search, 'Plains', 'Plains');
  assert.equal(tracked?.availableQuantity, 0);
  assert.equal(tracked?.allocationTracked, true);
});

// ------------------------------------------------------------- loc / decks

test('loc: matches by name, case-insensitively, and quoted names survive', () => {
  const { db, search, collection } = fixture();
  db.prepare(`INSERT INTO storage_locations (name,kind) VALUES ('Blue Tackle Box','box')`).run();
  const boxId = (db.prepare(`SELECT id FROM storage_locations WHERE name = 'Blue Tackle Box'`)
    .get() as { id: number }).id;
  own(collection, boxId, 'o-swan', 1);

  assert.deepEqual(names(search, 'loc:"Blue Tackle Box"'), ['Swan Song']);
  assert.deepEqual(names(search, 'loc:"blue tackle box"'), ['Swan Song']);
  assert.deepEqual(names(search, 'location:"Blue Tackle Box"'), ['Swan Song']);
});

test('an unknown location is empty with a warning, not an error', () => {
  const { search } = fixture();
  const result = search.search('loc:Binderrr', {}, 'name', 100);
  assert.equal(result.total, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Binderrr/);
});

test('a known name warns about nothing', () => {
  const { db, search } = fixture();
  db.prepare(`INSERT INTO storage_locations (name,kind) VALUES ('Binder 3','binder')`).run();
  assert.deepEqual(search.search('loc:"Binder 3"', {}, 'name', 100).warnings, []);
});

test('deck: and indeck read the same definition, and -indeck owned is dead inventory', () => {
  const { search, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  own(collection, locationId, 'o-bolt', 1);
  const deckId = decks.create({ name: 'Atraxa', formatCode: 'commander' });
  decks.addCard(deckId, 'o-ring', { quantity: 1 });

  assert.deepEqual(names(search, 'deck:Atraxa'), ['Sol Ring']);
  assert.deepEqual(names(search, 'indeck'), ['Sol Ring']);
  assert.deepEqual(names(search, '-indeck owned>=1'), ['Lightning Bolt']);

  // Adding it to a deck takes it out of that answer.
  decks.addCard(deckId, 'o-bolt', { quantity: 1 });
  assert.deepEqual(names(search, '-indeck owned>=1'), []);
});

test('a result row carries the decks that use it', () => {
  const { search, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 4);
  for (const name of ['Atraxa, Praetors’ Voice', 'Rakdos, Lord of Riots']) {
    const id = decks.create({ name, formatCode: 'commander' });
    decks.addCard(id, 'o-ring', { quantity: 1 });
  }

  const row = rowFor(search, 'Sol Ring', 'Sol Ring');
  assert.equal(row?.deckCount, 2);
  // Comma in a deck name must not split it — the separator is a unit separator.
  assert.deepEqual(row?.deckNames.sort(),
    ['Atraxa, Praetors’ Voice', 'Rakdos, Lord of Riots']);
});

test('an unknown deck name warns rather than reading as no filter', () => {
  const { search } = fixture();
  const result = search.search('deck:Nonesuch', {}, 'name', 100);
  assert.equal(result.total, 0);
  assert.match(result.warnings[0], /deck/i);
});

// ------------------------------------------------------------------- wants

test('want and want:<list> find cards on an active want list', () => {
  const { search, wants } = fixture();
  const listId = wants.createList('Grails');
  wants.addItem(listId, 'o-swan', { quantity: 1 });

  assert.deepEqual(names(search, 'want'), ['Swan Song']);
  assert.deepEqual(names(search, 'want:Grails'), ['Swan Song']);
  assert.deepEqual(names(search, '-want owned>=1'), []);
  assert.match(search.search('want:Nope', {}, 'name', 100).warnings[0], /want list/i);
});

// ------------------------------------------------------- composing, not replacing

test('collection terms AND into the query rather than replacing it', () => {
  const { search, collection, locationId } = fixture();
  own(collection, locationId, 'o-bolt', 1);
  own(collection, locationId, 'o-llan', 1);

  assert.deepEqual(names(search, 'owned>=1 c:r'), ['Lightning Bolt']);
  assert.deepEqual(names(search, 'owned>=1 t:creature'), ['Llanowar Elves']);
});

test('a scope term can only narrow, never widen — including under a colour filter', () => {
  const { search, collection, locationId } = fixture();
  own(collection, locationId, 'o-bolt', 1);
  own(collection, locationId, 'o-llan', 1);

  // The deck builder's identity restriction arrives as a structured filter, so
  // it survives any query text. This is the failure mode the phase names: a
  // chip implemented as a *replacement* would drop it silently.
  const monoWhite = { colors: ['W', 'C'] };
  const withScope = search.search('available>=1', monoWhite, 'name', 100);
  const without = search.search('', monoWhite, 'name', 100);

  assert.ok(withScope.total <= without.total);
  // Owning available green cards does not put them in a mono-white builder.
  assert.ok(!withScope.cards.some((c) => c.name === 'Llanowar Elves'));
});

test('widening the commander identity widens the same query', () => {
  const { search, collection, locationId } = fixture();
  own(collection, locationId, 'o-llan', 1);
  own(collection, locationId, 'o-bolt', 1);

  const white = search.search('available>=1', { colors: ['W', 'C'] }, 'name', 100);
  const naya = search.search('available>=1', { colors: ['R', 'G', 'W', 'C'] }, 'name', 100);
  assert.equal(white.total, 0);
  assert.equal(naya.total, 2);
});

test('is:owned means what owned means, archived locations and all', () => {
  const { db, search, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  assert.deepEqual(names(search, 'is:owned'), ['Sol Ring']);

  db.prepare('UPDATE storage_locations SET is_archived = 1 WHERE id = ?').run(locationId);
  assert.deepEqual(names(search, 'is:owned'), []);
  assert.deepEqual(names(search, 'is:owned'), names(search, 'owned>=1'));
});

test('the ownedOnly filter and the owned term give the same answer', () => {
  const { search, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  assert.deepEqual(
    names(search, '', { ownedOnly: true }),
    names(search, 'owned>=1'),
  );
});

test('a count that is not a number is reported, not silently dropped', () => {
  const { search, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  const result = search.search('owned>=lots', {}, 'name', 100);
  assert.match(result.warnings[0], /number/i);
});
