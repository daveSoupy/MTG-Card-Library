# Phase 22 — Allocation Honesty: Deck Status, Basics, Proxies, and Trade Lists

Four changes to one computation. They ship together because they all answer the same
question — *how many copies of this card can a new deck actually have?* — and shipping
any one alone leaves that number wrong in the other ways.

## Why

`available = owned − allocated` is the number the whole app leans on, and today it
lies four ways:

1. **Every deck reserves copies.** A deck you sketched at 1am and will never sleeve
   holds its `quantity_from_collection` forever, so the deck you actually want to build
   reads as short. `is_archived` doesn't help — archiving hides a deck from the list, it
   doesn't say the cards came back.
2. **Basic lands count.** `oracle_cards.is_basic_land` exists but nothing consumes it in
   allocation, so a Commander deck reports 38 missing cards and its shortfall figure is
   noise.
3. **Proxies have nowhere to live.** A slot is either "from my collection" or, by
   omission, "need to buy." A proxied card is neither, so playtesting a brew pollutes
   the want list and the cost-to-complete figure.
4. **Trade-list copies read as available.** `CLAUDE.md` defines trade-list quantity as
   its own bucket, separate from owned and from deck-allocated, but nothing subtracts
   it. A copy you've offered to a friend shows as free to build with, and the deck that
   takes it either loses the card mid-trade or scuttles the trade.

## Schema

Bump `PRAGMA user_version` to the next unused value. Both `schema.sql` and
`migrations.ts`; new columns at the end of each column list.

### `decks` — two new columns

```sql
status TEXT NOT NULL DEFAULT 'brew'
  CHECK (status IN ('brew','building','assembled','disassembled')),
status_changed_at TEXT
```

Semantics — the comment belongs above the table, not in the column list:

| status | Reserves copies? | Means |
| --- | --- | --- |
| `brew` | no | An idea. A list of cards, no claim on cardboard. |
| `building` | yes | Actively being assembled; copies are spoken for. |
| `assembled` | yes | Physically exists, sleeved, in a box. |
| `disassembled` | no | Existed once, cards went back. Keeps its list. |

`is_archived` stays orthogonal and keeps its current meaning (hide from the list).

**Migration rule for existing rows: set every existing deck to `'assembled'`.** Today
every deck reserves, so this preserves behaviour exactly across the upgrade. Defaulting
existing decks to `'brew'` would silently free hundreds of copies and change every
number in the app during a migration, which is not a thing a migration should do. New
decks get `'brew'` from the column default. Set `status_changed_at` to the migration
timestamp on those rows so the column is never NULL for a deck that has a status.

### `deck_cards` — one new column

```sql
quantity_proxied INTEGER NOT NULL DEFAULT 0 CHECK (quantity_proxied >= 0)
```

The real rule is `quantity_from_collection + quantity_proxied <= quantity`, but keep
that **out** of the column CHECK and enforce it in `DeckStore` instead. A cross-column
CHECK added via `ALTER TABLE ADD COLUMN` is the kind of thing that works until
`migrations.test.ts` rebuilds the table and the two definitions drift. One place, in
code, with a test.

### `app_settings`

Three keys, registered in the allowlists in `server/src/routes/settings.ts`:

- `allocation_ignores_basics` — BOOLEAN, default `true`. Basic lands are excluded from
  allocation, availability, shortfall and want-list generation.
- `brews_reserve_copies` — BOOLEAN, default `false`. Escape hatch for someone who wants
  the old behaviour back.
- `tradelist_reduces_available` — BOOLEAN, default `true`. Copies on a trade list are
  subtracted from `available`. Off, they count as available and the UI just shows the
  trade badge (the current behaviour).

## Server

Put the reserving-status set in exactly one place — `server/src/decks/allocation.ts` —
and have every caller import it. Scattering `status IN ('building','assembled')` across
stores is how these rules drift apart again.

```ts
export const RESERVING_STATUSES = ['building', 'assembled'] as const;
// plus 'brew' when brews_reserve_copies is on
```

Rules the allocation module owns:

- `ownedFor(oracleId)` — sum of `collection_items.quantity` across every printing of
  the oracle card, from **non-archived** storage locations only. An archived location
  is one whose cards you no longer consider on the shelf; this is the same rule Phase 25
  uses when picking lots, and the two must agree.
- `tradeListedFor(oracleId)` — sum of `trade_list_items.quantity` across lots of that
  oracle card. Only counted when `tradelist_reduces_available` is on.
- `reservedFor(oracleId)` — sum of `quantity_from_collection` across deck_cards whose
  deck's status is reserving, excluding `board = 'maybe'`.
- `availableFor(oracleId, excludeDeckId?)` —
  `owned − tradeListed − reserved`, floored at 0, with the named deck's own reservation
  excluded so a deck never reports itself as competing with itself.
- Basics: when `allocation_ignores_basics` is on, any oracle row with
  `is_basic_land = 1` is skipped entirely — it has no owned figure, no reservation, no
  shortfall, and never lands on a want list.
- Proxied copies count as neither owned nor to-buy. They satisfy a slot without
  touching allocation.

**Every downstream phase (23, 24, 25, 26, 27) computes "available" by calling this
module.** None of them re-derive it. If a later phase needs a variant (Phase 23's search
predicate, Phase 24's coverage), it passes parameters into these functions rather than
writing its own subtraction.

Changing a deck's status **must not** rewrite `quantity_from_collection` on its cards.
The declared allocation is the user's intent and survives the deck going cold; status
only controls whether it counts. Moving `assembled → brew` and back must be lossless.

Endpoints:

- `PATCH /api/v1/decks/:id` accepts `status`; sets `status_changed_at`; returns the
  deck with recomputed allocation figures.
- `PATCH /api/v1/decks/:id/cards/:cardId` accepts `quantity_proxied`.
- Every response that already carries owned/allocated/available numbers keeps its
  shape — the numbers just get correct. No client should need to know why. Add a
  `trade_listed_qty` alongside them where the row is per-card, so the UI can say
  "1 owned · on trade list" rather than a bare 0 available.

If Phase 25 (Assembly and Pull Sheets) is already built, moving a deck to
`disassembled` should offer its return flow rather than silently dropping the
reservation. If it isn't, the status change is enough.

## Client

- Status pill in the deck header, tappable, four options. Colour-code it; this is the
  single most-glanced-at fact about a deck.
- Deck list filters by status, and defaults to hiding `disassembled`.
- Card slot gets a proxy stepper next to the existing from-collection control. A slot
  showing `1 owned / 2 proxy / 1 to buy` should read that plainly.
- Basic lands in a deck render without owned/missing badges — they're not tracked, and
  a blank badge is better than a wrong one.
- A card whose only copies are on a trade list shows why it isn't available, not just
  that it isn't.

## Verification

- Two decks each reserving 1 copy of a card you own 1 of: with one deck set to `brew`,
  the other reports 1 available and no shortfall.
- Flipping a deck `assembled → brew → assembled` leaves every
  `quantity_from_collection` byte-identical.
- A Commander deck with 38 Islands and `allocation_ignores_basics` on reports 0 missing
  from those slots and adds nothing to the want list.
- A slot with `quantity = 4`, `quantity_from_collection = 1`, `quantity_proxied = 2`
  reports exactly 1 to buy.
- `quantity_from_collection + quantity_proxied > quantity` is rejected by the API with
  a 4xx, not silently clamped.
- Own 2 of a card, 1 on a trade list, no decks: `available = 1`. Turn
  `tradelist_reduces_available` off: `available = 2`. Remove the trade-list row:
  `available = 2` either way.
- Own 1 of a card, 1 on a trade list, 1 `assembled` deck reserving it: `available`
  floors at 0, never −1.
- A lot in an archived location contributes nothing to `owned`; unarchiving the
  location brings it back.
- Migration test: a database at the prior `user_version` with three decks comes out
  with all three at `'assembled'`, `status_changed_at` set, and every allocation
  figure identical before and after (with `tradelist_reduces_available` forced off for
  the comparison, since that setting intentionally changes numbers).
- `migrations.test.ts` passes — the three added columns are last in their column lists
  in both files.
