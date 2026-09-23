import { test } from 'node:test';
import { CardImporter } from '../sync/importer.ts';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, setSetting } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { TradeListStore } from '../tradelists/store.ts';
import { DeckStore } from './store.ts';
import { TRADELIST_REDUCES_AVAILABLE } from './allocation.ts';
import {
  SUBSTITUTE_SUGGESTION_COUNT, primaryType, scoreCandidate, substitutesFor,
} from './substitutes.ts';

/**
 * Phase 27 — substitutes from your own collection.
 *
 * The pool is proved by exclusion: a card that is unowned, unavailable,
 * off-colour, illegal, basic or already in the deck must not come back, and
 * each of those is one test. The ranking is proved by invariant: a card
 * sharing a role always outranks one sharing none. And the swap is proved to
 * be an ordinary edit by running it and a hand edit side by side.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

// Colour masks: W=1 U=2 B=4 R=8 G=16.
interface CardSpec {
  id: string;
  name: string;
  type: string;
  cmc: number;
  mask?: number;
  text?: string;
  categories?: string[];
  /** Formats this card is legal in; default both. */
  legal?: string[];
  basic?: boolean;
  edhrec?: number | null;
}

const CATALOGUE: CardSpec[] = [
  // Targets and substitutes for a UB deck.
  { id: 'doom', name: 'Doom Blade', type: 'Instant', cmc: 2, mask: 4, text: 'Destroy target nonblack creature.', categories: ['removal'], edhrec: 500 },
  { id: 'murder', name: 'Murder', type: 'Instant', cmc: 3, mask: 4, text: 'Destroy target creature.', categories: ['removal'], edhrec: 800 },
  { id: 'fatal', name: 'Fatal Push', type: 'Instant', cmc: 1, mask: 4, text: 'Destroy target creature if it has mana value 2 or less.', categories: ['removal'], edhrec: 400 },
  { id: 'grasp', name: "Hero's Downfall", type: 'Instant', cmc: 3, mask: 4, text: 'Destroy target creature or planeswalker.', categories: ['removal'], edhrec: 300 },
  { id: 'bounce', name: 'Into the Roil', type: 'Instant', cmc: 2, mask: 2, text: 'Return target nonland permanent to its owner\'s hand.', categories: ['removal'], edhrec: 1200 },
  { id: 'opt', name: 'Opt', type: 'Instant', cmc: 1, mask: 2, text: 'Scry 1. Draw a card.', categories: ['draw'], edhrec: 900 },
  { id: 'elves', name: 'Llanowar Elves', type: 'Creature — Elf Druid', cmc: 1, mask: 16, text: '{T}: Add {G}.', categories: ['ramp'], edhrec: 200 },
  { id: 'bolt', name: 'Lightning Bolt', type: 'Instant', cmc: 1, mask: 8, text: 'Lightning Bolt deals 3 damage to any target.', categories: ['removal'], edhrec: 100 },
  { id: 'rock', name: 'Mind Stone', type: 'Artifact', cmc: 2, mask: 0, text: '{T}: Add {C}.', categories: ['ramp'], edhrec: 600 },
  { id: 'wrath', name: 'Damnation', type: 'Sorcery', cmc: 4, mask: 4, text: 'Destroy all creatures. They can\'t be regenerated.', categories: ['removal', 'sweeper'], edhrec: 700 },
  // Legal in commander only — the format filter's witness.
  { id: 'snuff', name: 'Snuff Out', type: 'Instant', cmc: 4, mask: 4, text: 'Destroy target nonblack creature.', categories: ['removal'], legal: ['commander'], edhrec: 1500 },
  // Plain creatures, for the no-role case.
  { id: 'bear', name: 'Grizzly Bears', type: 'Creature — Bear', cmc: 2, mask: 16, text: '', edhrec: null },
  { id: 'rat', name: 'Typhoid Rats', type: 'Creature — Rat', cmc: 2, mask: 4, text: 'Deathtouch', edhrec: 4000 },
  { id: 'drake', name: 'Wind Drake', type: 'Creature — Drake', cmc: 3, mask: 2, text: 'Flying', edhrec: null },
  { id: 'island', name: 'Island', type: 'Basic Land — Island', cmc: 0, mask: 2, basic: true, text: '' },
];

