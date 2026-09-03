import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { normalizeName } from '../model/mtg.ts';
import { CardSearchStore } from './store.ts';

/**
 * Hiding cards that are legal in no format.
 *
 * Un-sets, "Unknown Event" cards and Mystery Booster playtest cards are 6% of
 * the database and can never be played. The test is legality rather than set,
 * because joke sets are not uniformly illegal — Unfinity's non-acorn cards are
 * legal in Legacy, Vintage and Commander.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

interface Fixture {
  name: string;
  layout?: string;
  /** format -> legality. Empty means legal nowhere. */
  legalities?: Record<string, string>;
}

const CARDS: Fixture[] = [
  { name: 'Lightning Bolt', legalities: { modern: 'legal', commander: 'legal' } },
  { name: 'Black Lotus', legalities: { vintage: 'restricted', legacy: 'banned' } },
  // A real, expensive card that is banned everywhere and legal nowhere.
  { name: 'Chaos Orb', legalities: { vintage: 'banned', legacy: 'banned', commander: 'banned' } },
  // Legal only in a format that is not in the app's picker.
  { name: 'Crusade', legalities: { oldschool: 'legal', premodern: 'legal' } },
  // The clutter this exists to remove.
  { name: 'Ashnods Coupon', legalities: { commander: 'not_legal', vintage: 'not_legal' } },
  { name: 'Your Favorite Character', legalities: { commander: 'not_legal' } },
  // Unfinity's non-acorn cards really are legal.
  { name: 'Complaints Clerk', legalities: { legacy: 'legal', commander: 'legal' } },
  // Real cards for their own formats, but hidden all the same — see below.
  { name: 'Academy at Tolaria West', layout: 'planar', legalities: { commander: 'not_legal' } },
  { name: 'A Reckoning Approaches', layout: 'scheme', legalities: { commander: 'not_legal' } },
  { name: 'Akroma, Angel of Fury', layout: 'vanguard', legalities: { commander: 'not_legal' } },
  // No legality rows whatsoever — see the last test.
  { name: 'Orphan Card' },
];

function makeStore() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test Set')`).run();

  const oracle = db.prepare(`
    INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line,
                              oracle_text_all, layout)
    VALUES (?,?,?,1,'Instant','x',?)`);
  const printing = db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number, is_digital)
    VALUES (?,?,'tst',?,0)`);
  const legality = db.prepare(
    'INSERT INTO card_legalities (oracle_id, format_code, legality) VALUES (?,?,?)');

  CARDS.forEach((card, index) => {
    const id = `o-${index}`;
    oracle.run(id, card.name, normalizeName(card.name), card.layout ?? 'normal');
    printing.run(`p-${index}`, id, String(index));
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${index}`, id);
    for (const [format, value] of Object.entries(card.legalities ?? {})) {
      legality.run(id, format, value);
    }
  });

  return { store: new CardSearchStore(db), close: () => db.close() };
}

const names = (r: { cards: Array<{ name: string }> }) => r.cards.map((c) => c.name).sort();

test('cards legal in no format are hidden by default', () => {
  const { store, close } = makeStore();
  const found = names(store.search('', {}, 'name', 50));
  assert.ok(!found.includes('Ashnods Coupon'), 'an Un-card should be gone');
  assert.ok(!found.includes('Your Favorite Character'), 'an Unknown Event card should be gone');
  assert.ok(found.includes('Lightning Bolt'));
  close();
});

test('a joke-set card that is actually legal stays', () => {
  const { store, close } = makeStore();
  // The reason this filters on legality and not on set: hiding Unfinity
  // wholesale would take real, tournament-legal cards with it.
  assert.ok(names(store.search('', {}, 'name', 50)).includes('Complaints Clerk'));
  close();
});

test('planes, schemes and vanguards are hidden too', () => {
  const { store, close } = makeStore();
  const found = names(store.search('', {}, 'name', 50));
  // They are genuine cards for Planechase and Archenemy — which is why
  // EXTRA_LAYOUTS spares them from the tokens filter — but they are legal in
  // no tracked format and are only ever in the way of a search.
  for (const name of ['Academy at Tolaria West', 'A Reckoning Approaches', 'Akroma, Angel of Fury']) {
    assert.ok(!found.includes(name), `${name} should be hidden`);
  }
  // The toggle brings them back like anything else.
  const all = names(store.search('', { includeUnplayable: true }, 'name', 50));
  assert.ok(all.includes('A Reckoning Approaches'));
  close();
});

test('legal in a format outside the picker still counts as legal', () => {
  const { store, close } = makeStore();
  // Old School and Premodern are not in the format picker, but a card legal
  // there is plainly a real card.
  assert.ok(names(store.search('', {}, 'name', 50)).includes('Crusade'));
  close();
});

test('banned everywhere means legal nowhere, so it is hidden by default', () => {
  const { store, close } = makeStore();
  assert.ok(!names(store.search('', {}, 'name', 50)).includes('Chaos Orb'));
  // Restricted counts as playable, so Black Lotus is not caught by this.
  assert.ok(names(store.search('', {}, 'name', 50)).includes('Black Lotus'));
  close();
});

