import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { DeckStore } from './store.ts';
import { availableFor } from './allocation.ts';
import { reconcileDeckClaims } from './reconcile.ts';

/**
 * The claim is derived, not declared.
 *
 * The deck row's "1 owned" chip set `quantity_from_collection` to the whole
 * slot with no availability check, so decks claimed cards the collection never
 * held. With the chip gone, these are the properties the server owes in its
 * place.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

const CARDS = [
  { id: 'o-ring', name: 'Sol Ring', type: 'Artifact', basic: 0 },
  { id: 'o-bolt', name: 'Lightning Bolt', type: 'Instant', basic: 0 },
  { id: 'o-island', name: 'Island', type: 'Basic Land — Island', basic: 1 },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  for (const [index, card] of CARDS.entries()) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,is_basic_land)
                VALUES (?,?,?,1,?,'x','normal',?)`)
      .run(card.id, card.name, card.name.toLowerCase(), card.type, card.basic);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
                VALUES (?,?,'tst',?,2)`).run(`p-${card.id}`, card.id, String(index));
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${card.id}`, card.id);
  }
  const locationId = (db.prepare('SELECT id FROM storage_locations LIMIT 1')
    .get() as { id: number }).id;
  return { db, decks: new DeckStore(db), collection: new CollectionStore(db), locationId };
}

const own = (
  collection: CollectionStore, locationId: number, oracleId: string, quantity: number,
): number => collection.addLot({ printingId: `p-${oracleId}`, locationId, quantity });

const claim = (db: Database.Database, deckId: number, oracleId: string): number =>
  (db.prepare(`SELECT quantity_from_collection AS q FROM deck_cards
                WHERE deck_id = ? AND oracle_id = ?`).get(deckId, oracleId) as { q: number }).q;

/** Writes a claim the UI could once produce but nothing should accept now. */
const forceClaim = (db: Database.Database, deckId: number, oracleId: string, value: number) =>
  db.prepare(`UPDATE deck_cards SET quantity_from_collection = ?
               WHERE deck_id = ? AND oracle_id = ?`).run(value, deckId, oracleId);

// ------------------------------------------------------------ the core rule

test('a claim on a card you do not own is cut to zero', () => {
  const { db, decks } = fixture();
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });
  forceClaim(db, deckId, 'o-ring', 1);

  reconcileDeckClaims(db, deckId);
  assert.equal(claim(db, deckId, 'o-ring'), 0, 'you cannot reserve what does not exist');
});

test('buying a card the deck already lists raises its claim', () => {
  const { db, decks, collection, locationId } = fixture();
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 2 });
  assert.equal(claim(db, deckId, 'o-ring'), 0, 'nothing owned at add time');

  // The gap `setQuantity` left: it clamps down into a smaller slot but never
  // tops one up, so the deck used to go on reserving nothing.
  own(collection, locationId, 'o-ring', 2);
  reconcileDeckClaims(db, deckId);
  assert.equal(claim(db, deckId, 'o-ring'), 2);
});

test('selling the card lowers the claim to what is left', () => {
  const { db, decks, collection, locationId } = fixture();
  const lotId = own(collection, locationId, 'o-ring', 3);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 3 });
  assert.equal(claim(db, deckId, 'o-ring'), 3);

  collection.updateLot(lotId, { quantity: 1 });
  assert.equal(claim(db, deckId, 'o-ring'), 1, 'the collection write reconciles the deck');
});

test('removing the lot entirely drops the claim', () => {
  const { db, decks, collection, locationId } = fixture();
  const lotId = own(collection, locationId, 'o-ring', 1);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });
  assert.equal(claim(db, deckId, 'o-ring'), 1);

  collection.removeLot(lotId);
  assert.equal(claim(db, deckId, 'o-ring'), 0);
});

test('a copy another built deck holds is never taken', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);

  const theirs = decks.create({ name: 'Theirs', formatCode: 'modern' });
  decks.addCard(theirs, 'o-ring', { board: 'main', quantity: 1 });
  decks.update(theirs, { status: 'assembled' });
  assert.equal(claim(db, theirs, 'o-ring'), 1);

  const mine = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(mine, 'o-ring', { board: 'main', quantity: 1 });

  reconcileDeckClaims(db, mine);
  assert.equal(claim(db, mine, 'o-ring'), 0, 'first to claim keeps it');
  assert.equal(claim(db, theirs, 'o-ring'), 1, 'and the holder is left alone');
});

