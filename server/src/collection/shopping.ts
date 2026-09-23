import type Database from 'better-sqlite3';
import { artUrlSql, imageUrlSql } from '../images/url.ts';
import { buildabilityDetail, missingForWantList, type BuildabilityRow } from '../decks/buildability.ts';

/**
 * A deck's shopping list, and pushing it onto a want list.
 *
 * The shopping list is buildability's missing set with pictures on it, and
 * nothing more. It used to be its own computation — the *stored* claim
 * subtracted per slot, priced at the preferred-or-default printing — and it
 * disagreed with the deck header on both counts: the stored claim is inert on
 * a brew and on an exempt basic, so one deck read "9 missing" beside
 * "Shopping list (7)", and the two priced the same Craterhoof at $21.49 and
 * $28.33. Now the rows, the count, the unit price and the total all come from
 * `decks/buildability.ts`, so they cannot drift apart again.
 */

export interface ShoppingListEntry {
  oracleId: string;
  name: string;
  needed: number;
  unitPriceUsd: number | null;
  /** `needed × unitPrice`, or null when the card has no price. */
  estimatedUsd: number | null;
  /** The printing the price is for — the one you would be buying. */
  printingId: string | null;
  imageSmall: string | null;
  setCode: string | null;
  /** Reserving decks holding copies this deck would otherwise have. */
  holdingDecks: BuildabilityRow['holdingDecks'];
  /** Copies you own but have promised on a trade list. */
  tradeListed: number;
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
  const detail = buildabilityDetail(db, deckId);
  if (!detail) return null;

  const missing = detail.rows.filter((row) => row.missing > 0);

  // Pictures and set codes for the printings buildability priced — the only
  // thing this module adds to what buildability already said.
  const printingIds = [...new Set(
    missing.map((row) => row.pricePrintingId).filter((id): id is string => id !== null),
  )];
  const pictures = new Map<string, { image_small: string | null; set_code: string }>();
  if (printingIds.length > 0) {
    const rows = db.prepare(`
      SELECT p.id, p.set_code,
             ${imageUrlSql({
                 id: 'p.id',
                 ts: 'COALESCE(p.image_ts, ff.image_ts)',
                 override: 'COALESCE(p.image_url_override, ff.image_url_override)',
                 size: 'small',
               })} AS image_small
        FROM card_printings p
        LEFT JOIN card_faces ff ON ff.printing_id = p.id AND ff.face_index = 0
       WHERE p.id IN (${printingIds.map(() => '?').join(',')})`).all(...printingIds) as Array<{
         id: string; set_code: string; image_small: string | null;
       }>;
    for (const row of rows) pictures.set(row.id, row);
  }

  const entries: ShoppingListEntry[] = missing
    .map((row) => {
      const picture = row.pricePrintingId ? pictures.get(row.pricePrintingId) : undefined;
      return {
        oracleId: row.oracleId,
        name: row.name,
        needed: row.missing,
        unitPriceUsd: row.unitPriceUsd,
        estimatedUsd: row.extendedUsd,
        printingId: row.pricePrintingId,
        imageSmall: picture?.image_small ?? null,
        setCode: picture?.set_code ?? null,
        holdingDecks: row.holdingDecks,
        tradeListed: row.tradeListed,
      };
    })
    .sort((a, b) => (b.estimatedUsd ?? 0) - (a.estimatedUsd ?? 0)
      || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    deckId: detail.deckId,
    deckName: detail.deckName,
    entries,
    totalCards: detail.summary.missingCards,
    totalUsd: detail.summary.costToCompleteUsd,
    unpricedCards: detail.summary.unpricedCount,
  };
}

export interface WantPushResult {
  added: number;
  updated: number;
  listName: string;
}

/**
 * Pushes a deck's missing cards onto a want list, tagged with the deck —
 * all of them, or only `oracleIds`.
 */
export function pushToWantList(
  db: Database.Database,
  deckId: number,
  options: { wantListId?: number; oracleIds?: string[] } = {},
): WantPushResult {
  const deck = db.prepare('SELECT id FROM decks WHERE id = ?').get(deckId);
  if (!deck) throw new Error(`No deck with id ${deckId}.`);

  const missing = missingForWantList(db, deckId);
  const only = options.oracleIds && options.oracleIds.length > 0 ? new Set(options.oracleIds) : null;
  const wanted = only ? missing.filter((entry) => only.has(entry.oracleId)) : missing;

  return pushEntriesToWantList(db, deckId, wanted, options.wantListId);
}

/**
 * The push itself, over a set of shortfalls.
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

/**
 * What a want list currently holds, with each entry's per-deck needs.
 *
 * `totals` is over the active wants only — a fulfilled one is no longer
 * something you are shopping for — and prices each at the same per-copy price
 * its row shows, so the line above the list is the rows added up and nothing
 * else. A want with no price is counted in `unpricedCount` rather than summed
 * as $0: unknown is not free.
 */
export function wantList(db: Database.Database, wantListId?: number) {
  const list = wantListId
    ? db.prepare('SELECT id, name FROM want_lists WHERE id = ?').get(wantListId)
    : db.prepare('SELECT id, name FROM want_lists ORDER BY is_default DESC, sort_order LIMIT 1').get();
  if (!list) return null;
  const target = list as { id: number; name: string };

  const items = db.prepare(`
    SELECT w.id, w.oracle_id, w.quantity, w.target_price_usd, w.priority, w.status, w.notes,
           w.sort_order, w.created_at, o.name, o.mana_cost, o.color_identity,
           dp.price_usd,
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

  const active = items.filter((row) => row.status === 'active');
  const priced = active.filter((row) => row.price_usd != null);

  return {
    id: target.id,
    name: target.name,
    totals: {
      activeCount: active.length,
      activeCopies: active.reduce((sum, row) => sum + row.quantity, 0),
      valueUsd: priced.reduce((sum, row) => sum + row.quantity * row.price_usd, 0),
      unpricedCount: active.length - priced.length,
    },
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
      // Null when the card has no price — the row says "—", matching the
      // totals line's "unpriced", rather than a $0.00 it never cost.
      priceUsd: row.price_usd,
      printingId: row.printing_id,
      imageSmall: row.image_small,
      ownedQuantity: row.owned_qty,
      addedAt: row.created_at,
      // "needed for: Deck A ×2" — shown as a field, not a tooltip.
      neededFor: byItem.get(row.id) ?? [],
    })),
  };
}
