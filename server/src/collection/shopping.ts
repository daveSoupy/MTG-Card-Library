import type Database from 'better-sqlite3';

/**
 * A deck's shopping list, and pushing it onto a want list.
 *
 * CLAUDE.md is explicit that this "falls out naturally from allocation tracking
 * rather than being a separate feature" — a slot's shortfall is simply
 * `quantity - quantity_from_collection`, which Phase 2 already maintains. There
 * is no separate shopping-list table, and nothing to keep in sync.
 */

export interface ShoppingListEntry {
  oracleId: string;
  name: string;
  needed: number;
  unitPriceUsd: number | null;
  estimatedUsd: number | null;
  printingId: string | null;
  imageSmall: string | null;
  setCode: string | null;
  /** Copies free elsewhere in the collection that this deck has not claimed. */
  availableElsewhere: number;
}

export interface ShoppingList {
  deckId: number;
  deckName: string;
  entries: ShoppingListEntry[];
  totalCards: number;
  totalUsd: number;
  /** Cards with no price at all, so the estimate is known to be incomplete. */
  unpricedCards: number;
}

export function shoppingList(db: Database.Database, deckId: number): ShoppingList | null {
  const deck = db.prepare('SELECT id, name FROM decks WHERE id = ?').get(deckId) as
    | { id: number; name: string } | undefined;
  if (!deck) return null;

  const rows = db.prepare(`
    SELECT s.oracle_id, s.card_name, s.qty_to_buy, s.unit_price_usd, s.est_cost_usd,
           s.price_printing_id,
           COALESCE(dp.image_small, ff.image_small) AS image_small,
           dp.set_code,
           COALESCE(free.qty, 0) AS available_elsewhere
    FROM v_deck_shopping_list s
    LEFT JOIN card_printings dp ON dp.id = s.price_printing_id
    LEFT JOIN card_faces ff ON ff.printing_id = dp.id AND ff.face_index = 0
    LEFT JOIN (
        SELECT p.oracle_id,
               SUM(ci.quantity) - COALESCE((
                   SELECT SUM(dc.quantity_from_collection) FROM deck_cards dc
                   WHERE dc.oracle_id = p.oracle_id AND dc.board IN ('main','side','command')
               ), 0) AS qty
        FROM collection_items ci
        JOIN card_printings p ON p.id = ci.printing_id
        GROUP BY p.oracle_id
    ) free ON free.oracle_id = s.oracle_id
    WHERE s.deck_id = ?
    ORDER BY s.est_cost_usd DESC, s.card_name COLLATE NOCASE`).all(deckId) as any[];

  const entries: ShoppingListEntry[] = rows.map((row) => ({
    oracleId: row.oracle_id,
    name: row.card_name,
    needed: row.qty_to_buy,
    unitPriceUsd: row.unit_price_usd,
    estimatedUsd: row.est_cost_usd,
    printingId: row.price_printing_id,
    imageSmall: row.image_small,
    setCode: row.set_code,
    availableElsewhere: Math.max(0, row.available_elsewhere),
  }));

  return {
    deckId: deck.id,
    deckName: deck.name,
    entries,
    totalCards: entries.reduce((total, e) => total + e.needed, 0),
    totalUsd: Math.round(entries.reduce((total, e) => total + (e.estimatedUsd ?? 0), 0) * 100) / 100,
    unpricedCards: entries.filter((e) => e.unitPriceUsd == null).length,
  };
}

export interface WantPushResult {
  added: number;
  updated: number;
  listName: string;
}

/**
 * Pushes shortfalls onto a want list, tagged with the deck that needs them.
 *
 * Phase 6 requires consolidation: one row per card per list, summing the
 * quantity and listing each deck's need separately. `want_list_items` enforces
 * that with UNIQUE(want_list_id, oracle_id), and `want_list_item_decks` holds
 * the per-deck breakdown that the list view shows as "needed for: Deck A ×2".
 */
