# Phase 26 — Allocation Contention

**Depends on Phases 22 and 24.** Revised at build time (2026-09-11): between spec and
build, `quantity_from_collection` became a derived figure — `reconcile.ts` sets it to what
the collection can spare, first come first served, on every write — and two sections below
were written for a claim the user set by hand. They are rewritten here rather than
patched in code, so the definitions match what ships.

## Why

`alerts.kind` already allows `'allocation_conflict'` — the schema anticipated this and
nothing raises or displays one. Meanwhile `CLAUDE.md` says a deck wanting more copies
than are available should be flagged visually rather than blocked, which is right, but a
flag on one card in one deck doesn't answer the question you actually have: *which of my
decks are fighting over the same 40 cards, and what happens if I break one up?*

That question is the difference between buying a second copy of a staple and moving the
one you own.

## Scope

### The contested set

The original definition was over-allocation alone:

```
Σ quantity_from_collection > owned_qty − tradeListed_qty        (reserving decks)
```

Under the derived claim that almost never holds. Reconciliation is first come first
served: the deck that claimed a scarce copy keeps it, the next deck's claim comes out
as 0, and the sum stays within what you own. The fight is just as real — the second
deck *wants* the copy and can't have it — it is simply no longer visible as a sum. So
a card is contested when **either** of two things is true:

1. **Over-allocation** — the sum above. It still happens, and means the ground moved
   under a built deck after it made its claim: a trade shipped the copy out (the
   outgoing path deliberately does not reconcile, so this is visible), a copy was put on
   a trade list, a deck's status changed, or a setting flipped. Phase 0's trade alert
   already fires on exactly this and its tests must keep passing.
2. **Contention** — a deck in a reserving status is short of the card (Phase 24's
   `missing > 0`) **while another reserving deck holds copies of it**
   (`reservedByOthers > 0`). This is Phase 24's per-row `contested` flag, lifted to the
   collection: the same figure, from the same engine, never re-derived.

A deck that is merely incomplete — wants 4, you own 2, nobody else holds any — is
neither. It reads "Buy 2" and stays out of this set; alerting on every unfinished deck
would be noise.

A contested card's **shortfall** is `Σ (required − proxied)` across reserving decks minus
`owned − tradeListed` (the trade-list term dropping out when
`tradelist_reduces_available` is off): the copies that would have to appear for every
reserving deck to be whole. Not `Σ missing` — in the over-allocated case every deck reads
short of the same copy and that sum double-counts it.

**Don't put the status filter in a view, and don't re-derive.** An earlier draft added
`v_allocation_contention` with `d.status IN ('building','assembled')` hardcoded, which
silently disagrees with `RESERVING_STATUSES` the moment `brews_reserve_copies` is turned
on. `contention.ts` computes the set from `buildability.ts`'s engine (which already
excludes each deck's own claim, drops exempt basics and the maybeboard, and honours every
setting) plus `allocation.ts`'s numbers for the over-allocation test. There is no third
formula.

### Reassignment

Move a claim from one deck to another: decrement `quantity_from_collection` on the
losing deck's slot, increment on the winning one, in one transaction, bounded by each
slot's `quantity − quantity_proxied`. This is the one-tap action the screen exists for.

This survives the derived claim as written — and it is the *only* hand-write that does.
Reconciliation never takes a copy from a deck already holding it, only fills what is
spare; after a reassignment the winner holds the copy, so the loser's next
reconciliation finds nothing spare and leaves its 0 alone. Two constraints follow:
`quantity ≤` the loser's current claim (you can only give what you hold), and both decks
must be in a reserving status (a brew holds nothing, so a copy "given" to it would be
reclaimed by the loser on its next edit).

The losing deck's slot becomes partially uncovered, which Phase 24 immediately reflects
as a shortfall and a cost. That's correct and should be shown in the confirmation:
"Deck A drops to 96%, +$4 to finish."

### Teardown simulation

`GET /api/v1/allocation/what-if?disassemble=<deckId>` — call Phase 24's
`buildabilityForDecks(undefined, statusOverrides = { [deckId]: 'disassembled' })` and
return the deltas against the unoverridden figures. "Breaking up Mono-Red finishes
Goblins and moves Slivers from 88% to 94%."

Pure computation, no writes, no transaction to roll back. Do not implement this by
changing the status and rolling back — the overrides parameter exists so nothing ever
touches `decks`.

### Alerts

Raise `kind = 'allocation_conflict'` with `dedupe_key = 'allocation_conflict:<oracle_id>'`
when a card enters the contested set, and resolve it when the card leaves the set,
which re-arms it — the same pattern `price_target` uses. Phase 0 already raises this
alert from the trade path with `subject_type = 'oracle_card'`; keep that, and route the
trade path through the one function below so there is one definition. The payload keeps
Phase 0's `{ owned, allocated, short }` and adds the holders and the short decks.

