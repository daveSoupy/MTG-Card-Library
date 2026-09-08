# Phase 7 — Deck-Building Templates (optional, not sequenced)

Depends only on Phase 2's deck building and Phase 3's categories, both done, so it can be built at any point.

A template answers "what should this deck contain?" — roughly 38 lands, 10 ramp, 10 card draw, 8 pieces of interaction for a Commander deck — and shows how far the deck is from that. **Off by default**, chosen per deck.

## The hard part, and the answer

Counting removal requires knowing which cards *are* removal. Three sources, in priority order:

1. **The category the user set.** `deck_cards.category` already exists and is already editable; an explicit choice always wins.
2. **Scryfall Tagger's oracle tags.** Community-curated functional tags, hierarchical. See "Sync" for sourcing.
3. **Uncategorised**, shown as its own row rather than hidden.

The tags are **hierarchical**. `removal` has zero cards tagged directly; its children hold them. Resolving each category means walking `child_ids` transitively. Measured against the live file:

| Category | Root tag | Subtags | Cards |
|---|---|---|---|
| Removal | `removal` | 55 | 6,690 |
| Card draw | `draw` | 36 | 4,477 |
| Ramp | `ramp` | 23 | 2,423 |
| Recursion | `recursion` | 95 | 2,334 |
| Protection | `protection` | 23 | 1,354 |
| Tutor | `tutor` | 139 | 1,212 |
| Board wipe | `sweeper` | 2 | 976 |
| Counterspell | `counterspell` | 24 | 558 |

16,545 distinct cards across all of them. Lands need no tag — the type line already says so.

Labels are inconsistent (`removal-creature` with a hyphen, `spot removal` with a space), so match by tag id after the first lookup, never by reconstructing labels.

## Schema

Next unused `user_version` at build time (see CLAUDE.md, "Schema changes").

```sql
-- Resolved category membership, not the whole 4,524-tag graph. The closure is
-- computed at sync time for the categories templates actually use (~20k rows).
CREATE TABLE card_categories (
    oracle_id  TEXT NOT NULL REFERENCES oracle_cards(oracle_id) ON DELETE CASCADE,
    category   TEXT NOT NULL,          -- 'removal', 'ramp', 'draw', …
    PRIMARY KEY (oracle_id, category)
) WITHOUT ROWID;

CREATE TABLE deck_templates (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    format_code  TEXT REFERENCES formats(code) ON DELETE SET NULL,
    archetype    TEXT,                 -- 'aggro', 'midrange', 'control', null
    description  TEXT,
    is_builtin   INTEGER NOT NULL DEFAULT 0,
    sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE deck_template_targets (
    template_id  INTEGER NOT NULL REFERENCES deck_templates(id) ON DELETE CASCADE,
    category     TEXT NOT NULL,
    ideal        INTEGER NOT NULL,
    min_count    INTEGER,
    max_count    INTEGER,
    note         TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (template_id, category)
);

ALTER TABLE decks ADD COLUMN template_id INTEGER REFERENCES deck_templates(id) ON DELETE SET NULL;
```

`decks.template_id` being NULL is the off state — opt-in per deck with no extra flag.

## Built-in templates

Seeded, editable, and clonable. Present them as **starting points, not rules** — the UI must say so; these are community heuristics, not anything official.

- **Commander — general.** 38 lands, 10 ramp, 10 draw, 5 removal, 3 board wipes, the rest flex. The widely-cited Command Zone template.
- **Commander — high power.** Fewer lands (34–36), more ramp and tutors.
- **60-card aggro.** ~22 lands, ~26 creatures, ~8 removal.
- **60-card midrange.** ~24 lands, ~20 creatures, ~12 removal, ~4 draw.
- **60-card control.** ~26 lands, ~4 creatures, ~12 removal, ~8 counterspells, ~8 draw.
- **Limited 40-card.** 17 lands, 23 spells, ~15 creatures.

## Counting rule

A card counts toward **every** category it matches — a creature that draws cards is both a creature and card draw. The category numbers therefore deliberately sum to more than the deck size; the panel shows the deck total separately and says the categories overlap. Presenting them as a partition would be misleading.

