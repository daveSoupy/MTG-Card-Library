import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { normalizeName } from '../model/mtg.ts';
import { CardSearchStore } from './store.ts';
import { compileQuery } from './query.ts';

/**
 * How the search box matches what you type.
 *
 * The bug these cover: free text compiled to an FTS5 phrase against a
 * word-oriented index, so typing "waste" could never find the card "Wastes" —
 * the row was filtered out before the relevance ordering (which has a perfectly
 * good substring tier) ever saw it.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

const CARDS: Array<{ name: string; type: string; text: string; cost?: string; colors?: number }> = [
  { name: 'Wastes', type: 'Basic Land', text: '{T}: Add {C}.' },
  { name: 'Wasteland', type: 'Land', text: 'Destroy target nonbasic land.' },
  { name: 'Waste Not', type: 'Enchantment', text: 'Whenever an opponent discards a card…' },
  { name: 'Lay Waste', type: 'Sorcery', text: 'Destroy target land.' },
  { name: 'Lightning Bolt', type: 'Instant', text: 'Deals 3 damage to any target.', colors: 8 },
  { name: 'Lightning Helix', type: 'Instant', text: 'Deals 3 damage and you gain 3 life.', colors: 9 },
  { name: 'Emeritus of Conflict // Lightning Bolt', type: 'Creature', text: 'x', colors: 8 },
  { name: 'Æther Vial', type: 'Artifact', text: 'Put a creature card onto the battlefield.' },
  { name: 'Boros Recruit', type: 'Creature', text: 'Double strike', cost: '{R/W}', colors: 9 },
  { name: 'Behemoth Sledge', type: 'Artifact — Equipment', text: 'Lifelink', cost: '{1}{G}{W}', colors: 17 },
];

function makeStore() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test Set')`).run();

  const oracle = db.prepare(`
    INSERT INTO oracle_cards
      (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all, mana_cost,
       colors_mask, color_identity_mask, colors, color_identity, layout)
    VALUES (?,?,?,1,?,?,?,?,?,'','','normal')`);
  const variant = db.prepare(`
    INSERT INTO card_name_variants (oracle_id, variant_name, variant_normalized, kind)
    VALUES (?,?,?,'primary')`);
  const printing = db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number, is_digital)
    VALUES (?,?,'tst',?,0)`);
  const link = db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?');
  const legality = db.prepare(
    `INSERT INTO card_legalities (oracle_id, format_code, legality) VALUES (?, 'commander', 'legal')`);

  CARDS.forEach((card, index) => {
    const oracleId = `o-${index}`;
    oracle.run(oracleId, card.name, normalizeName(card.name), card.type, card.text,
               card.cost ?? '{1}', card.colors ?? 0, card.colors ?? 0);
    variant.run(oracleId, card.name, normalizeName(card.name));
    printing.run(`p-${index}`, oracleId, String(index));
    link.run(`p-${index}`, oracleId);
    legality.run(oracleId);
  });

  return { store: new CardSearchStore(db), close: () => db.close() };
}

const names = (r: { cards: Array<{ name: string }> }) => r.cards.map((c) => c.name);

test('a singular query finds the plural card', () => {
  const { store, close } = makeStore();
  const found = names(store.search('waste', {}, 'relevance', 50));
  // The whole point: "Wastes" used to be missing from this list entirely.
  assert.ok(found.includes('Wastes'), `expected Wastes in ${JSON.stringify(found)}`);
  assert.ok(found.includes('Wasteland'));
  close();
});

test('an exact name still ranks first, ahead of the cards that merely contain it', () => {
  const { store, close } = makeStore();
  assert.equal(names(store.search('wastes', {}, 'relevance', 50))[0], 'Wastes');
  assert.equal(names(store.search('lightning bolt', {}, 'relevance', 50))[0], 'Lightning Bolt');
  close();
});

test('typing the middle of a name finds it', () => {
  const { store, close } = makeStore();
  // Word-prefix matching alone cannot do this; it is the trigram half.
  assert.ok(names(store.search('ightning bolt', {}, 'relevance', 50)).includes('Lightning Bolt'));
  assert.ok(names(store.search('asteland', {}, 'relevance', 50)).includes('Wasteland'));
  close();
});

test('multiple words are AND, and order does not matter', () => {
  const { store, close } = makeStore();
  const forward = names(store.search('lightning helix', {}, 'relevance', 50));
  const reversed = names(store.search('helix lightning', {}, 'relevance', 50));
  assert.ok(forward.includes('Lightning Helix'));
  assert.deepEqual(forward.sort(), reversed.sort());
  // AND, not OR: a word that matches nothing eliminates the result.
  assert.deepEqual(names(store.search('lightning zzzzq', {}, 'relevance', 50)), []);
  close();
});

test('free text folds ligatures the way names do', () => {
  const { store, close } = makeStore();
  // normalizeName maps Æ -> ae, but free text used to reach FTS5 unnormalised.
  assert.ok(names(store.search('aether vial', {}, 'relevance', 50)).includes('Æther Vial'));
  close();
});

test('a query shorter than a trigram still works instead of erroring', () => {
  const { store, close } = makeStore();
  // The trigram tokenizer needs three characters; below that only the word
  // index runs. It must degrade, not throw.
  for (const query of ['a', 'la']) {
    assert.doesNotThrow(() => store.search(query, {}, 'relevance', 50), query);
  }
  assert.ok(names(store.search('la', {}, 'relevance', 50)).length >= 0);
  close();
});

test('searching still matches rules text, not just names', () => {
  const { store, close } = makeStore();
  assert.ok(names(store.search('nonbasic', {}, 'relevance', 50)).includes('Wasteland'));
  close();
});

test('gold selects multicolour cards and hybrid selects split symbols', () => {
  const { store, close } = makeStore();
  const gold = names(store.search('is:gold', {}, 'name', 50)).sort();
  assert.deepEqual(gold, ['Behemoth Sledge', 'Boros Recruit', 'Lightning Helix']);

  // Hybrid is about the cost, not the colour count — Boros Recruit is {R/W}.
  assert.deepEqual(names(store.search('is:hybrid', {}, 'name', 50)), ['Boros Recruit']);

  assert.deepEqual(names(store.search('-is:gold is:hybrid', {}, 'name', 50)), []);
  close();
});

test('free text compiles to prefix terms', () => {
  // Guards the one-character change that fixes all of the above.
  assert.equal(compileQuery('waste').ftsMatch, '"waste"*');
  assert.equal(compileQuery('lightning bolt').ftsMatch, '"lightning"* AND "bolt"*');
  assert.equal(compileQuery('Æther').ftsMatch, '"aether"*');
  assert.equal(compileQuery('t:creature').ftsMatch, null, 'operators are not free text');
});

test('the closest match comes first, not the alphabetically first', () => {
  const { store, close } = makeStore();
  // Every "Waste…" card sits in the same relevance tier, so without a length
  // tiebreak "Waste Not" outranks the card actually called Wastes.
  assert.equal(names(store.search('waste', {}, 'relevance', 50))[0], 'Wastes');
  // Likewise a card whose *face* is named Lightning Bolt must not outrank the
  // card that simply is Lightning Bolt.
  assert.equal(names(store.search('ightning bolt', {}, 'relevance', 50))[0], 'Lightning Bolt');
  close();
});
