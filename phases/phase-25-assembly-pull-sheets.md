# Phase 25 — Assembly, Pull Sheets, and Disassembly

**Depends on Phases 22 and 24.**

The physical half of the app. Everything upstream tells you *how many* copies you own.
This tells you which binder to open, in what order, and puts the cards back afterwards.

## Why

Allocation is stored as a per-slot count, not a link to a lot — a deliberate choice
(`CLAUDE.md`, Section 4: it makes "deleting a deck releases its allocation" a cascade
rather than a fix-up pass, with no way to leak). The cost is that the app can say "you
own 2 Sol Rings" and cannot say **where they are**. So assembling a deck means standing
in front of a shelf with a decklist on a phone, which is the manual work this app was
supposed to remove.

Fix it without breaking the model: resolve allocations to specific lots **at assembly
time**, as a run, and record the result. The steady-state schema stays count-based.

## The resolver

`resolveLots(deckId)` picks, for each needed oracle card, which `collection_items` lots
to pull from. Deterministic, ordered, and explainable — the user has to trust it while
holding a binder.

Candidate lots: any lot whose printing shares the card's `oracle_id`, from a
non-archived location (the same rule as Phase 22's `ownedFor`), with quantity remaining
after earlier picks in the same run.

Preference order:

1. Lots **not** referenced by `trade_list_items` — don't pull a card you've offered to
   someone. Fall back to them only if nothing else covers the slot, and flag it in the
   output. (With `tradelist_reduces_available` on, Phase 24 already counts these copies
   as missing, so the fallback only fires when that setting is off.)
2. Lots matching the slot's `preferred_printing_id`, if pinned.
3. Lots already in the deck's `home_location_id` — they may already be in the box.
4. Cheapest acceptable copy: lowest `price_override ?? price_usd` for its finish,
   `nonfoil` before `foil`/`etched`. The collectible copy stays in the binder; the
   beater goes in the deck.
5. Poorer condition first among equals, `DMG` last.
6. Tie-break on lot `id`, so two runs over an unchanged collection produce identical
   sheets.

Basics are skipped entirely when `allocation_ignores_basics` is on — you have a pile of
Islands and don't want them on a checklist.

## The pull sheet

The output, grouped the way a shelf is actually organised:

- Group by `storage_locations.sort_order`, then name.
- Within a location: set `released_at` descending, then `set_code`, then
  `collector_number_num`, then `collector_number_suffix` — the order cards sit in a
  set-sorted binder. This is what `collector_number_num` was split out for.
- Each line: quantity, card name, set code + collector number, finish, condition, and
  the destination.
- A trailing **Not available** section: missing cards with their cost, straight from
  Phase 24, so the sheet doubles as the buy list.

Checkable line by line, and the check state survives a page reload mid-pull — you will
be interrupted halfway through a binder.

## Schema

Bump `PRAGMA user_version` to the next unused value.

```sql
CREATE TABLE deck_assembly_runs (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('assemble','disassemble')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','completed','cancelled')),
  moves_lots INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  completed_at TEXT,
  notes TEXT
);

CREATE INDEX idx_assembly_deck ON deck_assembly_runs(deck_id, started_at DESC);

CREATE TABLE deck_assembly_items (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES deck_assembly_runs(id) ON DELETE CASCADE,
  oracle_id TEXT NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE RESTRICT,
  printing_id TEXT REFERENCES card_printings(id) ON DELETE SET NULL,
  collection_item_id INTEGER REFERENCES collection_items(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  from_location_id INTEGER REFERENCES storage_locations(id) ON DELETE SET NULL,
  to_location_id INTEGER REFERENCES storage_locations(id) ON DELETE SET NULL,
  picked INTEGER NOT NULL DEFAULT 0,
  unavailable INTEGER NOT NULL DEFAULT 0,
  snapshot_name TEXT,
  snapshot_set_code TEXT,
  snapshot_number TEXT,
  snapshot_finish TEXT,
  snapshot_condition TEXT,
  snapshot_language TEXT,
  snapshot_acquired_at TEXT,
  snapshot_acquired_unit_cost REAL,
  snapshot_acquisition_kind TEXT,
  snapshot_acquired_from TEXT
);

CREATE INDEX idx_assembly_items_run ON deck_assembly_items(run_id);
```

Match the `printing_id` type to whatever `card_printings.id` actually is in
`schema.sql` — don't assume TEXT.

`from_location_id` is the load-bearing column: it's how disassembly knows where each
card came from. `collection_item_id` is `SET NULL` because the source lot legitimately
disappears when it hits zero, exactly as `trade_items.source_collection_item_id` does.

**The snapshot columns are not decorative.** The name/set/number ones keep an old run
readable, as on `trade_items`. The finish/condition/language/cost-basis ones are what
disassembly *matches on* — see below. Once a lot has been moved and merged, the item
row is the only record of what was moved, so it has to carry enough to find it again.

Setting, in `BOOLEAN_SETTINGS`:

- `assembly_moves_lots` — default **`false`**. Off, a run is a checklist and touches no
  data. On, completing a run physically relocates lots to the deck's home location. Off
  by default because the safe version is useful on its own and the destructive version
  should be a decision.

## Server

`server/src/decks/assembly.ts`.

- `POST /api/v1/decks/:id/assembly` — opens a run, resolves lots, returns the grouped
  sheet. A deck may have only one open run; return the existing one rather than a
  second.
- `PATCH /api/v1/assembly/:runId/items/:itemId` — `picked`.
- `POST /api/v1/assembly/:runId/complete` — see "Completing a run" below.
- `POST /api/v1/decks/:id/disassembly` — opens a `disassemble` run from the most recent
  completed `assemble` run. See "Disassembly" below. Completing it sets the deck to
  `disassembled`.
- `POST /api/v1/assembly/:runId/cancel`.

### Completing an assemble run

Three things happen, in one transaction:

1. **Status** → `assembled`, `status_changed_at` set.
2. ~~**Declared allocation is written from what was actually picked.**~~ **Superseded
   at build time (2026-09-11).** Between spec and build, `quantity_from_collection`
   stopped being something the user sets: `server/src/decks/reconcile.ts` now derives it
   — "claim what the collection can spare" — and recomputes it on every deck and
   collection write. So the contention Phase 26 needs is already true for every deck
   without this step, and a lower figure written here for an un-picked line would be
   raised straight back by the next edit, erasing the one thing it recorded. Completion
   therefore **reconciles** the claim like any other write, and the shortfall lives on
   the run instead: `RunSummary.notFound` lists the un-ticked lines of a completed
   assemble, and the deck header shows "N not found on last pull" from it for as long as
   that run is the latest thing that happened to the deck. Phase 24's numbers do not
   show this gap — from the collection's point of view there is none — which is exactly
   why the run has to.
3. **Lot moves**, only when `assembly_moves_lots` is on.

**Moving lots must preserve cost basis.** A move is: decrement the source lot; insert or
merge a lot at the destination carrying the same `printing_id`, `finish`, `condition`,
`language`, `acquired_at`, `acquired_unit_cost`, `acquisition_kind`, `acquired_from`.
Merge only when *all* of those match, per the app-level merge rule in the
`collection_items` comment — a NULL cost never merges. A move that mints a new lot with
no cost basis silently destroys P&L history, so this is the part to write a test for
first.

**Trade-list rows on a moved lot.** `trade_list_items` references a specific lot. When
the resolver has fallen back to a trade-listed lot and the move would take the lot to
zero, do not let the FK fail or the row dangle. Rule: decrement `trade_list_items.quantity`
by the moved amount (a card that went into a deck is no longer on offer), delete the
trade-list row if it reaches zero, and record `unavailable = 0, notes` on the item so
the completion summary can say "1 Sol Ring removed from trade list Binder Sale." Check
the actual FK action on `trade_list_items.collection_item_id` in `schema.sql` first; if
it's `RESTRICT`, the decrement-first order matters.

**Allocation math stays location-agnostic.** Moving a lot into the deck's home location
must not also count as a reservation — that would double-count and drop `available`
below zero. The lot's location is where it *is*; `quantity_from_collection` is what's
*claimed*. Assert this in a test, because it's the bug this design invites.

### Disassembly

Opens a `disassemble` run built from the most recent completed `assemble` run's items.
For each assemble item, the disassemble item has `to_location_id = from_location_id` of
the original (falling back to the `is_default` location if that location was archived
or deleted since), and `from_location_id = deck.home_location_id`.

**The original lot may no longer exist.** With `assembly_moves_lots` on, the source lot
may have hit zero and been deleted, and the moved copies may have *merged* into an
existing lot at the home location. So "same lots" is not a thing that can be found by
`collection_item_id`. Instead, the return move finds its source by matching:

```
location_id        = deck.home_location_id
printing_id        = item.printing_id
finish             = item.snapshot_finish
condition          = item.snapshot_condition
language           = item.snapshot_language
acquired_at        = item.snapshot_acquired_at
acquired_unit_cost = item.snapshot_acquired_unit_cost  (NULL matches NULL)
acquisition_kind   = item.snapshot_acquisition_kind
acquired_from      = item.snapshot_acquired_from
```

— exactly the merge key, so the return move is the inverse of the forward move. It
decrements that lot by `item.quantity` and re-mints (or merges) at `to_location_id`
with the identical cost basis. If no matching lot exists at the home location (the user
sold it, or edited the lot by hand), mark the item `unavailable = 1` with a note and
return the rest; never invent a lot from nothing.

With `assembly_moves_lots` off, disassembly is a checklist in reverse and touches no
`collection_items`. Either way, completing it sets `status = 'disassembled'` and
reconciles the claim, which — being a function of the collection and the *other* decks,
not of this deck's status — comes out unchanged. Phase 22's rule that a status change
never rewrites the claim now falls out of the derivation rather than being enforced.

## Client

- "Assemble" button on the deck header, prominent when Phase 24 shows high buildability.
- Pull sheet as a one-handed phone view: big checkboxes, current location as a sticky
  header, progress count. This gets used standing up, holding a binder.
- Completion summary: pulled, proxied, still missing, trade-list rows adjusted, cost of
  the remainder with a one-tap "add to want list."
- "Disassemble" on an assembled deck, showing where each card goes back.
- Run history on the deck, read-only.

## Verification

- A deck whose cards sit in three locations produces a sheet with three groups, each
  internally sorted by set then collector number.
- Two runs over an unchanged collection produce identical sheets, line for line.
- A card available in both a binder lot and a foil lot picks the cheaper non-foil one.
- A card whose only lot is on a trade list is flagged, not silently pulled.
- Completing a run reconciles `quantity_from_collection` like any other write; a deck
  whose slots were all at 0 before assembly is fully claimed after, because the
  collection can spare every copy it pulled.
- Un-picking one line before completing records that copy as not found **on the run**,
  where it survives a later edit to the deck; the claim itself reads what the collection
  can spare, and the deck header says "1 not found on last pull" from the run.
- With `assembly_moves_lots` off, completing a run leaves `collection_items` byte-identical.
- With it on: the source lot decrements, the destination lot carries the identical
  `acquired_unit_cost` and `acquired_at`, and total collection value and cost basis are
  unchanged before and after.
- Moving into a home location that already holds an identical lot merges; moving a
  copy with a different `acquired_unit_cost` does not merge and creates a second lot.
- After a move, `available` for those cards is unchanged — the move did not create a
  second reservation.
- Moving a trade-listed lot to zero decrements or deletes the trade-list row and leaves
  no `trade_list_items` row pointing at a missing lot.
- Disassembling returns every lot to its original location; a round trip of
  assemble → disassemble leaves the collection in its starting state **including the
  merge case**: seed the home location with an identical lot first, assemble,
  disassemble, and assert the home lot is back to its seed quantity and the original
  binder lot is restored with its cost basis.
- Disassembling after the home-location lot was deleted by hand marks that item
  unavailable and completes the rest.
- Deleting a deck with an open run cascades cleanly and leaves no orphan items.