function fixture(cards: CardSpec[] = CATALOGUE) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  const insertCard = db.prepare(`
    INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text,oracle_text_all,
                              layout,is_basic_land,color_identity_mask,colors_mask,color_identity,edhrec_rank)
    VALUES (?,?,?,?,?,?,?,'normal',?,?,?,?,?)`);
  const insertLegal = db.prepare(
    'INSERT INTO card_legalities (oracle_id, format_code, legality) VALUES (?,?,?)');
  const insertCategory = db.prepare('INSERT INTO card_categories (oracle_id, category) VALUES (?,?)');
  for (const [index, card] of cards.entries()) {
    const mask = card.mask ?? 0;
    const identity = ['W', 'U', 'B', 'R', 'G'].filter((_, i) => mask & (1 << i)).join('');
    insertCard.run(card.id, card.name, card.name.toLowerCase(), card.cmc, card.type,
      card.text ?? '', card.text ?? '', card.basic ? 1 : 0, mask, mask, identity, card.edhrec ?? null);
    db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,price_usd,image_ts)
                VALUES (?,?,'tst',?,1,1)`).run(`p-${card.id}`, card.id, String(index + 1));
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${card.id}`, card.id);
    for (const format of card.legal ?? ['commander', 'standard']) insertLegal.run(card.id, format, 'legal');
    for (const category of card.categories ?? []) insertCategory.run(card.id, category);
  }
  const binder = Number(db.prepare(
    "INSERT INTO storage_locations (name, kind, sort_order) VALUES ('Binder 3','binder',1)",
  ).run().lastInsertRowid);
  // is_playable is derived at sync from card_legalities, the same as any
  // other flag on oracle_cards, so a hand-built fixture derives it too.
  new CardImporter(db).assignPlayableFlags();
  return {
    db,
    binder,
    collection: new CollectionStore(db),
    decks: new DeckStore(db),
    tradeLists: new TradeListStore(db),
  };
}

type Fixture = ReturnType<typeof fixture>;

const own = (f: Fixture, oracleId: string, quantity: number, locationId = f.binder) =>
  f.collection.addLot({ printingId: `p-${oracleId}`, locationId, quantity });

function deck(f: Fixture, name: string, format: string | null, cards: string[], status = 'building') {
  const id = f.decks.create({ name, formatCode: format, description: null });
  f.decks.update(id, { status: status as any });
  for (const oracleId of cards) f.decks.addCard(id, oracleId, { board: 'main', quantity: 1 });
  return id;
}

const names = (result: ReturnType<typeof substitutesFor>) => result.candidates.map((c) => c.name);

/** A UB deck that wants Doom Blade and does not own it. */
function ubDeck(f: Fixture) {
  return deck(f, 'Dimir', 'standard', ['doom', 'opt', 'drake']);
}

// -- the pool -------------------------------------------------------------------

test('for a missing removal spell in a UB deck, every candidate is owned, free, on-colour, legal and not in the deck', () => {
  const f = fixture();
  for (const id of ['murder', 'fatal', 'grasp', 'bounce', 'elves', 'bolt', 'rock', 'wrath', 'snuff', 'bear', 'rat']) {
    own(f, id, 2);
  }
  own(f, 'opt', 1); // in the deck already
  const id = ubDeck(f);

  const result = substitutesFor(f.db, 'doom', id);
  assert.equal(result.categorySource, 'tagger');
  assert.equal(result.context.colorIdentity, 'UB', 'a 60-card deck\'s identity is the union of its cards');

  const got = names(result);
  assert.ok(got.length > 0);
  assert.ok(!got.includes('Llanowar Elves'), 'green is off-colour');
  assert.ok(!got.includes('Lightning Bolt'), 'red is off-colour');
  assert.ok(!got.includes('Snuff Out'), 'not legal in Standard');
  assert.ok(!got.includes('Opt'), 'already in the deck');
  assert.ok(!got.includes('Doom Blade'), 'the target itself');
  assert.ok(!got.includes('Grizzly Bears') && !got.includes('Typhoid Rats'),
    'a creature with no role does not fill a removal slot');
  for (const candidate of result.candidates) {
    assert.ok(candidate.available >= 1, `${candidate.name} is free`);
    assert.ok(candidate.sharedCategories.some((c) => c.category === 'removal'), `${candidate.name} is removal`);
    assert.ok(candidate.reasons.length >= 1, `${candidate.name} carries a reason`);
  }
  f.db.close();
});

