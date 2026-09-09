import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CardImporter } from './importer.ts';

/**
 * Per-card copy limits, through the real import path.
 *
 * The parser itself is covered in model/mtg.test.ts; what this adds is that
 * the value actually reaches its column. The oracle insert binds thirty-odd
 * positional parameters, so a new one in the wrong place would quietly write a
 * copy limit into some other field and still pass every parser test.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

function importOne(card: Record<string, unknown>) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code, name, set_type) VALUES ('tst','Test','expansion')`).run();
  assert.equal(new CardImporter(db).importCard({
    id: 'p1', oracle_id: 'o1', set: 'tst', collector_number: '1', ...card,
  }), true);
  const row = db.prepare(`
    SELECT name, oracle_text_all, deck_copy_limit, is_legendary, can_be_commander
    FROM oracle_cards WHERE oracle_id = 'o1'`).get() as any;
  db.close();
  return row;
}

test('an "any number" card imports with an unlimited copy limit', () => {
  const row = importOne({
    name: 'Relentless Rats',
    type_line: 'Creature — Rat',
    oracle_text: 'Relentless Rats gets +1/+1 for each other creature on the battlefield named Relentless Rats.\nA deck can have any number of cards named Relentless Rats.',
  });
  assert.equal(row.deck_copy_limit, -1);
  // Neighbouring columns still hold their own values, not a shifted binding.
  assert.equal(row.name, 'Relentless Rats');
  assert.equal(row.is_legendary, 0);
  assert.equal(row.can_be_commander, 0);
});

test('a printed cap imports as that number', () => {
  const row = importOne({
    name: 'Seven Dwarves',
    type_line: 'Creature — Dwarf',
    oracle_text: 'Seven Dwarves gets +1/+1 for each other creature you control named Seven Dwarves.\nA deck can have up to seven cards named Seven Dwarves.',
  });
  assert.equal(row.deck_copy_limit, 7);
});

test('an ordinary card imports with no copy limit of its own', () => {
  const row = importOne({
    name: 'Lightning Bolt',
    type_line: 'Instant',
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
  });
  assert.equal(row.deck_copy_limit, null);
});

test('a clause on the back face of a double-faced card is still found', () => {
  // The insert derives the limit from the all-faces text, so a card whose
  // front says nothing does not slip through.
  const row = importOne({
    name: 'Front // Back',
    layout: 'modal_dfc',
    type_line: 'Creature — Rat // Creature — Rat',
    card_faces: [
      { name: 'Front', type_line: 'Creature — Rat', oracle_text: 'Flying' },
      { name: 'Back', type_line: 'Creature — Rat',
        oracle_text: 'A deck can have any number of cards named Front // Back.' },
    ],
  });
  assert.equal(row.deck_copy_limit, -1);
});
