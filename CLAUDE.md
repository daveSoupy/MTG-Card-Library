# MTG Deck Builder — Project Instructions

This file is auto-loaded by Claude Code at the start of every session. Keep it lean — it holds only what's relevant to *every* session: the build process, the tech stack, and the full data model (since nearly every phase touches the data layer). Phase-specific feature requirements live separately in `phases/` and are **not** auto-loaded — reference the specific one you're working on with an `@`-mention (e.g. `@phases/phase-4-collection-pricing.md`) only for the session working on that phase.

## How to Build This

1. **One-time only, before any schema or code exists:** read this file plus every file in `phases/` in full, then design the complete SQLite schema against the full Data Model below (all seven entities), even though most tables sit unused until later phases are built. This is the single most important step for avoiding rework — a schema designed only around Phase 1 will need real migrations once Trades, Storage Locations, and allocation tracking arrive later; designing against the full model up front costs nothing extra and avoids that entirely.
2. **Present the schema for review before writing any UI code.** Highest-leverage checkpoint in the project — confirm it before building on top of it.
3. **After the schema is settled, build one phase at a time, in order.** For each phase's session, `@`-mention only that phase's file under `phases/` — you don't need to reload the others; this file plus the target phase file is sufficient context.
4. **If the current phase file references another phase by name or says "see Phase N"**, read that specific phase's file (and, if it's already built, its actual code) before implementing that piece — don't guess at what the referenced phase means or contains.
5. **Produce working, runnable software at the end of each phase**, not partial UI spanning multiple phases at once.
6. **Stop and wait for confirmation after each phase** rather than continuing to the next one unprompted.
7. **Commit at the end of each completed phase.**
8. Phase 7 (OCR-assisted entry) is an optional stretch goal — build it only if explicitly requested, after Phases 1–6 are solid.

## Repo Layout

- `CLAUDE.md` — this file, project root, auto-loaded every session.
- `phases/phase-1-core-database-search.md`
- `phases/phase-2-deck-building-format-rules.md`
- `phases/phase-3-commander-specific-rules.md`
- `phases/phase-4-collection-pricing.md`
- `phases/phase-5-import-export-backup.md`
- `phases/phase-6-trades-want-trade-lists.md`
- `phases/phase-7-ocr-assisted-entry.md` (optional stretch goal)

## Overview

Native macOS application for browsing the full Magic: The Gathering card database, building and managing multiple decks, tracking a personal card collection and its value, and interacting with TCGplayer and Card Kingdom for pricing and purchasing. Single-user, local-first, personal use.

## Tech Stack

- **Platform:** Native macOS app in SwiftUI.
- **Local storage:** SQLite (or Core Data) for the cached card database, collection, and decks. All search/filtering happens against this local store — never against a live API call per keystroke.
- **Networking:** URLSession for Scryfall API and bulk data sync.

## Data Source: Scryfall