test('a green card never appears as a substitute in a mono-blue Commander deck', () => {
  const f = fixture();
  own(f, 'elves', 4);
  own(f, 'rock', 1);
  own(f, 'bounce', 1);
  // The command zone sets the identity, not the 99: a blue commander.
  const id = f.decks.create({ name: 'Mono U', formatCode: 'commander', description: null });
  f.decks.addCard(id, 'drake', { board: 'command', quantity: 1 });
  f.decks.addCard(id, 'rock', { board: 'main', quantity: 1 });

  // Llanowar Elves is ramp, Mind Stone is ramp, and Elves is green.
  const result = substitutesFor(f.db, 'elves', id);
  assert.equal(result.context.colorIdentity, 'U');
  assert.ok(!names(result).includes('Llanowar Elves'));

  // And the same asked of a ramp slot the deck is short of: only colourless fits.
  f.decks.removeCard(id, f.decks.get(id)!.cards.find((c) => c.oracleId === 'rock')!.id);
  f.decks.addCard(id, 'elves', { board: 'main', quantity: 1 });
  const ramp = substitutesFor(f.db, 'elves', id);
  assert.deepEqual(names(ramp), ['Mind Stone']);
  f.db.close();
});

test('a card another assembled deck holds to zero availability does not appear', () => {
  const f = fixture();
  own(f, 'murder', 1);
  own(f, 'fatal', 1);
  deck(f, 'Holder', 'standard', ['murder'], 'assembled');
  const id = ubDeck(f);

  assert.deepEqual(names(substitutesFor(f.db, 'doom', id)), ['Fatal Push']);

  // Put the holder away and the copy is free again.
  f.decks.update(f.decks.list().find((d) => d.name === 'Holder')!.id, { status: 'disassembled' });
  assert.deepEqual(names(substitutesFor(f.db, 'doom', id)).sort(), ['Fatal Push', 'Murder']);
  f.db.close();
});

test('a card whose only copy is on a trade list is excluded while tradelist_reduces_available is on', () => {
  const f = fixture();
  const lot = own(f, 'murder', 1);
  own(f, 'fatal', 1);
  const id = ubDeck(f);
  f.tradeLists.addItem((f.tradeLists.lists()[0] as { id: number }).id, lot, { quantity: 1 });

  assert.deepEqual(names(substitutesFor(f.db, 'doom', id)), ['Fatal Push']);

  setSetting(f.db, TRADELIST_REDUCES_AVAILABLE, '0');
  assert.deepEqual(names(substitutesFor(f.db, 'doom', id)).sort(), ['Fatal Push', 'Murder']);
  f.db.close();
});

test('a basic land is never a candidate, and the deck\'s own claim does not count against it', () => {
  const f = fixture();
  own(f, 'island', 40);
  own(f, 'murder', 1);
  const id = ubDeck(f);
  // The deck reserves Murder itself once it is in the list — that claim is
  // excluded, so Murder stays a candidate for a *different* slot in this deck.
  // (It is then filtered for being in the deck, which is the point of the
  // next assertion rather than this one.)
  const result = substitutesFor(f.db, 'doom', id);
  assert.ok(!names(result).includes('Island'));
  assert.ok(names(result).includes('Murder'));
  f.db.close();
});

test('without a deck, colour and format are unconstrained and nothing is excluded for being in a deck', () => {
  const f = fixture();
  own(f, 'bolt', 1);
  own(f, 'snuff', 1);
  own(f, 'murder', 1);
  deck(f, 'Some deck', 'standard', ['murder'], 'brew');

  const result = substitutesFor(f.db, 'doom', null);
  assert.equal(result.context.deckId, null);
  assert.equal(result.context.colorIdentity, null);
  assert.deepEqual(names(result).sort(), ['Lightning Bolt', 'Murder', 'Snuff Out']);
  f.db.close();
});

