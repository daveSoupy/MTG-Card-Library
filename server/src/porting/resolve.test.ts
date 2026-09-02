import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { normalizeName } from '../model/mtg.ts';
import { CardResolver, similarity, resolvePrinting } from './resolve.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

/** A handful of cards chosen for the ways names actually go wrong. */
const CARDS: Array<{ id: string; name: string; faces?: string[] }> = [
  { id: 'o-bolt', name: 'Lightning Bolt' },
  { id: 'o-helix', name: 'Lightning Helix' },
  { id: 'o-atraxa', name: "Atraxa, Praetors' Voice" },
  { id: 'o-fire', name: 'Fire // Ice', faces: ['Fire', 'Ice'] },
  { id: 'o-jace', name: 'Jace, the Mind Sculptor' },
  { id: 'o-solring', name: 'Sol Ring' },
  { id: 'o-aether', name: 'Æther Vial' },
  { id: 'o-delver', name: 'Delver of Secrets // Insectile Aberration',
    faces: ['Delver of Secrets', 'Insectile Aberration'] },
];

function fixture(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('lea','Limited Edition Alpha')`).run();
  db.prepare(`INSERT INTO sets (code, name) VALUES ('m10','Magic 2010')`).run();

  const oracle = db.prepare(`
    INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all, layout)
    VALUES (?, ?, ?, 1, 'Instant', 'x', 'normal')`);
  const variant = db.prepare(`
    INSERT INTO card_name_variants (oracle_id, variant_name, variant_normalized, kind) VALUES (?, ?, ?, ?)`);
  const printing = db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number, collector_number_num)
    VALUES (?, ?, ?, ?, ?)`);

  CARDS.forEach((card, index) => {
    oracle.run(card.id, card.name, normalizeName(card.name));
    variant.run(card.id, card.name, normalizeName(card.name), 'primary');
    for (const face of card.faces ?? []) {
      variant.run(card.id, face, normalizeName(face), 'face');
    }
    // Two printings for Lightning Bolt, so set preference is testable.
    const number = String(index + 1);
    printing.run(`${card.id}-m10`, card.id, 'm10', number, index + 1);
    if (card.id === 'o-bolt') printing.run('o-bolt-lea', 'o-bolt', 'lea', '161', 161);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`${card.id}-m10`, card.id);
  });
  return db;
}

test('an exact name resolves with full confidence', () => {
  const db = fixture();
  const r = new CardResolver(db).resolve('Lightning Bolt');
  assert.equal(r.match?.oracleId, 'o-bolt');
  assert.equal(r.match?.via, 'exact');
  assert.equal(r.match?.confidence, 1);
  db.close();
});

test('case and punctuation differences still resolve exactly', () => {
  const db = fixture();
  const resolver = new CardResolver(db);
  for (const spelling of ['lightning bolt', 'LIGHTNING BOLT', '  Lightning   Bolt  ']) {
    assert.equal(resolver.resolve(spelling).match?.oracleId, 'o-bolt', spelling);
  }
  // Apostrophe styles vary between exporters.
  assert.equal(resolver.resolve("Atraxa, Praetors' Voice").match?.oracleId, 'o-atraxa');
  assert.equal(resolver.resolve('Atraxa, Praetors’ Voice').match?.oracleId, 'o-atraxa');
  db.close();
});

test('a single face name resolves to its whole card', () => {
  const db = fixture();
  const resolver = new CardResolver(db);
  // Exporters write split and transforming cards inconsistently.
  assert.equal(resolver.resolve('Fire // Ice').match?.oracleId, 'o-fire');
  assert.equal(resolver.resolve('Fire').match?.oracleId, 'o-fire');
  assert.equal(resolver.resolve('Delver of Secrets').match?.oracleId, 'o-delver');
  assert.equal(resolver.resolve('Delver of Secrets').match?.via, 'face');
  db.close();
});

test('an accented name resolves from its plain spelling', () => {
  const db = fixture();
  // People type "Aether Vial"; the card is printed "Æther Vial".
  const r = new CardResolver(db).resolve('Aether Vial');
  assert.equal(r.match?.oracleId, 'o-aether');
  db.close();
});

test('a typo resolves fuzzily, and says so', () => {
  const db = fixture();
  const r = new CardResolver(db).resolve('Lightnig Bolt');
  assert.equal(r.match?.oracleId, 'o-bolt');
  assert.equal(r.match?.via, 'fuzzy');
  assert.ok(r.match!.confidence < 1 && r.match!.confidence > 0.7,
    `confidence ${r.match?.confidence} should be high but not certain`);
  db.close();
});

test('a name that matches nothing is left for the user, never guessed', () => {
  const db = fixture();
  const r = new CardResolver(db).resolve('Qqzzx Unpronounceable');
  assert.equal(r.match, null, 'no silent wrong import');
  db.close();
});

test('an ambiguous prefix offers candidates rather than picking blind', () => {
  const db = fixture();
  const r = new CardResolver(db).resolve('Lightning');
  // Both Bolt and Helix start this way; whichever is offered, the other is
  // reachable, because importing the wrong one is the failure that matters.
  assert.ok(r.candidates.length >= 2, 'both Lightning cards are offered');
  const ids = r.candidates.map((c) => c.oracleId);
  assert.ok(ids.includes('o-bolt') && ids.includes('o-helix'));
  db.close();
});

test('resolving is cached, so a repeated name costs one lookup', () => {
  const db = fixture();
  const resolver = new CardResolver(db);
  const first = resolver.resolve('Sol Ring');
  const second = resolver.resolve('Sol Ring');
  assert.equal(first, second, 'the same object comes back');
  db.close();
});

test('a set hint picks the printing from that set', () => {
  const db = fixture();
  assert.deepEqual(resolvePrinting(db, 'o-bolt', 'lea', '161'), { printingId: 'o-bolt-lea', exact: true });
  assert.deepEqual(resolvePrinting(db, 'o-bolt', 'lea', null), { printingId: 'o-bolt-lea', exact: false });
  db.close();
});

test('an unknown set falls back to the default printing, flagged inexact', () => {
  const db = fixture();
  const result = resolvePrinting(db, 'o-bolt', 'zzz', '999');
  assert.equal(result.printingId, 'o-bolt-m10');
  assert.equal(result.exact, false, 'the caller must know the printing was chosen for them');
  db.close();
});

test('similarity ranks a typo above an unrelated name', () => {
  assert.equal(similarity('sol ring', 'sol ring'), 1);
  assert.ok(similarity('lightnig bolt', 'lightning bolt') > 0.8);
  assert.ok(similarity('lightning bolt', 'lightning helix') < 0.8);
  // Unrelated names still share stray bigrams, so what matters is the ordering,
  // not the absolute figure.
  assert.ok(similarity('lightnig bolt', 'lightning bolt') > similarity('sol ring', 'lightning bolt') * 2);
});
