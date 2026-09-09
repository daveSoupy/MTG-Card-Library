import type Database from 'better-sqlite3';
import { validateDeck, canLeadDeck, isSignatureSpell, pairingIsLegal } from './validate.ts';
import { deckStats } from './stats.ts';
import { analyseManaBase } from './manabase.ts';
import type { ManaBase } from './manabase.ts';
import { planBasics, type BasicLand } from './lands.ts';
import { loadTemplate, computeTemplateProgress, type TemplateProgress } from './templates.ts';
import { getSetting } from '../db/index.ts';
import { CollectionStore } from '../collection/store.ts';
import { hasCardCategories } from '../sync/categories.ts';
import { normalizeCategoryInput, parseCategoryList } from './categories.ts';
import { isLimitedFormat } from '../model/mtg.ts';
import type { Color } from '../model/mtg.ts';
import type {
  Board, CommanderRole, Deck, DeckCard, DeckStats, DeckValidation, DeckWithCards, FormatRules,
} from './types.ts';

/** Setting key: when '1', basics are kept in step with the deck automatically. */
export const AUTO_MAINTAIN_LANDS = 'auto_maintain_lands';

/** Live land maintenance stays out of the way until a deck has real spells. */
const MIN_CARDS_FOR_AUTO_LANDS = 10;

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
  tags: string[];
  /** Explicit if one was chosen, otherwise worked out from the contents. */
  coverPrintingId: string | null;
}

/** The deck fields the limited-format acquisition path reads. */
interface LimitedDeckRow {
  id: number;
  format_code: string | null;
  home_location_id: number | null;
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
  /** Built on first use by the limited-deck path — see collection(). */
  private collectionStore: CollectionStore | null = null;

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
      commanderKind: (row.commander_kind ?? 'legendary') as FormatRules['commanderKind'],
      usesSignatureSpell: Boolean(row.uses_signature_spell),
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

    const tags = new Map<number, string[]>();
    for (const row of this.db.prepare(
      'SELECT deck_id, tag FROM deck_tags ORDER BY tag COLLATE NOCASE',
    ).all() as any[]) {
      tags.set(row.deck_id, [...(tags.get(row.deck_id) ?? []), row.tag]);
    }

    const covers = this.coverPrintings(rows.map((r) => r.id));

