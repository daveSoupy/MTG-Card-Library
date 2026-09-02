import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { DeckStore } from './store.ts';

/**
 * Where a card goes when you just click it.
 *
 * Picking the commander is the first thing you do in a Commander deck, and the
 * app used to make it the awkward path: add the card, then move it. The first
 * card into an empty deck now leads it, if it can.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

interface Fixture {
  id: string; name: string; type: string;
  legendary?: number; commander?: number;
  partnerKind?: string | null; partnerWith?: string | null;
  rarity?: string;
  /** W=1 U=2 B=4 R=8 G=16 */
  identity?: number;
}

const CARDS: Fixture[] = [
  { id: 'atraxa', name: "Atraxa, Praetors' Voice", type: 'Legendary Creature — Angel',
    legendary: 1, commander: 1, identity: 1 | 2 | 4 | 16 },
  { id: 'krenko', name: 'Krenko, Mob Boss', type: 'Legendary Creature — Goblin',
    legendary: 1, commander: 1, identity: 8 },
  { id: 'solring', name: 'Sol Ring', type: 'Artifact' },
  { id: 'teferi', name: 'Teferi, Hero of Dominaria', type: 'Legendary Planeswalker — Teferi',
    legendary: 1, commander: 0 },
  { id: 'thrasios', name: 'Thrasios, Triton Hero', type: 'Legendary Creature — Merfolk',
    legendary: 1, commander: 1, partnerKind: 'partner' },
  { id: 'tymna', name: 'Tymna the Weaver', type: 'Legendary Creature — Human',
    legendary: 1, commander: 1, partnerKind: 'partner' },
  { id: 'wilhelt', name: 'Wilhelt, the Rotcleaver', type: 'Legendary Creature — Zombie',
    legendary: 1, commander: 1 },
  { id: 'candlekeep', name: 'Candlekeep Sage', type: 'Legendary Creature — Human',
    legendary: 1, commander: 1, partnerKind: 'choose_background' },
  { id: 'guild', name: 'Guild Artisan', type: 'Legendary Enchantment — Background',
    legendary: 1, commander: 0, partnerKind: 'background' },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  CARDS.forEach((c, i) => {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,is_legendary,can_be_commander,partner_kind,partner_with,
                  color_identity_mask)
                VALUES (?,?,?,2,?,'x','normal',?,?,?,?,?)`)
      .run(c.id, c.name, c.name.toLowerCase(), c.type,
           c.legendary ?? 0, c.commander ?? 0, c.partnerKind ?? null, c.partnerWith ?? null,
           c.identity ?? 0);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity)
                VALUES (?,?,'tst',?,?)`).run(`p-${i}`, c.id, String(i), c.rarity ?? 'rare');
    db.prepare('UPDATE oracle_cards SET default_printing_id=? WHERE oracle_id=?').run(`p-${i}`, c.id);
  });
  return { db, decks: new DeckStore(db) };
}

const zone = (decks: DeckStore, id: number) =>
  decks.get(id)!.cards.filter((c) => c.board === 'command')
    .map((c) => [c.oracleId, c.commanderRole]);
const boardOf = (decks: DeckStore, id: number, oracleId: string) =>
  decks.get(id)!.cards.find((c) => c.oracleId === oracleId)?.board;

test('the first card into an empty Commander deck leads it', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'atraxa');
  assert.deepEqual(zone(decks, id), [['atraxa', 'commander']]);
  db.close();
});

test('the second card does not, even when it could have led', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'atraxa');
  // A Commander deck runs several legendary creatures in the 99.
  decks.addCard(id, 'krenko');
  assert.equal(boardOf(decks, id, 'krenko'), 'main');
  assert.deepEqual(zone(decks, id), [['atraxa', 'commander']]);
  db.close();
});

test('a first card that cannot lead goes to the deck', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'solring');
  assert.equal(boardOf(decks, id, 'solring'), 'main');
  assert.deepEqual(zone(decks, id), []);
  // And the next card still gets its chance, since the zone is still empty...
  // but the deck is no longer empty, so no.
  decks.addCard(id, 'atraxa');
  assert.equal(boardOf(decks, id, 'atraxa'), 'main');
  db.close();
});

test('formats without a command zone are untouched', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'Modern', formatCode: 'modern' });
  decks.addCard(id, 'atraxa');
  assert.equal(boardOf(decks, id, 'atraxa'), 'main');

  const none = decks.create({ name: 'No format', formatCode: null });
  decks.addCard(none, 'atraxa');
  assert.equal(boardOf(decks, none, 'atraxa'), 'main');
  db.close();
});

test('an explicit board always wins — which is what keeps import unaffected', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'atraxa', { board: 'main' });
  assert.equal(boardOf(decks, id, 'atraxa'), 'main');
  assert.deepEqual(zone(decks, id), []);
  db.close();
});

test('a legal partner takes the second slot', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'thrasios');
  decks.addCard(id, 'tymna');
  assert.deepEqual(zone(decks, id), [['thrasios', 'commander'], ['tymna', 'partner']]);
  db.close();
});

test('a card that cannot pair does not join the zone', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'thrasios');
  // Wilhelt has no Partner, so this is a 99 card even though the zone has room.
  decks.addCard(id, 'wilhelt');
  assert.equal(boardOf(decks, id, 'wilhelt'), 'main');
  assert.deepEqual(zone(decks, id), [['thrasios', 'commander']]);
  db.close();
});

test('a Background joins a card that chooses one, with the right role', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'candlekeep');
  decks.addCard(id, 'guild');
  assert.deepEqual(zone(decks, id), [['candlekeep', 'commander'], ['guild', 'background']]);
  db.close();
});

test('a third card never joins a full command zone', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'thrasios');
  decks.addCard(id, 'tymna');
  decks.addCard(id, 'krenko');
  assert.equal(boardOf(decks, id, 'krenko'), 'main');
  db.close();
});

test('Oathbreaker takes the planeswalker Commander would refuse', () => {
  const { db, decks } = fixture();
  const oath = decks.create({ name: 'Oath', formatCode: 'oathbreaker' });
  decks.addCard(oath, 'teferi');
  assert.deepEqual(zone(decks, oath), [['teferi', 'commander']]);

  // The same card leads nothing in Commander.
  const edh = decks.create({ name: 'EDH', formatCode: 'commander' });
  decks.addCard(edh, 'teferi');
  assert.equal(boardOf(decks, edh, 'teferi'), 'main');
  db.close();
});

test('Brawl takes either a legendary creature or a planeswalker', () => {
  const { db, decks } = fixture();
  const a = decks.create({ name: 'A', formatCode: 'brawl' });
  decks.addCard(a, 'teferi');
  assert.deepEqual(zone(decks, a), [['teferi', 'commander']]);

  const b = decks.create({ name: 'B', formatCode: 'brawl' });
  decks.addCard(b, 'atraxa');
  assert.deepEqual(zone(decks, b), [['atraxa', 'commander']]);
  db.close();
});

test('the auto-placed commander sets the colour identity for what follows', () => {
  const { db, decks } = fixture();
  const id = decks.create({ name: 'New', formatCode: 'commander' });
  decks.addCard(id, 'krenko');
  // Identity comes from the command board, so it is live from the first click.
  assert.equal(decks.get(id)!.validation.commanderIdentity, 'R');
  db.close();
});
