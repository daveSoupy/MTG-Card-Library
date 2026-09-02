# Phase 3 — Commander Rules, Deck Analysis & Playtesting

(Assumes Phase 2 is complete.)

Colour identity is the spine of this phase: it is the Commander rule that decides what may go in a deck, and it is also what a mana base has to support. The analysis and playtest work folded in here exists because both answer the same question from different directions — *will this deck actually cast its spells?*

## First: three gaps in already-shipped work

Fix these before adding anything, since two of them silently limit existing features.

- **Search pagination.** The API accepts `offset` and returns a true total, but the UI only ever requests the first 60 results. A search reporting 32,885 cards can only reach 60 of them.
- **Search syntax reference.** Scryfall-style syntax is supported (`t:creature c:rg cmc<=3`, `is:commander`, `-` negation) but documented nowhere in the app. Needs an in-app cheat sheet.
- **Per-card price history.** `printing_price_history` and `v_tracked_printings` were added to the schema but nothing writes to them, so per-card price charts cannot work. Write a point after each price sync, only for cards that are owned or want-listed, and only when the price actually moved.

## Commander rules

- Designate a commander for Commander-format decks, from the deck list or the card picker.
- Compute the commander's **full colour identity** — all mana symbols in cost *and* rules text, including symbols on the reverse face of a double-faced card. Scryfall's `color_identity` already accounts for all of this, so use it rather than re-deriving it; verify against a card whose identity exceeds its colours (Kenrith is mono-white but WUBRG identity).
- **Restrict card selection in that deck to cards within the commander's identity.** The card picker filters to it; a card already in the deck that falls outside it is flagged as an error, not silently removed.
- Enforce singleton, the exactly-100 size, and the **Commander ban list**, which is distinct from other formats' — the Phase 2 rule engine already reads per-format legality, so this is verification against real data rather than new logic.
- **Partner and Backgrounds**, which relax the one-commander rule in specific ways. Four distinct mechanics, and they do not interchange:
  - **Partner** — any two cards with the plain Partner keyword may pair.
  - **Partner with [name]** — pairs *only* with the named card. A generic "has partner" flag would wrongly allow any two of these together, so the named card has to be stored.
  - **Friends forever** — any two cards with it may pair.
  - **Choose a Background** — a legendary creature with that text pairs with a card whose type line includes Background.

## Mana base analysis

Colour distribution already shows how many cards are each colour. That is not the question a deck builder actually has, which is whether the lands can cast the spells.

- Count **coloured pips** in mana costs, weighted by quantity, per colour.
- Count **sources** producing each colour — lands and mana creatures/rocks, from Scryfall's `produced_mana`, which is already imported.
- Show sources against pips per colour, and flag colours that look short.

## Deck building

- **Categories per card slot.** `deck_cards.category` already exists and is unused. Let a card be filed under a user-named section (Ramp, Removal, Draw) and add "Category" as a deck sort alongside the existing six.
- **Choose the printing for a deck slot.** `deck_cards.preferred_printing_id` already exists and is unused; it also decides which art the card view shows and which set code a Phase 5 export writes.

## Playtesting

- Draw an opening hand of seven, mulligan (London: draw seven, put N on the bottom), and draw further cards.
- Enough to sanity-check a curve and a mana base — not a game engine. No casting, no stack, no board state.

## Deliberately not in this phase

Named so they are decided rather than forgotten:

- **Rulings and related cards.** Scryfall publishes a rulings bulk file, and `all_parts` gives tokens and meld pairs. Both are card-database work rather than Commander work, and belong with Phase 1's material.
- **Deck versioning and deck folders.** Worth having once there are many decks; revisit after Phase 6.
- **Random card, theme toggle.** Polish, any time.