    return rows.map((row) => ({
      ...toDeck(row),
      formatName: row.format_name ?? null,
      cardCount: row.card_count,
      uniqueCards: row.unique_cards,
      colorIdentity: maskToColors(row.identity_mask),
      commanderNames: byDeck.get(row.id) ?? [],
      tags: tags.get(row.id) ?? [],
      coverPrintingId: covers.get(row.id) ?? null,
    }));
  }

  get(id: number): (DeckWithCards & {
    validation: DeckValidation;
    stats: DeckStats;
    manaBase: ManaBase;
    templateProgress: TemplateProgress | null;
  }) | null {
    const row = this.db.prepare('SELECT * FROM decks WHERE id = ?').get(id) as any;
    if (!row) return null;

    const deck = toDeck(row);
    const cards = this.cardsFor(id, deck.formatCode);
    const rules = this.formatRules(deck.formatCode);
    const template = deck.templateId ? loadTemplate(this.db, deck.templateId) : null;

    return {
      ...deck,
      cards,
      validation: validateDeck(cards, rules),
      stats: deckStats(cards),
      manaBase: analyseManaBase(cards),
      templateProgress: template
        ? computeTemplateProgress(cards, template, hasCardCategories(this.db))
        : null,
    };
  }

  private cardsFor(deckId: number, formatCode: string | null): DeckCard[] {
    // Draft and sealed have no published legalities, so the join is deliberately
    // given no format to match: every card comes back with a NULL legality
    // rather than a missing row that later reads as "not legal here".
    const legalityFormat = isLimitedFormat(formatCode) ? null : formatCode;

    // availableQuantity deliberately excludes this deck's own claim, so the
    // number reads as "copies other decks are not already using".
    const rows = this.db.prepare(`
      SELECT dc.id, dc.oracle_id, dc.board, dc.quantity, dc.quantity_from_collection,
             dc.commander_role, dc.category, dc.sort_order,
             o.name, o.cmc, o.type_line, o.mana_cost, o.color_identity,
             o.color_identity_mask, o.colors_mask, o.is_basic_land, o.is_legendary,
             o.can_be_commander, o.partner_kind, o.partner_with, o.produced_mana,
             o.has_uncommon_printing, o.deck_copy_limit,
             cl.legality,
             COALESCE(owned.qty, 0) AS owned_qty,
             COALESCE(owned.qty, 0)
               - COALESCE(claimed.qty, 0)
               + COALESCE(mine.qty, 0) AS available_qty,
             dp.id AS printing_id, dp.set_code, dp.rarity, dp.price_usd,
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
      -- Inside the command zone the leader comes first and Oathbreaker's
      -- signature spell last; elsewhere commander_role is NULL, so every card
      -- falls into the same bucket and the old cmc/name order is unchanged.
      ORDER BY dc.board,
               CASE dc.commander_role
                 WHEN 'commander' THEN 0
                 WHEN 'partner' THEN 1
                 WHEN 'background' THEN 1
                 WHEN 'signature_spell' THEN 2
                 ELSE 3 END,
               o.cmc, o.name COLLATE NOCASE`).all(legalityFormat, deckId, deckId) as any[];

    const categories = this.categoriesByOracle(rows.map((r) => r.oracle_id));

    return rows.map((row) => ({
      id: row.id,
      oracleId: row.oracle_id,
      name: row.name,
      board: row.board as Board,
      quantity: row.quantity,
      quantityFromCollection: row.quantity_from_collection,
      commanderRole: row.commander_role as CommanderRole | null,
      category: row.category,
      categories: categories.get(row.oracle_id) ?? [],
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
      hasUncommonPrinting: Boolean(row.has_uncommon_printing),
      producedMana: parseJsonArray(row.produced_mana),
      partnerKind: row.partner_kind,
      partnerWith: row.partner_with,
      legality: row.legality ?? null,
      deckCopyLimit: row.deck_copy_limit ?? null,
      ownedQuantity: row.owned_qty,
      availableQuantity: row.available_qty,
      printingId: row.printing_id,
      setCode: row.set_code,
      rarity: row.rarity,
      imageSmall: row.image_small,
      priceUsd: row.price_usd,
    }));
  }

  /** Phase 7: card_categories rows for a set of oracle ids, grouped for attaching to deck cards. */
  private categoriesByOracle(oracleIds: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    if (oracleIds.length === 0) return map;
    const unique = [...new Set(oracleIds)];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT oracle_id, category FROM card_categories WHERE oracle_id IN (${placeholders})`,
    ).all(...unique) as Array<{ oracle_id: string; category: string }>;
    for (const row of rows) {
      map.set(row.oracle_id, [...(map.get(row.oracle_id) ?? []), row.category]);
    }
    return map;
  }

  /**
   * The printing whose art fronts each deck.
   *
   * An explicit choice wins. Otherwise it is worked out from the contents, in
   * the order you would point at a deck and describe it: its commander, then a
   * legendary creature in the colour the deck mostly is, then simply its most
   * expensive card. Resolved for every deck in one pass, because the deck list
   * asks for all of them at once.
   */
  private coverPrintings(deckIds: number[]): Map<number, string> {
    const covers = new Map<number, string>();
    if (deckIds.length === 0) return covers;
    const list = deckIds.map(() => '?').join(',');

    for (const row of this.db.prepare(
      `SELECT id, cover_printing_id FROM decks WHERE id IN (${list}) AND cover_printing_id IS NOT NULL`,
    ).all(...deckIds) as any[]) {
      covers.set(row.id, row.cover_printing_id);
    }

    const remaining = deckIds.filter((id) => !covers.has(id));
    if (remaining.length === 0) return covers;
    const rest = remaining.map(() => '?').join(',');

    // One query, ranked: the CASE is the priority order, and the deck's own
    // dominant colour decides which legendary counts as "on theme".
    for (const row of this.db.prepare(`
      WITH deck_colour AS (
          SELECT dc.deck_id,
                 -- The single colour with the most cards in the deck.
                 (SELECT o2.color_identity_mask
                    FROM deck_cards dc2
                    JOIN oracle_cards o2 ON o2.oracle_id = dc2.oracle_id
                   WHERE dc2.deck_id = dc.deck_id AND dc2.board <> 'maybe'
                     AND o2.color_identity_mask <> 0
                   GROUP BY o2.color_identity_mask
                   ORDER BY SUM(dc2.quantity) DESC LIMIT 1) AS mask
            FROM deck_cards dc
           WHERE dc.deck_id IN (${rest})
           GROUP BY dc.deck_id
      )
      SELECT dc.deck_id,
             COALESCE(ap.printing_id, o.default_printing_id) AS printing_id,
             CASE
               WHEN dc.commander_role IS NOT NULL THEN 0
               WHEN o.is_legendary = 1 AND o.type_line LIKE '%Creature%'
                    AND o.color_identity_mask = COALESCE(k.mask, -1) THEN 1
               WHEN o.is_legendary = 1 AND o.type_line LIKE '%Creature%' THEN 2
               ELSE 3
             END AS rank,
             COALESCE(p.price_usd, 0) AS price
        FROM deck_cards dc
        JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
        LEFT JOIN card_art_preferences ap ON ap.oracle_id = o.oracle_id
        LEFT JOIN card_printings p ON p.id = COALESCE(ap.printing_id, o.default_printing_id)
        LEFT JOIN deck_colour k ON k.deck_id = dc.deck_id
       WHERE dc.deck_id IN (${rest}) AND dc.board <> 'maybe'
         AND COALESCE(ap.printing_id, o.default_printing_id) IS NOT NULL
       ORDER BY dc.deck_id, rank ASC, price DESC, o.name COLLATE NOCASE`)
      .all(...remaining, ...remaining) as any[]) {
      // Ordered, so the first row per deck is the winner.
      if (!covers.has(row.deck_id)) covers.set(row.deck_id, row.printing_id);
    }

    return covers;
  }

  setCover(deckId: number, printingId: string | null): void {
    this.db.prepare('UPDATE decks SET cover_printing_id = ? WHERE id = ?').run(printingId, deckId);
    this.touch(deckId);
  }

  // -- tags --------------------------------------------------------------------

  tags(deckId: number): string[] {
    return (this.db.prepare(
      'SELECT tag FROM deck_tags WHERE deck_id = ? ORDER BY tag COLLATE NOCASE',
    ).all(deckId) as any[]).map((r) => r.tag);
  }

  /** Every tag in use, with how many decks carry it, for the filter bar. */
  allTags(): Array<{ tag: string; deckCount: number }> {
    return this.db.prepare(`
      SELECT tag, COUNT(*) AS deckCount FROM deck_tags
      GROUP BY tag COLLATE NOCASE ORDER BY tag COLLATE NOCASE`).all() as any[];
  }

  addTag(deckId: number, tag: string): void {
    const cleaned = tag.trim();
    if (!cleaned) return;
    // The unique index is case-insensitive, so re-adding with different casing
    // is a no-op rather than a duplicate.
    this.db.prepare('INSERT OR IGNORE INTO deck_tags (deck_id, tag) VALUES (?, ?)')
      .run(deckId, cleaned);
    this.touch(deckId);
  }

  removeTag(deckId: number, tag: string): void {
    this.db.prepare('DELETE FROM deck_tags WHERE deck_id = ? AND tag = ? COLLATE NOCASE')
      .run(deckId, tag);
    this.touch(deckId);
  }

  create(input: { name: string; formatCode?: string | null; description?: string | null }): number {
    const result = this.db.prepare(
      `INSERT INTO decks (name, format_code, description) VALUES (?,?,?)`,
    ).run(input.name.trim() || 'Untitled deck', input.formatCode ?? null, input.description ?? null);
    return Number(result.lastInsertRowid);
  }

  update(
    id: number,
    changes: {
      name?: string; formatCode?: string | null; description?: string | null; notes?: string | null;
      isArchived?: boolean; templateId?: number | null;
    },
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
    // decks.template_id is ON DELETE SET NULL, so an explicit null here is
    // indistinguishable from "template was deleted" — both mean off.
    if (changes.templateId !== undefined) { sets.push('template_id = ?'); params.push(changes.templateId); }
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
        INSERT INTO decks (name, format_code, home_location_id, description, notes, template_id)
        VALUES (?,?,?,?,?,?)`)
        .run(newName?.trim() || `${source.name} copy`, source.format_code,
             source.home_location_id, source.description, source.notes, source.template_id);
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
    options: {
      board?: Board;
      quantity?: number;
      fromCollection?: number;
      commanderRole?: CommanderRole | null;
      /**
       * The exact printing being added, when the caller knows which one it is.
       * Pins a new slot's art, and is the printing acquired by a limited deck's
       * add below. Falls back to the card's default printing.
       */
      printingId?: string | null;
    } = {},
  ): void {
    const deck = this.db.prepare(
      'SELECT id, format_code, home_location_id FROM decks WHERE id = ?',
    ).get(deckId) as LimitedDeckRow | undefined;
    if (!deck) throw new DeckNotFoundError(deckId);

    const quantity = Math.max(1, options.quantity ?? 1);

    // Only when the caller did not say. An explicit board always wins, which is
    // what keeps the decklist importer — which always passes one — unaffected.
    const placed = options.board !== undefined
      ? { board: options.board, role: options.commanderRole ?? null }
      : this.placeAutomatically(deckId, oracleId, deck.format_code);
    const board = placed.board;
    const commanderRole = placed.role;

    this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id, quantity, quantity_from_collection FROM deck_cards WHERE deck_id = ? AND oracle_id = ? AND board = ?',
      ).get(deckId, oracleId, board) as any;

      // A limited deck is built out of cards you physically opened, so adding
      // one is an acquisition as well as a slot: the copies enter the
      // collection first, and the allocation below then finds them free and
      // claims them. Skipped when the caller states the allocation itself —
      // an undo or a snapshot restore is putting back a slot whose copies were
      // acquired once already, and must not buy them twice.
      if (options.fromCollection === undefined && isLimitedFormat(deck.format_code)) {
        this.acquireForLimitedDeck(deck, oracleId, quantity, options.printingId ?? null);
      }

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
          INSERT INTO deck_cards (deck_id, oracle_id, board, quantity,
                                  quantity_from_collection, commander_role,
                                  preferred_printing_id)
          VALUES (?,?,?,?,?,?,?)`)
          .run(deckId, oracleId, board, quantity, Math.min(quantity, fromCollection),
               board === 'command' ? (commanderRole ?? 'commander') : null,
               this.printingFor(oracleId, options.printingId ?? null));
      }
      this.touch(deckId);
    })();
  }

  /**
   * Puts the copies a limited deck just claimed into the collection.
   *
   * Everything about the lot is the ordinary add-to-collection path — the same
   * merge rules, and the same cost pool re-split — so a draft entered through
   * the deck builder costs what a draft entered through Collection costs.
   *
   * Basic lands are the exception: in paper limited they come from the venue's
   * land station rather than out of the packs, so a Mountain in a draft deck is
   * a deck slot and nothing more. Non-basic lands are ordinary cards here.
   */
  private acquireForLimitedDeck(
    deck: LimitedDeckRow,
    oracleId: string,
    quantity: number,
    printingId: string | null,
  ): void {
    const card = this.db.prepare(
      'SELECT is_basic_land, default_printing_id FROM oracle_cards WHERE oracle_id = ?',
    ).get(oracleId) as { is_basic_land: number; default_printing_id: string | null } | undefined;
    if (!card || card.is_basic_land) return;

    const printing = this.printingFor(oracleId, printingId) ?? card.default_printing_id;
    const locationId = this.acquisitionLocation(deck.home_location_id);
    // Nothing to file the copies against — a card whose printings have not been
    // synced, or a database with no storage locations at all. The slot is still
    // worth adding, so this degrades to today's behaviour rather than failing.
    if (!printing || locationId == null) return;

    const collection = this.collection();
    // A draft's cost pool, when one is open: the lot joins the batch and the
    // pool re-divides its total across everything it now holds.
    const pool = collection.currentCostPool();
    collection.addLot({
      printingId: printing,
      locationId,
      quantity,
      acquisitionKind: 'pull',
      importBatchId: pool?.id ?? null,
      costMethod: pool ? 'box' : 'unknown',
    });
  }

  /** The given printing when it really is one of this card's, otherwise null. */
  private printingFor(oracleId: string, printingId: string | null): string | null {
    if (!printingId) return null;
    const row = this.db.prepare(
      'SELECT id FROM card_printings WHERE id = ? AND oracle_id = ?',
    ).get(printingId, oracleId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Where a limited deck's cards land: its own home, else the default bucket. */
  private acquisitionLocation(homeLocationId: number | null): number | null {
    if (homeLocationId != null) {
      const home = this.db.prepare('SELECT id FROM storage_locations WHERE id = ?')
        .get(homeLocationId) as { id: number } | undefined;
      if (home) return home.id;
    }
    const fallback = this.db.prepare(
      'SELECT id FROM storage_locations ORDER BY is_default DESC, sort_order, id LIMIT 1',
    ).get() as { id: number } | undefined;
    return fallback?.id ?? null;
  }

  /**
   * The collection store, built on demand.
   *
   * Only the limited-deck path needs it, and building it here rather than
   * taking it as a constructor argument keeps every existing `new DeckStore(db)`
   * — routes and tests alike — working unchanged.
   */
  private collection(): CollectionStore {
    this.collectionStore ??= new CollectionStore(this.db);
    return this.collectionStore;
  }

  /**
   * Where a card goes when the caller did not say.
   *
   * Picking the commander is the first thing you do in a Commander deck, so the
   * first card into an empty deck goes to the command zone if it can lead. Only
   * the first: a Commander deck runs several legendary creatures in the 99, and
   * anything more eager would keep stealing them.
   *
   * A second card joins it only when the pairing is actually legal — Partner,
   * a named "Partner with", Friends forever, a Doctor and companion, or a
   * Background and a card that chooses one.
   */
  private placeAutomatically(
    deckId: number,
    oracleId: string,
    formatCode: string | null,
  ): { board: Board; role: CommanderRole | null } {
    const main = { board: 'main' as Board, role: null };

    const rules = this.formatRules(formatCode);
    if (!rules?.requiresCommander) return main;

    // Cheap counts rather than the full cardsFor query — this runs on every add,
    // and all the decision needs is how many cards are in the deck and how many
    // are already in the command zone.
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN board = 'command' THEN 1 ELSE 0 END) AS in_command
      FROM deck_cards WHERE deck_id = ?`).get(deckId) as { total: number; in_command: number | null };
    const inCommand = counts.in_command ?? 0;

    // Already paired, or the zone is full.
    if (inCommand >= 2) return main;
    // Past the first pick, and nothing in the zone to pair with.
    if (inCommand === 0 && counts.total > 0) return main;

    const incoming = this.cardForPlacement(oracleId);
    if (!incoming) return main;

    if (inCommand === 0) {
      return canLeadDeck(incoming, rules)
        ? { board: 'command', role: 'commander' }
        : main;
    }

    // Oathbreaker's second card is a signature spell, not a partner.
    if (rules.usesSignatureSpell) {
      return isSignatureSpell(incoming) && !canLeadDeck(incoming, rules)
        ? { board: 'command', role: 'signature_spell' }
        : main;
    }

    // The one card already in the zone, loaded in the same shape as the incoming
    // card so the pairing check sees identical fields on both sides.
    const leaderOracle = this.db.prepare(
      `SELECT oracle_id FROM deck_cards WHERE deck_id = ? AND board = 'command' LIMIT 1`,
    ).get(deckId) as { oracle_id: string } | undefined;
    const leader = leaderOracle ? this.cardForPlacement(leaderOracle.oracle_id) : null;
    if (!leader || !pairingIsLegal(leader, incoming)) return main;
    return {
      board: 'command',
      role: incoming.partnerKind === 'background' ? 'background' : 'partner',
    };
  }

  /**
   * One prospective card in the same shape validation uses, so the placement
   * rules and the validator cannot disagree about what a card is.
   */
  private cardForPlacement(oracleId: string): DeckCard | null {
    const row = this.db.prepare(`
      SELECT o.name, o.type_line, o.is_legendary, o.can_be_commander,
             o.partner_kind, o.partner_with, o.color_identity_mask,
             o.has_uncommon_printing
      FROM oracle_cards o WHERE o.oracle_id = ?`).get(oracleId) as any;
    if (!row) return null;

    return {
      name: row.name,
      typeLine: row.type_line ?? '',
      isLegendary: Boolean(row.is_legendary),
      canBeCommander: Boolean(row.can_be_commander),
      hasUncommonPrinting: Boolean(row.has_uncommon_printing),
      partnerKind: row.partner_kind,
      partnerWith: row.partner_with,
      colorIdentityMask: row.color_identity_mask ?? 0,
    } as DeckCard;
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
  /**
   * A user-named section within the deck: Ramp, Removal, Draw — or several at
   * once, comma-separated, for a card doing two jobs. Normalised on the way in
   * so the stored spelling is canonical.
   */
  setCategory(deckId: number, cardId: number, category: string | null): void {
    this.db.prepare('UPDATE deck_cards SET category = ? WHERE id = ? AND deck_id = ?')
      .run(normalizeCategoryInput(category), cardId, deckId);
    this.touch(deckId);
  }

  /**
   * Pins a slot to a specific printing, which decides the art shown and the set
   * code a decklist export writes. Null falls back to the card's default.
   */
  setPreferredPrinting(deckId: number, cardId: number, printingId: string | null): void {
    this.db.prepare('UPDATE deck_cards SET preferred_printing_id = ? WHERE id = ? AND deck_id = ?')
      .run(printingId, cardId, deckId);
    this.touch(deckId);
  }

  /**
   * The categories a deck actually uses. Stored values are lists, so they are
   * split rather than reported whole — "ramp, draw" is two categories, not one
   * odd third.
   *
   * The client no longer suggests from this: the category control is a
   * checklist of the categories the server resolves, not a free-text box that
   * needed completions. Kept as a resource because "what is this deck filed
   * under" is a fair question to ask the API.
   */
  categories(deckId: number): string[] {
    const stored = (this.db.prepare(`
      SELECT category FROM deck_cards
      WHERE deck_id = ? AND category IS NOT NULL AND category <> ''`)
      .pluck().all(deckId) as string[]).flatMap(parseCategoryList);

    const seen = new Map<string, string>();
    for (const value of stored) {
      const key = value.toLowerCase();
      if (!seen.has(key)) seen.set(key, value);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

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

  // -- basic lands -----------------------------------------------------------

  /** The basic lands in the catalogue, one per colour, with the colour each makes. */
  private resolveBasics(): BasicLand[] {
    const rows = this.db.prepare(
      `SELECT oracle_id, produced_mana FROM oracle_cards
       WHERE is_basic_land = 1 AND type_line NOT LIKE '%Snow%'
       ORDER BY oracle_id`,
    ).all() as Array<{ oracle_id: string; produced_mana: string | null }>;

    const basics: BasicLand[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const produced = parseJsonArray(row.produced_mana).map((s) => s.toUpperCase());
      const color = (['W', 'U', 'B', 'R', 'G'] as Color[]).find((c) => produced.includes(c)) ?? 'C';
      // One canonical basic per colour — ignore duplicates like snow basics.
      if (seen.has(color)) continue;
      seen.add(color);
      basics.push({ color, oracleId: row.oracle_id });
    }
    return basics;
  }

  private isBasicLand(oracleId: string): boolean {
    const row = this.db.prepare('SELECT is_basic_land FROM oracle_cards WHERE oracle_id = ?')
      .get(oracleId) as { is_basic_land: number } | undefined;
    return Boolean(row?.is_basic_land);
  }

  /** The oracle id behind a deck slot, or null — for deciding what was edited. */
  oracleForCard(deckId: number, cardId: number): string | null {
    const row = this.db.prepare('SELECT oracle_id FROM deck_cards WHERE id = ? AND deck_id = ?')
      .get(cardId, deckId) as { oracle_id: string } | undefined;
    return row?.oracle_id ?? null;
  }

  /**
   * Adds basics to bring the deck up to the recommended land count.
   *
   * Additive: existing basics and non-basic lands are counted and never removed,
   * so pressing it after adding duals simply adds fewer basics, and pressing it
   * on a deck that already has enough lands does nothing. Distribution follows
   * the deck's coloured-pip shares.
   */
  applyRecommendedLands(deckId: number): void {
    const deck = this.db.prepare('SELECT format_code FROM decks WHERE id = ?')
      .get(deckId) as { format_code: string | null } | undefined;
    if (!deck) throw new DeckNotFoundError(deckId);

    const cards = this.cardsFor(deckId, deck.format_code);
    const rules = this.formatRules(deck.format_code);
    const targets = planBasics(cards, rules, this.resolveBasics());

    const existingByOracle = new Map<string, number>();
    for (const card of cards) {
      if (card.board === 'main' && card.isBasicLand) {
        existingByOracle.set(card.oracleId, (existingByOracle.get(card.oracleId) ?? 0) + card.quantity);
      }
    }

    for (const target of targets) {
      const have = existingByOracle.get(target.oracleId) ?? 0;
      const toAdd = target.desired - have;
      if (toAdd > 0) this.addCard(deckId, target.oracleId, { board: 'main', quantity: toAdd });
    }
  }

  /**
   * Keeps the basic-land base in step with the deck, when the setting is on.
   *
   * Unlike the button this both adds and trims: it sets each basic to its
   * recommended count, so adding a dual removes a basic and cutting spells trims
   * lands, always capped at the recommended total. Skipped when the change was
   * itself a basic-land edit (so a hand-set basic count is left alone) and while
   * the deck is too small to have a real mana base yet.
   */
  autoMaintainLands(deckId: number, editedOracleId?: string | null): void {
    if (getSetting(this.db, AUTO_MAINTAIN_LANDS) !== '1') return;
    if (editedOracleId && this.isBasicLand(editedOracleId)) return;

    const deck = this.db.prepare('SELECT format_code FROM decks WHERE id = ?')
      .get(deckId) as { format_code: string | null } | undefined;
    if (!deck) return;

    const cards = this.cardsFor(deckId, deck.format_code);
    // Nothing to build a mana base around yet — don't flood a near-empty deck.
    const nonLandCards = cards
      .filter((c) => (c.board === 'main' || c.board === 'command')
        && !c.typeLine.toLowerCase().includes('land'))
      .reduce((n, c) => n + c.quantity, 0);
    if (nonLandCards < MIN_CARDS_FOR_AUTO_LANDS) return;

    const rules = this.formatRules(deck.format_code);
    const targets = planBasics(cards, rules, this.resolveBasics());

    const existing = new Map<string, { cardId: number; quantity: number }>();
    for (const card of cards) {
      if (card.board === 'main' && card.isBasicLand) {
        existing.set(card.oracleId, { cardId: card.id, quantity: card.quantity });
      }
    }

    for (const target of targets) {
      const have = existing.get(target.oracleId);
      if (target.desired <= 0) {
        if (have) this.setQuantity(deckId, have.cardId, 0);
      } else if (!have) {
        this.addCard(deckId, target.oracleId, { board: 'main', quantity: target.desired });
      } else if (have.quantity !== target.desired) {
        this.setQuantity(deckId, have.cardId, target.desired);
      }
    }
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
    templateId: row.template_id,
  };
}

/** produced_mana is stored as a JSON array; a malformed one should not throw. */
function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function maskToColors(mask: number): string {
  return ['W', 'U', 'B', 'R', 'G'].filter((_, i) => mask & (1 << i)).join('');
}
