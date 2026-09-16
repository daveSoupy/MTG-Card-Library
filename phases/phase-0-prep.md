# Phase 0 — Engineering Prep (not sequenced; build before Phase 9)

Housekeeping on the shipped Phases 1–6 so that Phases 7–21 land on a codebase ready for them. No user-visible features. Six independent items; each is its own commit. Build this before Phase 9, since 9, 10, 11, 13, and 16 all edit the files split here.

## 1. Split the two oversized components

`CollectionPage.tsx` (885 lines) and `DeckBuilder.tsx` (598 lines) are edited by most later phases. Extract, with no behavior change:

- From `CollectionPage.tsx`: `CollectionValuePanel.tsx` (totals + `ValueChart`), `AddBySetTab.tsx` (`.entry-tile` grid and set picker), `CostPoolControls.tsx` (open/close/bump, the `costMethod === 'draft'` path), `OwnedGrid.tsx` (`.card` tiles, foil overlay, `startPress`/`removeOne`). `CollectionPage.tsx` becomes tabs + shared state.
- From `DeckBuilder.tsx`: `DeckTile.tsx` (`.deck-tile`, `.tile-controls`), `DeckRow.tsx` (`.deck-row`, `onPreview`), `DeckPanes.tsx` (the `.decklist` / `.picker` / `.stats-pane` layout shell). `DeckBuilder.tsx` keeps data loading and the list/cards toggle.

Keep every CSS class name; later phase docs reference them.

## 2. DOM test tooling

The four web tests are pure logic. Phases 9, 10, and 17 verify DOM behavior. Add **Vitest + @testing-library/react + jsdom** to `web/` with one smoke test per extracted component above (renders without crashing, one interaction). `npm test` at the root runs both workspaces.

## 3. Trade conflicts: alert path as the default

`TradeStore.complete()` returns `needsConfirmation` when an outgoing card is deck-allocated, and on `force: true` clamps the deck's allocation. Phase 13 (sell) and Phase 36 (offline replay) need a non-interactive path that never blocks and never edits a deck:

- Add a `conflictMode: 'prompt' | 'alert'` option. `'alert'` completes the trade, leaves deck allocations untouched, and raises one `allocation_conflict` alert per affected card (`dedupe_key = 'allocation_conflict:<oracle_id>'`), resolved automatically when availability catches up. Existing `'prompt'` behavior stays for the web UI.
- Extract the shared sequence — decrement lot, write `collection_disposals`, reconcile trade lists (`trade_list_clamped`), raise allocation alerts — into one store method (`disposeFromLot`) that Phase 13's sell and Phase 36's replay call directly.

## 4. Route hardening

- `app.setErrorHandler` in `server/src/index.ts`: known error classes (`TradeNotDraftError`, not-found, validation) → 4xx with `{ error }`; everything else → 500 with `{ error: 'Internal error' }` and a logged stack. Never return a stack to the client.
- Body validation: add Fastify JSON-schema `schema: { body, params }` to every `POST`/`PATCH`/`PUT` route that currently does `request.body as any` (116 casts across `server/src/routes/`). Numbers must be numbers, ids positive integers, enums from the schema's CHECK lists. A bad body is a 400 before any store method runs. Do this route file by route file; each is its own commit.

## 5. SQLite maintenance

- End of `runSync.ts`: `PRAGMA wal_checkpoint(TRUNCATE)` after the import transaction commits, so a 17-second write with concurrent readers doesn't leave a large WAL behind.
- `close()` in `db/index.ts`: `PRAGMA optimize` before closing.
- Shutdown in `server/src/index.ts`: `sync.stop()` races a 10-second timeout; on timeout, log and `process.exit(1)` rather than hanging.

## 6. Phase-doc alignment check

Grep every `phases/phase-*.md` for the component and function names it references and confirm each exists after the split above (`ValueChart`, `startPress`, `.tile-controls`, `onPreview`, `groupCards`, …). Fix the doc, not the code, where a name moved to a new file.

## Verification

1. Every existing test passes; no CSS class name present before the split is absent after it (diff `grep -oh 'className="[^"]*"'` output before/after).
2. `npm test` at the root runs server and web tests; the web run includes at least one Testing Library test that mounts a component.
3. Completing a trade with `conflictMode: 'alert'` against a deck-allocated card completes, leaves `deck_cards` unchanged, and creates one `allocation_conflict` alert; completing the same shape with `'prompt'` still returns `needsConfirmation`.
4. `POST /api/v1/decks/:id/cards` with `quantity: "four"` returns 400 and writes nothing.
5. A route that throws an unexpected error returns `{ error: 'Internal error' }` with no stack, and the stack appears in the server log.
6. After a full sync, the `-wal` file is under 1 MB.
7. `SIGTERM` during a running sync exits within 10 seconds.

## Out of scope

Anything user-visible. Snow basics stays in Phase 8.
