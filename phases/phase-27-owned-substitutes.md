# Phase 27 — Substitutes From Your Own Collection

**Depends on Phases 22 and 23.** Also depends on `card_categories` having rows in it.

> **Built 2026-09-13 — what changed at build time.**
>
> - **The data source exists.** Scryfall now publishes `oracle_tags` in `/bulk-data`
>   (alongside `art_tags`), Phase 7's `syncCardCategories` already loads it, and the live
>   library had 20k rows over 16.5k cards. This shipped at **full ranking**, not degraded.
>   The keyword heuristic below was built anyway (`server/src/decks/roleHeuristics.ts`) and
>   is used only while `card_categories` is empty — never mixed with tagger data. Measured
>   against the tagger over the 8k most-played cards: precision 91–100% per role, recall
>   21–87%. It rarely lies; it mostly misses.
> - **A relevance floor was added after the ranking.** CMC-only matches were the "five bad
>   suggestions" this doc warns about ("Solemn Simulacrum · CMC 4" for Wrath of God). When
>   the target has a role, a candidate must share one; when it has none, it must be the
>   same primary type. Counterspell in a WR deck now honestly returns nothing.
>   `poolSize` reports the hard-filter survivors so the empty state can say why.
> - **The command zone is excluded.** A commander is the deck, not a slot; the deck tile
>   and the Missing panel offer no swap for it, and `swapPlan` never touches that board.
> - **Colour identity for a non-Commander deck** is the union of its non-maybeboard cards
>   (an empty union means unconstrained). Commander decks use the command zone, as
>   `validate.ts` does. Limited formats skip the legality test.
> - **Query parameters are camelCase** (`oracleId`, `deckId`), matching every other route.
> - **On a deck tile the action is a `⇄` in the hover control bar**, not the chip: the
>   bar overlays the bottom of the art where the chip sits, so a chip-button there was
>   unreachable (found in the browser). The text row's chip is the button.
> - Final weights are in `substitutes.ts` with the reasoning; the "tuned against your own
>   collection" step ran against a copy of the live library seeded with 400 well-played
>   cards, since the real collection had 15 lots.

## Check this before starting — and it may fail

`card_categories` is meant to be populated by the `syncCardCategories` step described
in Phase 7 (Deck Templates), which Phase 7 says walks a Scryfall `oracle_tags` bulk
file. **Verify that file exists before believing it.** As of when these phases were
written, Scryfall's published bulk data files are `oracle_cards`, `unique_artwork`,
`default_cards`, `all_cards`, and `rulings`. Tagger tags — the `otag:` / `function:`
data Scryfall search uses — are not, to the author's knowledge, in any of them. Phase 7
may have been written on an assumption that isn't true.

Spend the first ten minutes of the session on this, in order:

1. `curl https://api.scryfall.com/bulk-data` and read the list. If there's a tags file,
   Phase 7's sync step is real; build it (it's self-contained; read
   `phases/phase-7-deck-templates.md`) and proceed with full ranking.
2. If not, check whether Phase 7 (if built) populated `card_categories` some other way,
   and whether that way is reproducible. If yes, use it.
3. If neither, **ship this phase degraded and say so in the commit message**: type line,
   CMC, colour and keyword-text matching only, no category signal. The ranking function
   takes the category term as an optional component, so a later data source is additive.
   Add a keyword heuristic as a cheap stand-in for categories — a small server-side map
   from oracle-text patterns to role labels (`destroy target creature` → removal,
   `draw a card` → card draw, `search your library for a land` → ramp, `counter target
   spell` → counterspell, and so on). It's coarse, it's honest, and it's a lot better
   than nothing. Keep it in one file with the patterns as data, and label the reason
   line "role (heuristic)" so the user knows it's a guess.

Do not discover any of this halfway through the session.

## Why

Every other phase in this set tells you what you're *missing*. This one is the only one
that tells you what to do about it without opening a shopping cart. You have thousands
of cards. The reason you buy a $12 removal spell is that you can't remember the three
you already own that would have done the job.

The data is already there: `card_categories` for role (or the heuristic above),
`color_identity_mask` for legality of fit, `cmc`, `type_line`, `edhrec_rank`. Nothing
new needs syncing.

