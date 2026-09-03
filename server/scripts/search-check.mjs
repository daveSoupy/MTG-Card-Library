#!/usr/bin/env node --experimental-strip-types
// Exercises the search layer against a synced database, so query parity can be
// checked after changes without clicking through the UI.
//
//   node --experimental-strip-types server/scripts/search-check.mjs

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { CardSearchStore } from '../src/search/store.ts';
import { resolveDataDir } from '../src/config.ts';

const db = new Database(join(resolveDataDir(), 'library.sqlite'), { readonly: true });
const store = new CardSearchStore(db);

let slow = 0;
const run = (query, { filters = {}, sort = 'relevance', show = 2 } = {}) => {
  const started = performance.now();
  const { cards, total } = store.search(query, filters, sort, 25);
  const ms = performance.now() - started;
  if (ms > 1000) slow += 1;
  const label = query || '(filters only)';
  console.log(`${label.padEnd(34)} ${String(total).padStart(6)} hits ${ms.toFixed(1).padStart(8)} ms`);
  for (const card of cards.slice(0, show)) {
    const pt = card.power && card.toughness ? ` ${card.power}/${card.toughness}` : '';
    console.log(`      ${card.name} — ${card.typeLine}${pt} [${card.setCode ?? '?'}]`);
  }
  return cards;
};

console.log('=== Scryfall-style syntax ===');
run('t:creature c:rg cmc<=3');
run('o:"draw a card" t:instant');
run('id<=wu is:commander');
run('t:legendary t:dragon cmc>=7');
run('pow>=8 -is:land');
run('f:modern banned:legacy');
run('set:blb r:mythic');
run('is:reserved c:u');
run('a:"Rebecca Guay"');
run('is:dfc t:werewolf');
run('-t:creature o:flying');

console.log('\n=== fix 1: relevance — exact name must win ===');
const bolt = run('lightning bolt', { show: 3 });
console.log(bolt[0]?.name === 'Lightning Bolt' ? '  PASS' : `  FAIL — got "${bolt[0]?.name}"`);

console.log('\n=== fix 2: no Alchemy cards by default ===');
const wide = run('t:creature', { show: 3 });
const alchemy = wide.filter((c) => c.name.startsWith('A-'));
console.log(alchemy.length === 0 ? '  PASS' : `  FAIL — ${alchemy.length} A- cards leaked in`);
const optIn = store.search('t:creature is:digital', {}, 'name', 5);
console.log(`  is:digital opt-in still works: ${optIn.total} digital cards`);

console.log('\n=== fix 3: set + rarity performance ===');
const t0 = performance.now();
store.search('set:blb r:mythic', {}, 'name', 25);
const setMs = performance.now() - t0;
console.log(`  set:blb r:mythic  ${setMs.toFixed(1)} ms  ${setMs < 1000 ? 'PASS' : 'FAIL (was 5043 ms in Swift)'}`);

console.log('\n=== structured filters ===');
run('', { filters: { colors: ['W', 'U'], rarities: ['mythic'] }, sort: 'name' });
run('', { filters: { format: 'commander', minCmc: 8 }, sort: 'name' });
run('', { filters: { ownedOnly: true }, sort: 'name', show: 0 });

console.log('\n=== detail lookup ===');
const [delver] = store.search('Delver of Secrets', {}, 'relevance', 1).cards;
if (delver) {
  const detail = store.detail(delver.oracleId);
  console.log(`  ${detail.name}  [${detail.layout}]`);
  console.log(`  faces: ${detail.faces.map((f) => f.name).join(' // ') || '(none)'}`);
  console.log(`  printings: ${detail.printings.length}, legalities: ${detail.legalities.length}, ` +
    `playable in ${detail.legalities.filter((l) => l.playable).length}`);
  console.log(`  front image: ${detail.imageNormal ? 'yes' : 'no'}, ` +
    `back image: ${detail.faces[1]?.imageNormal ? 'yes' : 'no'}`);
}

console.log(`\nsets: ${store.sets().length}, formats: ${store.formats().length}`);
console.log(slow === 0 ? '\nNo query exceeded 1s.' : `\n${slow} slow queries.`);
db.close();
