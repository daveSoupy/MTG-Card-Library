import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH, setSetting } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { TradeListStore } from '../tradelists/store.ts';
import { DeckStore } from './store.ts';
import { availableFor } from './allocation.ts';
import {
  ASSEMBLY_MOVES_LOTS, assemblySheet, cancelRun, completeRun, listRuns, openAssemblyRun,
  openDisassemblyRun, setItemPicked, type AssemblySheet,
} from './assembly.ts';

/**
 * Phase 25 — the physical half.
 *
 * Two things are being proved here and they pull in different directions. One
 * is that the sheet is *stable and explainable*: the same collection has to
 * produce the same lines in the same order, or it cannot be trusted by someone
 * holding a binder. The other is that moving lots is *lossless* — the same
 * copies, the same cost basis, the same total value, and an assemble followed
 * by a disassemble leaving the collection exactly where it started. A move that
 * mints a fresh lot with no cost basis destroys P&L history silently, so that
 * is where the assertions are thickest.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

interface CardSpec {
  id: string;
  name: string;
  setCode?: string;
  number?: string;
  released?: string;
  price?: number | null;
  foilPrice?: number | null;
  basic?: boolean;
}

function fixture(cards: CardSpec[]) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  // The cascade rules this phase leans on are FK behaviour, and an in-memory
  // database does not inherit the pragma openLibrary() sets.
  db.pragma('foreign_keys = ON');

  const sets = new Set(cards.map((card) => card.setCode ?? 'tst'));
  for (const code of sets) {
    db.prepare(`INSERT INTO sets (code,name,released_at) VALUES (?,?,?)`)
      .run(code, code.toUpperCase(), '2020-01-01');
  }

  for (const [index, card] of cards.entries()) {
    db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,
                  oracle_text_all,layout,is_basic_land)
                VALUES (?,?,?,1,?,'x','normal',?)`)
      .run(card.id, card.name, card.name.toLowerCase(),
        card.basic ? 'Basic Land' : 'Artifact', card.basic ? 1 : 0);
    const number = card.number ?? String(index + 1);
    db.prepare(`INSERT INTO card_printings
                  (id,oracle_id,set_code,collector_number,collector_number_num,
                   released_at,price_usd,price_usd_foil)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(`p-${card.id}`, card.id, card.setCode ?? 'tst', number, Number(number) || null,
        card.released ?? '2020-01-01', card.price ?? 1, card.foilPrice ?? null);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`p-${card.id}`, card.id);
  }

  const unsorted = (db.prepare(`SELECT id FROM storage_locations WHERE is_default = 1`)
    .get() as { id: number }).id;

  const location = (name: string, sortOrder = 1): number => {
    const existing = db.prepare('SELECT id FROM storage_locations WHERE name = ?').get(name) as
      | { id: number } | undefined;
    if (existing) return existing.id;
    return Number(db.prepare(
      'INSERT INTO storage_locations (name, kind, sort_order) VALUES (?,?,?)',
    ).run(name, 'binder', sortOrder).lastInsertRowid);
  };

  return {
    db,
    decks: new DeckStore(db),
    collection: new CollectionStore(db),
    tradeLists: new TradeListStore(db),
    unsorted,
    location,
  };
}

/** A deck holding one copy each of the given cards, claiming nothing yet. */
function deckOf(decks: DeckStore, name: string, cards: string[], quantity = 1): number {
  const id = decks.create({ name, formatCode: null, description: null });
  for (const oracleId of cards) decks.addCard(id, oracleId, { quantity, fromCollection: 0 });
  return id;
}

const lines = (sheet: AssemblySheet) => sheet.groups.flatMap((group) => group.lines);

/** Every line, ticked — the ordinary case of standing up and pulling the deck. */
function pickAll(db: Database.Database, sheet: AssemblySheet): AssemblySheet {
  let current = sheet;
  for (const line of lines(sheet)) {
    current = setItemPicked(db, sheet.run.id, line.id, true)!;
  }
  return current;
}

const lotsIn = (db: Database.Database) =>
  db.prepare(`SELECT id, printing_id, location_id, quantity, finish, condition, language,
                     price_override, is_signed, is_altered, notes, acquired_at,
                     acquired_unit_cost, acquisition_kind, acquired_from, import_batch_id
              FROM collection_items ORDER BY id`).all();

