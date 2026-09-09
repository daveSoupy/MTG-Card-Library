import type Database from 'better-sqlite3';

/**
 * Events and the game log.
 *
 * An event is a night out — a draft, a prerelease, a sealed pool — and holds no
 * data of its own beyond a name, a format and a date. What makes it useful is
 * the two links: the cost pool that bought the cards (`import_batches`) and the
 * deck built from them (`decks`). Spend and the card list are read back through
 * those links on every request, never copied onto the event, so editing the
 * pool or the deck can never leave the event describing something that is no
 * longer true.
 *
 * Games are the other half. Most games belong to no event at all — a
 * constructed game at the kitchen table is just a deck, an opponent and a
 * result — so the record views here aggregate `games` by deck first and by
 * event second.
 */

/**
 * Setting key: when '1', the Games tab and the deck builder's Games button
 * appear. Off by default — the feature is complete but parked, and hiding it
 * is a UI decision only: the routes stay registered, and every event and game
 * already recorded is still there when it is switched back on.
 */
export const SHOW_GAME_LOG = 'show_game_log';

export type GameResult = 'win' | 'loss' | 'draw';
export const GAME_RESULTS: GameResult[] = ['win', 'loss', 'draw'];

export class EventNotFoundError extends Error {
  constructor(id: number) { super(`No event with id ${id}.`); this.name = 'EventNotFoundError'; }
}
export class GameNotFoundError extends Error {
  constructor(id: number) { super(`No game with id ${id}.`); this.name = 'GameNotFoundError'; }
}

/** Match wins/losses/draws, the "12–4" a deck or an event is quoted as. */
export interface MatchRecord {
  wins: number;
  losses: number;
  draws: number;
  games: number;
}

export interface EventInput {
  name: string;
  formatCode?: string | null;
  eventDate?: string | null;
  deckId?: number | null;
  importBatchId?: number | null;
  notes?: string | null;
}

/** Every field of an event is editable; anything omitted is left alone. */
export type EventUpdate = Partial<EventInput>;

export interface EventSummary {
  id: number;
  name: string;
  formatCode: string | null;
  formatName: string | null;
  eventDate: string | null;
  notes: string | null;
  deckId: number | null;
  deckName: string | null;
  importBatchId: number | null;
  /** The linked cost pool's lump sum. Phase 13's entry fee joins it here. */
  spendUsd: number | null;
  /** Copies the linked pool holds — the cards actually acquired that night. */
  poolCardCount: number;
  /** Cards in the linked deck's played boards. */
  deckCardCount: number;
  record: MatchRecord;
  createdAt: string;
  updatedAt: string;
}

export interface GameRow {
  id: number;
  eventId: number | null;
  eventName: string | null;
  /** Null once the deck has been deleted; the game itself survives. */
  deckId: number | null;
  /** The live deck's name, or the one kept from it when it was deleted. */
  deckName: string | null;
  /** Null for a detached game — the format lived on the deck. */
  formatCode: string | null;
  playedAt: string;
  opponents: string | null;
  result: GameResult;
  gamesWon: number | null;
  gamesLost: number | null;
  gamesDrawn: number | null;
  roundNumber: number | null;
  notes: string | null;
}

export interface GameInput {
  deckId: number;
  eventId?: number | null;
  playedAt?: string | null;
  opponents?: string | null;
  result: GameResult;
  gamesWon?: number | null;
  gamesLost?: number | null;
  gamesDrawn?: number | null;
  roundNumber?: number | null;
  notes?: string | null;
}

export type GameUpdate = Partial<Omit<GameInput, 'deckId'>> & { deckId?: number };

/** What a record view narrows by. Every field is independent and optional. */
export interface GameFilters {
  deckId?: number;
  eventId?: number;
  /**
   * The deck's format. A game whose deck has been deleted has no format to
   * match any more, so it drops out of a format-narrowed view while still
   * counting in the unnarrowed one.
   */
  formatCode?: string;
  /** 'YYYY-MM-DD', inclusive, compared against the date part of played_at. */
  from?: string;
  to?: string;
  limit?: number;
}

const EMPTY_RECORD: MatchRecord = { wins: 0, losses: 0, draws: 0, games: 0 };

