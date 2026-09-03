#!/usr/bin/env node --experimental-strip-types
// Recomputes oracle_cards.default_printing_id in place.
//
// The choice of default printing is a pure function of data already in the
// database, so changing the rule does not need a re-download — this runs the
// one statement the sync would have run, over the printings already there.
//
//   node --experimental-strip-types server/scripts/reassign-art.mjs [--dry-run]

import { openLibrary } from '../src/db/index.ts';
import { CardImporter } from '../src/sync/importer.ts';
import { resolveDataDir } from '../src/config.ts';

const dryRun = process.argv.includes('--dry-run');
const library = openLibrary({ dataDir: resolveDataDir(), createImageDir: false });
const db = library.db;

const sample = (label) => {
  const rows = db.prepare(`
    SELECT o.name, p.set_code, p.collector_number, s.set_type, p.is_promo, p.in_booster
    FROM oracle_cards o
    JOIN card_printings p ON p.id = o.default_printing_id
    LEFT JOIN sets s ON s.code = p.set_code
    WHERE o.name IN ('Lightning Bolt','Sol Ring','Counterspell','Swords to Plowshares',
                     'Cyclonic Rift','Delver of Secrets // Insectile Aberration')
    ORDER BY o.name`).all();
  console.log(`\n${label}`);
  for (const r of rows) {
    console.log(`  ${r.name.slice(0, 34).padEnd(36)} ${r.set_code.padEnd(6)} #${String(r.collector_number).padEnd(6)} ` +
                `${String(r.set_type ?? '-').padEnd(12)} promo=${r.is_promo} booster=${r.in_booster}`);
  }
};

const oddities = () => {
  const row = db.prepare(`
    SELECT count(*) AS n FROM oracle_cards o
    JOIN card_printings p ON p.id = o.default_printing_id
    LEFT JOIN sets s ON s.code = p.set_code
    WHERE COALESCE(s.set_type,'') IN ('promo','memorabilia','funny','masterpiece','alchemy','box')
       OR p.is_promo = 1 OR COALESCE(p.in_booster,1) = 0`).get();
  const missing = db.prepare('SELECT count(*) AS n FROM oracle_cards WHERE default_printing_id IS NULL').get();
  console.log(`\n  cards defaulting to a promo/Secret Lair/special printing: ${row.n.toLocaleString()}`);
  console.log(`  cards with no default printing at all:                    ${missing.n.toLocaleString()}`);
};

sample('before:');
oddities();

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
} else {
  const started = Date.now();
  db.transaction(() => new CardImporter(db).assignDefaultPrintings())();
  console.log(`\nreassigned in ${Date.now() - started}ms`);
  sample('after:');
  oddities();
}

db.close();
