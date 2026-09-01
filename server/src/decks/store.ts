import type Database from 'better-sqlite3';
import { validateDeck } from './validate.ts';
import { deckStats } from './stats.ts';
import type {
  Board, CommanderRole, Deck, DeckCard, DeckStats, DeckValidation, DeckWithCards, FormatRules,
} from './types.ts';

export class DeckNotFoundError extends Error {
  constructor(id: number) {
    super(`No deck with id ${id}.`);
    this.name = 'DeckNotFoundError';
  }
}

export interface DeckSummary extends Deck {
  cardCount: number;
  uniqueCards: number;
  colorIdentity: string;
  commanderNames: string[];
  formatName: string | null;
}

/**
 * Reads and writes decks.
 *
 * Validation and stats are computed on read rather than stored, for the same
 * reason allocation is: a deck's legality depends on the card database and on
 * what other decks claim, both of which change underneath it.
 */
export class DeckStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // -- formats ---------------------------------------------------------------

  formatRules(code: string | null): FormatRules | null {
    if (!code) return null;
    const row = this.db.prepare('SELECT * FROM formats WHERE code = ?').get(code) as any;
    if (!row) return null;
    return {
      code: row.code,
      displayName: row.display_name,
      minDeckSize: row.min_deck_size,
      exactDeckSize: row.exact_deck_size,
      maxCopies: row.max_copies,
      basicsExempt: Boolean(row.basics_exempt),
      isSingleton: Boolean(row.is_singleton),
      sideboardSize: row.sideboard_size,
      requiresCommander: Boolean(row.requires_commander),
      enforcesColorIdentity: Boolean(row.enforces_color_id),
    };
  }

  // -- deck CRUD -------------------------------------------------------------

  list(): DeckSummary[] {
    const rows = this.db.prepare(`
      SELECT d.*, f.display_name AS format_name,
             COALESCE(counts.card_count, 0) AS card_count,
             COALESCE(counts.unique_cards, 0) AS unique_cards,
             COALESCE(counts.identity_mask, 0) AS identity_mask
      FROM decks d
      LEFT JOIN formats f ON f.code = d.format_code
      LEFT JOIN (
          SELECT dc.deck_id,
                 SUM(CASE WHEN dc.board IN ('main','command') THEN dc.quantity ELSE 0 END) AS card_count,
                 COUNT(DISTINCT dc.oracle_id) AS unique_cards,
                 -- Bitwise OR across the deck gives its combined colour identity.
                 SUM(DISTINCT o.color_identity_mask & 1)
                   | SUM(DISTINCT o.color_identity_mask & 2)
                   | SUM(DISTINCT o.color_identity_mask & 4)
                   | SUM(DISTINCT o.color_identity_mask & 8)
                   | SUM(DISTINCT o.color_identity_mask & 16) AS identity_mask
          FROM deck_cards dc
          JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
          WHERE dc.board <> 'maybe'
          GROUP BY dc.deck_id
      ) counts ON counts.deck_id = d.id
      ORDER BY d.is_archived, d.sort_order, d.updated_at DESC`).all() as any[];

    const commanders = this.db.prepare(`
      SELECT dc.deck_id, o.name FROM deck_cards dc
      JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
      WHERE dc.board = 'command' ORDER BY dc.sort_order`).all() as any[];

    const byDeck = new Map<number, string[]>();
    for (const row of commanders) {
      byDeck.set(row.deck_id, [...(byDeck.get(row.deck_id) ?? []), row.name]);
    }

    return rows.map((row) => ({
      ...toDeck(row),
      formatName: row.format_name ?? null,
      cardCount: row.card_count,
      uniqueCards: row.unique_cards,
      colorIdentity: maskToColors(row.identity_mask),
      commanderNames: byDeck.get(row.id) ?? [],
    }));
  }

  get(id: number): (DeckWithCards & { validation: DeckValidation; stats: DeckStats }) | null {
    const row = this.db.prepare('SELECT * FROM decks WHERE id = ?').get(id) as any;
    if (!row) return null;

    const deck = toDeck(row);
    const cards = this.cardsFor(id, deck.formatCode);
    const rules = this.formatRules(deck.formatCode);

    return {
      ...deck,
      cards,
      validation: validateDeck(cards, rules),
      stats: deckStats(cards),
    };
  }

  private cardsFor(deckId: number, formatCode: string | null): DeckCard[] {
    // availableQuantity deliberately excludes this deck's own claim, so the
    // number reads as "copies other decks are not already using".
    const rows = this.db.prepare(`
      SELECT dc.id, dc.oracle_id, dc.board, dc.quantity, dc.quantity_from_collection,
             dc.commander_role, dc.category, dc.sort_order,
             o.name, o.cmc, o.type_line, o.mana_cost, o.color_identity,
             o.color_identity_mask, o.colors_mask, o.is_basic_land, o.is_legendary,
             o.can_be_commander,
             cl.legality,
             COALESCE(owned.qty, 0) AS owned_qty,
             COALESCE(owned.qty, 0)
               - COALESCE(claimed.qty, 0)
               + COALESCE(mine.qty, 0) AS available_qty,
             dp.id AS printing_id, dp.set_code, dp.price_usd,
             COALESCE(dp.image_small, ff.image_small) AS image_small
      FROM deck_cards dc
      JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
      LEFT JOIN card_printings dp ON dp.id = COALESCE(dc.preferred_printing_id, o.default_printing_id)
      LEFT JOIN card_faces ff ON ff.printing_id = dp.id AND ff.face_index = 0
      LEFT JOIN card_legalities cl ON cl.oracle_id = dc.oracle_id AND cl.format_code = ?
      LEFT JOIN (
          SELECT p.oracle_id, SUM(ci.quantity) AS qty
          FROM collection_items ci JOIN card_printings p ON p.id = ci.printing_id
          GROUP BY p.oracle_id
      ) owned ON owned.oracle_id = dc.oracle_id
      LEFT JOIN (
          SELECT oracle_id, SUM(quantity_from_collection) AS qty FROM deck_cards
          WHERE board IN ('main','side','command') GROUP BY oracle_id
      ) claimed ON claimed.oracle_id = dc.oracle_id
      LEFT JOIN (
          SELECT oracle_id, SUM(quantity_from_collection) AS qty FROM deck_cards
          WHERE deck_id = ? AND board IN ('main','side','command') GROUP BY oracle_id
      ) mine ON mine.oracle_id = dc.oracle_id
      WHERE dc.deck_id = ?
      ORDER BY dc.board, o.cmc, o.name COLLATE NOCASE`).all(formatCode, deckId, deckId) as any[];

    return rows.map((row) => ({
      id: row.id,
      oracleId: row.oracle_id,
      name: row.name,
      board: row.board as Board,
      quantity: row.quantity,
      quantityFromCollection: row.quantity_from_collection,
      commanderRole: row.commander_role as CommanderRole | null,
      category: row.category,
      sortOrder: row.sort_order,
      cmc: row.cmc,
      typeLine: row.type_line ?? '',
      manaCost: row.mana_cost,
      colorIdentity: row.color_identity ?? '',
      colorIdentityMask: row.color_identity_mask ?? 0,
      colorsMask: row.colors_mask ?? 0,
      isBasicLand: Boolean(row.is_basic_land),
      isLegendary: Boolean(row.is_legendary),
      canBeCommander: Boolean(row.can_be_commander),
      legality: row.legality ?? null,
      ownedQuantity: row.owned_qty,
      availableQuantity: row.available_qty,
      printingId: row.printing_id,
      setCode: row.set_code,
      imageSmall: row.image_small,
      priceUsd: row.price_usd,
    }));
  }

  create(input: { name: string; formatCode?: string | null; description?: string | null }): number {
    const result = this.db.prepare(
      `INSERT INTO decks (name, format_code, description) VALUES (?,?,?)`,
    ).run(input.name.trim() || 'Untitled deck', input.formatCode ?? null, input.description ?? null);
    return Number(result.lastInsertRowid);
  }

  update(
    id: number,
    changes: { name?: string; formatCode?: string | null; description?: string | null; notes?: string | null; isArchived?: boolean },
  ): void {
    const existing = this.db.prepare('SELECT id FROM decks WHERE id = ?').get(id);
    if (!existing) throw new DeckNotFoundError(id);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name.trim() || 'Untitled deck'); }
    if (changes.formatCode !== undefined) { sets.push('format_code = ?'); params.push(changes.formatCode); }
    if (changes.description !== undefined) { sets.push('description = ?'); params.push(changes.description); }
    if (changes.notes !== undefined) { sets.push('notes = ?'); params.push(changes.notes); }
    if (changes.isArchived !== undefined) { sets.push('is_archived = ?'); params.push(changes.isArchived ? 1 : 0); }
    if (sets.length === 0) return;

    sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    this.db.prepare(`UPDATE decks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  /** Copies the deck and every slot, including how much each claims. */
  duplicate(id: number, newName?: string): number {
    const source = this.db.prepare('SELECT * FROM decks WHERE id = ?').get(id) as any;
    if (!source) throw new DeckNotFoundError(id);

    return this.db.transaction(() => {
      const created = this.db.prepare(`
        INSERT INTO decks (name, format_code, home_location_id, description, notes)
        VALUES (?,?,?,?,?)`)
        .run(newName?.trim() || `${source.name} copy`, source.format_code,
             source.home_location_id, source.description, source.notes);
      const newId = Number(created.lastInsertRowid);

      this.db.prepare(`
        INSERT INTO deck_cards
          (deck_id, oracle_id, board, quantity, quantity_from_collection,
           preferred_printing_id, commander_role, category, sort_order)
        SELECT ?, oracle_id, board, quantity, quantity_from_collection,
               preferred_printing_id, commander_role, category, sort_order
        FROM deck_cards WHERE deck_id = ?`).run(newId, id);

      return newId;
    })();
  }

  /**
   * Deleting a deck releases its allocation, because `deck_cards` cascades and
   * availability is computed rather than stored. No fix-up pass exists, by
   * design — see CLAUDE.md's allocation-tracking rules.
   */
  delete(id: number): void {
    const result = this.db.prepare('DELETE FROM decks WHERE id = ?').run(id);
    if (result.changes === 0) throw new DeckNotFoundError(id);
  }

  // -- card slots ------------------------------------------------------------

  /**
   * Adds copies, merging into the existing slot on that board.
   *
   * `fromCollection` defaults to whatever is actually free, so adding a card
   * you own claims it automatically and adding one you do not leaves it as
   * "need to buy" — the default CLAUDE.md asks for.
   */
  addCard(
    deckId: number,
    oracleId: string,
    options: { board?: Board; quantity?: number; fromCollection?: number } = {},
  ): void {
    const deck = this.db.prepare('SELECT id FROM decks WHERE id = ?').get(deckId);
    if (!deck) throw new DeckNotFoundError(deckId);

    const board = options.board ?? 'main';
    const quantity = Math.max(1, options.quantity ?? 1);

    this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id, quantity, quantity_from_collection FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND board = ?',
      ).get(deckId, oracleId, board) as any;

      const free = this.availableFor(oracleId, deckId);
      const alreadyClaimed = existing?.quantity_from_collection ?? 0;
      const claimable = Math.max(0, Math.min(quantity, free - alreadyClaimed));
      const fromCollection = options.fromCollection ?? claimable;

      if (existing) {
        this.db.prepare(
          'UPDATE deck_cards SET quantity = ?, quantity_from_collection = ? WHERE id = ?',
        ).run(existing.quantity + quantity,
              Math.min(existing.quantity + quantity, alreadyClaimed + fromCollection),
              existing.id);
      } else {
        this.db.prepare(`
          INSERT INTO deck_cards (deck_id, oracle_id, board, quantity, quantity_from_collection)
          VALUES (?,?,?,?,?)`)
          .run(deckId, oracleId, board, quantity, Math.min(quantity, fromCollection));
      }
      this.touch(deckId);
    })();
  }

  /** Sets an exact quantity; 0 removes the slot. */
  setQuantity(deckId: number, cardId: number, quantity: number): void {
    this.db.transaction(() => {
      if (quantity <= 0) {
        this.db.prepare('DELETE FROM deck_cards WHERE id = ? AND deck_id = ?').run(cardId, deckId);
      } else {
        // quantity_from_collection may never exceed quantity — the schema has a
        // CHECK for it, so clamp rather than letting the write fail.
        this.db.prepare(`
          UPDATE deck_cards
             SET quantity = ?,
                 quantity_from_collection = MIN(quantity_from_collection, ?)
           WHERE id = ? AND deck_id = ?`).run(quantity, quantity, cardId, deckId);
      }
      this.touch(deckId);
    })();
  }

  setFromCollection(deckId: number, cardId: number, fromCollection: number): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE deck_cards
           SET quantity_from_collection = MAX(0, MIN(quantity, ?))
         WHERE id = ? AND deck_id = ?`).run(fromCollection, cardId, deckId);
      this.touch(deckId);
    })();
  }

  /** Moves a slot between main, sideboard, command zone and maybeboard. */
  setBoard(deckId: number, cardId: number, board: Board, commanderRole?: CommanderRole | null): void {
    this.db.transaction(() => {
      const card = this.db.prepare(
        'SELECT oracle_id, quantity FROM deck_cards WHERE id = ? AND deck_id = ?',
      ).get(cardId, deckId) as any;
      if (!card) return;

      // A slot already on the target board would collide with the unique key,
      // so merge into it instead of failing.
      const collision = this.db.prepare(
        'SELECT id, quantity FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND board = ? AND id <> ?',
      ).get(deckId, card.oracle_id, board, cardId) as any;

      if (collision) {
        this.db.prepare('UPDATE deck_cards SET quantity = ? WHERE id = ?')
          .run(collision.quantity + card.quantity, collision.id);
        this.db.prepare('DELETE FROM deck_cards WHERE id = ?').run(cardId);
      } else {
        this.db.prepare('UPDATE deck_cards SET board = ?, commander_role = ? WHERE id = ?')
          .run(board, board === 'command' ? (commanderRole ?? 'commander') : null, cardId);
      }
      this.touch(deckId);
    })();
  }

  removeCard(deckId: number, cardId: number): void {
    this.db.prepare('DELETE FROM deck_cards WHERE id = ? AND deck_id = ?').run(cardId, deckId);
    this.touch(deckId);
  }

  /** Copies of a card no other deck is already claiming. */
  private availableFor(oracleId: string, excludingDeckId: number): number {
    const row = this.db.prepare(`
      SELECT COALESCE((SELECT SUM(ci.quantity) FROM collection_items ci
                       JOIN card_printings p ON p.id = ci.printing_id
                       WHERE p.oracle_id = ?), 0)
           - COALESCE((SELECT SUM(quantity_from_collection) FROM deck_cards
                       WHERE oracle_id = ? AND deck_id <> ?
                         AND board IN ('main','side','command')), 0) AS free`)
      .get(oracleId, oracleId, excludingDeckId) as { free: number };
    return Math.max(0, row.free);
  }

  private touch(deckId: number): void {
    this.db.prepare(`UPDATE decks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(deckId);
  }
}

function toDeck(row: any): Deck {
  return {
    id: row.id,
    name: row.name,
    formatCode: row.format_code,
    homeLocationId: row.home_location_id,
    description: row.description,
    notes: row.notes,
    isArchived: Boolean(row.is_archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maskToColors(mask: number): string {
  return ['W', 'U', 'B', 'R', 'G'].filter((_, i) => mask & (1 << i)).join('');
}