## Scope

Given a target card (a slot in a deck you don't own enough of, or a want-list item) and
a deck for context, return owned cards that could fill the same role.

**Candidate pool** — hard filters, all or nothing:

- `allocation.availableFor(oracleId, excludeDeckId = deck) >= 1` — Phase 22's function,
  which already excludes trade-listed and archived copies. Don't re-derive it.
- Colour identity fits: `(color_identity_mask & ~:deck_mask) = 0` — the same indexable
  subset test Phase 3 uses for Commander.
- Legal in the deck's format (`card_legalities.legality IN ('legal','restricted')`).
- Not already in the deck on any board.
- Not a basic land.

**Ranking** — a weighted score, computed server-side, deterministic:

| Signal | Weight |
| --- | --- |
| Shares a `card_categories` value (or heuristic role) with the target | highest; a card sharing none should rank below every card sharing one |
| Same primary type from `type_line` (creature / instant / sorcery / artifact / enchantment / planeswalker / land) | high |
| CMC proximity: `1 / (1 + abs(cmc − target_cmc))` | medium |
| `edhrec_rank` | low tie-break only |
| Number of copies available | low tie-break — a card you own 4 of is more useful than one you own 1 of |

Return the top 6–8 with **reasons attached**, not just a score: `"Removal · CMC 2 · 3
available in Binder 3"`. A recommendation the user can't audit is one they won't trust,
and the categories are the honest reason the card came up.

Tune the weights against your own collection during the session and write the final
numbers into a comment. Don't leave them as magic constants.

## Schema

None. Pure query over `oracle_cards`, `card_categories`, `card_legalities`,
`collection_items`.

One setting is worth having in `NUMBER_SETTINGS`:

- `substitute_suggestion_count` — default 6.

## Server

`server/src/decks/substitutes.ts`:

- `GET /api/v1/decks/:deckId/cards/:oracleId/substitutes` — substitutes for a slot in a
  deck's context.
- `GET /api/v1/substitutes?oracle_id=&deck_id=` — same for a want-list item, where
  `deck_id` supplies colour identity and format and is optional.

Response per candidate: oracle id, name, default printing for art, cmc, type line,
shared categories (with a `source: 'tagger' | 'heuristic' | null` field), available
quantity, locations, and the score components. The client renders reasons from those
components rather than inventing its own copy. The response also carries a top-level
`category_source` so the UI can say "matched on card role" versus "matched on type and
cost only."

**Never auto-swap.** These are suggestions surfaced next to a missing card; replacing a
slot is always an explicit tap. And the substitution is an ordinary deck edit — remove
the missing card, add the substitute, allocation follows normally. No special path.

Performance: the candidate pool is bounded by what you own, which is small. Do the
colour and legality filtering in SQL and the scoring in TypeScript over the survivors;
don't attempt the whole ranking as one query.

## Client

- On any missing card in a deck: **"Swap for something I own."**
- The sheet shows candidates as art tiles with the reason line beneath, availability
  badge, and a single tap to replace the slot.
- Same entry point from a want-list item, with a second option: "keep it on the list but
  play this for now."
- An honest empty state: "Nothing you own fills this role" is a useful answer and much
  better than five bad suggestions.
- When running degraded, one quiet line at the top of the sheet: "Matching on type and
  cost only."

## Verification

- For a known missing removal spell in a UB deck, every returned candidate is owned,
  available, colour-legal for that deck, format-legal, and not already in the deck.
- A green card never appears as a substitute in a mono-blue Commander deck.
- A card reserved by another `assembled` deck to the point of zero availability does not
  appear.
- A card whose only copy is on a trade list does not appear while
  `tradelist_reduces_available` is on.
- Candidates sharing a category with the target all rank above candidates sharing none.
- With `card_categories` empty, the endpoint still returns type/CMC/colour (and
  heuristic-role) matches and reports `category_source` accordingly, rather than
  returning an empty list.
- Every candidate carries at least one human-readable reason.
- Accepting a suggestion produces exactly the same deck state as removing the old card
  and adding the new one by hand — compare the two paths' resulting `deck_cards` rows.
- Timing under ~150ms for a full-size collection.