test('a deck with no coloured cards yet is unconstrained rather than colourless-only', () => {
  const f = fixture();
  own(f, 'murder', 1);
  const id = f.decks.create({ name: 'Empty', formatCode: 'standard', description: null });
  f.decks.addCard(id, 'rock', { board: 'main', quantity: 1 });
  const result = substitutesFor(f.db, 'doom', id);
  assert.equal(result.context.colorIdentity, null);
  assert.deepEqual(names(result), ['Murder']);
  f.db.close();
});

test('limited formats skip the legality test', () => {
  const f = fixture();
  own(f, 'snuff', 1);
  const id = deck(f, 'Draft', 'draft', ['rat']);
  assert.deepEqual(names(substitutesFor(f.db, 'doom', id)), ['Snuff Out']);
  f.db.close();
});

test('unknown card and unknown deck are 404s, not 500s', () => {
  const f = fixture();
  assert.throws(() => substitutesFor(f.db, 'nope', null), /No card/);
  assert.throws(() => substitutesFor(f.db, 'doom', 999), /No deck/);
  f.db.close();
});

// -- the ranking ------------------------------------------------------------------

test('one shared role outweighs every other signal combined', () => {
  const worstWithRole = scoreCandidate({
    sharedCategories: 1, sameType: false, cmcDelta: 100, edhrecRank: null, available: 1,
  });
  const bestWithout = scoreCandidate({
    sharedCategories: 0, sameType: true, cmcDelta: 0, edhrecRank: 1, available: 99,
  });
  assert.ok(worstWithRole.total > bestWithout.total,
    `${worstWithRole.total} should beat ${bestWithout.total}`);
  // And two roles beat one, for the same reason.
  const twoRoles = scoreCandidate({
    sharedCategories: 2, sameType: false, cmcDelta: 100, edhrecRank: null, available: 1,
  });
  const oneRole = scoreCandidate({
    sharedCategories: 1, sameType: true, cmcDelta: 0, edhrecRank: 1, available: 99,
  });
  assert.ok(twoRoles.total > oneRole.total);
});

test('type beats any CMC distance; CMC proximity then orders; EDHREC and availability only split ties', () => {
  const sameTypeFar = scoreCandidate({ sharedCategories: 1, sameType: true, cmcDelta: 5, edhrecRank: null, available: 1 });
  const otherTypeClose = scoreCandidate({ sharedCategories: 1, sameType: false, cmcDelta: 0, edhrecRank: null, available: 1 });
  assert.ok(sameTypeFar.total > otherTypeClose.total);

  const close = scoreCandidate({ sharedCategories: 1, sameType: true, cmcDelta: 1, edhrecRank: 30000, available: 1 });
  const far = scoreCandidate({ sharedCategories: 1, sameType: true, cmcDelta: 2, edhrecRank: 1, available: 4 });
  assert.ok(close.total > far.total, 'a CMC step is worth more than the best tie-breaks');

  const popular = scoreCandidate({ sharedCategories: 1, sameType: true, cmcDelta: 0, edhrecRank: 1, available: 1 });
  const obscure = scoreCandidate({ sharedCategories: 1, sameType: true, cmcDelta: 0, edhrecRank: null, available: 1 });
  assert.ok(popular.total > obscure.total);
  const playset = scoreCandidate({ sharedCategories: 1, sameType: true, cmcDelta: 0, edhrecRank: null, available: 4 });
  const single = scoreCandidate({ sharedCategories: 1, sameType: true, cmcDelta: 0, edhrecRank: null, available: 1 });
  assert.ok(playset.total > single.total);
});

