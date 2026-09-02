import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { DeckStore } from './store.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

/** W=1 U=2 B=4 R=8 G=16 */
const CARDS = [
  { id: 'o-atraxa', name: "Atraxa, Praetors' Voice", type: 'Legendary Creature — Angel', mask: 1|2|4|16, leg: 1, price: 20 },
  { id: 'o-krenko', name: 'Krenko, Mob Boss', type: 'Legendary Creature — Goblin', mask: 8, leg: 1, price: 5 },
  { id: 'o-thalia', name: 'Thalia, Guardian of Thraben', type: 'Legendary Creature — Human', mask: 1, leg: 1, price: 8 },
  { id: 'o-bolt', name: 'Lightning Bolt', type: 'Instant', mask: 8, leg: 0, price: 2 },
  { id: 'o-mountain', name: 'Mountain', type: 'Basic Land', mask: 8, leg: 0, price: 0.1 },
  { id: 'o-jewel', name: 'Jeweled Lotus', type: 'Artifact', mask: 0, leg: 0, price: 90 },
  { id: 'o-sword', name: 'Sword of Feast and Famine', type: 'Legendary Artifact — Equipment', mask: 0, leg: 1, price: 40 },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  CARDS.forEach((c, i) => {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,color_identity_mask,is_legendary,can_be_commander)
                VALUES (?,?,?,1,?,'x','normal',?,?,?)`)
      .run(c.id, c.name, c.name.toLowerCase(), c.type, c.mask, c.leg, c.leg);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
                VALUES (?,?,'tst',?,?)`).run(`p-${c.id}`, c.id, String(i), c.price);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?').run(`p-${c.id}`, c.id);
  });
  return { db, decks: new DeckStore(db) };
}

const coverOf = (decks: DeckStore, id: number) =>
  decks.list().find((d) => d.id === id)!.coverPrintingId;

test('a commander deck fronts with its commander', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Atraxa', formatCode: 'commander' });
  decks.addCard(id, 'o-atraxa', { board: 'command' });
  const card = decks.get(id)!.cards[0];
  decks.setBoard(id, card.id, 'command', 'commander');
  // Jeweled Lotus is worth far more, and must not win.
  decks.addCard(id, 'o-jewel', { quantity: 1 });
  assert.equal(coverOf(decks, id), 'p-o-atraxa');
  db.close();
});

test('a deck with no commander uses a legendary creature in its main colour', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Mono red', formatCode: 'modern' });
  decks.addCard(id, 'o-mountain', { quantity: 20 });   // makes red dominant
  decks.addCard(id, 'o-bolt', { quantity: 4 });
  decks.addCard(id, 'o-krenko', { quantity: 1 });      // red legendary
  decks.addCard(id, 'o-thalia', { quantity: 1 });      // white legendary, off-colour
  assert.equal(coverOf(decks, id), 'p-o-krenko');
  db.close();
});

test('with no legendary creature at all it falls back to the most expensive card', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Burn', formatCode: 'modern' });
  decks.addCard(id, 'o-bolt', { quantity: 4 });
  decks.addCard(id, 'o-mountain', { quantity: 20 });
  decks.addCard(id, 'o-jewel', { quantity: 1 });       // priciest, not a creature
  assert.equal(coverOf(decks, id), 'p-o-jewel');
  db.close();
});

test('a legendary artifact is not mistaken for a legendary creature', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Equipment', formatCode: 'modern' });
  decks.addCard(id, 'o-sword', { quantity: 1 });       // legendary, but not a creature
  decks.addCard(id, 'o-jewel', { quantity: 1 });       // more expensive
  assert.equal(coverOf(decks, id), 'p-o-jewel', 'the price fallback, not the sword');
  db.close();
});

test('an empty deck has no cover rather than a wrong one', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Empty' });
  assert.equal(coverOf(decks, id), null);
  db.close();
});

test('a chosen cover beats everything the deck would have picked', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Atraxa', formatCode: 'commander' });
  decks.addCard(id, 'o-atraxa', { board: 'command' });
  decks.addCard(id, 'o-bolt', { quantity: 1 });

  decks.setCover(id, 'p-o-bolt');
  assert.equal(coverOf(decks, id), 'p-o-bolt');

  // Clearing it goes back to working it out.
  decks.setCover(id, null);
  assert.equal(coverOf(decks, id), 'p-o-atraxa');
  db.close();
});

test('a pinned art carries through to the deck cover', () => {
  const { db, decks } = fixture();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd)
              VALUES ('p-alt','o-krenko','tst','99',1)`).run();
  db.prepare(`INSERT INTO card_art_preferences (oracle_id, printing_id) VALUES ('o-krenko','p-alt')`).run();

  const id = decks.create({ name: 'Goblins', formatCode: 'modern' });
  decks.addCard(id, 'o-mountain', { quantity: 20 });
  decks.addCard(id, 'o-krenko', { quantity: 1 });
  assert.equal(coverOf(decks, id), 'p-alt', 'the cover uses the art you chose');
  db.close();
});

test('tags are case-insensitive, listed with counts, and removable', () => {
  const { db, decks } = fixture();
  const a = decks.create({ name: 'A' });
  const b = decks.create({ name: 'B' });

  decks.addTag(a, 'Commander');
  decks.addTag(a, 'commander');           // same tag, different casing
  decks.addTag(a, '  budget  ');          // trimmed
  decks.addTag(b, 'Commander');

  assert.deepEqual(decks.tags(a), ['budget', 'Commander']);
  assert.deepEqual(decks.allTags(), [
    { tag: 'budget', deckCount: 1 },
    { tag: 'Commander', deckCount: 2 },
  ]);

  decks.removeTag(a, 'COMMANDER');        // also case-insensitive
  assert.deepEqual(decks.tags(a), ['budget']);

  // A blank tag is not a tag.
  decks.addTag(a, '   ');
  assert.deepEqual(decks.tags(a), ['budget']);
  db.close();
});

test('deleting a deck takes its tags with it', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'A' });
  decks.addTag(id, 'temporary');
  decks.delete(id);
  assert.deepEqual(decks.allTags(), []);
  db.close();
});

test('tags appear on the deck summary', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'A' });
  decks.addTag(id, 'built');
  decks.addTag(id, 'cEDH');
  assert.deepEqual(decks.list().find((d) => d.id === id)!.tags, ['built', 'cEDH']);
  db.close();
});
