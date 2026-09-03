import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { CardImporter } from './importer.ts';

/**
 * Which printing a card wears by default.
 *
 * After the switch to Scryfall's default_cards file every variant is in the
 * database, so "newest" stopped being a good enough rule: Secret Lair is newer
 * than the real set, sits in a set typed `box`, and reports promo = false, so
 * nothing in the old ordering held it back.
 */

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

interface P {
  id: string; set: string; number: number; released: string;
  promo?: number; booster?: number; digital?: number; oversized?: number;
  variation?: number; border?: string; frame?: string; image?: string | null;
}

function build(printings: P[], sets: Array<[string, string]>) {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  const set = db.prepare(`INSERT INTO sets (code, name, set_type) VALUES (?,?,?)`);
  for (const [code, type] of sets) set.run(code, code.toUpperCase(), type);

  db.prepare(`INSERT INTO oracle_cards (oracle_id, name, name_normalized, cmc, type_line,
                                        oracle_text_all, layout)
              VALUES ('o1','Test Card','test card',1,'Instant','x','normal')`).run();

  const ins = db.prepare(`
    INSERT INTO card_printings (id, oracle_id, set_code, collector_number, collector_number_num,
                                released_at, is_promo, in_booster, is_digital, is_oversized,
                                is_variation, border_color, frame_effects, image_normal)
    VALUES (?, 'o1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of printings) {
    ins.run(p.id, p.set, String(p.number), p.number, p.released,
            p.promo ?? 0, p.booster ?? 1, p.digital ?? 0, p.oversized ?? 0,
            p.variation ?? 0, p.border ?? 'black', p.frame ?? null,
            p.image === undefined ? 'http://img' : p.image);
  }

  new CardImporter(db).assignDefaultPrintings();
  const chosen = (db.prepare('SELECT default_printing_id AS id FROM oracle_cards').get() as any).id;
  return { db, chosen };
}

test('a Secret Lair loses to an older ordinary printing', () => {
  const { db, chosen } = build([
    { id: 'normal', set: 'cmm', number: 81, released: '2023-08-04' },
    // Newer, and reports promo = false — which is why recency alone failed.
    { id: 'secret', set: 'sld', number: 2783, released: '2026-08-31', booster: 0 },
  ], [['cmm', 'masters'], ['sld', 'box']]);
  assert.equal(chosen, 'normal');
  db.close();
});

test('among ordinary printings the newest still wins', () => {
  const { db, chosen } = build([
    { id: 'old', set: 'lea', number: 161, released: '1993-08-05' },
    { id: 'new', set: 'cmm', number: 81, released: '2023-08-04' },
  ], [['lea', 'core'], ['cmm', 'masters']]);
  assert.equal(chosen, 'new');
  db.close();
});

test('promos, digital, oversized and non-booster printings are all passed over', () => {
  for (const bad of [
    { id: 'bad', set: 'exp', number: 5, released: '2026-01-01', promo: 1 },
    { id: 'bad', set: 'exp', number: 5, released: '2026-01-01', digital: 1 },
    { id: 'bad', set: 'exp', number: 5, released: '2026-01-01', oversized: 1 },
    { id: 'bad', set: 'exp', number: 5, released: '2026-01-01', booster: 0 },
  ] as P[]) {
    const { db, chosen } = build([
      bad,
      { id: 'good', set: 'exp', number: 1, released: '2020-01-01' },
    ], [['exp', 'expansion']]);
    assert.equal(chosen, 'good', JSON.stringify(bad));
    db.close();
  }
});

test('showcase, borderless and variation art lose to the plain version of the same set', () => {
  for (const fancy of [
    { id: 'fancy', set: 'exp', number: 300, released: '2026-01-01', frame: '["showcase"]' },
    { id: 'fancy', set: 'exp', number: 301, released: '2026-01-01', frame: '["extendedart"]' },
    { id: 'fancy', set: 'exp', number: 302, released: '2026-01-01', border: 'borderless' },
    { id: 'fancy', set: 'exp', number: 303, released: '2026-01-01', variation: 1 },
  ] as P[]) {
    const { db, chosen } = build([
      fancy,
      // Same release date, so only the variant flags can separate them.
      { id: 'plain', set: 'exp', number: 12, released: '2026-01-01' },
    ], [['exp', 'expansion']]);
    assert.equal(chosen, 'plain', JSON.stringify(fancy));
    db.close();
  }
});

test('reprint inserts lose, because they carry another set under a borrowed number', () => {
  const { db, chosen } = build([
    { id: 'list', set: 'plst', number: 187, released: '2026-11-09' },
    { id: 'real', set: '2x2', number: 117, released: '2022-07-08' },
  ], [['plst', 'masters'], ['2x2', 'masters']]);
  assert.equal(chosen, 'real');
  db.close();
});

test('a card that exists only as a Secret Lair still gets art', () => {
  // The rule ranks rather than filters, so the fallback needs no special case.
  const { db, chosen } = build([
    { id: 'only', set: 'sld', number: 99, released: '2026-01-01', booster: 0 },
  ], [['sld', 'box']]);
  assert.equal(chosen, 'only');
  db.close();
});

test('a printing with no art loses to one that has some', () => {
  const { db, chosen } = build([
    { id: 'artless', set: 'exp', number: 1, released: '2026-06-01', image: null },
    { id: 'arted', set: 'exp', number: 2, released: '2020-01-01' },
  ], [['exp', 'expansion']]);
  assert.equal(chosen, 'arted');
  db.close();
});

test('a double-faced card is not scored as artless just because its art is on a face', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name,set_type) VALUES ('exp','EXP','expansion')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('o1','Delver','delver',1,'Creature','x','transform')`).run();
  const ins = db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,
              collector_number_num,released_at,image_normal) VALUES (?,'o1','exp',?,?,?,NULL)`);
  ins.run('newer', '51', 51, '2026-01-01');
  ins.run('older', '12', 12, '2020-01-01');
  // Art lives on the face, as it does for every transforming card.
  db.prepare(`INSERT INTO card_faces (printing_id, face_index, name, image_normal)
              VALUES ('newer', 0, 'Delver', 'http://img')`).run();

  new CardImporter(db).assignDefaultPrintings();
  const chosen = (db.prepare('SELECT default_printing_id AS id FROM oracle_cards').get() as any).id;
  assert.equal(chosen, 'newer', 'face art should count as having art');
  db.close();
});

test('ties break deterministically rather than by insertion order', () => {
  const printings: P[] = [
    { id: 'z', set: 'exp', number: 300, released: '2026-01-01' },
    { id: 'a', set: 'exp', number: 12, released: '2026-01-01' },
    { id: 'm', set: 'exp', number: 45, released: '2026-01-01' },
  ];
  const first = build(printings, [['exp', 'expansion']]);
  const reversed = build([...printings].reverse(), [['exp', 'expansion']]);
  assert.equal(first.chosen, 'a', 'lowest collector number wins');
  assert.equal(reversed.chosen, first.chosen, 'insertion order must not matter');
  first.db.close(); reversed.db.close();
});

test('English wins, even over a nicer printing in another language', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name,set_type) VALUES ('exp','EXP','expansion')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('o1','Test','test',1,'Instant','x','normal')`).run();
  const ins = db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,
      collector_number_num,released_at,lang,image_normal) VALUES (?,'o1','exp',?,?,?,?,'http://img')`);
  // The Japanese one is newer, so recency alone would take it.
  ins.run('ja', '10', 10, '2026-01-01', 'ja');
  ins.run('en', '11', 11, '2020-01-01', 'en');

  new CardImporter(db).assignDefaultPrintings();
  assert.equal((db.prepare('SELECT default_printing_id AS id FROM oracle_cards').get() as any).id, 'en');
  db.close();
});

test('a card printed only in another language still gets its art', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name,set_type) VALUES ('ren','Renaissance','expansion')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,type_line,oracle_text_all,layout)
              VALUES ('o1','Marsh Gas','marsh gas',1,'Instant','x','normal')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,collector_number_num,
      released_at,lang,image_normal) VALUES ('fr','o1','ren','59',59,'1995-01-01','fr','http://img')`).run();

  new CardImporter(db).assignDefaultPrintings();
  // Ranked, not filtered — otherwise these lose their art entirely.
  assert.equal((db.prepare('SELECT default_printing_id AS id FROM oracle_cards').get() as any).id, 'fr');
  db.close();
});

test('assignRarityFlags marks cards with any uncommon printing', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  const oracle = db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,cmc,
                               type_line,oracle_text_all,layout) VALUES (?,?,?,1,'Creature','x','normal')`);
  const printing = db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,rarity)
                               VALUES (?,?,'tst',?,?)`);
  oracle.run('a', 'Uncommon Only', 'uncommon only');
  printing.run('pa', 'a', '1', 'uncommon');
  oracle.run('b', 'Rare And Uncommon', 'rare and uncommon');
  printing.run('pb1', 'b', '2', 'rare');
  printing.run('pb2', 'b', '3', 'uncommon');
  oracle.run('c', 'Never Uncommon', 'never uncommon');
  printing.run('pc', 'c', '4', 'rare');

  new CardImporter(db).assignRarityFlags();

  const flag = (id: string) =>
    (db.prepare('SELECT has_uncommon_printing AS f FROM oracle_cards WHERE oracle_id = ?')
      .get(id) as { f: number }).f;
  assert.equal(flag('a'), 1);
  assert.equal(flag('b'), 1);
  assert.equal(flag('c'), 0);
  db.close();
});
