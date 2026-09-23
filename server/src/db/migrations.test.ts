import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { MIGRATIONS } from './migrations.ts';
import { SCHEMA_PATH, schemaVersion } from './index.ts';

const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8');
const TARGET = schemaVersion(SCHEMA_SQL);

/** Structure only — names, columns and types, ignoring formatting. */
function shapeOf(db: Database.Database): string {
  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name`).all() as Array<{ type: string; name: string; sql: string | null }>;

  return objects
    .map(({ type, name, sql }) => {
      // Strip comments and normalise spacing so cosmetic differences do not
      // read as drift. SQLite rewrites the stored DDL during ALTER TABLE and
      // its spacing around punctuation differs from the hand-written file.
      // Column names, types, constraints and order are all still compared.
      const normalized = (sql ?? '')
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        // ALTER TABLE ... RENAME TO quotes the name, so a table rebuilt by a
        // migration reads CREATE TABLE "deck_cards" where the file says
        // CREATE TABLE deck_cards. Identifier quoting only; string literals in
        // this schema are single-quoted and are left alone.
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .trim();
      return `${type} ${name}\n  ${normalized}`;
    })
    .join('\n');
}

/** A database at the state before a given migration ran. */
function databaseAtVersion(version: number): Database.Database {
  const db = new Database(':memory:');
  // Apply the full current schema, then undo what later migrations added, so
  // the "old" database is realistic without keeping historical copies of the
  // whole DDL around.
  db.exec(SCHEMA_SQL);
  // Rewind past every later migration. Each kind a migration can take has an
  // inverse: a created table is dropped, an added column is dropped, a created
  // index, trigger or view is dropped. A kind with no inverse here would silently leave the
  // "old" database identical to a fresh one, and the drift check below would
  // pass without ever comparing anything — so the assertion that the fixture
  // really is missing something is what keeps this list honest.
  //
  // Some inverses cannot be derived from the migration at all. Undoing a
  // DROP COLUMN means putting the column back, and the statement that dropped
  // it never said what type it was; undoing a table rebuild means rebuilding
  // it the old way. Those migrations declare their own inverse with a
  // `-- rewind: <statement>` comment, which runs here before the derived ones.
  for (const migration of [...MIGRATIONS].reverse().filter((m) => m.version > version)) {
    // Declared inverses first: a re-added column may be one a later step reads.
    for (const statement of rewindDirectives(migration.sql)) db.exec(statement);
    // Triggers first: SQLite re-validates every trigger body whenever the
    // schema is re-read, so a trigger left behind pointing at a table the next
    // line drops fails everything after it.
    for (const name of createdTriggers(migration.sql)) {
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    // Views next, and for the same reason: SQLite re-validates every view body
    // whenever the schema is re-read, so one left pointing at a column the
    // column-drop below is about to remove fails everything after it.
    for (const name of createdViews(migration.sql)) {
      db.exec(`DROP VIEW IF EXISTS ${name}`);
    }
    for (const name of createdTables(migration.sql)) {
      db.exec(`DROP TABLE IF EXISTS ${name}`);
    }
    for (const name of createdIndexes(migration.sql)) {
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    }
    for (const { table, column } of addedColumns(migration.sql)) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
  db.pragma(`user_version = ${version}`);
  return db;
}

/**
 * A migration's SQL with comments stripped.
 *
 * Every extractor below runs over this rather than the raw text, so prose in a
 * comment can never be mistaken for DDL. That matters now that a migration can
 * carry a `-- rewind:` directive: an inverse reading "ALTER TABLE x ADD COLUMN
 * y" would otherwise be picked up by addedColumns() and promptly undone.
 */
function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ');
}

/** The inverses a migration declares for itself, as `-- rewind: <statement>`. */
function rewindDirectives(sql: string): string[] {
  return [...sql.matchAll(/--\s*rewind:\s*(.+)/gi)].map((m) => m[1].trim());
}

function createdTables(sql: string): string[] {
  return [...withoutComments(sql).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);
}

function createdTriggers(sql: string): string[] {
  return [...withoutComments(sql).matchAll(/CREATE TRIGGER (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);
}

function createdViews(sql: string): string[] {
  return [...withoutComments(sql).matchAll(/CREATE VIEW (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);
}

function createdIndexes(sql: string): string[] {
  return [...withoutComments(sql).matchAll(/CREATE(?: UNIQUE)? INDEX (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]);
}

function addedColumns(sql: string): Array<{ table: string; column: string }> {
  return [...withoutComments(sql).matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi)]
    .map((m) => ({ table: m[1], column: m[2] }));
}

/**
 * A migration that only rewrites rows (v20 is the first) creates nothing the
 * rewind above could undo, so its "old" fixture is legitimately identical to a
 * fresh database and the drift check cannot demand otherwise. This is a
 * keyword test rather than "none of the extractors matched" on purpose: DDL of
 * a kind the rewind list does not know about would also leave the fixture
 * unchanged, and that case must still fail the honesty assertion.
 */
function isDataOnly(sql: string): boolean {
  const code = sql.replace(/--[^\n]*/g, ' ');
  return !/\b(?:CREATE(?: UNIQUE)?|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b/i.test(code);
}

test('every migration is numbered above the previous one', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b), 'migrations must be ordered');
  assert.equal(new Set(versions).size, versions.length, 'migration versions must be unique');
});

test('schema.sql version is at least the newest migration', () => {
  const newest = Math.max(0, ...MIGRATIONS.map((m) => m.version));
  assert.ok(
    TARGET >= newest,
    `schema.sql is at v${TARGET} but a migration targets v${newest} — bump PRAGMA user_version`,
  );
});

test('a migrated database ends up structurally identical to a fresh one', () => {
  // This is the check that keeps schema.sql and migrations.ts from drifting:
  // the DDL for a new object is necessarily written in both places, and only a
  // comparison like this notices when they stop agreeing.
  const fresh = new Database(':memory:');
  fresh.exec(SCHEMA_SQL);

  for (const migration of MIGRATIONS) {
    const old = databaseAtVersion(migration.version - 1);
    if (!isDataOnly(migration.sql)) {
      assert.ok(
        shapeOf(old) !== shapeOf(fresh),
        `v${migration.version - 1} fixture should be missing what "${migration.description}" adds`,
      );
    }

    old.transaction(() => {
      for (const pending of MIGRATIONS.filter((m) => m.version >= migration.version)) {
        old.exec(pending.sql);
      }
      old.pragma(`user_version = ${TARGET}`);
    })();

    assert.equal(
      shapeOf(old),
      shapeOf(fresh),
      `migrating from v${migration.version - 1} does not match schema.sql — the two definitions have drifted`,
    );
    assert.equal(old.pragma('user_version', { simple: true }), TARGET);
    old.close();
  }
  fresh.close();
});

test('a failed migration rolls back completely, leaving the version untouched', () => {
  // Idempotency is deliberately *not* required: ALTER TABLE ADD COLUMN cannot
  // be re-run in SQLite, and the runner never replays a migration because it
  // filters on version. What has to hold instead is that a failure leaves no
  // partial state behind, so a retry starts from a clean database.
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const before = db.pragma('user_version', { simple: true });

  assert.throws(() => {
    db.transaction(() => {
      db.exec('ALTER TABLE oracle_cards ADD COLUMN scratch_column TEXT');
      db.exec('THIS IS NOT VALID SQL');
      db.pragma('user_version = 999');
    })();
  });

  assert.equal(db.pragma('user_version', { simple: true }), before, 'version must not advance');
  const columns = db.prepare(`SELECT name FROM pragma_table_info('oracle_cards')`).all() as Array<{ name: string }>;
  assert.ok(!columns.some((c) => c.name === 'scratch_column'), 'the partial change must be gone');
  db.close();
});

test('the runner never replays a migration the database already has', () => {
  const applied: number[] = [];
  const from = 3;
  for (const migration of MIGRATIONS.filter((m) => m.version > from && m.version <= TARGET)) {
    applied.push(migration.version);
  }
  assert.ok(!applied.includes(3), 'v3 must not re-run on a database already at v3');
  assert.ok(applied.every((v) => v > from));
});

/**
 * The v15 backfill is a SQL restatement of parseDeckCopyLimit(), so it can
 * drift from the parser in a way the structural check above cannot see. This
 * runs it over the real rules text and checks it lands on the same answers.
 */
test('the copy-limit backfill reads existing cards without a re-sync', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Rewind to just before v15: the column is what the migration adds.
  db.exec('ALTER TABLE oracle_cards DROP COLUMN deck_copy_limit');
  db.pragma('user_version = 14');

  const insert = db.prepare(`
    INSERT INTO oracle_cards (oracle_id, name, name_normalized, oracle_text_all)
    VALUES (?, ?, ?, ?)`);
  const cards: Array<[id: string, name: string, text: string, limit: number | null]> = [
    ['rats', 'Relentless Rats',
     'A deck can have any number of cards named Relentless Rats.', -1],
    ['apostle', 'Shadowborn Apostle',
     'A deck can have any number of cards named Shadowborn Apostle.\n{6}, Sacrifice six Creatures named Shadowborn Apostle: Search your library for a Demon creature card.', -1],
    ['nazgul', 'Nazgûl', 'Amass Orcs 1.\nA deck can have up to nine cards named Nazgûl.', 9],
    ['dwarves', 'Seven Dwarves', 'A deck can have up to seven cards named Seven Dwarves.', 7],
    ['champ', '1996 World Champion',
     'A deck can have only one card named 1996 World Champion.', 1],
    ['bolt', 'Lightning Bolt', 'Lightning Bolt deals 3 damage to any target.', null],
  ];
  for (const [id, name, text] of cards) insert.run(id, name, name.toLowerCase(), text);

  const v15 = MIGRATIONS.find((m) => m.version === 15);
  assert.ok(v15, 'expected a v15 migration');
  db.exec(v15.sql);

  const read = db.prepare('SELECT deck_copy_limit AS limit_ FROM oracle_cards WHERE oracle_id = ?');
  for (const [id, name, , expected] of cards) {
    const row = read.get(id) as { limit_: number | null };
    assert.equal(row.limit_, expected, `${name} should back-fill to ${expected}`);
  }
  db.close();
});

/**
 * v20 is the data half of the fix in DeckStore.update(): a deck stepped out of
 * a reserving status cancels its open pull sheet. Rows that already violated
 * that before the runtime guard existed are cancelled here, with the same
 * notes text the runtime path writes, and nothing else is touched.
 */
test('v20 cancels open pull sheets on decks that no longer reserve', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.pragma('user_version = 19');

  const deck = db.prepare('INSERT INTO decks (name, status) VALUES (?, ?)');
  const run = db.prepare(
    "INSERT INTO deck_assembly_runs (deck_id, kind, status, notes) VALUES (?, 'assemble', ?, ?)",
  );
  const seed = (name: string, deckStatus: string, runStatus: string, notes: string | null = null) => {
    const deckId = Number(deck.run(name, deckStatus).lastInsertRowid);
    return Number(run.run(deckId, runStatus, notes).lastInsertRowid);
  };
  const brewOpen = seed('Eric', 'brew', 'open');
  const disassembledOpen = seed('Torn down', 'disassembled', 'open', 'sheet started Tuesday');
  const buildingOpen = seed('In progress', 'building', 'open');
  const assembledOpen = seed('On the table', 'assembled', 'open');
  const brewDone = seed('Old brew', 'brew', 'completed');
  const brewCancelled = seed('Older brew', 'brew', 'cancelled');

  const v20 = MIGRATIONS.find((m) => m.version === 20);
  assert.ok(v20, 'expected a v20 migration');
  assert.ok(isDataOnly(v20.sql), 'v20 should be data-only');
  db.exec(v20.sql);

  const read = db.prepare(
    'SELECT status, completed_at, notes FROM deck_assembly_runs WHERE id = ?',
  );
  const after = (id: number) => read.get(id) as { status: string; completed_at: string | null; notes: string | null };

  assert.equal(after(brewOpen).status, 'cancelled');
  assert.ok(after(brewOpen).completed_at, 'a cancelled run is stamped completed_at');
  assert.equal(after(brewOpen).notes, 'Cancelled automatically: deck status changed to brew.');

  assert.equal(after(disassembledOpen).status, 'cancelled');
  assert.equal(
    after(disassembledOpen).notes,
    'Cancelled automatically: deck status changed to disassembled.',
    'the reason replaces prior notes, as cancelRun() does at runtime',
  );

  // Reserving decks keep their sheets, and finished runs are history.
  assert.equal(after(buildingOpen).status, 'open');
  assert.equal(after(assembledOpen).status, 'open');
  assert.equal(after(brewDone).status, 'completed');
  assert.equal(after(brewCancelled).status, 'cancelled');
  assert.equal(after(brewDone).completed_at, null, 'untouched rows are not re-stamped');
  db.close();
});

/**
 * v21 is Phase 17's guard against greeting an established library as new: the
 * welcome shows while welcome_seen is unset and card data exists, so an
 * install that predates the flag gets it marked seen. A library with no cards
 * yet is a fresh install mid-setup and keeps its welcome; a user who already
 * dismissed it (or asked to see it again) is not overwritten.
 */
test('v21 marks the welcome seen only on libraries that already hold card data', () => {
  const v21 = MIGRATIONS.find((m) => m.version === 21);
  assert.ok(v21, 'expected a v21 migration');
  assert.ok(isDataOnly(v21.sql), 'v21 should be data-only');

  const readFlag = (db: InstanceType<typeof Database>) =>
    (db.prepare("SELECT value FROM app_settings WHERE key = 'welcome_seen'").get() as { value: string } | undefined)?.value ?? null;

  const withCards = new Database(':memory:');
  withCards.exec(SCHEMA_SQL);
  withCards.prepare("INSERT INTO oracle_cards (oracle_id, name, name_normalized) VALUES ('bolt', 'Lightning Bolt', 'lightning bolt')").run();
  withCards.exec(v21.sql);
  assert.equal(readFlag(withCards), '1', 'an established library is not a newcomer');
  withCards.close();

  const empty = new Database(':memory:');
  empty.exec(SCHEMA_SQL);
  empty.exec(v21.sql);
  assert.equal(readFlag(empty), null, 'a library with no cards still gets its welcome after the first sync');
  empty.close();

  const reset = new Database(':memory:');
  reset.exec(SCHEMA_SQL);
  reset.prepare("INSERT INTO oracle_cards (oracle_id, name, name_normalized) VALUES ('bolt', 'Lightning Bolt', 'lightning bolt')").run();
  reset.prepare("INSERT INTO app_settings (key, value) VALUES ('welcome_seen', '0')").run();
  reset.exec(v21.sql);
  assert.equal(readFlag(reset), '0', 'an explicit value is left alone');
  reset.close();
});

test('filter_presets enforces unique names case-insensitively', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const insert = db.prepare('INSERT INTO filter_presets (name, filters) VALUES (?, ?)');
  insert.run('Commander staples', '{}');
  assert.throws(() => insert.run('commander staples', '{}'), /UNIQUE/);
  db.close();
});

/**
 * v25 is the one migration in this phase that has to compute something. The
 * rebuild to WITHOUT ROWID is mechanical, but dropping idx_legal_playable with
 * it only works because "legal anywhere" moved to a flag — so the flag has to
 * be right on a library that never re-syncs.
 */
test('v25 derives is_playable from the legality rows a library already has', () => {
  const db = databaseAtVersion(24);
  const card = db.prepare(
    'INSERT INTO oracle_cards (oracle_id, name, name_normalized, oracle_text_all) VALUES (?,?,?,\'\')');
  const legal = db.prepare('INSERT INTO card_legalities (oracle_id, format_code, legality) VALUES (?,?,?)');
  for (const id of ['legal-somewhere', 'restricted-only', 'banned-everywhere', 'never-legal', 'no-rows']) {
    card.run(id, id, id);
  }
  legal.run('legal-somewhere', 'modern', 'not_legal');
  legal.run('legal-somewhere', 'commander', 'legal');
  legal.run('restricted-only', 'vintage', 'restricted');
  legal.run('banned-everywhere', 'legacy', 'banned');
  legal.run('banned-everywhere', 'modern', 'not_legal');
  legal.run('never-legal', 'commander', 'not_legal');
  // 'no-rows' has no card_legalities at all — an Un-card or a playtest card.

  db.exec(MIGRATIONS.find((m) => m.version === 25)!.sql);

  const flag = (id: string) =>
    (db.prepare('SELECT is_playable FROM oracle_cards WHERE oracle_id = ?').get(id) as { is_playable: number }).is_playable;
  assert.equal(flag('legal-somewhere'), 1);
  assert.equal(flag('restricted-only'), 1, 'restricted is playable — it is a limit, not a ban');
  assert.equal(flag('banned-everywhere'), 0, 'banned is not playable, which is what makes is:unplayable useful');
  assert.equal(flag('never-legal'), 0);
  assert.equal(flag('no-rows'), 0, 'no legality rows at all is not playable');

  // And the rebuild really did happen, with no secondary index left behind.
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'card_legalities'").get() as { sql: string }).sql;
  assert.match(sql, /WITHOUT ROWID/i);
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='card_legalities' AND name NOT LIKE 'sqlite_%'")
    .pluck().all();
  assert.deepEqual(indexes, [], 'both secondary indexes go with the rebuild');
  db.close();
});

/**
 * v26 throws away 54MB of URLs on the strength of a template. If the template
 * is wrong for a row, that row has to keep its URLs rather than lose them —
 * which is what image_url_override is for, and what this checks.
 */
test('v26 keeps every URL it can derive and stores the ones it cannot', () => {
  const db = databaseAtVersion(25);
  db.prepare("INSERT INTO sets (code,name) VALUES ('tst','Test')").run();
  db.prepare(`INSERT INTO oracle_cards (oracle_id,name,name_normalized,oracle_text_all)
              VALUES ('o1','Card','card','')`).run();

  const id = 'a471b306-4941-4e46-a0cb-d92895c16f8a';
  const ts = 1783907750;
  const scryfall = (size: string, ext: string, side = 'front', key = id) =>
    `https://cards.scryfall.io/${size}/${side}/${key[0]}/${key[1]}/${key}.${ext}?${ts}`;

  const printing = db.prepare(`INSERT INTO card_printings
    (id,oracle_id,set_code,collector_number,image_small,image_normal,image_large,image_png,image_art_crop)
    VALUES (?,'o1','tst',?,?,?,?,?,?)`);
  // One ordinary row, one with no art, one Scryfall served from somewhere else.
  printing.run(id, '1', scryfall('small', 'jpg'), scryfall('normal', 'jpg'),
    scryfall('large', 'jpg'), scryfall('png', 'png'), scryfall('art_crop', 'jpg'));
  printing.run('dark', '2', null, null, null, null, null);
  printing.run('odd', '3', 'https://elsewhere.test/odd-small.jpg', 'https://elsewhere.test/odd-normal.jpg',
    null, null, null);

  db.exec(MIGRATIONS.find((m) => m.version === 26)!.sql);

  const row = (key: string) => db.prepare(
    'SELECT image_ts, image_url_override FROM card_printings WHERE id = ?')
    .get(key) as { image_ts: number | null; image_url_override: string | null };

  assert.equal(row(id).image_ts, ts, 'the timestamp is lifted out of the query string');
  assert.equal(row(id).image_url_override, null, 'a row that fits the template stores nothing else');

  assert.equal(row('dark').image_ts, null, 'no art stays no art');
  assert.equal(row('dark').image_url_override, null);

  assert.ok(row('odd').image_url_override, 'a URL the template does not fit is kept verbatim');
  assert.deepEqual(JSON.parse(row('odd').image_url_override!), {
    small: 'https://elsewhere.test/odd-small.jpg',
    normal: 'https://elsewhere.test/odd-normal.jpg',
    large: null, png: null, art_crop: null,
  });
  db.close();
});
