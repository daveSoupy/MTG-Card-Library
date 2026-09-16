# Phase 11 — Game & Draft Log

Two things travel together here: match results, and "what did I actually draft." The schema already has a head start on the second half.

## What already exists

- **The Draft cost-pool.** `CostPoolControls.tsx` (used from `AddBySetTab.tsx`) has a `costMethod === 'draft'` path that opens a pool (`import_batches`, doubling as a cost pool via `total_cost_usd` / `split_method`) defaulting to 3× a booster's price, split across whatever's added while it's open. This already answers "what did I draft and what did it cost per card."
- **Formats are data-driven; `draft` and `sealed` aren't seeded.** `formats` is the table Phase 2 reads for every legality rule. Add `draft` and `sealed` as seeded rows (min deck size 40, no singleton, no sideboard cap). **Legality checking needs an explicit skip:** `checkLegality()` in `server/src/decks/validate.ts` and the query in `decks/store.ts` join `card_legalities` by `format_code`, and Scryfall never publishes legalities for draft or sealed. Without a skip keyed off `format_code IN ('draft','sealed')`, every card in a draft deck validates as illegal.
- **Decks already support freeform tags** (`deck_tags`) and `home_location_id`. A pool built into a playable deck is a normal Deck row with `format_code = 'draft'`.

Missing: the connective tissue tying one draft night's cost pool, the deck built from it, and the games played with it into one record.

## Schema

Next unused `user_version` at build time. Adds `events`, `games`, and the two format rows in one migration.

## New: `events`

One row per draft, sealed pool, prerelease, or any occasion worth remembering as a unit.

- `id`, `name` (freeform — "FDN Draft Night"), `format_code` (FK to `formats`), `event_date`
- `deck_id` — nullable FK to `decks`, `ON DELETE SET NULL` (deleting the deck detaches it; the event's history survives)
- `import_batch_id` — nullable FK to `import_batches`, `ON DELETE SET NULL` — the cost pool that acquired the cards

Total spend and card list are derivable through these links; nothing is duplicated onto the event row.

## Companion fix: reopening a closed cost pool

`openCostPool()` always inserts a new `import_batches` row; nothing lets more cards be added to a pool once closed, so a draft entered across two sittings can only link one batch. The resplit logic already handles the hard part — `updateCostPoolTotal()`/`resplitCostPool()` re-divide a batch's total across every card tied to its id regardless of when each was added. Only the way back in is missing:

- Add `reopenCostPool(id)` alongside `openCostPool`/`closeCostPool` in `server/src/collection/store.ts`: repoint `OPEN_COST_POOL_ID` at a past batch **and restore `OPEN_COST_POOL_SET`** (the companion setting holding the pool's set-scope, which `closeCostPool` clears with it).
- `fetchImportBatches()` already lists every past batch. Add a "Reopen" action next to "Undo," available only for batches with `total_cost_usd IS NOT NULL`, behind a confirmation showing what's being reopened ("closed on March 5 with 43 cards — add more now?").
- Once reopened, cards added get the same batch id; bumping the total resplits across the combined set.

## New: `games`

The match log. Most games won't belong to an event.

- `id`, `event_id` (nullable FK, `ON DELETE SET NULL`), `deck_id` (nullable FK to `decks`, `ON DELETE SET NULL`), `deck_name`, `played_at`
  - **Built as `SET NULL`, not `CASCADE`.** A game that was played stays played after the deck is dismantled, which is also what Verification 4 below asks for. `deck_name` is NULL while the deck exists — the deck row is the live copy of its name, renames included — and a `BEFORE DELETE` trigger on `decks` stamps it on the way out, so a detached game still says what it was played with. A detached game has no format, so it drops out of deck- and format-narrowed record views while still counting in the overall one.
- `opponents` — freeform text, comma-separated for a multiplayer pod. One row per game from the tracked deck's perspective, not per opponent. Same convention as trade counterparties.
- `result` ('win' / 'loss' / 'draw')
- `games_won` / `games_lost` / `games_drawn` (nullable ints, for a Bo3 breakdown)
- `round_number` (nullable — only meaningful inside an event)
- `notes`

## The constructed game (the common case)

Open the deck, log a game: opponent(s), result, notes. No event, no cost pool, no format restriction — `games.deck_id` accepts any deck.

## The draft, end to end

1. Create an Event (name, format, date).
2. Open the Draft cost-pool flow in Collection as normal; link the resulting `import_batches` row to the Event.
3. Build the pool into a deck (`format_code = 'draft'`); link that deck to the Event.
4. Log each round's game against the Event.
5. The Event's summary view shows spend (linked pool), the built list (linked deck), and the record (aggregated from `games`).

## New: building a limited deck adds the cards to the collection

Step 3 needs one real change to the deck-mutation path, plus one exception.

**Add-and-allocate mode for limited decks.** Today's add-to-deck never creates collection rows — it marks a slot "from my collection" or "need to buy." For a deck whose `format_code IN ('draft','sealed')`, adding a card does both: insert a `collection_items` row (at the deck's `home_location_id` if set, tagged with the open cost pool's batch id if one is open) and add the deck slot as from-collection, allocated from that new lot. This is a branch in the existing add-card store method keyed on the deck's format, not a parallel path — legality, quantity increment, and validation all behave as they do today. Phase 16's OCR "Collection + Deck" scan target reuses this same branch.

**Boards.** The 40 played cards go in the deck's existing `main` board; everything else from the pool goes in `side`. No new board type.

**Basic lands are the one exception.** Every `isBasicLand` card lands in `main` as a normal deck slot but creates no collection row and no allocation — in paper limited, basics come from the venue's land station, not the packs. Non-basic lands (`isBasicLand` false, type line says land) follow the normal add-and-allocate path. `isBasicLand` is already precomputed on every card; this is one boolean check.

No schema change for any of this — `deck_cards.board` already supports `main`/`side`.

## New: the event creation/edit form

Fields: `name`, `format_code` (a picker over `formats`, the same control decks use), `event_date`, plus `deck_id` and `import_batch_id` as optional links set at creation or later from the deck/collection side. Edit uses the same form. Phase 13's `entry_fee_usd` lands here.

## Reporting

A record view filterable by format / deck / event / date range. A lifetime record on each deck's own page (e.g. "12–4"), pulled from `games.deck_id`.

## Verification

1. A deck with `format_code = 'draft'` and arbitrary card contents passes validation with zero legality errors.
2. Reopening a closed cost pool restores both `OPEN_COST_POOL_ID` and `OPEN_COST_POOL_SET`; a card added immediately after is scoped to the original session's set filter and tagged with the reopened batch id.
3. Adding a non-basic card to a `draft`-format deck creates a `collection_items` row and an allocated from-collection slot; adding a basic land creates the slot only. Adding a card to a `commander` deck creates no collection row (unchanged behavior).
4. Deleting a deck linked to an event sets `events.deck_id` to NULL; the event and its games remain queryable, each game keeping the deleted deck's name.
5. Logging a multiplayer game with three opponents produces exactly one `games` row.
6. A game logged with no `event_id` appears on its deck's lifetime record alongside event games.
7. `migrations.test.ts` passes.

## Out of scope

- **Pick-by-pick draft tracking** (P1P1, full pack contents) — "cards drafted" is served by the main/sideboard split.
- **Opponent accounts.** Opponents stay freeform text.

## Note for Phase 13

Phase 13's event costs hang off this `events` table — don't invent a second one.