export function pushToWantList(
  db: Database.Database,
  deckId: number,
  options: { wantListId?: number; oracleIds?: string[] } = {},
): WantPushResult {
  const list = options.wantListId
    ? db.prepare('SELECT id, name FROM want_lists WHERE id = ?').get(options.wantListId)
    : db.prepare('SELECT id, name FROM want_lists ORDER BY is_default DESC, sort_order LIMIT 1').get();
  if (!list) throw new Error('No want list to add to.');
  const target = list as { id: number; name: string };

  const full = shoppingList(db, deckId);
  if (!full) throw new Error(`No deck with id ${deckId}.`);

  const wanted = options.oracleIds && options.oracleIds.length > 0
    ? full.entries.filter((e) => options.oracleIds!.includes(e.oracleId))
    : full.entries;

  const upsertItem = db.prepare(`
    INSERT INTO want_list_items (want_list_id, oracle_id, quantity)
    VALUES (?,?,?)
    ON CONFLICT(want_list_id, oracle_id) DO UPDATE SET
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      -- Re-opens an entry that had been marked fulfilled but is wanted again.
      status = 'active'`);

  const upsertDeckNeed = db.prepare(`
    INSERT INTO want_list_item_decks (want_list_item_id, deck_id, quantity)
    VALUES (?,?,?)
    ON CONFLICT(want_list_item_id, deck_id) DO UPDATE SET quantity = excluded.quantity`);

  // The item's own quantity is the sum of every deck's need plus anything
  // wanted freestanding, so it is recomputed rather than incremented — that
  // keeps a re-push from doubling the count.
  const recount = db.prepare(`
    UPDATE want_list_items
       SET quantity = MAX(1, (
             SELECT COALESCE(SUM(quantity), 0) FROM want_list_item_decks
             WHERE want_list_item_id = want_list_items.id))
     WHERE id = ?`);

  return db.transaction(() => {
    let added = 0;
    let updated = 0;

    for (const entry of wanted) {
      const before = db.prepare(
        'SELECT id FROM want_list_items WHERE want_list_id = ? AND oracle_id = ?',
      ).get(target.id, entry.oracleId) as { id: number } | undefined;

      upsertItem.run(target.id, entry.oracleId, entry.needed);
      const item = db.prepare(
        'SELECT id FROM want_list_items WHERE want_list_id = ? AND oracle_id = ?',
      ).get(target.id, entry.oracleId) as { id: number };

      upsertDeckNeed.run(item.id, deckId, entry.needed);
      recount.run(item.id);

      if (before) updated += 1;
      else added += 1;
    }

    return { added, updated, listName: target.name };
  })();
}

/** What a want list currently holds, with each entry's per-deck needs. */
export function wantList(db: Database.Database, wantListId?: number) {
  const list = wantListId
    ? db.prepare('SELECT id, name FROM want_lists WHERE id = ?').get(wantListId)
    : db.prepare('SELECT id, name FROM want_lists ORDER BY is_default DESC, sort_order LIMIT 1').get();
  if (!list) return null;
  const target = list as { id: number; name: string };

  const items = db.prepare(`
    SELECT w.id, w.oracle_id, w.quantity, w.target_price_usd, w.priority, w.status, w.notes,
           w.sort_order, o.name, o.mana_cost, o.color_identity,
           COALESCE(dp.price_usd, 0) AS price_usd,
           COALESCE(dp.image_small, ff.image_small) AS image_small,
           dp.id AS printing_id,
           COALESCE(owned.qty, 0) AS owned_qty
    FROM want_list_items w
    JOIN oracle_cards o ON o.oracle_id = w.oracle_id
    LEFT JOIN card_printings dp ON dp.id = COALESCE(w.preferred_printing_id, o.default_printing_id)
    LEFT JOIN card_faces ff ON ff.printing_id = dp.id AND ff.face_index = 0
    LEFT JOIN (
        SELECT p.oracle_id, SUM(ci.quantity) AS qty FROM collection_items ci
        JOIN card_printings p ON p.id = ci.printing_id GROUP BY p.oracle_id
    ) owned ON owned.oracle_id = w.oracle_id
    WHERE w.want_list_id = ?
    ORDER BY w.sort_order, o.name COLLATE NOCASE`).all(target.id) as any[];

  const needs = db.prepare(`
    SELECT wd.want_list_item_id, wd.quantity, d.id AS deck_id, d.name AS deck_name
    FROM want_list_item_decks wd
    JOIN decks d ON d.id = wd.deck_id
    JOIN want_list_items w ON w.id = wd.want_list_item_id
    WHERE w.want_list_id = ?
    ORDER BY d.name COLLATE NOCASE`).all(target.id) as any[];

  const byItem = new Map<number, Array<{ deckId: number; deckName: string; quantity: number }>>();
  for (const need of needs) {
    const list = byItem.get(need.want_list_item_id) ?? [];
    list.push({ deckId: need.deck_id, deckName: need.deck_name, quantity: need.quantity });
    byItem.set(need.want_list_item_id, list);
  }

  return {
    id: target.id,
    name: target.name,
    items: items.map((row) => ({
      id: row.id,
      oracleId: row.oracle_id,
      name: row.name,
      manaCost: row.mana_cost,
      colorIdentity: row.color_identity ?? '',
      quantity: row.quantity,
      targetPriceUsd: row.target_price_usd,
      priority: row.priority,
      status: row.status,
      notes: row.notes,
      priceUsd: row.price_usd,
      printingId: row.printing_id,
      imageSmall: row.image_small,
      ownedQuantity: row.owned_qty,
      // "needed for: Deck A ×2" — shown as a field, not a tooltip.
      neededFor: byItem.get(row.id) ?? [],
    })),
  };
}