/** The collection as shape rather than rows: ids and order are not the claim. */
const lotShapes = (db: Database.Database) => (lotsIn(db) as any[])
  .map((lot) => ({ ...lot, id: undefined }))
  .sort((a, b) => a.location_id - b.location_id
    || String(a.printing_id).localeCompare(String(b.printing_id))
    || (a.acquired_unit_cost ?? 0) - (b.acquired_unit_cost ?? 0));

const valueOf = (db: Database.Database) =>
  db.prepare('SELECT total_value_usd, total_cost_basis_usd, total_cards FROM v_collection_value')
    .get() as { total_value_usd: number; total_cost_basis_usd: number; total_cards: number };

// -- the sheet ----------------------------------------------------------------

test('a deck whose cards sit in three locations produces three groups, each set-sorted', () => {
  const { db, decks, collection, location } = fixture([
    { id: 'a', name: 'Alpha', setCode: 'aaa', number: '20', released: '2021-01-01' },
    { id: 'b', name: 'Beta', setCode: 'aaa', number: '3', released: '2021-01-01' },
    { id: 'c', name: 'Gamma', setCode: 'bbb', number: '5', released: '2019-01-01' },
    { id: 'd', name: 'Delta', setCode: 'aaa', number: '7', released: '2021-01-01' },
  ]);

  const shelf = location('Shelf', 3);
  const binder = location('Binder', 1);
  const box = location('Box', 2);

  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1 });
  collection.addLot({ printingId: 'p-b', locationId: binder, quantity: 1 });
  collection.addLot({ printingId: 'p-c', locationId: box, quantity: 1 });
  collection.addLot({ printingId: 'p-d', locationId: shelf, quantity: 1 });

  const deckId = deckOf(decks, 'Three shelves', ['a', 'b', 'c', 'd']);
  const sheet = openAssemblyRun(db, deckId);

  assert.deepEqual(
    sheet.groups.map((group) => group.locationName),
    ['Binder', 'Box', 'Shelf'],
    'locations come in sort_order',
  );
  // Within a location: set code, then collector number as a number — 3 before
  // 20, which is the whole reason collector_number_num exists.
  assert.deepEqual(sheet.groups[0].lines.map((line) => line.name), ['Beta', 'Alpha']);
  assert.equal(sheet.summary.cardsToPull, 4);
  db.close();
});

test('two runs over an unchanged collection produce identical sheets, line for line', () => {
  const { db, decks, collection, location } = fixture([
    { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' },
  ]);
  const binder = location('Binder');
  // Several interchangeable lots, so a resolver with any nondeterminism in it
  // has somewhere to wobble.
  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1, acquiredUnitCost: 2 });
  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1, acquiredUnitCost: 3 });
  collection.addLot({ printingId: 'p-b', locationId: binder, quantity: 2 });

  const deckId = deckOf(decks, 'Stable', ['a', 'b'], 2);

  const first = openAssemblyRun(db, deckId);
  const firstLines = lines(first).map((line) => `${line.name}/${line.collectionItemId}/${line.quantity}`);
  cancelRun(db, first.run.id);

  const second = openAssemblyRun(db, deckId);
  const secondLines = lines(second).map((line) => `${line.name}/${line.collectionItemId}/${line.quantity}`);

  assert.deepEqual(secondLines, firstLines);
  db.close();
});

test('a card in both a binder lot and a foil lot picks the cheaper non-foil one', () => {
  const { db, decks, collection, location } = fixture([
    { id: 'a', name: 'Alpha', price: 2, foilPrice: 30 },
  ]);
  const binder = location('Binder');
  const foilLot = collection.addLot({
    printingId: 'p-a', locationId: binder, quantity: 1, finish: 'foil',
  });
  const plainLot = collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1 });

  const deckId = deckOf(decks, 'Cheap', ['a']);
  const sheet = openAssemblyRun(db, deckId);

  assert.equal(lines(sheet).length, 1);
  assert.equal(lines(sheet)[0].collectionItemId, plainLot, 'the collectible copy stays in the binder');
  assert.notEqual(lines(sheet)[0].collectionItemId, foilLot);
  assert.equal(lines(sheet)[0].finish, 'nonfoil');
  db.close();
});