test('candidates sharing a role all rank above candidates sharing none, and the order is deterministic', () => {
  const f = fixture();
  for (const id of ['murder', 'fatal', 'grasp', 'bounce', 'wrath', 'rat']) own(f, id, 1);
  const id = ubDeck(f);
  setSetting(f.db, SUBSTITUTE_SUGGESTION_COUNT, '10');

  const result = substitutesFor(f.db, 'doom', id);
  const scores = result.candidates.map((c) => c.score.total);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'sorted best first');
  // Every candidate shares removal (the floor), so the ordering is type, then
  // CMC, then EDHREC: the instant at CMC 2, then the three one step away —
  // Downfall (rank 300), Push (400), Murder (800) — then the sorcery.
  assert.deepEqual(names(result), ['Into the Roil', "Hero's Downfall", 'Fatal Push', 'Murder', 'Damnation']);
  assert.equal(result.candidates.at(-1)!.score.type, 0, 'Damnation is a sorcery');
  assert.deepEqual(names(substitutesFor(f.db, 'doom', id)), names(result), 'same answer twice');
  f.db.close();
});

test('substitute_suggestion_count caps the list and poolSize reports what survived the filters', () => {
  const f = fixture();
  for (const id of ['murder', 'fatal', 'grasp', 'bounce', 'wrath', 'rat']) own(f, id, 1);
  const id = ubDeck(f);
  setSetting(f.db, SUBSTITUTE_SUGGESTION_COUNT, '2');
  const result = substitutesFor(f.db, 'doom', id);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.poolSize, 6, 'the rat is in the pool; it just fills no role');
  f.db.close();
});

// -- degraded mode ---------------------------------------------------------------

test('with card_categories empty, the heuristic supplies the role and says so', () => {
  const f = fixture();
  f.db.exec('DELETE FROM card_categories');
  for (const id of ['murder', 'fatal', 'bounce', 'rat']) own(f, id, 1);
  const id = ubDeck(f);

  const result = substitutesFor(f.db, 'doom', id);
  assert.equal(result.categorySource, 'heuristic');
  assert.deepEqual(result.target.categories.map((c) => [c.category, c.source]), [['removal', 'heuristic']]);
  // Murder and Fatal Push say "destroy target creature"; Into the Roil bounces,
  // which the heuristic does not know is removal. Honest, and labelled.
  assert.deepEqual(names(result).sort(), ['Fatal Push', 'Murder']);
  for (const candidate of result.candidates) {
    assert.ok(candidate.reasons[0].endsWith('(heuristic)'), candidate.reasons.join(' · '));
  }
  f.db.close();
});

test('a target with no role under either source matches on type and cost only, and reports null', () => {
  const f = fixture();
  own(f, 'rat', 2);
  own(f, 'murder', 1);
  const id = deck(f, 'Bears', 'standard', ['bear', 'murder']);
  // Grizzly Bears: no tag, no text. Typhoid Rats is the only other creature,
  // and Murder — black, so the deck is BG — is already in the deck.
  const result = substitutesFor(f.db, 'bear', id);
  assert.equal(result.categorySource, null);
  assert.deepEqual(names(result), ['Typhoid Rats']);
  assert.deepEqual(result.candidates[0].reasons, ['Creature', 'CMC 2', '2 available in Binder 3']);
  f.db.close();
});

// -- the reason line -------------------------------------------------------------

test('every candidate carries a human-readable reason, in the server\'s words', () => {
  const f = fixture();
  own(f, 'murder', 3);
  const box = Number(f.db.prepare(
    "INSERT INTO storage_locations (name, kind, sort_order) VALUES ('Box','box',2)").run().lastInsertRowid);
  own(f, 'murder', 1, box);
  const id = ubDeck(f);
  const [murder] = substitutesFor(f.db, 'doom', id).candidates;
  assert.deepEqual(murder.reasons, ['Removal', 'Instant', 'CMC 3', '4 available in Binder 3 +']);
  assert.deepEqual(murder.locations.map((l) => [l.name, l.quantity]), [['Binder 3', 3], ['Box', 1]]);
  assert.equal(murder.printingId, 'p-murder');
  // Derived, not stored: the fixture put `image_ts = 1` on printing p-murder
  // and nothing else, and what comes back is the whole Scryfall URL — shard
  // directories from the id, .jpg for the small size, the stamp as the query.
  assert.equal(murder.imageSmall, 'https://cards.scryfall.io/small/front/p/-/p-murder.jpg?1');
  f.db.close();
});