test('asking about legality turns the default off', () => {
  const { store, close } = makeStore();
  // Without this, banned:vintage returns nothing at all: everything banned
  // everywhere is legal nowhere, so the default cancels the query.
  // Chaos Orb is legal nowhere, so the default would have swallowed it.
  assert.deepEqual(names(store.search('banned:vintage', {}, 'name', 50)), ['Chaos Orb']);
  assert.ok(names(store.search('legal:commander', {}, 'name', 50)).length > 0);
  close();
});

test('the toggle brings everything back', () => {
  const { store, close } = makeStore();
  const hidden = store.search('', {}, 'name', 50).total;
  const all = store.search('', { includeUnplayable: true }, 'name', 50).total;
  assert.equal(all, CARDS.length);
  assert.equal(hidden, CARDS.length - 7, 'everything legal nowhere, planes and schemes included');
  close();
});

test('is:unplayable names exactly what the default hides', () => {
  const { store, close } = makeStore();
  assert.deepEqual(names(store.search('is:unplayable', {}, 'name', 50)), [
    'A Reckoning Approaches', 'Academy at Tolaria West', 'Akroma, Angel of Fury',
    'Ashnods Coupon', 'Chaos Orb', 'Orphan Card', 'Your Favorite Character',
  ]);
  assert.ok(!names(store.search('is:playable', {}, 'name', 50)).includes('Chaos Orb'));
  close();
});

test('a card carrying no legality rows at all is hidden, and that is accepted', () => {
  const { store, close } = makeStore();
  // Documents a deliberate limit rather than an aspiration. Real data always
  // carries all 23 legality rows, so this state does not occur; defending
  // against it would mean a second EXISTS probe on every card of every search.
  assert.ok(!names(store.search('', {}, 'name', 50)).includes('Orphan Card'));
  close();
});

// -- Universes Beyond ----------------------------------------------------------

/**
 * Crossover cards, and the trap in identifying them.
 *
 * Scryfall marks them in `promo_types`, but the crossover precons reprint
 * ordinary cards — Sol Ring, Command Tower, Arcane Signet — so "has a Universes
 * Beyond printing" catches 1,574 cards nobody means. A card is a crossover card
 * when it has no ordinary printing at all.
 */
function ubStore() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('ltr','Tales of Middle-earth')`).run();
  db.prepare(`INSERT INTO sets (code,name) VALUES ('cmm','Commander Masters')`).run();

  const add = (id: string, name: string, printings: Array<[string, string, string | null]>) => {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout) VALUES (?,?,?,1,'Artifact','x','normal')`)
      .run(id, name, normalizeName(name));
    // Collector numbers must be unique per (set, number, lang), so they are
    // taken from the printing id rather than restarting for each card.
    printings.forEach(([pid, set, promo]) => {
      db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,promo_types,is_digital)
                  VALUES (?,?,?,?,?,0)`).run(pid, id, set, pid, promo);
    });
    db.prepare('UPDATE oracle_cards SET default_printing_id=? WHERE oracle_id=?').run(printings[0][0], id);
    db.prepare(`INSERT INTO card_legalities (oracle_id,format_code,legality)
                VALUES (?,'commander','legal')`).run(id);
  };

  // Born in a crossover set, exists nowhere else.
  add('o-ring', 'The One Ring', [['p1', 'ltr', '["universesbeyond"]']]);
  add('o-bowm', 'Orcish Bowmasters', [['p2', 'ltr', '["universesbeyond"]']]);
  // Reprinted into a crossover precon, but an ordinary card.
  add('o-sol', 'Sol Ring', [['p3', 'cmm', null], ['p4', 'ltr', '["universesbeyond"]']]);
  // Never anywhere near a crossover.
  add('o-bolt', 'Lightning Bolt', [['p5', 'cmm', null]]);

  return { store: new CardSearchStore(db), close: () => db.close() };
}

test('crossover cards are shown by default — they are real tournament cards', () => {
  const { store, close } = ubStore();
  assert.deepEqual(names(store.search('', {}, 'name', 50)),
                   ['Lightning Bolt', 'Orcish Bowmasters', 'Sol Ring', 'The One Ring']);
  close();
});

test('excluding crossovers keeps cards merely reprinted in one', () => {
  const { store, close } = ubStore();
  const found = names(store.search('', { excludeUniversesBeyond: true }, 'name', 50));
  assert.deepEqual(found, ['Lightning Bolt', 'Sol Ring']);
  // Sol Ring has a Tales of Middle-earth printing; it is still a Sol Ring.
  assert.ok(found.includes('Sol Ring'), 'a reprint does not make it a crossover card');
  close();
});

test('is:ub names the crossover cards, and -is:ub the rest', () => {
  const { store, close } = ubStore();
  assert.deepEqual(names(store.search('is:ub', {}, 'name', 50)),
                   ['Orcish Bowmasters', 'The One Ring']);
  assert.deepEqual(names(store.search('-is:ub', {}, 'name', 50)),
                   ['Lightning Bolt', 'Sol Ring']);
  assert.deepEqual(names(store.search('is:universesbeyond', {}, 'name', 50)),
                   ['Orcish Bowmasters', 'The One Ring']);
  close();
});

test('the crossover filter is independent of the unplayable one', () => {
  const { store, close } = ubStore();
  // Both filters on at once must not interfere: everything here is legal.
  assert.deepEqual(
    names(store.search('', { excludeUniversesBeyond: true, includeUnplayable: true }, 'name', 50)),
    ['Lightning Bolt', 'Sol Ring'],
  );
  close();
});
