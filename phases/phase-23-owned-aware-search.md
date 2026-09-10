# Phase 23 — Owned-Aware Search

Search predicates that make "build only from what I own" an actual mode rather than a
thing you do by squinting at badges.

## Why

Search today knows the Scryfall catalog and nothing about your collection. Every
"do I own this?" question is answered per-card, after the fact, by eye. The point of
this app is to build decks out of a shelf, and that means the shelf has to be a filter.

## Scope

New predicates in the existing Scryfall-style query parser (`server/src/search`):

| Predicate | Meaning |
| --- | --- |
| `owned` / `owned>=N` / `owned:0` | Total copies across all lots and printings, non-archived locations only (Phase 22's `ownedFor`). |
| `available` / `available>=N` | Phase 22's `availableFor`: owned minus trade-listed minus reserved. In a deck-builder context, excluding the current deck's own reservation. |
| `loc:<name>` | Has at least one lot in that storage location. Quoted names: `loc:"Blue Tackle Box"`. Match on `storage_locations.name COLLATE NOCASE`. |
| `deck:<name>` | Used by that deck. |
| `indeck` / `-indeck` | Used by any deck / used by none. `-indeck owned>=1` is your dead inventory. |
| `want` / `want:<list>` | On any want list / that named one. |
| `fortrade` / `tradelist:<name>` | Flagged on a trade list. |

All negatable with a leading `-`, and composable with everything that already parses —
`available>=1 c:ur t:instant cmc<=2` is the query this phase exists to make possible.

Unknown names (`loc:Binderrr`) return an empty result with a parse warning in the
response, not an error. A typo shouldn't blank the screen with no explanation.

**`available` is not defined here.** If Phase 22 is built, the predicate calls
`allocation.ts`. If it isn't, `available` behaves as `owned − Σ quantity_from_collection
across all decks` and the parser emits a one-time warning in the response that
availability is pre-Phase-22 and treats every deck as reserving. Don't fork the rule.

### These compose with the deck context — they don't replace it

Collection predicates are ordinary terms ANDed into the query. In a Commander deck's
builder, Phase 3's `formats.enforces_color_id` restriction still applies, so
`available>=1` returns cards that are available **and** within the commander's color
identity. The scope chips add a term; they never rewrite the query.

The failure mode to avoid: implementing a chip as a query *replacement*, which silently
drops the identity constraint the moment someone taps "Owned." Same for format legality
and the deck's existing filters.

**Check this before implementing.** Confirm whether Phase 3 applies the color identity
restriction to the *search pane*, or only validates on add. If it's validation-only,
off-color cards are visible in results today and get rejected at insert — in which case
this phase carries the filter itself rather than assuming it, using the same indexable
subset test Phase 3 already uses: `(color_identity_mask & ~:cmdr_mask) = 0`. Read
`phases/phase-3-commander-specific-rules.md` and the shipped search code before
deciding; don't infer it from behaviour.

## Schema

None required. One optional setting, registered in `ENUM_SETTINGS`:

- `deckbuilder_default_scope` — `'all' | 'owned' | 'available'`, default `'all'`. The
  scope the deck builder's search pane opens in.

`filter_presets.filters` is opaque JSON handed back to the client verbatim, so the new
filters ride along in existing presets with no migration. Say so in the phase's commit
message; it's the kind of thing that gets "fixed" with a needless migration later.

## Server

The collection predicates are correlated existence checks against `collection_items`
joined through `card_printings.oracle_id`. The catalog is oracle-grained and the
collection is printing-grained, so every one of these crosses that boundary.

Add a view for the rollup rather than repeating the join in six places:

```sql
-- Owned rollup per oracle card. Excludes archived locations, matching
-- allocation.ts ownedFor(); keep the two in step.
CREATE VIEW v_owned_by_oracle AS
SELECT p.oracle_id,
       SUM(ci.quantity) AS owned_qty,
       COUNT(DISTINCT ci.location_id) AS location_count
FROM collection_items ci
JOIN card_printings p ON p.id = ci.printing_id
JOIN storage_locations sl ON sl.id = ci.location_id AND sl.is_archived = 0
GROUP BY p.oracle_id;
```

(Check the real name of the archived flag on `storage_locations` in `schema.sql`
before writing this; if the table has no such flag, drop the join and note it — don't
invent a column.)

Views go in both `schema.sql` and `migrations.ts` like any other DDL.

**Measure before you optimise, but do measure.** `idx_coll_printing` exists and the
collection is small next to 117k printings, so a correlated subquery should be fine —
but `owned>=1` combined with a broad text query is the shape that could degrade, and
the repo already has one 5-second regression on record from exactly this kind of
correlated subquery. Add the timing to `server/scripts/search-check.mjs`.

The search endpoint takes an optional `deck_id` so `available` can exclude that deck's
own reservation; the deck builder always sends it.

Search result rows must carry `owned_qty`, `available_qty`, `trade_listed_qty`, and
`deck_names` (or at least `deck_count`) so the client can render badges from the result
set. A per-row follow-up request per card is the failure mode here.

## Client

- Scope chips above the search pane: **All cards / Owned / Available**. They compile to
  the predicates above and are visible in the query box when tapped, so the syntax is
  discoverable by using the buttons.
- In the deck builder, the scope defaults from `deckbuilder_default_scope`, and
  `available` there means available *to this deck*.
- Result rows show an owned badge and, when the card is in decks, which ones.
- The help/syntax sheet lists the new predicates alongside the existing ones.

## Verification

- `owned>=1` returns exactly the distinct oracle cards with at least one lot in a
  non-archived location; count it against a direct SQL query on `collection_items`.
- A card you own 2 of, reserved once by an `assembled` deck, appears for `available>=1`
  and not for `available>=2`.
- The same card searched from inside that deck's builder shows `available: 2` — its own
  reservation excluded.
- A card you own 1 of, on a trade list, does not appear for `available>=1` while
  `tradelist_reduces_available` is on, and does appear for `owned>=1` and `fortrade`.
- `-indeck owned>=1` returns cards owned and used by no deck; adding one to a deck
  removes it from that result.
- `loc:"<a real location>"` matches; `loc:nonsense` returns empty with a warning, not a
  500.
- With Phase 22 built, a `brew` deck's cards do not reduce `available`.
- In a mono-white Commander deck's builder, `available>=1` returns no green cards, even
  when you own green cards that are available.
- For any query in that builder, the result count with a scope chip on is less than or
  equal to the count with it off — a chip can only narrow, never widen.
- Switching the commander to one with a wider identity widens the same query's results
  accordingly.
- `search-check.mjs` reports the timing of a text query with and without `owned>=1`,
  and the phase is not done if the owned variant is more than ~2× slower.
