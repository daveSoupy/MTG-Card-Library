#!/usr/bin/env node --experimental-strip-types
// Runs a bulk sync from the command line, for setup and for verifying an
// install without going through the web UI.
//
//   node --experimental-strip-types server/scripts/sync.mjs [--type oracle_cards] [--force]

import { openLibrary, libraryStatus } from '../src/db/index.ts';
import { runSync } from '../src/sync/runSync.ts';
import { resolveDataDir } from '../src/config.ts';

const args = process.argv.slice(2);
const typeIndex = args.indexOf('--type');
const bulkType = typeIndex >= 0 ? args[typeIndex + 1] : undefined;
const force = args.includes('--force');

const library = openLibrary({ dataDir: resolveDataDir() });
console.log(`database: ${library.databasePath}`);

let lastLine = '';
const write = (line) => {
  if (line === lastLine) return;
  lastLine = line;
  process.stdout.write(`\r${' '.repeat(78)}\r${line}`);
};

try {
  const result = await runSync(library.db, {
    bulkType,
    force,
    onProgress: (p) => {
      const pct = p.fraction === null ? '' : ` ${Math.round(p.fraction * 100)}%`;
      write(`[${p.phase}]${pct} ${p.message}`);
    },
  });
  process.stdout.write('\n\n');

  if (result.status === 'skipped') {
    console.log('Already up to date; nothing imported.');
  } else {
    console.log(`cards       ${result.cardsImported.toLocaleString()}`);
    console.log(`printings   ${result.printingsImported.toLocaleString()}`);
    console.log(`sets        ${result.setsImported.toLocaleString()}`);
    console.log(`skipped     ${result.skippedRecords.toLocaleString()}`);
    console.log(`duration    ${(result.durationMs / 1000).toFixed(1)}s`);
  }

  const status = libraryStatus(library.db);
  console.log(`\nstatus: ${status.oracleCards.toLocaleString()} cards, ` +
    `${status.printings.toLocaleString()} printings, ${status.sets.toLocaleString()} sets`);
} catch (error) {
  process.stdout.write('\n');
  console.error(`Sync failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  library.close();
}