test('an exempt basic land is left alone rather than zeroed', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-island', 20);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-island', { board: 'main', quantity: 20 });
  forceClaim(db, deckId, 'o-island', 20);

  // The claim is already inert — allocation.ts zeroes an exempt basic's
  // reserved count — so overwriting it would buy nothing and cost something:
  // turn `allocation_ignores_basics` off and these claims mean something again.
  reconcileDeckClaims(db, deckId);
  assert.equal(claim(db, deckId, 'o-island'), 20);
  assert.equal(availableFor(db, 'o-island'), 20, 'and it reserves nothing meanwhile');
});

test('a proxied copy leaves less of the slot to claim', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 4);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 4 });

  const cardId = (db.prepare('SELECT id FROM deck_cards WHERE deck_id = ?')
    .get(deckId) as { id: number }).id;
  decks.setSlotAllocation(deckId, cardId, { fromCollection: 0, proxied: 3 });

  reconcileDeckClaims(db, deckId);
  assert.equal(claim(db, deckId, 'o-ring'), 1, 'three proxies fill three of the four');
});

test('reconciling twice changes nothing the second time', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 2);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 3 });

  reconcileDeckClaims(db, deckId);
  const once = claim(db, deckId, 'o-ring');
  reconcileDeckClaims(db, deckId);
  assert.equal(claim(db, deckId, 'o-ring'), once, 'a deck never competes with itself');
  assert.equal(once, 2);
});

// ------------------------------------------------------------ what it spares

test('a status round trip is still lossless', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 1 });
  decks.update(deckId, { status: 'assembled' });
  assert.equal(claim(db, deckId, 'o-ring'), 1);

  // CLAUDE.md requires assembled -> brew -> assembled to lose nothing, which is
  // why a status change deliberately does not reconcile.
  decks.update(deckId, { status: 'brew' });
  decks.update(deckId, { status: 'assembled' });
  assert.equal(claim(db, deckId, 'o-ring'), 1);
  assert.equal(availableFor(db, 'o-ring'), 0, 'and the copy is reserved again');
});

test('a maybeboard slot reserves nothing, and reserves again when it comes back', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-bolt', 1);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-bolt', { board: 'main', quantity: 1 });
  decks.update(deckId, { status: 'assembled' });
  assert.equal(availableFor(db, 'o-bolt'), 0);

  const cardId = (db.prepare('SELECT id FROM deck_cards WHERE deck_id = ?')
    .get(deckId) as { id: number }).id;
  decks.setBoard(deckId, cardId, 'maybe');
  // The stored claim rides along untouched; what changes is that the
  // maybeboard is outside the reservation rollup entirely.
  assert.equal(availableFor(db, 'o-bolt'), 1, 'a maybeboard is a notepad');

  decks.setBoard(deckId, cardId, 'main');
  assert.equal(availableFor(db, 'o-bolt'), 0);
  assert.equal(claim(db, deckId, 'o-bolt'), 1);
});

test('duplicating a deck does not hand the copy two owners', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 1);
  const original = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(original, 'o-ring', { board: 'main', quantity: 1 });
  decks.update(original, { status: 'assembled' });

  const copy = decks.duplicate(original);
  assert.equal(claim(db, original, 'o-ring'), 1);
  assert.equal(claim(db, copy, 'o-ring'), 0, 'one physical card, one deck');
});

test('shrinking a slot still clamps the claim into it', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 4);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 4 });
  assert.equal(claim(db, deckId, 'o-ring'), 4);

  const cardId = (db.prepare('SELECT id FROM deck_cards WHERE deck_id = ?')
    .get(deckId) as { id: number }).id;
  decks.setQuantity(deckId, cardId, 2);
  assert.equal(claim(db, deckId, 'o-ring'), 2);
});

test('archiving a location takes its cards out of every deck claim', () => {
  const { db, decks, collection, locationId } = fixture();
  own(collection, locationId, 'o-ring', 2);
  const deckId = decks.create({ name: 'Mine', formatCode: 'modern' });
  decks.addCard(deckId, 'o-ring', { board: 'main', quantity: 2 });
  assert.equal(claim(db, deckId, 'o-ring'), 2);

  collection.updateLocation(locationId, { isArchived: true });
  assert.equal(claim(db, deckId, 'o-ring'), 0, 'an archived box is off the shelf');

  collection.updateLocation(locationId, { isArchived: false });
  assert.equal(claim(db, deckId, 'o-ring'), 2);
});
