import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { DeckStore } from '../decks/store.ts';
import { CollectionStore } from '../collection/store.ts';
import { normalizeName } from '../model/mtg.ts';
import {
  previewDecklist, commitDecklist, previewCollectionCsv, commitCollectionCsv,
  importBatches, undoImport,
} from './importer.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

const CARDS = [
  { id: 'o-atraxa', name: "Atraxa, Praetors' Voice", type: 'Legendary Creature — Phyrexian Angel Horror',
    identity: 'WUBG', mask: 1 | 2 | 4 | 16, legendary: 1, commander: 1 },
  { id: 'o-bolt', name: 'Lightning Bolt', type: 'Instant', identity: 'R', mask: 8, legendary: 0, commander: 0 },
  { id: 'o-solring', name: 'Sol Ring', type: 'Artifact', identity: '', mask: 0, legendary: 0, commander: 0 },
];

function fixture() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name) VALUES ('tst','Test Set')`).run();

  CARDS.forEach((card, index) => {
    db.prepare(`
      INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line, oracle_text_all,
                                layout, color_identity, color_identity_mask, is_legendary, can_be_commander)
      VALUES (?,?,?,1,?,'x','normal',?,?,?,?)`)
      .run(card.id, card.name, normalizeName(card.name), card.type,
           card.identity, card.mask, card.legendary, card.commander);
    db.prepare(`INSERT INTO card_name_variants (oracle_id, variant_name, variant_normalized, kind)
                VALUES (?,?,?,'primary')`).run(card.id, card.name, normalizeName(card.name));
    db.prepare(`INSERT INTO card_printings (id, oracle_id, set_code, collector_number, collector_number_num, price_usd)
                VALUES (?,?,'tst',?,?,2.0)`).run(`${card.id}-p`, card.id, String(index + 1), index + 1);
    db.prepare('UPDATE oracle_cards SET default_printing_id = ? WHERE oracle_id = ?')
      .run(`${card.id}-p`, card.id);
  });

  return { db, decks: new DeckStore(db), collection: new CollectionStore(db) };
}

test('an imported commander is marked as the commander, not just filed in the zone', () => {
  const { db, decks } = fixture();
  const deckId = decks.create({ name: 'Imported', formatCode: 'commander' });

  const preview = previewDecklist(db, `Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring`);
  commitDecklist(db, decks, deckId, preview.lines
    .filter((l) => l.match)
    .map((l) => ({ oracleId: l.match!.oracleId, quantity: l.quantity, board: l.board })));

  const deck = decks.get(deckId)!;
  const commander = deck.cards.find((c) => c.board === 'command');
  assert.ok(commander, 'the commander is in the command zone');
  // Without the role, colour identity has nothing to validate against and the
  // deck would report as having no commander at all.
  assert.equal(commander!.commanderRole, 'commander');
  // The deck list reads the commander from that role, so it shows up there too.
  const summary = decks.list().find((d) => d.id === deckId)!;
  assert.deepEqual(summary.commanderNames, ["Atraxa, Praetors' Voice"]);
});

test('a card outside the commander colour identity is caught on an imported deck', () => {
  const { db, decks } = fixture();
  const deckId = decks.create({ name: 'Off-colour', formatCode: 'commander' });

  // Atraxa is WUBG; Lightning Bolt is red, so 903.4 must reject it.
  const preview = previewDecklist(db, `Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Lightning Bolt`);
  commitDecklist(db, decks, deckId, preview.lines
    .filter((l) => l.match)
    .map((l) => ({ oracleId: l.match!.oracleId, quantity: l.quantity, board: l.board })));

  const deck = decks.get(deckId)!;
  assert.ok(
    deck.validation.issues.some((issue) => /colou?r identity/i.test(issue.message)),
    `expected a colour identity issue, got: ${deck.validation.issues.map((i) => i.message).join(' | ')}`,
  );
});

test('a maybeboard line is imported into the deck rather than dropped', () => {
  const { db, decks } = fixture();
  const deckId = decks.create({ name: 'Deck', formatCode: null });
  commitDecklist(db, decks, deckId, [{ oracleId: 'o-bolt', quantity: 2, board: 'maybe' }]);
  const deck = decks.get(deckId)!;
  assert.equal(deck.cards[0].board, 'main');
  assert.equal(deck.cards[0].quantity, 2);
});

test('a CSV import can be undone, taking back exactly what it added', () => {
  const { db, collection } = fixture();
  const locationId = collection.createLocation({ name: 'Binder' });

  const csv = 'Name,Count,Edition,Condition,Price\n'
            + "Lightning Bolt,4,Test Set,Near Mint,1.50\n"
            + 'Sol Ring,2,Test Set,Lightly Played,3.00\n';
  const preview = previewCollectionCsv(db, csv);
  assert.equal(preview.counts.resolved, 2);
  // The set was named rather than coded, and must still pin the printing.
  assert.equal(preview.rows[0].setCode, 'tst');

  const result = commitCollectionCsv(db, collection, {
    locationId,
    rows: preview.rows.map((r) => ({
      printingId: r.printingId!, quantity: r.quantity,
      finish: r.finish, condition: r.condition, language: r.language,
      acquiredUnitCost: r.price,
    })),
    fileName: 'test.csv',
  });
  assert.equal(result.cards, 6);
  assert.equal(collection.value().total_cards, 6);

  const batch = importBatches(db)[0] as any;
  assert.equal(batch.cardsRemaining, 6);

  const undone = undoImport(db, result.batchId);
  assert.equal(undone.removed, 2, 'both lots');
  assert.equal(collection.value().total_cards ?? 0, 0);
});

test('an undo leaves cards the import did not add alone', () => {
  const { db, collection } = fixture();
  const locationId = collection.createLocation({ name: 'Binder' });

  // A copy owned beforehand, with no batch of its own.
  collection.addLot({ printingId: 'o-bolt-p', locationId, quantity: 1, acquiredUnitCost: 5 });

  const preview = previewCollectionCsv(db, 'Name,Count\nLightning Bolt,4\n');
  const result = commitCollectionCsv(db, collection, {
    locationId,
    rows: preview.rows.map((r) => ({
      printingId: r.printingId!, quantity: r.quantity,
      finish: r.finish, condition: r.condition, language: r.language, acquiredUnitCost: r.price,
    })),
    fileName: 'test.csv',
  });
  assert.equal(collection.value().total_cards, 5);

  undoImport(db, result.batchId);
  assert.equal(collection.value().total_cards, 1, 'the pre-existing copy survives');
});
