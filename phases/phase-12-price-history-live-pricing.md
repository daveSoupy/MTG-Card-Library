# Phase 12 — Price History & Live Pricing

Mostly surfacing what already runs, plus two genuinely new pieces.

## Already built and running — confirm, don't rebuild

- **Daily collection value snapshot.** `collection_value_snapshots` is populated by `CollectionStore.takeSnapshot()`, called at the end of every sync in `runSync.ts`. One row per day: value, cost basis, cumulative realized gain.
- **Per-card price history.** `printing_price_history` is written by `runSync.ts` whenever a *tracked* printing's price moves — scoped by the `v_tracked_printings` view (owned, on a trade list, or an active want-list item), not all ~500k printings.
- **The whole-collection value graph.** `GET /api/v1/collection/value` returns a `history` array and `CollectionPage.tsx` renders it as a hand-rolled inline SVG sparkline (`ValueChart`). No charting library.

## Schema

Next unused `user_version` at build time. Covers the `v_tracked_printings` redefinition, `deck_value_snapshots`, and the `alerts.kind` rebuild.

## New: expose per-card price history

- Add `GET /api/v1/cards/:printingId/price-history` over `printing_price_history`.
- Client: reuse `ValueChart`'s inline-SVG approach and its "one data point so far, filling in over time" fallback. No charting library.
- Surface on `CardDetailPane.tsx` for any printing; a printing with no rows gets the fallback state, not an error.

## New: per-deck value over time

**Decided: a `deck_value_snapshots` table**, populated daily during sync alongside `takeSnapshot()`, by summing each deck's current cards against their latest tracked price. (Reconstructing on demand from `printing_price_history` was the alternative; the table is simpler to query and matches the existing collection pattern.) `deck_id` FK `ON DELETE CASCADE`.

**Extend `v_tracked_printings` to include `deck_cards`.** `deck_cards.oracle_id` is required but the printing pin is optional — a "need to buy" slot usually has none. Use the same fallback the view's `want_list_items` branch already uses: `COALESCE(dc.preferred_printing_id, o.default_printing_id)` joined through `oracle_cards`, not a naive `SELECT printing_id FROM deck_cards`, which would miss most unowned slots.

**Where it shows:** the deck builder's stats pane, the same spot Phase 7's template tracking lives — a `ValueChart`-style sparkline for that deck.

## New: spike detection + alerts

Reuse the `alerts` table and `AlertsBell.tsx` wholesale — the mechanism Phase 6 built for want-list price targets, with a new kind.

- Add `'price_spike'` to the `alerts.kind` CHECK constraint (currently `price_target`, `trade_list_clamped`, `allocation_conflict`, `want_fulfilled`, `sync_failed`, `import_unmatched`). SQLite has no `ALTER TABLE … MODIFY CONSTRAINT`: create the new table, copy rows, drop the old, rename — **and recreate every index on `alerts` identically**, or `migrations.test.ts` fails. Run with foreign keys off for the rebuild.
- During sync, after writing a new `printing_price_history` row, compare against the price 7 days prior and raise an alert past a percentage threshold (start at 25%; make it a `NUMBER_SETTINGS` entry).
- `dedupe_key = 'price_spike:<printing_id>'`, the same convention as price targets, so a card that stays up doesn't re-alert daily.
- **Decided: a spike alert auto-resolves 14 days after it was raised**, regardless of what the price does next. Manual dismissal still works before then. (A spike has no symmetric "price recovered" condition the way a price target does.)

## Stretch: live TCGplayer / Card Kingdom pricing

Scryfall's bulk prices are ~24h stale and sourced from TCGplayer/Cardmarket/Cardhoarder — fine for trends, not real-time. TCGplayer's partner API needs an approved developer account and OAuth; Card Kingdom has no public API. Separable and optional; don't block the rest of the phase on it. If pursued: an on-demand "check live price" action per printing, not a background job.

## Verification

1. `GET /api/v1/cards/:printingId/price-history` returns a valid empty-history response for a printing with no rows — not an error.
2. A deck's value chart includes a "need to buy" card that was never want-listed — confirms the `COALESCE` fallback reaches unpinned deck slots.
3. After the `alerts` rebuild, `migrations.test.ts` passes unmodified.
4. Two consecutive daily rises past the threshold for one printing produce exactly one active alert.
5. A `price_spike` alert raised 14 days ago is resolved by the next sync; one raised 13 days ago is not.
6. The existing whole-collection `ValueChart` renders unchanged.

## Out of scope

Retroactive history for dates before this phase ships — `printing_price_history` only has rows from when the sync first wrote them.
