#!/usr/bin/env node --experimental-strip-types
// One-time repair: settle every deck's claim on the collection.
//
// The deck row used to carry a chip that set `quantity_from_collection` to the
// whole slot with no availability check, so decks ended up claiming cards the
// collection never held — a slot reading "1 owned" for a card owned zero of.
// The chip is gone and the claim is derived now; this brings existing decks in
// line, calling the very same function the server calls on every write, so the
// repair cannot drift from the rule.
//
// Deliberately a script rather than a migration: nothing about the schema
// changes, and it is safe to run as often as you like.
//
//   node --experimental-strip-types server/scripts/repair-claims.mjs [--dry-run]

import { openLibrary } from '../src/db/index.ts';
import { resolveDataDir } from '../src/config.ts';
import { reconcileDeckClaims } from '../src/decks/reconcile.ts';

const dryRun = process.argv.includes('--dry-run');
const library = openLibrary({ dataDir: resolveDataDir() });
const db = library.db;
console.log(`database: ${library.databasePath}${dryRun ? '  (dry run)' : ''}\n`);

const claims = () => new Map(
  db.prepare('SELECT id, quantity_from_collection AS q FROM deck_cards').all()
    .map((row) => [row.id, row.q]),
);

const label = db.prepare(`
  SELECT dc.id, d.name AS deck, o.name AS card, dc.quantity AS qty
    FROM deck_cards dc
    JOIN decks d ON d.id = dc.deck_id
    JOIN oracle_cards o ON o.oracle_id = dc.oracle_id`);

const decks = db.prepare('SELECT id, name FROM decks ORDER BY name').all();
const before = claims();

/** Thrown to unwind a dry run — the only way to leave the work uncommitted. */
class Rollback extends Error {}

let changed = [];
try {
  db.transaction(() => {
    for (const deck of decks) reconcileDeckClaims(db, deck.id);

    // Read back inside the transaction, so a dry run still reports what it
    // *would* have done before the rollback throws the numbers away.
    const after = claims();
    changed = label.all()
      .filter((row) => before.get(row.id) !== after.get(row.id))
      .map((row) => ({ ...row, from: before.get(row.id), to: after.get(row.id) }));

    if (dryRun) throw new Rollback();
  })();
} catch (error) {
  if (!(error instanceof Rollback)) throw error;
}

if (changed.length === 0) {
  console.log(`No change — all ${decks.length} deck(s) already claim exactly what they can.`);
} else {
  console.log(`${changed.length} slot(s) across ${decks.length} deck(s):\n`);
  for (const row of changed) {
    console.log(`  ${row.deck} — ${row.card} (x${row.qty}): claimed ${row.from} -> ${row.to}`);
  }
  console.log(dryRun ? '\nRolled back; re-run without --dry-run to apply.' : '\nApplied.');
}

db.close();
