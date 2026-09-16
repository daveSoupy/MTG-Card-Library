# Phase 8 — Quick Fixes (not sequenced)

Four small, independent items: three wiring fixes to Phases 1–6, plus card rulings, which were never scoped anywhere. Nothing later depends on them. Build whenever — the rulings item adds a migration, so bump `user_version` as usual.

## Snow basics instead of regular basics

Root cause in `server/src/decks/store.ts`, `resolveBasics()`:

```js
// One canonical basic per colour — ignore duplicates like snow basics.
if (seen.has(color)) continue;
```

The comment states the intent; the code doesn't implement it. The query (`SELECT oracle_id, produced_mana FROM oracle_cards WHERE is_basic_land = 1`) has no clause excluding snow basics, so the dedupe-by-color loop keeps whichever row SQLite returns first. If Snow-Covered Plains sorts ahead of Plains, Snow becomes the canonical white basic silently.

**Fix:** `... WHERE is_basic_land = 1 AND type_line NOT LIKE '%Snow%' ORDER BY oracle_id`. The `ORDER BY` makes the result deterministic rather than dependent on row order. One line, no new logic.

## Add to want list from the browse page

The browse page (`App.tsx`) shows a star badge when `card.wantedQuantity > 0` — informational only, no way to add from there. The only existing add action, `pushToWantList(deckId, oracleIds)` (`web/src/api.ts`), is deck-shopping-list-specific.

**Fix:** reuse `addWantItem(listId, oracleId, fields)` (`web/src/api.ts`) — the single-item call the deck-builder path already uses — with a small button on each browse result. If more than one want list exists, a lightweight picker for which list; if only one, add straight to it.

## Promo/prerelease printing selection in Collection

`is_promo` and `promo_types` are real columns on `card_printings`, populated from Scryfall's bulk data today. This is a missing UI filter, not a sync gap.

**Fix:** add a promo/prerelease filter to the Collection add-card flow, scoped the same way set-scoped entry (Phase 4) already narrows results, so adding a prerelease-stamped copy doesn't mean scrolling past every standard printing.

## Card rulings — never scoped, not just unsynced

No `card_rulings` table, no sync code referencing rulings, nothing in `CardDetailPane.tsx`. Phase 3 deferred rulings without assigning them anywhere; this is where they land.

Scryfall's Rulings bulk file is one of its five official bulk-data types — unlike Phase 7's oracle-tags source, this needs no third-party source and no "may go away" caveat.

**Fix:**

```sql
CREATE TABLE card_rulings (
    id            INTEGER PRIMARY KEY,
    oracle_id     TEXT NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
    source        TEXT NOT NULL CHECK (source IN ('wotc','scryfall')),
    published_at  TEXT NOT NULL,
    comment       TEXT NOT NULL
);
CREATE INDEX idx_card_rulings_oracle ON card_rulings(oracle_id);
```

- Add `rulings` as an additional bulk type in the sync worker — a separate, independent fetch step after the card import, same pattern as Phase 7's tag closure: **a failure here must not fail the card sync.** On each sync, replace all rows with the file's contents in one transaction rather than diffing. **Insert only rows whose `oracle_id` exists in `oracle_cards`** (`INSERT … SELECT … WHERE EXISTS`) — the Rulings file covers cards `default_cards` omits, and one orphan would otherwise fail the whole transaction on the FK. Log the skipped count in `sync_log`.
- Client: a collapsible "Rulings" section on `CardDetailPane.tsx`, sorted by `published_at` **descending — newest first**, each entry showing its source, date, and comment. Collapsed by default, showing a count ("4 rulings"). Cards with zero rulings show no section at all.
- Next unused `user_version` at build time.

## Verification

1. With auto-maintain-lands on, in a database where Snow-Covered Plains sorts ahead of Plains (seed one in the test), the resolved canonical white basic is the non-Snow oracle card.
2. The new want-list button on a browse result creates a `want_list_items` row identical in shape to one added through the deck builder's shopping list — same table, same fields, no separate code path.
3. A card already on a want list shows the button in its already-wanted state on browse.
4. A promo or prerelease printing is selectable from the Collection add-card filter, and the resulting `collection_items` row links to that specific `card_printings.id`.
5. A card with published rulings shows the collapsed "N rulings" section on its detail pane; expanding it lists every ruling newest-first, with source and date visible per entry.
6. A card with zero rulings shows no rulings section at all.
7. The card sync still completes when the rulings fetch fails or times out, and when the file contains a ruling for an unknown `oracle_id` (that row is skipped, the rest land).
8. `migrations.test.ts` passes with the new table.

## Out of scope

Nothing bigger than these four — this phase exists specifically not to grow. Another small fix later gets its own line here or its own equally small phase.
