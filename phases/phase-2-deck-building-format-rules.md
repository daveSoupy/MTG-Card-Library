# Phase 2 — Deck Building & Format Rules

(Assumes Phase 1 is complete. References the Allocation Tracking section in `CLAUDE.md`.)

- Create, rename, duplicate, delete multiple named decks.
- Add/remove cards and set quantities per card within a deck, with the option to build entirely from owned cards using the "owned only" filter and allocation tracking (see `CLAUDE.md` Data Model).
- Format selector per deck (Standard, Pioneer, Modern, Legacy, Vintage, Pauper, Commander, etc. — pull the exact list from Scryfall's `legalities` keys).
- Enforce deck-building rules based on selected format:
  - Max 4 copies of any non-basic-land card in constructed formats.
  - Singleton (1 copy max, basics excepted) in Commander.
  - Deck size validation against the format's requirement — minimum 60 for most constructed formats, **exactly** 100 for Commander (99 + commander) — flag decks that don't meet it, don't just count "over the minimum."
  - Optional sideboard (15 cards) for constructed formats.
  - Flag any card in the deck that's banned or restricted in the selected format.
- Deck stats panel: total card count, mana curve (count of cards by CMC, shown as a simple bar chart — not just a single average number), color identity/color distribution, deck name.