test('a card whose only lot is on a trade list is flagged, not silently pulled', () => {
  const { db, decks, collection, tradeLists, location } = fixture([{ id: 'a', name: 'Alpha' }]);
  const binder = location('Binder');
  const lot = collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1 });
  const listId = (tradeLists.lists()[0] as { id: number }).id;
  tradeLists.addItem(listId, lot, { quantity: 1 });

  // With the subtraction on, a listed copy is already unavailable and the card
  // simply reads as missing; the fallback only fires when it is off.
  setSetting(db, 'tradelist_reduces_available', '0');

  const deckId = deckOf(decks, 'Promised', ['a']);
  const sheet = openAssemblyRun(db, deckId);

  const line = lines(sheet)[0];
  assert.equal(line.collectionItemId, lot);
  assert.equal(line.tradeListed, 1, 'the line says the copy is spoken for');
  assert.match(line.notes ?? '', /trade list/i);
  assert.equal(sheet.summary.tradeListedLines, 1);
  db.close();
});

test('a copy the collection cannot supply lands in Not available with its cost', () => {
  const { db, decks, collection, location } = fixture([
    { id: 'a', name: 'Alpha', price: 4 }, { id: 'b', name: 'Beta', price: 7 },
  ]);
  collection.addLot({ printingId: 'p-a', locationId: location('Binder'), quantity: 1 });

  const deckId = deckOf(decks, 'Short', ['a', 'b']);
  const sheet = openAssemblyRun(db, deckId);

  assert.equal(lines(sheet).length, 1, 'only the owned card is on the sheet');
  assert.deepEqual(sheet.unavailable.map((line) => line.name), ['Beta']);
  assert.equal(sheet.unavailable[0].extendedUsd, 7);
  assert.equal(sheet.summary.unavailableCostUsd, 7);
  db.close();
});

test('basic lands never reach the sheet while the exemption is on', () => {
  const { db, decks, collection, location } = fixture([
    { id: 'a', name: 'Alpha' }, { id: 'i', name: 'Island', basic: true },
  ]);
  const binder = location('Binder');
  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1 });
  collection.addLot({ printingId: 'p-i', locationId: binder, quantity: 20 });

  const deckId = decks.create({ name: 'Lands', formatCode: null, description: null });
  decks.addCard(deckId, 'a', { quantity: 1, fromCollection: 0 });
  decks.addCard(deckId, 'i', { quantity: 15, fromCollection: 0 });

  const sheet = openAssemblyRun(db, deckId);
  assert.deepEqual(lines(sheet).map((line) => line.name), ['Alpha']);
  db.close();
});

test('the tick state is stored, so a reload mid-pull resumes where it left off', () => {
  const { db, decks, collection, location } = fixture([
    { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' },
  ]);
  const binder = location('Binder');
  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1 });
  collection.addLot({ printingId: 'p-b', locationId: binder, quantity: 1 });

  const deckId = deckOf(decks, 'Interrupted', ['a', 'b']);
  const sheet = openAssemblyRun(db, deckId);
  setItemPicked(db, sheet.run.id, lines(sheet)[0].id, true);

  const reloaded = assemblySheet(db, sheet.run.id)!;
  assert.equal(reloaded.summary.pickedLines, 1);
  assert.equal(reloaded.summary.pickedCards, 1);

  // And opening assembly again returns the run in progress rather than a fresh
  // sheet with every tick thrown away.
  const again = openAssemblyRun(db, deckId);
  assert.equal(again.run.id, sheet.run.id);
  assert.equal(again.summary.pickedLines, 1);
  db.close();
});

// -- completing a run ---------------------------------------------------------

test('completing a run settles the claim the way every other write does', () => {
  const { db, decks, collection, location } = fixture([
    { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' },
  ]);
  const binder = location('Binder');
  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 2 });
  collection.addLot({ printingId: 'p-b', locationId: binder, quantity: 2 });

  const deckId = deckOf(decks, 'Claimed', ['a', 'b'], 2);
  // A stale claim going in — the sort of thing a hand edit or an old import
  // leaves behind — so the assertion below is about completion reconciling it,
  // not about it already having been right.
  db.prepare('UPDATE deck_cards SET quantity_from_collection = 0 WHERE deck_id = ?').run(deckId);
  assert.ok(decks.get(deckId)!.cards.every((card) => card.quantityFromCollection === 0));

  const sheet = pickAll(db, openAssemblyRun(db, deckId));
  const summary = completeRun(db, sheet.run.id)!;

  assert.equal(summary.pulledCards, 4);
  const after = decks.get(deckId)!;
  assert.equal(after.status, 'assembled');
  assert.ok(after.cards.every((card) => card.quantityFromCollection === card.quantity),
    'the claim is what the collection can spare — here, everything');
  assert.ok(
    db.prepare('SELECT status_changed_at FROM decks WHERE id = ?').get(deckId),
    'the status change is stamped',
  );
  db.close();
});

