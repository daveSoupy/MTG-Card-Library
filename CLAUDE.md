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
- `schema.sql` — the complete SQLite schema, source of truth. Loaded verbatim at
  bootstrap; there is no second copy of the DDL to drift out of sync with it.
- `server/` — Fastify API. `src/db`, `src/sync`, `src/search`, `src/routes`, `src/model`.
- `server/scripts/` — `check-sqlite.mjs` (verify the SQLite build has FTS5 and
  trigram — run after any `npm rebuild`), `sync.mjs`, `search-check.mjs`.
- `web/` — React + Vite client.
- `deploy/` — systemd unit and install notes.
- `phases/phase-1-core-database-search.md`
- `phases/phase-2-deck-building-format-rules.md`
- `phases/phase-3-commander-specific-rules.md`
- `phases/phase-4-collection-pricing.md`
- `phases/phase-5-import-export-backup.md`
- `phases/phase-6-trades-want-trade-lists.md`
- `phases/phase-7-ocr-assisted-entry.md` (optional stretch goal)

## Overview

Self-hosted web application for browsing the full Magic: The Gathering card database, building and managing multiple decks, tracking a personal card collection and its value, and interacting with TCGplayer and Card Kingdom for pricing and purchasing. Single-user, personal use, running on a machine at home.

## Tech Stack

- **Shape:** One server owns the data *and the rules*; clients only render. Deck validation, search parsing, allocation maths and format rules all live server-side — never duplicated into a client.
- **Server:** Node 22+ with TypeScript, Fastify, and `better-sqlite3`. REST + JSON under `/api/v1`.
- **Storage:** SQLite. All search and filtering runs against the local database — never a live API call per keystroke.
- **Client:** React + Vite, one codebase with two real layouts — a multi-pane deck builder at desktop widths, and one-handed views for trades and want lists on a phone.
- **Networking:** `fetch` for the Scryfall API and bulk sync; `DecompressionStream` for the gzipped bulk files.
- **Hosting:** An always-on Linux box under systemd, reached over Tailscale.

### Rules that keep the architecture honest

- **The bulk sync runs in a `worker_thread`.** `better-sqlite3` is synchronous and a full import takes ~17s; on the main thread that blocks every HTTP request for the duration. WAL lets the main process keep serving reads while the worker writes. Progress reaches the browser over Server-Sent Events.
- **Tailscale is the security perimeter, so there is no login.** The server is never exposed publicly. Moving to Cloudflare Tunnel or port-forwarding would make authentication mandatory.
- **A native iOS client stays cheap by construction** — it would consume the same endpoints rather than reimplementing any rules. Keep business logic server-side, keep responses resource-shaped, return `updated_at`, and use a token header rather than cookies if auth is ever added.

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

- Search and deck-building must never hit the network — everything runs against the local SQLite store. Only the bulk sync and price refresh reach out to Scryfall, and a stale cache must stay fully usable when they fail.
- Autosave decks and collection changes on the server; no account/login system needed (single user behind Tailscale).
- Basic error handling for sync failures (stale cache is fine, don't block the app).

## Scope Note: One Server, Many Clients

This was originally specced as a native macOS app, single-device by design. That was revisited during Phase 1: recording a trade at a card shop is a *write*, so the read-only export the old scope note proposed would never have covered it.

The app is now a self-hosted server that owns the database and the rules, with clients against it. Practical effects:

- **Any device on the tailnet works** — phone at a card shop, desktop at home — with no sync layer, because there is only ever one database.
- **The server has to be up.** Clients are always-connected by design; there is no offline mode and no local cache to reconcile. This is a deliberate trade for having zero conflict-resolution code.
- **A native iOS client is left open, not built.** It would be another consumer of the same API. Keep rules on the server and that stays a small project; move rules into a client and it stops being one.
- **Backups are one file.** `library.sqlite` plus the phase docs is the whole of it; the card cache re-downloads from Scryfall in about 17 seconds.
