# Phase 13 — Sales & Event Costs

Like Phase 12, more of this is designed than built. The schema anticipated standalone sales from the start; it has no door in yet.

## Already built — confirm, don't rebuild

- **`collection_disposals` supports a sale with no trade.** `disposal_kind IN ('trade','sale','gift','loss')`, `unit_proceeds_usd` documented as "cash actually received," a `counterparty` field for "buyer or recipient when there is no trade record," and a nullable `trade_id`.
- **The P&L math is sale-aware.** `v_collection_pnl` already separates `cash_proceeds_usd` and `cash_realized_gain_usd` (both `WHERE disposal_kind='sale'`) from the trade-inclusive `realized_gain_usd`.
- **`CollectionStore.value()` already spreads `v_collection_pnl` into the `/api/v1/collection/value` response.** The Collection page just never renders those fields.
- **The gap is the write path.** Only `server/src/trades/store.ts` writes `collection_disposals` rows.

## Schema

Next unused `user_version` at build time. One `ALTER TABLE events ADD COLUMN entry_fee_usd REAL` — a simple addition, not a rebuild.

## New: log a sale directly

- `POST /api/v1/collection/items/:id/sell` and a store method that decrements the lot the same way trade completion does and writes a `collection_disposals` row: `disposal_kind='sale'`, `unit_proceeds_usd`, optional freeform `counterparty`, notes, date.
- **Selling an allocated or trade-listed copy** reuses trade completion's handling: the `trade_list_clamped` alert already fires when a completion reduces a lot below what a trade list expects; a sale that breaks a deck allocation raises `allocation_conflict`. Call `disposeFromLot` in `trades/store.ts` (the shared decrement + disposal + clamp + alert sequence) with `conflictMode: 'alert'`. Never fail silently; never block the sale.
- Client: a "Sell" action beside the existing "For trade" toggle in the collection detail panel. A small form — quantity, proceeds, date, counterparty, notes — the same shape as `TradeItemDialog.tsx`.

## New: reversing a sale

Phase 6's long-press undo doesn't cover this — `startPress` in `CollectionPage.tsx` only calls `removeOne` on a tile you just added and never touches `collection_disposals`. Add a "Reverse" action on a sale disposal that deletes the row and restores the lot's quantity in one transaction. A straight undo of the row, not an edit history.

## New: surface what's already computed

Add to the Collection page's existing value panel (currently total value, cost basis, unrealized gain):

- **Realized gain to date** (`realized_gain_usd`) — every disposal with known cost and proceeds, trades included. Trade-driven appreciation already flows here on completion; it's just invisible.
- **Cash from sales** (`cash_proceeds_usd`) and **cash realized gain** (`cash_realized_gain_usd`) — the sale-only subset. Visually distinct from the trade-inclusive figure.

## New: event costs

- `events.entry_fee_usd` — spend not already captured as card cost basis through a linked cost pool (a pure entry fee, or a prerelease ticket on top of the packs). Input: the event create/edit form from Phase 11.
- An event's total cost = `entry_fee_usd` (if set) + linked `import_batches.total_cost_usd` (if any). Don't double-count — pack cost already flows into card cost basis through the pool.
- Roll up across all events into a lifetime "spent on events" figure beside the sales and realized-gain figures — money in via sales, money out via packs/entries, appreciation via trades, in one place.

## Verification

1. Logging a sale of quantity 2 from a 5-count lot leaves a 3-count lot and exactly one new `collection_disposals` row with `disposal_kind = 'sale'`.
2. `GET /api/v1/collection/value` reflects the sale's `cash_proceeds_usd` immediately.
3. Selling the last copy of a lot allocated to a deck raises `allocation_conflict`; selling below a trade list's quantity raises `trade_list_clamped`. Neither blocks the sale.
4. Reversing a sale restores the lot's quantity, removes the disposal row, and `cash_proceeds_usd` returns to its pre-sale value.
5. An event with only `entry_fee_usd` set, only a linked batch, or both shows the correct total in each case.
6. `migrations.test.ts` passes.

## Out of scope

Editing a sale's fields after the fact — a wrong amount or date is fixed by reversing and re-entering.