**When it's evaluated.** The contested set changes only when one of its inputs changes,
so recompute it — for the affected oracle cards only, not the whole collection — from
one function, `contention.reconcileAlerts(oracleIds)`, called at these points:

| Trigger | Where the call goes |
| --- | --- |
| `deck_cards` insert / update / delete (quantity, `quantity_from_collection`, `quantity_proxied`, board) | `DeckStore`, after the write |
| Deck status change | `PATCH /decks/:id` handler, after Phase 22 sets status — pass every oracle id in the deck |
| Deck delete | cascade already releases the claim; call with the deck's oracle ids *before* the delete |
| `collection_items` quantity change, lot delete, location archive/unarchive | `CollectionStore` |
| Trade completion (moves copies in and out) | `TradeStore.complete`, after the collection writes |
| `trade_list_items` add / quantity change / delete | `TradeListStore` |
| Phase 25 run completion (reconciles the claim and may move lots) | via `reconcile.ts` |
| Phase 26 reassignment | `contention.ts`, after the transaction commits |
| An allocation setting changes (`allocation_ignores_basics`, `brews_reserve_copies`, `tradelist_reduces_available`) | `PUT /settings`, for every card in a reserving-board slot |

Most of these already funnel through `reconcile.ts` — every `DeckStore` and
`CollectionStore` write that can change a claim ends there — so that is where the alert
evaluation hangs for those rows, and the explicit calls are only for the paths that
deliberately do *not* reconcile claims: the trade's outgoing path, trade-list changes, a
deck delete, a reassignment, a settings change.

A trigger you forget is a stale alert, so put the list above in a comment on
`reconcileAlerts` and add a test per row. Do not use SQLite triggers for this — the rule
depends on `app_settings` and `RESERVING_STATUSES`, which live in code.

The deck that "pushed it over" is the deck whose write triggered the reconcile; when
the trigger is a collection change, use the deck with the largest claim.

No new alert kind, so no CHECK-constraint migration. Do not raise one alert per deck per
card; the dedupe key is per oracle card for a reason.

## Schema

None. Reassignment writes to existing columns; alerts use the existing table.

## Server

`server/src/decks/contention.ts`:

- `GET /api/v1/allocation/contention` — contested cards with owned, trade-listed,
  reserved, shortfall, and per-card the decks holding claims with quantities, deck
  names and statuses. Sorted by shortfall descending, then card price descending: the
  expensive fights first.
- `POST /api/v1/allocation/reassign` — `{ oracle_id, from_deck_id, to_deck_id, quantity }`,
  transactional, validated against both slots' `quantity − quantity_proxied`. Returns
  both decks' Phase 24 figures.
- `GET /api/v1/allocation/what-if?disassemble=<deckId>`.
- `reconcileAlerts(oracleIds)` — exported for the callers in the table above.

## Client

- **Contention screen** reachable from the deck list and from the contested count in
  Phase 24's deck header strip. Each row: the card, `owned 1 / claimed 3`, and the three
  decks with a "give it to…" control.
- Confirmation on reassign shows both decks' buildability before and after.
- **Held by** line on any card detail view: which decks claim it, how many, where the
  unclaimed copies physically live, and any trade-list quantity — this is the line
  `CLAUDE.md` describes as "Deck A ×2 (home: Blue Tackle Box), Binder 3 ×2 available"
  and it should read exactly like that.
- Teardown simulation offered from a deck's overflow menu: "What would breaking this up
  free?"

## Verification

- Own 1 copy, two `assembled` decks each claiming 1: the card appears in the contested
  set with shortfall 1. Set one deck to `brew` and it leaves the set.
- Turn `brews_reserve_copies` on: the `brew` deck's claim counts again and the card is
  contested again, with no code path that consults a hardcoded status list.
- Own 2 copies, 1 on a trade list, two `assembled` decks claiming 1 each: contested
  with shortfall 1 while `tradelist_reduces_available` is on; not contested with it off.
- Reassigning that copy moves the claim, and both decks' Phase 24 figures update in the
  same response.
- Reassigning more than the target slot's `quantity − quantity_proxied` is rejected;
  nothing is written to either deck.
- A `maybe`-board claim never contests.
- One alert per contested card, not per deck; resolving the contention resolves the
  alert; re-creating it raises a fresh one rather than being swallowed by the dedupe key.
- Every trigger in the table above is exercised by a test that creates contention via
  that path and asserts the alert exists, then removes it via the same path and asserts
  it's resolved. Completing a trade that ships away the only copy of a doubly-claimed
  card raises the alert.
- The what-if endpoint writes nothing — assert `decks.updated_at` is untouched for every
  deck after calling it, and that no alert is raised or resolved by it.
- What-if deltas match reality: run the simulation, actually disassemble the deck, and
  the recomputed buildability figures agree exactly.