test('a card not found where the sheet said is recorded on the run, and stays recorded', () => {
  const { db, decks, collection, location } = fixture([
    { id: 'a', name: 'Alpha', price: 5 }, { id: 'b', name: 'Beta' },
  ]);
  const binder = location('Binder');
  // Two separate lots, so one line can be un-ticked independently.
  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1, acquiredUnitCost: 1 });
  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1, acquiredUnitCost: 2 });
  collection.addLot({ printingId: 'p-b', locationId: binder, quantity: 1 });

  const deckId = deckOf(decks, 'One short', ['a'], 2);
  const sheet = pickAll(db, openAssemblyRun(db, deckId));
  const dropped = lines(sheet)[1];
  setItemPicked(db, sheet.run.id, dropped.id, false);

  const summary = completeRun(db, sheet.run.id)!;
  assert.equal(summary.notFoundCards, 1);

  // The claim is derived from the collection, which still holds both copies,
  // so it reads 2. That is deliberate: a hand-written 1 here would be raised
  // straight back by the next edit, and the shortfall would vanish with it.
  const slot = decks.get(deckId)!.cards.find((card) => card.oracleId === 'a')!;
  assert.equal(slot.quantityFromCollection, 2);

  // The shortfall lives on the run instead, where nothing recomputes it.
  const [latest] = listRuns(db, deckId);
  assert.equal(latest.id, sheet.run.id);
  assert.equal(latest.notFoundCount, 1);
  assert.deepEqual(latest.notFound, [{ oracleId: 'a', name: 'Alpha', quantity: 1 }]);

  // …including after an ordinary edit reconciles the deck's claims again.
  decks.addCard(deckId, 'b', { quantity: 1, fromCollection: 0 });
  assert.equal(listRuns(db, deckId)[0].notFoundCount, 1,
    'the fact survives what the claim could not');
  db.close();
});

test('an open run reports nothing as not found, whatever is un-ticked', () => {
  const { db, decks, collection, location } = fixture([{ id: 'a', name: 'Alpha' }]);
  collection.addLot({ printingId: 'p-a', locationId: location('Binder'), quantity: 2 });
  const deckId = deckOf(decks, 'In progress', ['a'], 2);
  openAssemblyRun(db, deckId);

  const [open] = listRuns(db, deckId);
  assert.equal(open.status, 'open');
  assert.equal(open.pickedCount, 0);
  assert.equal(open.notFoundCount, 0);
  assert.deepEqual(open.notFound, []);
  db.close();
});

test('with assembly_moves_lots off, completing a run leaves the collection untouched', () => {
  const { db, decks, collection, location } = fixture([{ id: 'a', name: 'Alpha' }]);
  const binder = location('Binder');
  collection.addLot({
    printingId: 'p-a', locationId: binder, quantity: 2, acquiredUnitCost: 4, acquiredAt: '2024-01-01',
  });
  const deckId = deckOf(decks, 'Checklist', ['a'], 2);
  decks.update(deckId, { homeLocationId: binder });

  const before = lotsIn(db);
  const sheet = pickAll(db, openAssemblyRun(db, deckId));
  assert.equal(sheet.movesLots, false);
  const summary = completeRun(db, sheet.run.id)!;

  assert.equal(summary.movedLots, false);
  assert.equal(summary.copiesMoved, 0);
  assert.deepEqual(lotsIn(db), before, 'a checklist moves no cardboard');
  db.close();
});

// -- moving lots --------------------------------------------------------------