test('primaryType reads the front face and prefers creature over its other types', () => {
  assert.equal(primaryType('Artifact Creature — Construct'), 'Creature');
  assert.equal(primaryType('Legendary Creature — Halfling Rogue // Sorcery — Adventure'), 'Creature');
  assert.equal(primaryType('Instant'), 'Instant');
  assert.equal(primaryType('Legendary Enchantment Artifact'), 'Artifact');
  assert.equal(primaryType('Basic Land — Island'), 'Land');
  assert.equal(primaryType(null), null);
  assert.equal(primaryType('Tribal Instant — Elf'), 'Instant');
});

// -- accepting a suggestion -----------------------------------------------------

test('swapping via the ordinary card edits leaves exactly the rows a hand edit would', () => {
  const rows = (f: Fixture, id: number) => f.db.prepare(`
    SELECT oracle_id, board, quantity, quantity_from_collection, quantity_proxied
      FROM deck_cards WHERE deck_id = ? ORDER BY oracle_id`).all(id);

  // Path A: what the client does on "swap" — the slot goes down by the
  // missing count (here, away entirely) and the substitute goes in its place.
  const a = fixture();
  own(a, 'murder', 1);
  const deckA = ubDeck(a);
  const slotA = a.decks.get(deckA)!.cards.find((c) => c.oracleId === 'doom')!;
  const [pick] = substitutesFor(a.db, 'doom', deckA).candidates;
  assert.equal(pick.name, 'Murder');
  a.decks.removeCard(deckA, slotA.id);
  a.decks.addCard(deckA, pick.oracleId, { board: slotA.board, quantity: 1 });

  // Path B: the user removes Doom Blade and searches for Murder by hand.
  const b = fixture();
  own(b, 'murder', 1);
  const deckB = ubDeck(b);
  const slotB = b.decks.get(deckB)!.cards.find((c) => c.oracleId === 'doom')!;
  b.decks.removeCard(deckB, slotB.id);
  b.decks.addCard(deckB, 'murder', { board: 'main', quantity: 1 });

  assert.deepEqual(rows(a, deckA), rows(b, deckB));
  const murder = rows(a, deckA).find((r: any) => r.oracle_id === 'murder') as any;
  assert.equal(murder.quantity_from_collection, 1, 'the claim followed: the copy is now reserved');
  a.db.close();
  b.db.close();
});

// -- performance -----------------------------------------------------------------

test('a collection of two thousand lots answers well under 150ms', () => {
  const f = fixture();
  const insertCard = f.db.prepare(`
    INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout,
                              color_identity_mask,edhrec_rank)
    VALUES (?,?,?,?,?,?,'normal',?,?)`);
  const insertPrinting = f.db.prepare(
    `INSERT INTO card_printings (id,oracle_id,set_code,collector_number) VALUES (?,?,'tst',?)`);
  const insertLegal = f.db.prepare(
    "INSERT INTO card_legalities (oracle_id, format_code, legality) VALUES (?,'standard','legal')");
  const insertCategory = f.db.prepare("INSERT INTO card_categories (oracle_id, category) VALUES (?,'removal')");
  const insertLot = f.db.prepare(
    'INSERT INTO collection_items (printing_id, location_id, quantity) VALUES (?,?,?)');
  f.db.transaction(() => {
    for (let i = 0; i < 2000; i += 1) {
      const id = `bulk-${i}`;
      insertCard.run(id, `Bulk ${i}`, `bulk ${i}`, i % 7, i % 2 ? 'Instant' : 'Creature — Bulk',
        'Destroy target creature.', [2, 4, 6][i % 3], i);
      insertPrinting.run(`p-${id}`, id, String(100 + i));
      insertLegal.run(id);
      if (i % 2 === 0) insertCategory.run(id);
      insertLot.run(`p-${id}`, f.binder, 1 + (i % 4));
    }
  })();
  const id = ubDeck(f);

  substitutesFor(f.db, 'doom', id); // warm the statement cache, as a server would
  const started = performance.now();
  const result = substitutesFor(f.db, 'doom', id);
  const elapsed = performance.now() - started;
  assert.ok(result.poolSize >= 1000, `pool ${result.poolSize}`);
  assert.ok(elapsed < 150, `took ${elapsed.toFixed(1)}ms`);
  f.db.close();
});
