# MTG Deck Builder — Project Instructions

This file is auto-loaded by Claude Code at the start of every session. Keep it lean — it holds only what's relevant to *every* session: the build process, the tech stack, and the full data model (since nearly every phase touches the data layer). Phase-specific feature requirements live separately in `phases/` and are **not** auto-loaded — reference the specific one you're working on with an `@`-mention (e.g. `@phases/phase-11-game-draft-log.md`) only for the session working on that phase.

## Where the project stands

Phases 1–6 are built and shipped. `schema.sql` is the complete schema at `PRAGMA user_version = 12`, designed up front against the full Data Model below — so most tables later phases need (`collection_disposals`, `printing_price_history`, `scan_sessions`, `alerts`, …) already exist. New phases extend the schema through migrations; they do not redesign it. Before assuming a table or column is missing, grep `schema.sql`.

## How to Build This

1. **Build one phase at a time.** For each phase's session, `@`-mention only that phase's file under `phases/` — this file plus the target phase file is sufficient context.
2. **If the current phase file references another phase by name or says "see Phase N"**, read that phase's file (and, if it's already built, its actual code) before implementing that piece — don't guess at what the referenced phase means or contains.
3. **Schema changes.** Every DDL change goes in **both** `schema.sql` (fresh installs) and `server/src/db/migrations.ts` (upgrades). `migrations.test.ts` proves the two agree — a migration that rebuilds a table must recreate its indexes identically. Keep multi-line comments out of column lists. Each schema-touching phase bumps `PRAGMA user_version` to **the next unused version at build time** — phase docs never hardcode a number, because optional and unsequenced phases make the build order non-deterministic.
4. **Produce working, runnable software at the end of each phase**, not partial UI spanning multiple phases at once.
5. **Every phase file ends with a Verification section.** Implement those checks as tests where they're testable, and walk through the rest manually before calling the phase done.
6. **Stop and wait for confirmation after each phase** rather than continuing to the next one unprompted.
7. **Commit at the end of each completed phase.**
8. Phase 0 is prep on shipped code and must precede Phase 9. Phases 7 and 8 are unsequenced and can be built at any point. Phase 16 (OCR-assisted entry) is optional — build it only if explicitly requested. Phase 20 (native iOS app) is a separate codebase against the same API.

## Repo Layout