/** A deck, a binder lot, a home location, and the setting on. */
function movingFixture(options: { unitCost?: number | null; quantity?: number } = {}) {
  const f = fixture([{ id: 'a', name: 'Alpha', price: 10 }]);
  const binder = f.location('Binder', 1);
  const deckBox = f.location('Deck box', 2);
  setSetting(f.db, ASSEMBLY_MOVES_LOTS, '1');

  const lotId = f.collection.addLot({
    printingId: 'p-a',
    locationId: binder,
    quantity: options.quantity ?? 1,
    acquiredUnitCost: options.unitCost === undefined ? 4 : options.unitCost,
    acquiredAt: '2023-05-01',
    acquisitionKind: 'purchase',
    acquiredFrom: 'LGS',
  });

  const deckId = deckOf(f.decks, 'Real deck', ['a'], options.quantity ?? 1);
  f.decks.update(deckId, { homeLocationId: deckBox });
  return { ...f, binder, deckBox, lotId, deckId };
}

test('a move decrements the source, preserves cost basis, and changes no totals', () => {
  const f = movingFixture();
  const before = valueOf(f.db);

  const sheet = pickAll(f.db, openAssemblyRun(f.db, f.deckId));
  assert.equal(sheet.movesLots, true);
  const summary = completeRun(f.db, sheet.run.id)!;

  assert.equal(summary.copiesMoved, 1);
  const lots = lotsIn(f.db) as any[];
  assert.equal(lots.length, 1, 'the emptied source lot is gone');
  assert.equal(lots[0].location_id, f.deckBox);
  assert.equal(lots[0].acquired_unit_cost, 4, 'cost basis rides along');
  assert.equal(lots[0].acquired_at, '2023-05-01');
  assert.equal(lots[0].acquisition_kind, 'purchase');
  assert.equal(lots[0].acquired_from, 'LGS');

  const after = valueOf(f.db);
  assert.deepEqual(after, before, 'a move is a move — nothing is created or destroyed');
  f.db.close();
});

test('a partial move leaves the rest of the lot where it was', () => {
  const f = movingFixture({ quantity: 3 });
  // The deck only wants two of the three.
  f.decks.get(f.deckId);
  const card = f.decks.get(f.deckId)!.cards[0];
  f.decks.setQuantity(f.deckId, card.id, 2);

  const before = valueOf(f.db);
  const sheet = pickAll(f.db, openAssemblyRun(f.db, f.deckId));
  completeRun(f.db, sheet.run.id);

  const lots = lotsIn(f.db) as any[];
  assert.equal(lots.length, 2);
  const source = lots.find((lot) => lot.location_id === f.binder)!;
  const moved = lots.find((lot) => lot.location_id === f.deckBox)!;
  assert.equal(source.quantity, 1);
  assert.equal(moved.quantity, 2);
  assert.equal(moved.acquired_unit_cost, 4);
  assert.deepEqual(valueOf(f.db), before);
  f.db.close();
});

test('moving into an identical lot merges; a different cost basis makes a second lot', () => {
  // The deck needs two copies and the home location already holds one of them,
  // so the resolver takes the copy that is already in the box and then reaches
  // into the binder for the second — which is the copy that actually moves.
  const f = movingFixture({ quantity: 1 });
  const card = f.decks.get(f.deckId)!.cards[0];
  f.decks.setQuantity(f.deckId, card.id, 2);
  f.collection.addLot({
    printingId: 'p-a', locationId: f.deckBox, quantity: 1,
    acquiredUnitCost: 4, acquiredAt: '2023-05-01',
    acquisitionKind: 'purchase', acquiredFrom: 'LGS',
  });

  completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, f.deckId)).run.id);

  let lots = lotsIn(f.db) as any[];
  assert.equal(lots.length, 1, 'identical lots merge');
  assert.equal(lots[0].location_id, f.deckBox);
  assert.equal(lots[0].quantity, 2);

  // Now the other half of the rule, with a home lot that differs only in what
  // it cost. The $4 copy from the binder must not disappear into the $9 one.
  const g = movingFixture({ quantity: 1 });
  const gCard = g.decks.get(g.deckId)!.cards[0];
  g.decks.setQuantity(g.deckId, gCard.id, 2);
  g.collection.addLot({
    printingId: 'p-a', locationId: g.deckBox, quantity: 1,
    acquiredUnitCost: 9, acquiredAt: '2023-05-01',
    acquisitionKind: 'purchase', acquiredFrom: 'LGS',
  });

  completeRun(g.db, pickAll(g.db, openAssemblyRun(g.db, g.deckId)).run.id);

  lots = (lotsIn(g.db) as any[]).filter((lot) => lot.location_id === g.deckBox);
  assert.equal(lots.length, 2, 'a $4 copy and a $9 copy are two lots, not one');
  assert.deepEqual(lots.map((lot) => lot.acquired_unit_cost).sort(), [4, 9]);
  f.db.close();
  g.db.close();
});