Use the [Scryfall API](https://scryfall.com/docs/api) as the single source of card data, rules text, images, and price data. Important constraints to follow:

- **Sync via bulk data, not live search.** Scryfall publishes daily "bulk data" JSON dumps (`oracle_cards` or `default_cards`) specifically so applications cache locally instead of hitting the live API for every lookup. On first launch and on a periodic schedule (e.g., daily, or on manual "refresh" trigger — this covers the "fetch new cards" requirement), download the current bulk data file, decompress, and upsert into the local database.
- **Respect rate limits.** If any live API calls are made (e.g., for something not in the local cache yet), stay under ~10 req/sec for normal endpoints and ~2 req/sec for search endpoints. Always send a descriptive `User-Agent` header.
- **Price data comes from Scryfall's card fields** (`usd`, `usd_foil`, `eur`, `tix`) — sourced from TCGplayer/Cardmarket/Cardhoarder. Do not scrape TCGplayer or Card Kingdom directly. Treat bulk-data prices as ~24h stale; that's fine for collection-value estimates.
- **Image handling.** Cache downloaded card images to disk (don't re-fetch repeatedly). Never crop, cover, or otherwise obscure the copyright line or artist name printed on a card image.
- **Attribution.** Don't imply Scryfall endorses the app; don't paywall or gate access to the underlying card data.

## Data Model

Seven distinct concepts — keep them separate; don't conflate them:

1. **Card Database** — the full synced Scryfall catalog. Read-only, always current after sync. Includes oracle text, mana cost, color identity, type line, legalities per format, set/printing info, image URIs, and price fields.
2. **Collection** — cards the user actually owns, tracked per physical storage location and specific printing as `(card, set/collector number, location, quantity, foil?, condition?, price override?)`. A single card can be split across multiple locations and printings (e.g., 2 copies of the modern reprint in one binder, 2 copies of an old foil in a box) — the total owned for a card name is the sum across all its rows, but value calculations use each row's own printing (since price varies a lot by printing). `price override` lets you set a manual value for a specific copy (e.g., a beat-up card, or a printing whose market price doesn't reflect its real condition) instead of always using the synced market price. This is what "track the value of the whole library" refers to — sum of `quantity × (price override or current market price)` across all rows.
3. **Decks** — named lists built from the Card Database. Each card slot in a deck can optionally be linked to the Collection (see Allocation Tracking below) rather than existing independently.
4. **Storage Locations** — user-defined physical places cards live: binders, boxes, deck boxes, etc. Every Collection row references one, and a Deck can optionally have a "home location" (e.g., the deck box it physically lives in) so allocated copies resolve to a real place, not just "in a deck."
5. **Trades** — records of cards exchanged with another person. Completing a trade automatically moves cards into and out of the Collection rather than requiring manual edits on both ends.
6. **Want List** — cards you're actively looking to acquire, independent of what you currently own.
7. **Trade List** — specific owned copies flagged as available to trade away, tracked as their own quantity — separate from total owned and separate from deck-allocated copies.

### Allocation tracking (Collection ↔ Decks)

A physical card can only be in one deck at a time, so the app should track not just *how many* of a card you own, but *how many are currently claimed by decks*:

- For each owned card: **owned qty**, **allocated qty** (sum of copies marked "from collection" across all decks that use it), and **available qty** (owned − allocated).
- When adding a card to a deck, the app should show whether you own enough available copies and let you mark that slot as "from my collection" (draws from allocation) vs. "need to buy" (doesn't touch the collection). Default to "from my collection" when you have enough available.
- If a deck wants more copies of a card than are currently available (because other decks already claim them), flag it visually rather than blocking it — you may be planning decks you don't intend to assemble simultaneously.
- From a card's detail view or the Collection view, show **which decks currently use this card and how many copies, and where the rest physically live** — e.g. "Deck A ×2 (home: Blue Tackle Box), Binder 3 ×2 available" — so you can find where to pull it from whether it's loose or already built into a deck.
- **Deleting a deck releases its allocation.** Any copies that deck claimed go back to "available" immediately — a card that was previously flagged as fully allocated across decks should become available again the moment one of those decks is deleted, without a manual fix-up step.

## Non-Functional Requirements

- App should work offline for search/deck-building once the initial sync has completed; only price refresh and new-card sync need network access.
- Autosave decks and collection changes locally; no account/login system needed (single local user).
- Basic error handling for sync failures (stale cache is fine, don't block the app).

## Scope Note: Single-Device for v1

This spec is local-first on one Mac, with no sync to other devices. That's a deliberate v1 scope choice, not an oversight — worth naming so it's decided on purpose. Practical effect: no way to check your collection or want lists from a phone while at a card shop or trade meetup. If that matters later, the cheapest add-on is a read-only export (e.g., a periodically-generated file or simple web view of the Collection/Want Lists) rather than building full multi-device sync — but that's out of scope here and can be revisited after the phases above are working.