- `CLAUDE.md` — this file, project root, auto-loaded every session.
- `schema.sql` — the complete SQLite schema, source of truth for fresh installs. Loaded verbatim at bootstrap. `server/src/db/migrations.ts` carries the upgrade path for existing databases; `migrations.test.ts` keeps the two in agreement.
- `server/` — Fastify API. `src/db`, `src/sync`, `src/search`, `src/routes`, `src/model`, plus per-domain stores (`src/collection`, `src/decks`, `src/trades`, `src/tradelists`, `src/porting`, `src/pricing`).
- `server/scripts/` — `check-sqlite.mjs` (verify the SQLite build has FTS5 and trigram — run after any `npm rebuild`), `sync.mjs`, `search-check.mjs`.
- `web/` — React + Vite client. Entry point `web/src/main.tsx`; components under `web/src/components/`.
- `deploy/` — systemd unit and install notes.
- `phases/phase-1-core-database-search.md` (shipped)
- `phases/phase-2-deck-building-format-rules.md` (shipped)
- `phases/phase-3-commander-specific-rules.md` (shipped)
- `phases/phase-4-collection-pricing.md` (shipped)
- `phases/phase-5-import-export-backup.md` (shipped)
- `phases/phase-6-trades-want-trade-lists.md` (shipped)
- `phases/phase-0-prep.md` (not sequenced — engineering prep on the shipped code; build before Phase 9)
- `phases/phase-7-deck-templates.md` (optional, not sequenced — depends only on Phases 2 and 3)
- `phases/phase-8-quick-fixes.md` (not sequenced — three small fixes to shipped features)
- `phases/phase-9-mobile-overhaul.md`
- `phases/phase-10-display-density.md`
- `phases/phase-11-game-draft-log.md`
- `phases/phase-12-price-history-live-pricing.md`
- `phases/phase-13-sales-event-costs.md`
- `phases/phase-14-shopping-cart-export.md`
- `phases/phase-15-theming.md`
- `phases/phase-16-ocr-assisted-entry.md` (optional stretch goal)
- `phases/phase-17-onboarding.md`
- Phase 18, Shareable Decklists — planned but not yet spec'd. Note the constraint before specing it: the server is never exposed publicly, so "shareable" means an exported artifact (a Moxfield-importable text blob, a file), not a public URL into this app.
- `phases/phase-19-pwa-install-flow.md`
- `phases/phase-20-native-companion-app.md` (native iOS client for OCR scanning and offline trade/sale/want recording — see the architecture notes below on what this means for the "no offline mode" rule)
- `phases/phase-21-known-players.md` (capstone — after every other phase. A lighter alternative to full multi-user: friends' collections and want lists as read-only imported snapshots, no accounts, no `user_id` on any existing table)

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
- **A native iOS client stays cheap by construction** — it consumes the same endpoints rather than reimplementing any rules. Keep business logic server-side, keep responses resource-shaped, return `updated_at`, and use a token header rather than cookies if auth is ever added. Phase 20 is this client: a thin native app for OCR scanning and offline trade/sale/want recording, not a full rewrite of anything else.
- **Settings go through the allowlists.** `app_settings` is a plain key/value table, but the settings route only reads and writes keys registered in `BOOLEAN_SETTINGS` / `ENUM_SETTINGS` / `NUMBER_SETTINGS` (`server/src/routes/settings.ts`). A new setting is an entry there, not a raw write to the table.

## Data Source: Scryfall

Use the [Scryfall API](https://scryfall.com/docs/api) as the single source of card data, rules text, images, and price data. Important constraints to follow:

- **Sync via bulk data, not live search.** Scryfall publishes daily "bulk data" JSON dumps (`oracle_cards` or `default_cards`) specifically so applications cache locally instead of hitting the live API for every lookup. On first launch and on a periodic schedule (daily, or on a manual "refresh" trigger), download the current bulk data file, decompress, and upsert into the local database.
- **Respect rate limits.** If any live API calls are made (e.g., for something not in the local cache yet), stay under ~10 req/sec for normal endpoints and ~2 req/sec for search endpoints. Always send a descriptive `User-Agent` header.
- **Price data comes from Scryfall's card fields** (`usd`, `usd_foil`, `eur`, `tix`) — sourced from TCGplayer/Cardmarket/Cardhoarder. Do not scrape TCGplayer or Card Kingdom directly. Treat bulk-data prices as ~24h stale; that's fine for collection-value estimates.
- **Image handling.** Cache downloaded card images to disk (don't re-fetch repeatedly). Never crop, cover, or otherwise obscure the copyright line or artist name printed on a card image.
- **Attribution.** Don't imply Scryfall endorses the app; don't paywall or gate access to the underlying card data.

## Data Model

Seven distinct concepts — keep them separate; don't conflate them:

1. **Card Database** — the full synced Scryfall catalog (`oracle_cards`, `card_printings`, `card_faces`, `card_legalities`, `sets`). Read-only, always current after sync. Includes oracle text, mana cost, color identity, type line, legalities per format, set/printing info, image URIs, and price fields.
2. **Collection** (`collection_items`) — cards the user actually owns, tracked per physical storage location and specific printing as `(card, set/collector number, location, quantity, foil?, condition?, price override?)`. A single card can be split across multiple locations and printings — the total owned for a card name is the sum across all its rows, but value calculations use each row's own printing. `price override` lets you set a manual value for a specific copy instead of the synced market price. Collection value = sum of `quantity × (price override or current market price)` across all rows.
3. **Decks** (`decks`, `deck_cards`) — named lists built from the Card Database. Each card slot can optionally be linked to the Collection (see Allocation Tracking below) rather than existing independently.
4. **Storage Locations** (`storage_locations`) — user-defined physical places cards live: binders, boxes, deck boxes. Every Collection row references one, and a Deck can optionally have a `home_location_id` so allocated copies resolve to a real place, not just "in a deck."
5. **Trades** (`trades`, `trade_items`) — records of cards exchanged with another person. Completing a trade automatically moves cards into and out of the Collection rather than requiring manual edits on both ends. Counterparties are freeform text, not accounts.
6. **Want List** (`want_lists`, `want_list_items`) — cards you're actively looking to acquire, independent of what you currently own.
7. **Trade List** (`trade_lists`, `trade_list_items`) — specific owned copies flagged as available to trade away, tracked as their own quantity — separate from total owned and separate from deck-allocated copies.

### Allocation tracking (Collection ↔ Decks)

A physical card can only be in one deck at a time, so the app tracks not just *how many* of a card you own, but *how many are currently claimed by decks*:

- For each owned card: **owned qty**, **allocated qty** (sum of copies marked "from collection" across all decks that use it), and **available qty** (owned − allocated).
- When adding a card to a deck, show whether you own enough available copies and let the slot be marked "from my collection" (draws from allocation) vs. "need to buy" (doesn't touch the collection). Default to "from my collection" when enough is available.
- If a deck wants more copies than are available (other decks already claim them), flag it visually rather than blocking — you may be planning decks you don't intend to assemble simultaneously.
- From a card's detail view or the Collection view, show which decks currently use this card, how many copies, and where the rest physically live — e.g. "Deck A ×2 (home: Blue Tackle Box), Binder 3 ×2 available."
- **Deleting a deck releases its allocation** immediately, with no manual fix-up step.

## Non-Functional Requirements

- Search and deck-building must never hit the network — everything runs against the local SQLite store. Only the bulk sync and price refresh reach out to Scryfall, and a stale cache must stay fully usable when they fail.
- Autosave decks and collection changes on the server; no account/login system (single user behind Tailscale).
- Basic error handling for sync failures (stale cache is fine, don't block the app).

## Scope Note: One Server, Many Clients

This was originally specced as a native macOS app, single-device by design. That was revisited during Phase 1: recording a trade at a card shop is a *write*, so a read-only export would never have covered it.

The app is a self-hosted server that owns the database and the rules, with clients against it. Practical effects:

- **Any device on the tailnet works** — phone at a card shop, desktop at home — with no sync layer, because there is only ever one database.
- **The server has to be up, with one narrow, deliberate exception.** Clients are always-connected by design; there is no general offline mode and no local cache to reconcile — a deliberate trade for having zero conflict-resolution code. Phase 20 carves out exactly one scenario: OCR scanning and trade/sale/want recording in the native app, queued locally and synced when connectivity returns. It's tractable because those three actions are inserts, not edits, and each queued action carries a client-generated idempotency key so a retried upload can never apply twice. It doesn't reopen the general question for anything else.
- **Backups are one file.** `library.sqlite` plus the phase docs is the whole of it; the card cache re-downloads from Scryfall in about 17 seconds.