export class EventStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // -- events ----------------------------------------------------------------

  list(): EventSummary[] {
    const rows = this.db.prepare(`${EVENT_SELECT}
      ORDER BY COALESCE(e.event_date, substr(e.created_at, 1, 10)) DESC, e.id DESC`).all() as any[];
    return rows.map(toEventSummary);
  }

  get(id: number): (EventSummary & { games: GameRow[] }) | null {
    const row = this.db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id) as any;
    if (!row) return null;
    return { ...toEventSummary(row), games: this.games({ eventId: id }) };
  }

  create(input: EventInput): number {
    const result = this.db.prepare(`
      INSERT INTO events (name, format_code, event_date, deck_id, import_batch_id, notes)
      VALUES (?,?,?,?,?,?)`)
      .run(input.name.trim(), input.formatCode ?? null, input.eventDate ?? null,
           input.deckId ?? null, input.importBatchId ?? null, input.notes ?? null);
    return Number(result.lastInsertRowid);
  }

  update(id: number, changes: EventUpdate): void {
    const columns: Array<[keyof EventUpdate, string]> = [
      ['name', 'name'], ['formatCode', 'format_code'], ['eventDate', 'event_date'],
      ['deckId', 'deck_id'], ['importBatchId', 'import_batch_id'], ['notes', 'notes'],
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of columns) {
      if (changes[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(key === 'name' ? String(changes.name).trim() : changes[key]);
    }
    if (sets.length === 0) return;

    sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    const result = this.db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
    if (result.changes === 0) throw new EventNotFoundError(id);
  }

  /**
   * Deletes the event only.
   *
   * Its games survive with `event_id` set to NULL rather than disappearing: the
   * games were played whatever happened to the record of the night, and they
   * still count toward their deck's lifetime record.
   */
  delete(id: number): void {
    const result = this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    if (result.changes === 0) throw new EventNotFoundError(id);
  }

  // -- games -----------------------------------------------------------------

  games(filters: GameFilters = {}): GameRow[] {
    const { where, params } = this.gameWhere(filters);
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 500;

    // One event reads as a night: round 1 at the top, in the order it was
    // played. Everywhere else reads as a log: the most recent game first.
    // Rounds are only meaningful inside an event, so unnumbered games sort
    // last there rather than pretending to be round 0.
    const order = filters.eventId !== undefined
      ? `ORDER BY COALESCE(g.round_number, 2147483647) ASC, g.played_at ASC, g.id ASC`
      : `ORDER BY g.played_at DESC, COALESCE(g.round_number, 0) DESC, g.id DESC`;

    return (this.db.prepare(`
      SELECT g.id, g.event_id, g.deck_id, g.played_at, g.opponents, g.result,
             g.games_won, g.games_lost, g.games_drawn, g.round_number, g.notes,
             -- The deck's own name while it has one, the copy kept on the game
             -- once it does not. Reading it in this order is what makes a
             -- rename show up on games already logged.
             COALESCE(d.name, g.deck_name) AS deck_name,
             d.format_code, e.name AS event_name
      FROM games g
      LEFT JOIN decks d  ON d.id = g.deck_id
      LEFT JOIN events e ON e.id = g.event_id
      ${where}
      ${order}
      LIMIT ?`).all(...params, limit) as any[]).map(toGameRow);
  }

  /** One game, in the same shape the list returns. */
  getGame(id: number): GameRow | null {
    const row = this.db.prepare(`
      SELECT g.id, g.event_id, g.deck_id, g.played_at, g.opponents, g.result,
             g.games_won, g.games_lost, g.games_drawn, g.round_number, g.notes,
             COALESCE(d.name, g.deck_name) AS deck_name,
             d.format_code, e.name AS event_name
      FROM games g
      LEFT JOIN decks d  ON d.id = g.deck_id
      LEFT JOIN events e ON e.id = g.event_id
      WHERE g.id = ?`).get(id) as any;
    return row ? toGameRow(row) : null;
  }

  /** Wins/losses/draws over whatever the same filters select. */
  record(filters: GameFilters = {}): MatchRecord {
    const { where, params } = this.gameWhere(filters);
    const row = this.db.prepare(`
      SELECT SUM(g.result = 'win')  AS wins,
             SUM(g.result = 'loss') AS losses,
             SUM(g.result = 'draw') AS draws,
             COUNT(*)               AS games
      FROM games g
      LEFT JOIN decks d ON d.id = g.deck_id
      ${where}`).get(...params) as any;

    return row?.games
      ? { wins: row.wins ?? 0, losses: row.losses ?? 0, draws: row.draws ?? 0, games: row.games }
      : { ...EMPTY_RECORD };
  }

  logGame(input: GameInput): number {
    const deck = this.db.prepare('SELECT id FROM decks WHERE id = ?').get(input.deckId);
    if (!deck) throw new Error(`No deck with id ${input.deckId}.`);

    const result = this.db.prepare(`
      INSERT INTO games (deck_id, event_id, played_at, opponents, result,
                         games_won, games_lost, games_drawn, round_number, notes)
      VALUES (?,?,COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')),?,?,?,?,?,?,?)`)
      .run(input.deckId, input.eventId ?? null, input.playedAt ?? null,
           normalizeOpponents(input.opponents), input.result,
           input.gamesWon ?? null, input.gamesLost ?? null, input.gamesDrawn ?? null,
           input.roundNumber ?? null, input.notes ?? null);
    return Number(result.lastInsertRowid);
  }

  updateGame(id: number, changes: GameUpdate): void {
    const columns: Array<[keyof GameUpdate, string]> = [
      ['deckId', 'deck_id'], ['eventId', 'event_id'], ['playedAt', 'played_at'],
      ['opponents', 'opponents'], ['result', 'result'], ['gamesWon', 'games_won'],
      ['gamesLost', 'games_lost'], ['gamesDrawn', 'games_drawn'],
      ['roundNumber', 'round_number'], ['notes', 'notes'],
    ];
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of columns) {
      if (changes[key] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(key === 'opponents' ? normalizeOpponents(changes.opponents) : changes[key]);
    }
    if (sets.length === 0) return;

    const result = this.db.prepare(`UPDATE games SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
    if (result.changes === 0) throw new GameNotFoundError(id);
  }

  deleteGame(id: number): void {
    const result = this.db.prepare('DELETE FROM games WHERE id = ?').run(id);
    if (result.changes === 0) throw new GameNotFoundError(id);
  }

  /** The filter clause shared by the game list and the record aggregate. */
  private gameWhere(filters: GameFilters): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.deckId !== undefined) { clauses.push('g.deck_id = ?'); params.push(filters.deckId); }
    if (filters.eventId !== undefined) { clauses.push('g.event_id = ?'); params.push(filters.eventId); }
    if (filters.formatCode) { clauses.push('d.format_code = ?'); params.push(filters.formatCode); }
    // played_at is a timestamp and the filters are dates, so both ends compare
    // on the date part — a game logged at 21:40 belongs to that day, not the
    // day after the range ends.
    if (filters.from) { clauses.push('substr(g.played_at, 1, 10) >= ?'); params.push(filters.from); }
    if (filters.to) { clauses.push('substr(g.played_at, 1, 10) <= ?'); params.push(filters.to); }

    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }
}

/**
 * Everything an event summary needs, derived rather than stored.
 *
 * The three correlated subqueries are one row each against indexed ids, and
 * the alternative — carrying spend and counts on the event row — is the thing
 * that goes stale the first time a pool's total is edited.
 */
const EVENT_SELECT = `
  SELECT e.*,
         f.display_name AS format_name,
         d.name         AS deck_name,
         b.total_cost_usd AS spend_usd,
         (SELECT COALESCE(SUM(ci.quantity), 0) FROM collection_items ci
           WHERE ci.import_batch_id = e.import_batch_id)          AS pool_card_count,
         (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc
           WHERE dc.deck_id = e.deck_id
             AND dc.board IN ('main','side','command'))           AS deck_card_count,
         (SELECT COUNT(*) FROM games g WHERE g.event_id = e.id)              AS games,
         (SELECT COUNT(*) FROM games g WHERE g.event_id = e.id AND g.result = 'win')  AS wins,
         (SELECT COUNT(*) FROM games g WHERE g.event_id = e.id AND g.result = 'loss') AS losses,
         (SELECT COUNT(*) FROM games g WHERE g.event_id = e.id AND g.result = 'draw') AS draws
  FROM events e
  LEFT JOIN formats f       ON f.code = e.format_code
  LEFT JOIN decks d         ON d.id   = e.deck_id
  LEFT JOIN import_batches b ON b.id  = e.import_batch_id`;

function toEventSummary(row: any): EventSummary {
  return {
    id: row.id,
    name: row.name,
    formatCode: row.format_code ?? null,
    formatName: row.format_name ?? null,
    eventDate: row.event_date ?? null,
    notes: row.notes ?? null,
    deckId: row.deck_id ?? null,
    deckName: row.deck_name ?? null,
    importBatchId: row.import_batch_id ?? null,
    spendUsd: row.spend_usd ?? null,
    poolCardCount: row.pool_card_count ?? 0,
    deckCardCount: row.deck_card_count ?? 0,
    record: { wins: row.wins ?? 0, losses: row.losses ?? 0, draws: row.draws ?? 0, games: row.games ?? 0 },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGameRow(row: any): GameRow {
  return {
    id: row.id,
    eventId: row.event_id ?? null,
    eventName: row.event_name ?? null,
    deckId: row.deck_id ?? null,
    deckName: row.deck_name ?? null,
    formatCode: row.format_code ?? null,
    playedAt: row.played_at,
    opponents: row.opponents ?? null,
    result: row.result as GameResult,
    gamesWon: row.games_won ?? null,
    gamesLost: row.games_lost ?? null,
    gamesDrawn: row.games_drawn ?? null,
    roundNumber: row.round_number ?? null,
    notes: row.notes ?? null,
  };
}

/**
 * Opponents are one freeform field holding a comma-separated pod, the same
 * convention trade counterparties use. Tidied on the way in — "Dave,  Sam ,"
 * becomes "Dave, Sam" — so a pod reads the same however it was typed, and one
 * game with three opponents is still exactly one row.
 */
function normalizeOpponents(value: string | null | undefined): string | null {
  if (value == null) return null;
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  return names.length > 0 ? names.join(', ') : null;
}
