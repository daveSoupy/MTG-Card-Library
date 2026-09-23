import type Database from 'better-sqlite3';
import { artUrlSql, imageUrlSql } from '../images/url.ts';
import { allocationForMany, allocationSettings, copiesToBuy } from '../decks/allocation.ts';

/**
 * A deck's shopping list, and pushing it onto a want list.
 *
 * CLAUDE.md is explicit that this "falls out naturally from allocation tracking
 * rather than being a separate feature" — a slot's shortfall is what allocation
 * already maintains. There is no separate shopping-list table, and nothing to
 * keep in sync.
 *
 * Phase 22 moved the shortfall itself into `decks/allocation.ts`: it is
 * `quantity - from_collection - proxied`, and it is zero for a basic land while
 * `allocation_ignores_basics` is on. Nothing here re-derives it, which is why
 * the v_deck_shopping_list view is gone — 38 Islands are not 38 missing cards,
 * and a view could not know that.
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

  const settings = allocationSettings(db);

  const slots = db.prepare(`
    SELECT dc.oracle_id, dc.quantity, dc.quantity_from_collection, dc.quantity_proxied,
           o.name AS card_name,
           COALESCE(dc.preferred_printing_id, o.default_printing_id) AS price_printing_id,
           COALESCE(pp.price_usd, dp.price_usd) AS unit_price_usd,
           ${imageUrlSql({
               id: 'COALESCE(pp.id, dp.id)',
               ts: 'COALESCE(pp.image_ts, ffp.image_ts, dp.image_ts, ffd.image_ts)',
               override: 'COALESCE(pp.image_url_override, ffp.image_url_override, dp.image_url_override, ffd.image_url_override)',
               size: 'small',
             })} AS image_small,
           COALESCE(pp.set_code, dp.set_code) AS set_code
    FROM deck_cards dc
    JOIN oracle_cards o ON o.oracle_id = dc.oracle_id
    LEFT JOIN card_printings pp ON pp.id = dc.preferred_printing_id
    LEFT JOIN card_printings dp ON dp.id = o.default_printing_id
    LEFT JOIN card_faces ffp ON ffp.printing_id = pp.id AND ffp.face_index = 0
    LEFT JOIN card_faces ffd ON ffd.printing_id = dp.id AND ffd.face_index = 0
    WHERE dc.deck_id = ? AND dc.board IN ('main','side','command')`).all(deckId) as any[];

  // Copies free elsewhere excludes this deck's own claim, so a row reading
  // "2 free in your collection" means two you could claim without taking them
  // off another deck.
  const allocation = allocationForMany(
    db, slots.map((row) => row.oracle_id), { excludeDeckId: deckId, settings },
  );

  const entries: ShoppingListEntry[] = slots
    .map((row) => {
      const needed = copiesToBuy({
        quantity: row.quantity,
        quantityFromCollection: row.quantity_from_collection,
        quantityProxied: row.quantity_proxied,
        allocationTracked: allocation.get(row.oracle_id)!.tracked,
      });
      const unitPriceUsd = row.unit_price_usd ?? null;
      return {
        oracleId: row.oracle_id,
        name: row.card_name,
        needed,
        unitPriceUsd,
        estimatedUsd: needed * (unitPriceUsd ?? 0),
        printingId: row.price_printing_id,
        imageSmall: row.image_small,
        setCode: row.set_code,
        availableElsewhere: allocation.get(row.oracle_id)!.available,
      };
    })
    .filter((entry) => entry.needed > 0)
    .sort((a, b) => (b.estimatedUsd ?? 0) - (a.estimatedUsd ?? 0)
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

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

/** Pushes a deck's *declared* shortfall onto a want list, tagged with the deck. */
export function pushToWantList(
  db: Database.Database,
  deckId: number,
  options: { wantListId?: number; oracleIds?: string[] } = {},
): WantPushResult {
  const full = shoppingList(db, deckId);
  if (!full) throw new Error(`No deck with id ${deckId}.`);

  const wanted = options.oracleIds && options.oracleIds.length > 0
    ? full.entries.filter((e) => options.oracleIds!.includes(e.oracleId))
    : full.entries;

  return pushEntriesToWantList(db, deckId, wanted, options.wantListId);
}

/**
 * The push itself, over whatever set of shortfalls a caller worked out.
 *
 * Two callers now disagree about what "needed" means, and both are right. The
 * shopping list above reads the *declared* shortfall — the copies you marked as
 * "need to buy". Phase 24's buildability reads *computed coverage* — copies the
 * collection could not supply whether or not you marked anything. They are
 * different questions, so they are different callers; the consolidation rules
 * below are the same for both, so they are written once, here.
 *
 * Phase 6 requires that consolidation: one row per card per list, summing the
 * quantity and listing each deck's need separately. `want_list_items` enforces
 * it with UNIQUE(want_list_id, oracle_id), and `want_list_item_decks` holds the
 * per-deck breakdown the list view shows as "needed for: Deck A x2".
 */
export function pushEntriesToWantList(
  db: Database.Database,
  deckId: number,
  entries: Array<{ oracleId: string; needed: number }>,
  wantListId?: number,
): WantPushResult {
  const list = wantListId
    ? db.prepare('SELECT id, name FROM want_lists WHERE id = ?').get(wantListId)
    : db.prepare('SELECT id, name FROM want_lists ORDER BY is_default DESC, sort_order LIMIT 1').get();
  if (!list) throw new Error('No want list to add to.');
  const target = list as { id: number; name: string };

  const wanted = entries.filter((entry) => entry.needed > 0);

  const upsertItem = db.prepare(`
    INSERT INTO want_list_items (want_list_id, oracle_id, quantity)
    VALUES (?,?,?)
    ON CONFLICT(want_list_id, oracle_id) DO UPDATE SET
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      -- Re-opens an entry that had been marked fulfilled but is wanted again.
      status = 'active'`);

  const findItem = db.prepare(
    'SELECT id FROM want_list_items WHERE want_list_id = ? AND oracle_id = ?',
  );

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
      const before = findItem.get(target.id, entry.oracleId) as { id: number } | undefined;
      const result = upsertItem.run(target.id, entry.oracleId, entry.needed);

      // One lookup, not two. The old code re-read the row after the upsert to
      // learn its id, but both answers were already in hand: an existing row
      // brought its own id, and a new one is the insert's rowid. That second
      // read only looked necessary because the two cases were not separated.
      //
      // lastInsertRowid is trusted *only* on the insert path — SQLite leaves
      // it untouched when ON CONFLICT takes the DO UPDATE branch, so on an
      // existing row it would be a stale id from somewhere else entirely.
      const itemId = before ? before.id : Number(result.lastInsertRowid);

      upsertDeckNeed.run(itemId, deckId, entry.needed);
      recount.run(itemId);

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
           ${artUrlSql('dp', 'ff', 'small')} AS image_small,
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
