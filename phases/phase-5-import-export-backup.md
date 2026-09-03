# Phase 5 — Import / Export & Backup

(Assumes Phases 1–4 are complete.)

- **Deck export:** copy a deck to the clipboard as plaintext decklist (`4 Lightning Bolt` format, optionally with set code/collector number), compatible with TCGplayer's mass-entry format and MTGO/Arena export format. Use the async Clipboard API; it must be triggered by a real click, since iOS Safari refuses clipboard writes outside a user gesture. Offer a plain textarea fallback for when it is refused anyway.
- **Deck import:** paste a plaintext decklist and resolve each line against the local card database, flagging any line that doesn't match a known card (fuzzy match with a manual-resolve step for ambiguous names).
- Direct links: from a deck view, open TCGplayer's mass-entry/cart page and Card Kingdom's decklist-import page pre-filled where those sites support it via URL; otherwise link to each site's search results.
- **Bulk collection import:** import owned cards from a CSV file (or a common export format from another tool, e.g. Deckbox, TCGplayer, or ManaBox), mapping name/set/quantity/foil/condition columns to Collection rows in one pass — so getting an existing binder/box collection into the app doesn't mean typing every card by hand.
- **Full backup / restore:** export the entire local database (Collection, Decks, Trades, Want/Trade Lists, Storage Locations) as a file download, and restore by uploading one — protects against a corrupted database, a drive failure, or moving to a new host. The card cache does not need to be in the backup; it re-downloads from Scryfall in about 17 seconds.
- **Server-side scheduled backups.** Because the server runs unattended, a periodic copy of `library.sqlite` (SQLite's `VACUUM INTO` gives a consistent snapshot without stopping writes) is worth more than a manual export anyone has to remember to click.
