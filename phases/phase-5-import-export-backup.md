# Phase 5 — Import / Export & Backup

(Assumes Phases 1–4 are complete.)

- **Deck export:** copy a deck to the clipboard as plaintext decklist (`4 Lightning Bolt` format, optionally with set code/collector number), compatible with TCGplayer's mass-entry format and MTGO/Arena export format.
- **Deck import:** paste a plaintext decklist and resolve each line against the local card database, flagging any line that doesn't match a known card (fuzzy match with a manual-resolve step for ambiguous names).
- Direct links: from a deck view, open TCGplayer's mass-entry/cart page and Card Kingdom's decklist-import page pre-filled where those sites support it via URL; otherwise link to each site's search results.
- **Bulk collection import:** import owned cards from a CSV file (or a common export format from another tool, e.g. Deckbox, TCGplayer, or ManaBox), mapping name/set/quantity/foil/condition columns to Collection rows in one pass — so getting an existing binder/box collection into the app doesn't mean typing every card by hand.
- **Full backup / restore:** export the entire local database (Collection, Decks, Trades, Want/Trade Lists, Storage Locations) to a single file the user can save elsewhere, and restore from that file — protects against a lost or corrupted local database, a drive failure, or migrating to a new Mac.
