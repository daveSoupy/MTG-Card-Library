# Phase 24 — Buildability and Cost to Complete

**Depends on Phase 22.** Buildability computed against dishonest availability is a
confident wrong number, which is worse than no number.

## Why

Nothing in the app answers the question that decides whether you buy cards this week:
*which of my decks could I put on the table tonight?* You can see per-card shortages
while looking at one deck, but there's no figure that says "this brew is 94% there for
$23" — and that figure, on the deck list, sorted, is the whole anti-buying mechanism.

## Definitions

Two different things get called allocation. Keep them apart.

- **Declared allocation** — `deck_cards.quantity_from_collection`. What the user marked.
  It drives contention (Phase 26) and reservation.
- **Computed coverage** — what the collection could actually supply right now. It drives
  everything in this phase.

Buildability uses computed coverage, deliberately, so a deck the user never got round
to marking up doesn't read as unbuildable.

For a deck D, over `board IN ('main','command')` (add `'side'` when the format has a
sideboard; never `'maybe'`), skipping basics when `allocation_ignores_basics` is on:

```
required(c)    = quantity
availableTo(c) = allocation.availableFor(c, excludeDeckId = D)   // Phase 22: owned − tradeListed − reservedByOtherReservingDecks, floor 0
covered(c)     = min(required(c), availableTo(c) + quantity_proxied(c))
missing(c)     = required(c) − covered(c)

buildable_pct     = Σ covered / Σ required
missing_cards     = Σ missing
cost_to_complete  = Σ missing(c) × unitPrice(c)
```

`availableTo` is Phase 22's function, not a re-derivation. If it changes there (trade
lists, archived locations, a new status), this phase follows for free.

`unitPrice(c)`: the slot's `preferred_printing_id` price if pinned; otherwise the
cheapest `price_usd` across that oracle card's non-digital printings; fall back to
`price_usd_foil`; otherwise NULL. Cards that price to NULL are **not** silently treated
as free — return `unpriced_count` alongside the total and let the UI say "$23 + 2
unpriced." Quietly rounding unknowns to zero is how a "$0 to finish" deck ends up
costing $80.

A deck is **contested** where `reservedByOtherReservingDecks(c) > 0` and `missing(c) > 0`
— that's the set Phase 26 acts on. Count it here and expose it.

## Schema

None. This is pure computation over existing tables. Resist the urge to cache it in a
column; the inputs change on every price sync and every collection edit, and a stale
buildability figure is exactly the failure this phase is meant to prevent.

## Server

`server/src/decks/buildability.ts`, on top of Phase 22's allocation module.

- `buildabilityForDecks(deckIds?, statusOverrides?)` — computes **all decks in one
  query set**, not one query per deck. The deck list calls this once. The optional
  `statusOverrides: Map<deckId, status>` exists for Phase 26's what-if simulation and
  must be honoured everywhere the function reads `decks.status`.
- `buildabilityDetail(deckId)` — per-card breakdown: required, owned, available,
  trade-listed, proxied, missing, unit price, holding decks.

Endpoints:

- `GET /api/v1/decks?include=buildability` — adds `buildable_pct`, `missing_cards`,
  `cost_to_complete_usd`, `unpriced_count`, `contested_count` per deck.
- `GET /api/v1/decks/:id/buildability` — the detail rows.
- Sort parameters on the deck list: `sort=buildable_desc | cost_to_complete_asc |
  missing_asc`, resolved server-side.

Wire the missing set into the existing want-list flow: "add everything missing to a
want list" should populate `want_list_items` with `want_list_item_decks` rows carrying
the per-deck quantity, which is what that table was built for. Skip basics. Skip
proxied copies — you don't want to buy a card you've already decided to proxy.

## Client

- **Deck list:** a buildability bar or percentage on each row, plus missing count and
  cost. Sort control with the three orders above. This screen is the deliverable — if
  it's good, the rest of the app gets used differently.
- **Deck header:** a summary strip — `94% • 6 missing • $23 • 2 contested`. Each
  segment taps through: missing → the missing-card list, contested → Phase 26's view
  when built.
- **Card slot:** a chip reading `2/3 owned` or `need 1`, and where the rest live.
- Empty/edge states: a deck with no cards reads "empty," not "100% buildable."

## Verification

- Hand-build a fixture: 10-card deck, 7 covered, 3 missing at known prices. Assert
  `buildable_pct = 0.7` and the exact cost figure.
- Proxying one of the 3 missing raises coverage to 8 and drops cost by that card's
  price.
- A second `assembled` deck reserving a copy shared with D lowers D's coverage; setting
  that deck to `brew` restores it.
- Putting D's only copy of a card on a trade list lowers D's coverage while
  `tradelist_reduces_available` is on.
- A missing card with no priced printing increments `unpriced_count` and adds 0 to the
  total, and the UI shows both.
- Basics never appear in `missing_cards` while `allocation_ignores_basics` is on.
- `board = 'maybe'` cards never affect any figure.
- `buildabilityForDecks` with a `statusOverrides` entry returns the same figures as
  actually changing that deck's status and calling it without overrides.
- "Add missing to want list" produces one `want_list_items` row per missing card with a
  matching `want_list_item_decks` quantity, and re-running it doesn't duplicate rows —
  `UNIQUE (want_list_id, oracle_id)` should be honoured by an upsert, not caught as an
  error.
- Deck-list timing with 25 decks and a full collection stays under ~100ms; a per-deck
  N+1 query pattern fails this phase regardless of correctness.
