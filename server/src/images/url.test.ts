import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { SCHEMA_PATH } from '../db/index.ts';
import { imageUrl, imageUrlSql, artUrlSql, sideForFace } from './url.ts';
import { remoteUrlFor } from './fetch.ts';

const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

// A real row from the library, kept verbatim: this is the shape the five
// dropped columns held, and the thing derivation has to reproduce exactly.
const ID = 'a471b306-4941-4e46-a0cb-d92895c16f8a';
const TS = 1783907750;
const SMALL = `https://cards.scryfall.io/small/front/a/4/${ID}.jpg?${TS}`;

test('a derived URL matches what Scryfall published, size for size', () => {
  assert.equal(imageUrl(ID, 'small', 'front', TS), SMALL);
  assert.equal(imageUrl(ID, 'normal', 'front', TS),
    `https://cards.scryfall.io/normal/front/a/4/${ID}.jpg?${TS}`);
  assert.equal(imageUrl(ID, 'art_crop', 'front', TS),
    `https://cards.scryfall.io/art_crop/front/a/4/${ID}.jpg?${TS}`);
  // png is the one size served as .png; everything else is .jpg.
  assert.equal(imageUrl(ID, 'png', 'front', TS),
    `https://cards.scryfall.io/png/front/a/4/${ID}.png?${TS}`);
});

test('the side comes from the face index, and only face 0 is the front', () => {
  assert.equal(sideForFace(0), 'front');
  assert.equal(sideForFace(1), 'back');
  assert.equal(imageUrl(ID, 'small', 'back', TS),
    `https://cards.scryfall.io/small/back/a/4/${ID}.jpg?${TS}`);
});

test('no timestamp means no art, not a broken URL', () => {
  assert.equal(imageUrl(ID, 'small', 'front', null), null);
});

test('an override wins, per size, and a malformed one is ignored', () => {
  const override = JSON.stringify({ small: 'https://example.test/one.jpg' });
  assert.equal(imageUrl(ID, 'small', 'front', TS, override), 'https://example.test/one.jpg');
  // A size the override does not mention still derives.
  assert.equal(imageUrl(ID, 'normal', 'front', TS, override),
    `https://cards.scryfall.io/normal/front/a/4/${ID}.jpg?${TS}`);
  // Garbage must cost the caller nothing: the derived URL is right for every
  // row this codebase has seen.
  assert.equal(imageUrl(ID, 'small', 'front', TS, '{not json'), SMALL);
});

/**
 * The SQL and the JS forms are two spellings of one template, and a dozen
 * queries ship the SQL one straight to a client. They have to agree.
 */
test('the SQL expression produces exactly what the JS helper does', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,oracle_text_all)
              VALUES ('o1','Card','card','')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,image_ts)
              VALUES (?, 'o1','tst','1',?)`).run(ID, TS);
  // A second printing with no art at all, and a third whose URLs Scryfall
  // published in some other shape.
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number)
              VALUES ('dark','o1','tst','2')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number,image_ts,image_url_override)
              VALUES ('odd','o1','tst','3',7,?)`)
    .run(JSON.stringify({ small: 'https://example.test/odd.jpg' }));

  for (const size of ['small', 'normal', 'large', 'png', 'art_crop'] as const) {
    const sql = imageUrlSql({
      id: 'p.id', ts: 'p.image_ts', override: 'p.image_url_override', size,
    });
    const rows = db.prepare(`SELECT p.id, ${sql} AS url FROM card_printings p ORDER BY p.collector_number`)
      .all() as Array<{ id: string; url: string | null }>;
    assert.equal(rows[0].url, imageUrl(ID, size, 'front', TS));
    assert.equal(rows[1].url, null, 'a printing with no image_ts has no URL');
    assert.equal(rows[2].url, imageUrl('odd', size, 'front', 7,
      JSON.stringify({ small: 'https://example.test/odd.jpg' })));
  }
  db.close();
});

/**
 * The fallback every list query relies on: a double-faced card keeps its art on
 * card_faces and has none of its own, so a query that reads only the printing
 * renders every transform card blank.
 */
test('artUrlSql falls back to the front face, and remoteUrlFor agrees', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO sets (code,name) VALUES ('tst','Test')`).run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,oracle_text_all,layout)
              VALUES ('o1','Delver','delver','','transform')`).run();
  db.prepare(`INSERT INTO card_printings (id,oracle_id,set_code,collector_number)
              VALUES ('dfc','o1','tst','1')`).run();
  db.prepare(`INSERT INTO card_faces (printing_id,face_index,name,image_ts) VALUES ('dfc',0,'Front',?)`).run(TS);
  db.prepare(`INSERT INTO card_faces (printing_id,face_index,name,image_ts) VALUES ('dfc',1,'Back',?)`).run(TS);

  const row = db.prepare(`
    SELECT ${artUrlSql('p', 'ff', 'small')} AS url
      FROM card_printings p
      LEFT JOIN card_faces ff ON ff.printing_id = p.id AND ff.face_index = 0
     WHERE p.id = 'dfc'`).get() as { url: string | null };
  assert.equal(row.url, imageUrl('dfc', 'small', 'front', TS));

  // The image route takes the same fallback, and asks the back face by index.
  assert.equal(remoteUrlFor(db, 'dfc', 0, 'small'), imageUrl('dfc', 'small', 'front', TS));
  assert.equal(remoteUrlFor(db, 'dfc', 1, 'normal'), imageUrl('dfc', 'normal', 'back', TS));
  db.close();
});