## Sync

**The tag data is not a Scryfall bulk-data type.** Scryfall's bulk-data endpoint publishes exactly five types (Oracle Cards, Unique Artwork, Default Cards, All Cards, Rulings). The tag hierarchy comes from Scryfall Tagger, a separate community project with no official export guarantee. Before implementing: pin the exact URL the counts above were measured against, record it in this doc and in `scryfall.ts`, and treat it as a third-party source that may go away or change shape.

- Fetch it after the card import, in the same worker, as a separate step from the official bulk-data sync.
- Resolve each template category's closure and rewrite `card_categories` in one transaction.
- **A failure here must not fail the card sync** — templates degrade to manual categories, which still work. Given the source, this rule is load-bearing, not boilerplate.

## UI

- **Off by default.** A "Follow a template" control in the deck header or the stats pane, with a picker; none is the off state.
- A **Template** section in the stats pane, one row per category: `Ramp 7 / 10` with a bar, over/under coloured; lands and creatures alongside the tag-derived rows.
- **Uncategorised count** as its own row, so incomplete numbers read as incomplete rather than as the deck being wrong.
- **Actionable shortfalls.** "3 ramp short" links into the card picker pre-filtered to ramp, the deck's colour identity and its format — reusing the Phase 3 identity filter and the existing preset machinery.
- **Per-card override** from the deck row: set the category by hand, which wins over the tag.
- Add a **Template** grouping to the deck sorts, next to Category.

The stats pane is hidden below 1200px until Phase 9 gives it a mobile toggle — template tracking is effectively desktop-only until then.

## Global on/off, alongside the per-deck one

- **Per-deck** — the "Follow a template" picker's none option.
- **Global** — a `showDeckTemplates` boolean setting, following the exact pattern `autoMaintainLands` establishes: an entry in `BOOLEAN_SETTINGS` (`server/src/routes/settings.ts`), default `false`, with a matching checkbox in the Data page's settings section. When off, the "Follow a template" control disappears from every deck entirely rather than defaulting each to none.

## Stretch goal: auto-build from a template

Low priority. Mechanically a filtering-and-allocation problem on machinery this phase already has:

- Filter the owned, *available* collection (allocation tracking already knows what's claimed) to the relevant color identity — the same filter Phase 3's card picker applies.
- Walk the template's categories, pulling candidates from `card_categories` until each target is met, with the same overlap accounting as the panel — a card in two categories fills both quotas from one slot.
- Fill whatever's left from the remaining filtered pool.
- Lands: `recommendedLandTotal`/`planBasics` in `lands.ts` already compute count and color split; call what auto-maintain-lands calls.
- Present the result for review in the editor; never save silently.

This never reaches outside the owned collection and uses no external synergy data — a mechanical fill, not a suggestion engine. It can produce a legal, quota-filled deck, not necessarily a good one.

**Decision deferred to build time, if ever built:** fill only from owned cards and leave gaps, or build the best list regardless of ownership and hand the gap to the shopping-list/cart machinery. Different features; decide then.

## Verification

1. The tag closure resolves to the counts in the table above, ±normal drift — a `removal` closure returning 0 means `child_ids` were not walked.
2. A seeded Commander deck of 38 lands / 10 ramp / 10 draw reports those categories as met.
3. A card in two categories is counted in both, and the panel's total does not claim to equal the deck size.
4. A manual `deck_cards.category` overrides the tag-derived one.
5. Turning the template off leaves the deck untouched — no validation errors, no changed rows.
6. A deck with no template selected behaves exactly as it does today.
7. Deleting a template sets `decks.template_id` to NULL rather than deleting decks.
8. The card sync still succeeds when the tag fetch fails or the source URL 404s.
9. Turning the global setting off hides the control on every deck; turning it back on restores each deck's prior template choice rather than resetting them.
10. `migrations.test.ts` passes with the new DDL in both `schema.sql` and `migrations.ts`.

## Out of scope

Suggesting *specific* cards to fill a gap ("add Cultivate") needs recommendation data the plan deliberately avoids. Linking to a filtered search is the honest version of that.