test('a copy already in the deck box is pulled without being moved', () => {
  const f = movingFixture({ quantity: 1 });
  // Everything the deck needs is already where the deck lives.
  const lotAtHome = f.collection.addLot({
    printingId: 'p-a', locationId: f.deckBox, quantity: 1, acquiredUnitCost: 4,
    acquiredAt: '2023-05-01', acquisitionKind: 'purchase', acquiredFrom: 'LGS',
  });
  const before = lotsIn(f.db);
  const sheet = pickAll(f.db, openAssemblyRun(f.db, f.deckId));
  assert.equal(lines(sheet)[0].collectionItemId, lotAtHome, 'the copy in the box is preferred');

  const summary = completeRun(f.db, sheet.run.id)!;

  assert.equal(summary.pulledCards, 1, 'it still counts as pulled');
  assert.deepEqual(lotsIn(f.db), before,
    'but nothing was decremented and re-minted under a new id');
  f.db.close();
});

test('a moved lot does not become a second reservation', () => {
  const f = movingFixture({ quantity: 2 });
  const availableBefore = availableFor(f.db, 'a');

  completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, f.deckId)).run.id);

  // The deck now claims both copies, which is the run's doing and is correct.
  // What must not have happened is the *move* also counting: 2 owned, 2 claimed
  // is 0 available, not -2.
  assert.equal(availableBefore, 2);
  assert.equal(availableFor(f.db, 'a'), 0);
  assert.equal(availableFor(f.db, 'a', { excludeDeckId: f.deckId }), 2,
    'the copies are exactly where the deck claimed them, and nowhere twice');
  f.db.close();
});

test('moving a trade-listed lot to zero settles the listing instead of dangling it', () => {
  const f = movingFixture();
  const listId = (f.tradeLists.lists()[0] as { id: number }).id;
  f.tradeLists.addItem(listId, f.lotId, { quantity: 1 });
  setSetting(f.db, 'tradelist_reduces_available', '0');

  const summary = completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, f.deckId)).run.id)!;

  assert.equal(summary.tradeListAdjustments.length, 1);
  assert.equal(summary.tradeListAdjustments[0].removed, true);
  assert.match(summary.tradeListAdjustments[0].listName, /Trades/);

  const dangling = f.db.prepare(`
    SELECT COUNT(*) AS n FROM trade_list_items tli
     LEFT JOIN collection_items ci ON ci.id = tli.collection_item_id
     WHERE ci.id IS NULL`).get() as { n: number };
  assert.equal(dangling.n, 0, 'no listing points at a lot that is gone');
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM trade_list_items').get() as { n: number }).n, 0);
  f.db.close();
});

test('a partly-listed lot keeps the rest of its offer', () => {
  const f = movingFixture({ quantity: 3 });
  const listId = (f.tradeLists.lists()[0] as { id: number }).id;
  f.tradeLists.addItem(listId, f.lotId, { quantity: 3 });
  setSetting(f.db, 'tradelist_reduces_available', '0');

  const card = f.decks.get(f.deckId)!.cards[0];
  f.decks.setQuantity(f.deckId, card.id, 1);

  const summary = completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, f.deckId)).run.id)!;

  const listing = f.db.prepare('SELECT quantity FROM trade_list_items').get() as { quantity: number };
  assert.equal(listing.quantity, 2, 'one copy went into a deck, two are still on offer');
  assert.equal(summary.tradeListAdjustments[0].removed, false);
  f.db.close();
});

// -- disassembly --------------------------------------------------------------

test('assemble then disassemble leaves the collection exactly as it started', () => {
  const f = movingFixture({ quantity: 2 });
  const before = lotShapes(f.db);
  const valueBefore = valueOf(f.db);

  completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, f.deckId)).run.id);
  const back = pickAll(f.db, openDisassemblyRun(f.db, f.deckId));
  assert.equal(back.run.kind, 'disassemble');
  assert.equal(back.groups[0].locationName, 'Deck box', 'you pull them out of the deck box');
  assert.equal(lines(back)[0].toLocationName, 'Binder', 'and they go back to the binder');

  const summary = completeRun(f.db, back.run.id)!;
  assert.equal(summary.deckStatus, 'disassembled');
  assert.equal(f.decks.get(f.deckId)!.status, 'disassembled');

  assert.deepEqual(lotShapes(f.db), before);
  assert.deepEqual(valueOf(f.db), valueBefore);
  f.db.close();
});

