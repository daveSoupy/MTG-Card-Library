# Phase 1 — Core Database & Search

(Assumes the schema from `CLAUDE.md`'s Data Model is already in place.)

- Sync full card database via bulk data on first launch; show sync progress.
- Full-text/attribute search: name, oracle text, type line, color(s), color identity, mana cost/CMC (exact or range), set, rarity, power/toughness. Support Scryfall-style query syntax if feasible (players already know it), otherwise a structured filter UI.
- **"Owned only" filter/toggle** on the search and card-picker views, so browsing and adding cards to a deck can be scoped to what's actually in the Collection instead of the full database.
- Card detail view: full card image (front/back for double-faced cards), oracle text, legality per format, current price fields, and a "view on TCGplayer" / "view on Card Kingdom" link that opens the browser to that card's search/product page on each site.
