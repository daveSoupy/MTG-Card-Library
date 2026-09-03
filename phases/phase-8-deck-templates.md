# Phase 8 — Deck-Building Templates (optional, not sequenced)

Not part of the 1–7 sequence. It depends only on Phase 2's deck building and Phase 3's categories, both of which are done, so it can be built whenever — before Phase 4 if it is more useful sooner.

A template answers "what should this deck contain?" — roughly 38 lands, 10 ramp, 10 card draw, 8 pieces of interaction for a Commander deck — and shows how far the deck is from that. **Off by default**, chosen per deck.

## The hard part, and the answer

Counting removal requires knowing which cards *are* removal. Three sources, in priority order:

1. **The category the user set.** `deck_cards.category` already exists and is already editable, and an explicit choice always wins.
2. **Scryfall's oracle tags.** Community-curated functional tags, published as a 5.6 MB bulk file the app does not currently download.
3. **Uncategorised**, which the panel shows as its own row rather than hiding.

The tags are **hierarchical**, which is the thing to get right. `removal` has zero cards tagged directly; its children hold them. Resolving each category means walking `child_ids` transitively. Measured against the live file:

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

Note the labels are inconsistent (`removal-creature` with a hyphen, `spot removal` with a space), so match by tag id after the first lookup, never by reconstructing labels.

## Schema (v5)

```sql
-- Resolved category membership, not the whole 4,524-tag graph. The closure is
-- computed at sync time for the categories templates actually use, which keeps
-- this to roughly 20k rows instead of storing every tag relationship.
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

`decks.template_id` being NULL is the off state, so the feature is opt-in per deck with no extra flag.

Follow the existing migration rules: add the DDL to `schema.sql` **and** `migrations.ts`, keep multi-line comments out of column lists, and let `migrations.test.ts` prove the two agree.

## Built-in templates

Seeded, editable, and clonable. Present them as **starting points, not rules** — the UI must say so, because these are community heuristics rather than anything official.

- **Commander — general.** 38 lands, 10 ramp, 10 draw, 5 removal, 3 board wipes, the rest flex. The widely-cited Command Zone template.
- **Commander — high power.** Fewer lands (34–36), more ramp and tutors.
- **60-card aggro.** ~22 lands, ~26 creatures, ~8 removal.
- **60-card midrange.** ~24 lands, ~20 creatures, ~12 removal, ~4 draw.
- **60-card control.** ~26 lands, ~4 creatures, ~12 removal, ~8 counterspells, ~8 draw.
- **Limited 40-card.** 17 lands, 23 spells, ~15 creatures.

## Counting rule, and the caveat it creates

A card counts toward **every** category it matches. A creature that draws cards is both a creature and card draw, and real templates intend that overlap — a deck is not partitioned into buckets.

The consequence is that **the category numbers deliberately sum to more than the deck size**, so the panel must show the deck total separately and say the categories overlap. Presenting them as a partition would be actively misleading.

## Sync

Add `oracle_tags` as a third bulk type alongside `oracle_cards` and `default_cards`. It is small and independent of the card sync, so:

- Fetch it after the card import, in the same worker.
- Resolve each template category's closure and rewrite `card_categories` in one transaction.
- A failure here must not fail the card sync — templates degrade to manual categories, which still work.

## UI

- **Off by default.** A "Follow a template" control in the deck header or the stats pane, with a picker; choosing none is the off state.
- A **Template** section in the stats pane, one row per category: `Ramp 7 / 10` with a bar, over/under coloured, and lands and creatures alongside the tag-derived rows.
- **Uncategorised count** shown as its own row, so it is obvious when the numbers are incomplete rather than the deck being wrong.
- **Actionable shortfalls.** "3 ramp short" links into the card picker pre-filtered to ramp, the deck's colour identity and its format — reusing the Phase 3 identity filter and the existing preset machinery.
- **Per-card override** from the deck row: set the category by hand, which then wins over the tag.
- Add a **Template** grouping to the deck sorts, next to Category.

## Verification

1. `oracle_tags` closure resolves to the counts in the table above, ±normal drift — a `removal` closure returning 0 means `child_ids` were not walked.
2. A seeded Commander deck of 38 lands / 10 ramp / 10 draw reports those categories as met.
3. A card in two categories is counted in both, and the panel's total does not claim to equal the deck size.
4. A manual `deck_cards.category` overrides the tag-derived one.
5. Turning the template off leaves the deck untouched — no validation errors, no changed rows.
6. A deck with no template selected behaves exactly as it does today.
7. Deleting a template sets `decks.template_id` to NULL rather than deleting decks.
8. The card sync still succeeds when the tag fetch fails.

## Out of scope

Suggesting *specific* cards to fill a gap ("add Cultivate") needs recommendation data the plan deliberately avoids. Linking to a filtered search is the useful, honest version of that.