test('a round trip through a merge still restores both lots', () => {
  // Three copies wanted, one already at home and two in the binder: the two
  // that move merge into the lot that was already there, so the return move has
  // to find its copies inside a lot it did not create.
  const f = movingFixture({ quantity: 2 });
  const card = f.decks.get(f.deckId)!.cards[0];
  f.decks.setQuantity(f.deckId, card.id, 3);
  f.collection.addLot({
    printingId: 'p-a', locationId: f.deckBox, quantity: 1,
    acquiredUnitCost: 4, acquiredAt: '2023-05-01',
    acquisitionKind: 'purchase', acquiredFrom: 'LGS',
  });
  const before = lotShapes(f.db);

  completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, f.deckId)).run.id);
  const merged = lotsIn(f.db) as any[];
  assert.equal(merged.length, 1, 'the binder lot merged into the deck-box lot');
  assert.equal(merged[0].quantity, 3);

  completeRun(f.db, pickAll(f.db, openDisassemblyRun(f.db, f.deckId)).run.id);

  const after = lotsIn(f.db) as any[];
  assert.equal(after.length, 2);
  assert.equal(after.find((lot) => lot.location_id === f.deckBox)!.quantity, 1,
    'the seeded home lot is back to its seed quantity');
  const restored = after.find((lot) => lot.location_id === f.binder)!;
  assert.equal(restored.quantity, 2);
  assert.equal(restored.acquired_unit_cost, 4, 'with its cost basis intact');
  assert.deepEqual(lotShapes(f.db), before);
  f.db.close();
});

test('a card whose original location was archived goes back to the default one', () => {
  const f = movingFixture();
  completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, f.deckId)).run.id);
  f.db.prepare('UPDATE storage_locations SET is_archived = 1 WHERE id = ?').run(f.binder);

  const back = openDisassemblyRun(f.db, f.deckId);
  assert.equal(lines(back)[0].toLocationName, 'Unsorted',
    'a card with nowhere to go still has to go somewhere');
  f.db.close();
});

test('disassembling after the home lot was deleted by hand marks that line and completes the rest', () => {
  const f = fixture([{ id: 'a', name: 'Alpha', price: 5 }, { id: 'b', name: 'Beta', price: 5 }]);
  const binder = f.location('Binder', 1);
  const deckBox = f.location('Deck box', 2);
  setSetting(f.db, ASSEMBLY_MOVES_LOTS, '1');
  f.collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1, acquiredUnitCost: 1 });
  f.collection.addLot({ printingId: 'p-b', locationId: binder, quantity: 1, acquiredUnitCost: 2 });
  const deckId = deckOf(f.decks, 'Half gone', ['a', 'b']);
  f.decks.update(deckId, { homeLocationId: deckBox });

  completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, deckId)).run.id);

  // The user sold one of them straight out of the deck box.
  const sold = f.db.prepare(`
    SELECT ci.id FROM collection_items ci WHERE ci.printing_id = 'p-a'`).get() as { id: number };
  f.collection.removeLot(sold.id);

  const summary = completeRun(f.db, pickAll(f.db, openDisassemblyRun(f.db, deckId)).run.id)!;

  assert.equal(summary.problems.length, 1);
  assert.match(summary.problems[0], /Alpha/);
  assert.equal(summary.copiesMoved, 1, 'the other card still went home');
  const beta = (lotsIn(f.db) as any[]).find((lot) => lot.printing_id === 'p-b')!;
  assert.equal(beta.location_id, binder);
  // Never invented from nothing: the sold card did not reappear.
  assert.equal((lotsIn(f.db) as any[]).filter((lot) => lot.printing_id === 'p-a').length, 0);
  f.db.close();
});

test('disassembly refuses when nothing was ever assembled', () => {
  const { db, decks, collection, location } = fixture([{ id: 'a', name: 'Alpha' }]);
  collection.addLot({ printingId: 'p-a', locationId: location('Binder'), quantity: 1 });
  const deckId = deckOf(decks, 'Never built', ['a']);
  assert.throws(() => openDisassemblyRun(db, deckId), /no completed assembly/i);
  db.close();
});

