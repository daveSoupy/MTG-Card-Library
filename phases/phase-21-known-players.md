# Phase 21 — Known Players: Playgroup Collections & Want Matching

Comes after every other phase. A deliberately lighter alternative to multi-user: no accounts, no login, no `user_id` on any existing table. Friends' collections and want lists are read-only snapshots you import, the way MTG Burrow layers playgroup search on top of Moxfield without a shared account system.

## Why not full multi-user

A `user_id` column on roughly two dozen tables, a rewrite of every route and store method, and per-user `app_settings` — a foundational redo, not a phase. This gets "who in my playgroup has this card" without any of that, at the cost of one limitation: a known player's data is only as fresh as their last export.

## Schema

Next unused `user_version` at build time — confirm the actual `PRAGMA user_version` rather than assuming a build order.

```sql
CREATE TABLE known_players (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Deliberately not a reuse of collection_items — a snapshot needs no location,
-- cost basis, allocation, foil, or condition. Just "N copies as of last import."
CREATE TABLE known_player_collection_items (
    id               INTEGER PRIMARY KEY,
    known_player_id  INTEGER NOT NULL REFERENCES known_players(id) ON DELETE CASCADE,
    printing_id      TEXT NOT NULL REFERENCES card_printings(id) ON DELETE RESTRICT,
    quantity         INTEGER NOT NULL,
    imported_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_kpci_printing ON known_player_collection_items(printing_id);
CREATE INDEX idx_kpci_player   ON known_player_collection_items(known_player_id);

ALTER TABLE want_lists ADD COLUMN known_player_id INTEGER REFERENCES known_players(id) ON DELETE CASCADE;
```

(`card_printings` is the actual table name; `ON DELETE RESTRICT` matches what `collection_items` already uses.)

**A re-import replaces the whole snapshot.** Delete every row for that `known_player_id` and insert the new set in one transaction — merging would accumulate phantom cards they've since traded away.

`want_lists.known_player_id` NULL means one of your own lists, unchanged. A set value means a friend's want list, entered by you.

## Getting a snapshot in

- **Phase 5's CSV import** gains a destination selector: "my collection" (default) or a known player. **Friends will hand you Moxfield or Archidekt exports.** Check whether Phase 5's importer already tolerates those column layouts; if it only accepts this app's own export shape, add column mapping for those two formats here. An unsupported format must produce a clear error, never a silent partial import.
- **Phase 16/20's OCR scanner** gets a third target alongside "Collection" and "Collection + Deck": a known player. Same capture pipeline, different target table, no allocation or cost-pool logic.
- **Phase 36's Share Extension** routes a shared CSV, photo, or screenshot to a chosen known player. The extension is Phase 36's deliverable; this phase supplies the destination.

## New: `owned_by:<name>` in search

`is:owned` already exists in the search syntax (`SyntaxHelp.tsx`, `server/src/search/query.ts`). Add `owned_by:<name>` matching against `known_player_collection_items`. Names with spaces use the parser's existing quoting convention (`owned_by:"Alex Chen"`) — confirm how quoted values are handled elsewhere in `query.ts` before adding. Show a badge on search results and the card detail pane listing which known players have the card, with each player's last-import date so it reads as a snapshot.

## New: the matching page

For every want-list item — yours or a known player's — check whether any collection, including your own, has that card available. **"Available" differs by side:**

- A known player: their recorded quantity.
- You: owned minus allocated-to-a-deck, reusing the existing allocation definition. A copy locked into a deck isn't yours to hand over.

One join surfaces both directions:

- "Alex wants Sol Ring — you have 2 available."
- "You want Sol Ring — Alex has one."

Match by **card, not printing or foil**.

**A suggestion, not a transaction.** A match links to starting a trade through Phase 6's trade flow with the counterparty prefilled; it never moves cards itself.

**A dedicated page, not an alert.** Matches only change on re-import, so they don't warrant Phase 12's alert treatment. Each match shows the known player's last-import date.

## Verification

1. Re-importing a known player's collection fully replaces the prior snapshot — a card in the old import but not the new one no longer appears in searches or matches.
2. `owned_by:"Alex Chen"` returns exactly the cards in that player's snapshot.
3. A want-list match shows your own copy as unavailable when it's allocated to a deck, even though owned quantity is nonzero.
4. Deleting a known player cascades to their collection items and any want lists tagged to them, without touching your own.
5. A Moxfield and an Archidekt CSV each import correctly as a known-player snapshot; an unrecognised layout produces a clear "unsupported format" message.
6. `migrations.test.ts` passes.

## Out of scope

- Accounts, login, or any access for known players.
- Live sync with a friend's collection.
- Allocation tracking for known players.
- Automatic trade execution from a match.
- A QR-code transfer mechanism — a real collection is too much data for one code, and a snapshot isn't time-critical; it can wait for wifi.
