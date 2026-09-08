# Phase 14 — Shopping Cart Export

Smallest phase — the mechanism already exists and is proven.

## Already built

`GET /api/v1/decks/:id/export` returns a TCGplayer mass-entry URL (`tcgplayerMassEntryUrl` in `server/src/porting/decklist.ts`, which handles the too-long-for-a-URL case by telling the client to fall back to copy/paste) and a Card Kingdom deck-builder link (`CARD_KINGDOM_DECKBUILDER`), for the **whole decklist**. `DeckExportDialog.tsx` renders both as buttons; `decklist.test.ts` covers the URL builder.

## New: shopping-list-only cart ("Complete this deck")

What you want to buy is what you're *missing*. The shopping list (`GET /api/v1/decks/:id/shopping-list`, `server/src/collection/shopping.ts`) already knows exactly which cards and quantities.

- Shape `ShoppingListEntry` (`needed`, `name`) into the `ExportCard[]` shape the whole-deck export uses, and call `tcgplayerMassEntryUrl` / `CARD_KINGDOM_DECKBUILDER` against just those entries. No new URL logic.
- Add `tcgplayerUrl` / `tcgplayerTooLong` / `cardKingdomUrl` to the shopping-list response.
- Render the same two buttons from `DeckExportDialog.tsx` inside `ShoppingListPanel.tsx`.

## Verification

1. The shopping-list TCGplayer URL contains only cards where `needed > 0`.
2. A shopping list long enough to exceed the URL limit reports `tcgplayerTooLong` — confirms the same length check is reused.
3. The Card Kingdom link from a shopping list is the same static builder URL the whole-deck export produces.

## Out of scope

Live prices or placing an order — Phase 12's stretch goal.
