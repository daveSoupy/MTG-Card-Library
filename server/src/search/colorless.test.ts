import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CardSearchStore } from './store.ts';

/**
 * Colourless is a value, not the absence of a selection.
 *
 * `c:c` used to compile to `(colors_mask & 0) = 0`, which is true of every card
 * in the database, and the sidebar's colour filter excluded colourless cards
 * outright — so a mono-white filter silently hid every artifact.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

interface Fixture {
  name: string;
  colors: number;
  identity: number;
  type?: string;
}

const FIXTURES: Fixture[] = [
  { name: 'Sol Ring', colors: 0, identity: 0, type: 'Artifact' },
  { name: 'Wastes', colors: 0, identity: 0, type: 'Basic Land' },
  { name: 'Savannah Lions', colors: 1, identity: 1, type: 'Creature' },   // W
  { name: 'Counterspell', colors: 2, identity: 2, type: 'Instant' },      // U
  { name: 'Azorius Charm', colors: 3, identity: 3, type: 'Instant' },     // WU
  { name: 'Lightning Bolt', colors: 8, identity: 8, type: 'Instant' },    // R
];

function makeStore(): { store: CardSearchStore; close: () => void } {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test Set')`).run();

  // The two tables reference each other: a printing needs its oracle row, and
  // oracle_cards.default_printing_id is trigger-checked against printings. So
  // insert oracle rows unlinked, add printings, then link.
  const oracle = db.prepare(`
    INSERT INTO oracle_cards
      (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all,
       colors_mask, color_identity_mask, colors, color_identity, layout)
    VALUES (?,?,?,1,?,?,?,?,'','','normal')`);
  const printing = db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number, is_digital)
    VALUES (?,?, 'tst', ?, 0)`);
  const link = db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?');
  // Real cards always carry legality rows, and search now hides cards that are
  // legal nowhere — so a fixture without them is not a realistic card.
  const legality = db.prepare(
    `INSERT INTO card_legalities (oracle_id, format_code, legality) VALUES (?, 'commander', 'legal')`);

  FIXTURES.forEach((card, index) => {
    const oracleId = `o-${index}`;
    const printingId = `p-${index}`;
    oracle.run(oracleId, card.name, card.name.toLowerCase(), card.type ?? 'Artifact',
               card.name, card.colors, card.identity);
    printing.run(printingId, oracleId, String(index));
    link.run(printingId, oracleId);
    legality.run(oracleId);
  });

  return { store: new CardSearchStore(db), close: () => db.close() };
}

const names = (result: { cards: Array<{ name: string }> }) => result.cards.map((c) => c.name).sort();

test('c:c matches only colourless cards, not everything', () => {
  const { store, close } = makeStore();
  assert.deepEqual(names(store.search('c:c', {}, 'name', 50)), ['Sol Ring', 'Wastes']);
  close();
});

test('c:c and -c:c partition the database exactly', () => {
  const { store, close } = makeStore();
  const colorless = store.search('c:c', {}, 'name', 50).total;
  const colored = store.search('-c:c', {}, 'name', 50).total;
  const all = store.search('', {}, 'name', 50).total;
  assert.equal(colorless + colored, all, 'colourless plus coloured must be the whole set');
  assert.ok(colorless > 0 && colored > 0);
  close();
});

test('identity and colorless aliases all work', () => {
  const { store, close } = makeStore();
  for (const query of ['c:c', 'c:colorless', 'c:colourless', 'id:c', 'is:colorless']) {
    assert.deepEqual(names(store.search(query, {}, 'name', 50)), ['Sol Ring', 'Wastes'], query);
  }
  close();
});

test('the colour filter excludes colourless unless C is chosen', () => {
  const { store, close } = makeStore();

  // The filter is a subset test — "fits inside these colours" — so mono-white
  // excludes the WU charm as well as every artifact.
  assert.deepEqual(names(store.search('', { colors: ['W'] }, 'name', 50)), ['Savannah Lions']);

  // White plus colourless: the artifacts come back, which is what a mono-white
  // deck builder actually wants. The WU charm still does not fit.
  assert.deepEqual(names(store.search('', { colors: ['W', 'C'] }, 'name', 50)),
    ['Savannah Lions', 'Sol Ring', 'Wastes']);

  // Selecting both halves of its identity does let it through.
  assert.ok(names(store.search('', { colors: ['W', 'U'] }, 'name', 50)).includes('Azorius Charm'));

  // Colourless alone means exactly that.
  assert.deepEqual(names(store.search('', { colors: ['C'] }, 'name', 50)), ['Sol Ring', 'Wastes']);
  close();
});

test('W + C is exactly W plus C, with nothing double-counted or lost', () => {
  const { store, close } = makeStore();
  const w = store.search('', { colors: ['W'] }, 'name', 50).total;
  const c = store.search('', { colors: ['C'] }, 'name', 50).total;
  const both = store.search('', { colors: ['W', 'C'] }, 'name', 50).total;
  assert.equal(both, w + c);
  close();
});

test('exact colour matching also respects colourless', () => {
  const { store, close } = makeStore();

  // Exactly white — the WU charm does not qualify.
  assert.deepEqual(names(store.search('', { colors: ['W'], colorsExact: true }, 'name', 50)),
    ['Savannah Lions']);

  // Exactly white, plus colourless cards alongside.
  assert.deepEqual(names(store.search('', { colors: ['W', 'C'], colorsExact: true }, 'name', 50)),
    ['Savannah Lions', 'Sol Ring', 'Wastes']);

  assert.deepEqual(names(store.search('', { colors: ['W', 'U'], colorsExact: true }, 'name', 50)),
    ['Azorius Charm']);
  close();
});

test('colourless combines with other filters rather than overriding them', () => {
  const { store, close } = makeStore();
  const artifacts = store.search('t:artifact', { colors: ['C'] }, 'name', 50);
  assert.deepEqual(names(artifacts), ['Sol Ring'], 'Wastes is a Land, not an Artifact');
  close();
});
