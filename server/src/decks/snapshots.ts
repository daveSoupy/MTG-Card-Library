import type Database from 'better-sqlite3';

/**
 * Deck history.
 *
 * A snapshot is a copy of the card rows, not a diff. Diffs have to be replayed
 * end to end to be read, and a deck is a hundred rows — the copy is cheaper to
 * store than the machinery to avoid storing it would be to maintain.
 *
 * Allocation is deliberately part of the snapshot: restoring a deck should put
 * back the same claim on the collection it had, or the available counts would
 * quietly shift underneath every other deck.
 */

export interface SnapshotSummary {
  id: number;
  deckId: number;
  name: string;
  note: string | null;
  createdAt: string;
  cardCount: number;
  uniqueCards: number;
}

export interface DeckDiffEntry {
  oracleId: string;
  name: string;
  board: string;
  from: number;
  to: number;
}

export interface DeckDiff {
  added: DeckDiffEntry[];
  removed: DeckDiffEntry[];
  changed: DeckDiffEntry[];
  unchanged: number;
}

export function takeSnapshot(
  db: Database.Database,
  deckId: number,
  name: string,
  note?: string | null,
): number {
  return db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO deck_snapshots (deck_id, name, note) VALUES (?, ?, ?)',
    ).run(deckId, name.trim() || 'Snapshot', note ?? null);
    const snapshotId = Number(result.lastInsertRowid);

    db.prepare(`
      INSERT INTO deck_snapshot_cards
        (snapshot_id, oracle_id, board, quantity, quantity_from_collection, category, commander_role)
      SELECT ?, oracle_id, board, quantity, quantity_from_collection, category, commander_role
      FROM deck_cards WHERE deck_id = ?`).run(snapshotId, deckId);

    return snapshotId;
  })();
}

export function listSnapshots(db: Database.Database, deckId: number): SnapshotSummary[] {
  return db.prepare(`
    SELECT s.id, s.deck_id AS deckId, s.name, s.note, s.created_at AS createdAt,
           COALESCE(SUM(CASE WHEN c.board IN ('main','command') THEN c.quantity ELSE 0 END), 0) AS cardCount,
           COUNT(c.oracle_id) AS uniqueCards
    FROM deck_snapshots s
    LEFT JOIN deck_snapshot_cards c ON c.snapshot_id = s.id
    WHERE s.deck_id = ?
    GROUP BY s.id
    ORDER BY s.created_at DESC, s.id DESC`).all(deckId) as SnapshotSummary[];
}

export function deleteSnapshot(db: Database.Database, snapshotId: number): void {
  db.prepare('DELETE FROM deck_snapshots WHERE id = ?').run(snapshotId);
}

/**
 * What changed between a snapshot and the deck as it stands.
 *
 * Keyed on card and board together, so moving a card to the sideboard reads as
 * a removal from one and an addition to the other rather than as no change.
 */
export function diffSnapshot(db: Database.Database, snapshotId: number): DeckDiff | null {
  const snapshot = db.prepare('SELECT deck_id FROM deck_snapshots WHERE id = ?')
    .get(snapshotId) as { deck_id: number } | undefined;
  if (!snapshot) return null;

  const rows = db.prepare(`
    SELECT COALESCE(s.oracle_id, d.oracle_id) AS oracleId,
           COALESCE(s.board, d.board) AS board,
           COALESCE(s.quantity, 0) AS "from",
           COALESCE(d.quantity, 0) AS "to",
           o.name
    FROM (SELECT * FROM deck_snapshot_cards WHERE snapshot_id = ?) s
    FULL OUTER JOIN (SELECT * FROM deck_cards WHERE deck_id = ?) d
      ON d.oracle_id = s.oracle_id AND d.board = s.board
    JOIN oracle_cards o ON o.oracle_id = COALESCE(s.oracle_id, d.oracle_id)
    ORDER BY o.name COLLATE NOCASE`).all(snapshotId, snapshot.deck_id) as DeckDiffEntry[];

  const diff: DeckDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const row of rows) {
    if (row.from === 0) diff.added.push(row);
    else if (row.to === 0) diff.removed.push(row);
    else if (row.from !== row.to) diff.changed.push(row);
    else diff.unchanged += 1;
  }
  return diff;
}

/**
 * Puts a deck back the way the snapshot found it.
 *
 * The current state is snapshotted first, unprompted — restoring is the one
 * action here that destroys work, and "restore, then realise" is exactly when
 * you want the thing you just replaced to still exist.
 */
export function restoreSnapshot(db: Database.Database, snapshotId: number): { deckId: number } | null {
  const snapshot = db.prepare('SELECT id, deck_id, name FROM deck_snapshots WHERE id = ?')
    .get(snapshotId) as { id: number; deck_id: number; name: string } | undefined;
  if (!snapshot) return null;

  return db.transaction(() => {
    takeSnapshot(db, snapshot.deck_id, 'Before restore', `Automatic, replaced by "${snapshot.name}"`);

    db.prepare('DELETE FROM deck_cards WHERE deck_id = ?').run(snapshot.deck_id);
    db.prepare(`
      INSERT INTO deck_cards
        (deck_id, oracle_id, board, quantity, quantity_from_collection, category, commander_role)
      SELECT ?, oracle_id, board, quantity, quantity_from_collection, category, commander_role
      FROM deck_snapshot_cards WHERE snapshot_id = ?`).run(snapshot.deck_id, snapshotId);

    db.prepare(`UPDATE decks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(snapshot.deck_id);

    return { deckId: snapshot.deck_id };
  })();
}