test('disassembly does not disturb the claim', () => {
  const f = movingFixture({ quantity: 2 });
  completeRun(f.db, pickAll(f.db, openAssemblyRun(f.db, f.deckId)).run.id);
  const claimed = f.decks.get(f.deckId)!.cards[0].quantityFromCollection;
  assert.equal(claimed, 2);

  completeRun(f.db, pickAll(f.db, openDisassemblyRun(f.db, f.deckId)).run.id);

  // The claim is a function of the collection and of the *other* decks, not of
  // this deck's status, so putting the deck away moves the cards and changes
  // nothing about what it could claim. Phase 22's rule that a status change
  // never rewrites the claim falls out of that rather than being enforced.
  assert.equal(f.decks.get(f.deckId)!.cards[0].quantityFromCollection, 2);
  assert.equal(f.decks.get(f.deckId)!.status, 'disassembled');
  f.db.close();
});

// -- housekeeping -------------------------------------------------------------

test('a run without a home location is a checklist, and says why', () => {
  const { db, decks, collection, location } = fixture([{ id: 'a', name: 'Alpha' }]);
  collection.addLot({ printingId: 'p-a', locationId: location('Binder'), quantity: 1 });
  setSetting(db, ASSEMBLY_MOVES_LOTS, '1');

  const sheet = openAssemblyRun(db, deckOf(decks, 'Homeless', ['a']));
  assert.equal(sheet.movesLots, false);
  assert.match(sheet.movesLotsBlocked ?? '', /home location/i);
  db.close();
});

test('flipping the setting mid-run does not turn a checklist into a move', () => {
  const { db, decks, collection, location } = fixture([{ id: 'a', name: 'Alpha' }]);
  const binder = location('Binder', 1);
  const deckBox = location('Deck box', 2);
  collection.addLot({ printingId: 'p-a', locationId: binder, quantity: 1 });
  const deckId = deckOf(decks, 'Mid-run', ['a']);
  decks.update(deckId, { homeLocationId: deckBox });

  const sheet = pickAll(db, openAssemblyRun(db, deckId));
  setSetting(db, ASSEMBLY_MOVES_LOTS, '1');
  const summary = completeRun(db, sheet.run.id)!;

  assert.equal(summary.movedLots, false);
  assert.equal((lotsIn(db) as any[])[0].location_id, binder);
  db.close();
});

test('a finished run cannot be ticked or completed twice', () => {
  const { db, decks, collection, location } = fixture([{ id: 'a', name: 'Alpha' }]);
  collection.addLot({ printingId: 'p-a', locationId: location('Binder'), quantity: 1 });
  const deckId = deckOf(decks, 'Once', ['a']);
  const sheet = pickAll(db, openAssemblyRun(db, deckId));
  const lineId = lines(sheet)[0].id;
  completeRun(db, sheet.run.id);

  assert.throws(() => completeRun(db, sheet.run.id), /already finished/i);
  assert.throws(() => setItemPicked(db, sheet.run.id, lineId, false), /already finished/i);
  db.close();
});

test('a cancelled run changes nothing and frees the deck for another', () => {
  const f = movingFixture();
  const before = lotsIn(f.db);
  const sheet = pickAll(f.db, openAssemblyRun(f.db, f.deckId));
  cancelRun(f.db, sheet.run.id);

  assert.deepEqual(lotsIn(f.db), before);
  assert.equal(f.decks.get(f.deckId)!.status, 'brew');
  const next = openAssemblyRun(f.db, f.deckId);
  assert.notEqual(next.run.id, sheet.run.id);
  assert.equal(listRuns(f.db, f.deckId).length, 2);
  f.db.close();
});

test('deleting a deck with an open run leaves no orphan items', () => {
  const { db, decks, collection, location } = fixture([{ id: 'a', name: 'Alpha' }]);
  collection.addLot({ printingId: 'p-a', locationId: location('Binder'), quantity: 1 });
  const deckId = deckOf(decks, 'Doomed', ['a']);
  openAssemblyRun(db, deckId);

  decks.delete(deckId);

  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM deck_assembly_runs').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM deck_assembly_items').get() as { n: number }).n, 0);
  db.close();
});
