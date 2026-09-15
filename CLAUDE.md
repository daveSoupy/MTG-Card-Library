# MTG Deck Builder — Project Instructions

This file is auto-loaded by Claude Code at the start of every session. Keep it lean — it holds only what's relevant to *every* session: the build process, the tech stack, and the full data model (since nearly every phase touches the data layer). Phase-specific feature requirements live separately in `phases/` and are **not** auto-loaded — reference the specific one you're working on with an `@`-mention (e.g. `@phases/phase-11-game-draft-log.md`) only for the session working on that phase.

## Where the project stands

Phases 0–11 and 22–27 are built and shipped. `schema.sql` is the complete schema at `PRAGMA user_version = 19`, designed up front against the full Data Model below — so most tables later phases need (`collection_disposals`, `printing_price_history`, `scan_sessions`, `alerts`, …) already exist. New phases extend the schema through migrations; they do not redesign it. Before assuming a table or column is missing, grep `schema.sql`.

## How to Build This

1. **Build one phase at a time.** For each phase's session, `@`-mention only that phase's file under `phases/` — this file plus the target phase file is sufficient context.
2. **If the current phase file references another phase by name or says "see Phase N"**, read that phase's file (and, if it's already built, its actual code) before implementing that piece — don't guess at what the referenced phase means or contains.
3. **Schema changes.** Every DDL change goes in **both** `schema.sql` (fresh installs) and `server/src/db/migrations.ts` (upgrades). `migrations.test.ts` proves the two agree — a migration that rebuilds a table must recreate its indexes identically. Keep multi-line comments out of column lists. Each schema-touching phase bumps `PRAGMA user_version` to **the next unused version at build time** — phase docs never hardcode a number, because optional and unsequenced phases make the build order non-deterministic.
4. **Produce working, runnable software at the end of each phase**, not partial UI spanning multiple phases at once.
5. **Every phase file ends with a Verification section.** Implement those checks as tests where they're testable, and walk through the rest manually before calling the phase done.
6. **Stop and wait for confirmation after each phase** rather than continuing to the next one unprompted.
7. **Commit at the end of each completed phase.**
8. Phase 0 is prep on shipped code and must precede Phase 9. Phases 7 and 8 are unsequenced and can be built at any point. Phase 16 (OCR-assisted entry) is optional — build it only if explicitly requested. Phase 20 (companion phone app) is a separate build against the same API and needs Phase 29 first; Phases 28 and 29 are unsequenced.
9. **Phase 22 comes before 23–27.** It rewrites how "available" is computed and puts that computation in one place (`server/src/decks/allocation.ts`). Phases 23–27 all call it rather than re-deriving the formula, and any phase built on the old rule produces numbers that are confidently wrong rather than visibly broken. Within that set, 24 precedes 25 and 26; 27 is last.

## Repo Layout

- `CLAUDE.md` — this file, project root, auto-loaded every session.
- `docs/CODEBASE-MAP.md` — **read this before searching for a file.** File-by-file map of `server/src` and `web/src`. Read its first section (the "where do I edit" table, ~80 lines) before any grep or find; read the per-file sections only if the table did not answer. Update its entry whenever you add, rename, or move a source file, and rerun `python3 docs/atlas/build.py` to regenerate the interactive map.
- `schema.sql` — the complete SQLite schema, source of truth for fresh installs. Loaded verbatim at bootstrap. `server/src/db/migrations.ts` carries the upgrade path for existing databases; `migrations.test.ts` keeps the two in agreement.
- `server/` — Fastify API. `src/db`, `src/sync`, `src/search`, `src/routes`, `src/model`, plus per-domain stores (`src/collection`, `src/decks`, `src/trades`, `src/tradelists`, `src/porting`, `src/pricing`).
- `server/scripts/` — `check-sqlite.mjs` (verify the SQLite build has FTS5 and trigram — run after any `npm rebuild`), `sync.mjs`, `search-check.mjs`.
- `web/` — React + Vite client. Entry point `web/src/main.tsx`; components under `web/src/components/`.
- `deploy/` — systemd unit and install notes.
- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.github/workflows/docker.yml` — the container path. The workflow publishes `ghcr.io/davesoupy/mtg-card-library` (`edge` from main, `latest` from a `v*` tag); compose pulls that image and carries no `build:` so the file works on its own. The image keeps the repo's directory shape because `server/dist` locates `schema.sql` and `web/dist` by walking up from its own path.
- `phases/phase-1-core-database-search.md` (shipped)
- `phases/phase-2-deck-building-format-rules.md` (shipped)
- `phases/phase-3-commander-specific-rules.md` (shipped)
- `phases/phase-4-collection-pricing.md` (shipped)
- `phases/phase-5-import-export-backup.md` (shipped)
- `phases/phase-6-trades-want-trade-lists.md` (shipped)
- `phases/phase-0-prep.md` (shipped)
- `phases/phase-7-deck-templates.md` (shipped)
- `phases/phase-8-quick-fixes.md` (shipped)
- `phases/phase-9-mobile-overhaul.md` (shipped)
- `phases/phase-10-display-density.md` (shipped)
- `phases/phase-11-game-draft-log.md` (shipped)
- `phases/phase-12-price-history-live-pricing.md`
- `phases/phase-13-sales-event-costs.md`
- `phases/phase-14-shopping-cart-export.md`
- `phases/phase-15-theming.md`
- `phases/phase-16-ocr-assisted-entry.md` (optional stretch goal)
- `phases/phase-17-onboarding.md`
- Phase 18, Shareable Decklists — planned but not yet spec'd. Note the constraint before specing it: the server is never exposed publicly, so "shareable" means an exported artifact (a Moxfield-importable text blob, a file), not a public URL into this app.
- `phases/phase-21-known-players.md` (capstone — after every other phase. A lighter alternative to full multi-user: friends' collections and want lists as read-only imported snapshots, no accounts, no `user_id` on any existing table)
- `phases/apps/` — the phases that make the server something people install: desktop app, phone app, how they find each other. `phases/apps/README.md` has the one-paragraph design and the reading order; the constraint they all share is that nothing outside the home network is ever in the default path.
  - `phases/apps/phase-28-desktop-app.md` (the server packaged as a desktop app — Electron shell around the unmodified `server/dist`, tray/menu-bar lifecycle, auto-update, signed builds. A third way to run the same binary alongside systemd and Docker; LAN sharing off by default)
  - `phases/apps/phase-29-pairing-and-lan-discovery.md` (instance id, `_mtglibrary._tcp` mDNS advertisement, one QR code that opens the web app or pairs the companion app. Home network only, deliberately — no tunnels, relays or embedded VPNs; "bring your own Tailscale" stays a documented advanced option)
  - `phases/apps/phase-19-pwa-install-flow.md`
  - `phases/apps/phase-20-native-companion-app.md` (companion phone app, iOS and Android, Capacitor over `web/`: the web app at home, a snapshot-plus-queue "shop mode" away, syncing over the home network via Phase 29 — see the architecture notes below on what this means for the "no offline mode" rule. Rewritten after 28/29; needs 29, and 13 for sale recording)
  - `phases/apps/phase-30-cloud-mailbox.md` (optional, after 20/28/29 — a folder in the user's own cloud storage as a second transport: snapshots one way, the write queue the other, immutable files, each side writes only its own directories. The desktop consumer injects queue files into the server's own routes so idempotency and alert rules apply unchanged. Never the only path)
- `phases/phase-22-allocation-honesty.md` (shipped — deck status lifecycle, basic-land exemption, proxy counts, trade-list subtraction; establishes `server/src/decks/allocation.ts` as the single source of truth for "available")
- `phases/phase-23-owned-aware-search.md` (shipped — `owned:` / `available:` / `loc:` / `indeck:` search predicates)
- `phases/phase-24-deck-buildability.md` (shipped — buildable %, missing count, cost to complete, deck-list sorting)
- `phases/phase-25-assembly-pull-sheets.md` (shipped — resolves allocations to real lots at assembly time; pull sheets grouped by storage location, and disassembly that puts cards back. Its "write the claim from what was picked" step was superseded at build time, because the claim had become a derived figure; the doc says why and what replaced it)
- `phases/phase-26-allocation-contention.md` (shipped — which decks are fighting over which copies, reassignment, teardown simulation. Its contested-set and alert sections were rewritten at build time for the derived claim; the doc carries both versions)
- `phases/phase-27-owned-substitutes.md` (shipped — owned cards that could fill a slot you're short on, ranked by shared Tagger role / type / CMC in `server/src/decks/substitutes.ts`, with a keyword-heuristic fallback in `roleHeuristics.ts` for a database whose tag sync has never run. Read-only endpoints; accepting one is two ordinary card edits from the client, never a server-side swap)


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
7. **Trade List** (`trade_lists`, `trade_list_items`) — specific owned copies flagged as available to trade away, tracked as their own quantity, separate from total owned and from deck-allocated copies. A copy promised to someone else is not a copy you can build with, so trade-listed quantity is subtracted from **available** alongside deck allocation (Phase 22).

### Allocation tracking (Collection ↔ Decks)

A physical card can only be in one deck at a time, so the app tracks not just *how many* of a card you own, but *how many are currently claimed by decks*:

- For each owned card: **owned qty**, **claimed qty** (`deck_cards.quantity_from_collection`, summed across decks in a *reserving* status), **trade-listed qty**, and **available qty** (owned − claimed − trade-listed).
- **The claim is derived, never set.** `server/src/decks/reconcile.ts` sets each reserving slot's `quantity_from_collection` to `min(quantity − quantity_proxied, available)`, with `available` computed *excluding that deck's own claim* — so a deck never competes with itself and reconciling twice changes nothing. It runs inside every write that could change the answer: each `DeckStore` edit, deck duplicate, snapshot restore, assembly completion, and each `CollectionStore` lot or location change (`reconcileDecksHolding` / `reconcileAllDecks`). Never on a read — looking at a deck must not write. Two deliberate exceptions: trade completion's outgoing path passes `reconcileDecks: false` so `conflictMode: 'alert'` keeps the signal it exists to raise, and a slot that reserves nothing (maybeboard, or an exempt basic) is skipped rather than zeroed, because its stored claim is inert and becomes meaningful again the moment the exemption is switched off. Reconciliation is first-come-first-served: it never takes a copy from a deck already holding it, only fills what is still spare. So `fromCollection` on the cards API (kept for undo/redo replay and for proxies) is honoured durably in exactly one case — when another reserving deck immediately holds what was given up, which is what makes a Phase 26 reassignment stable. Any other hand-written claim is reverted by the next reconciling write. **Do not build anything that stores a fact in the claim** that the collection cannot see; that fact needs its own home (see assembly, below).
- **Only decks in a reserving status consume allocation** (Phase 22). A deck's `status` is one of `brew`, `building`, `assembled`, `disassembled`; the middle two reserve, the outer two don't. A brew holds a card list without laying claim to physical copies, so half-formed ideas stop starving decks you actually intend to build. `is_archived` is orthogonal and still only controls visibility.
- **Basic lands are exempt** from allocation, availability, shortfall and want lists while `allocation_ignores_basics` is on. **Proxied copies** (`deck_cards.quantity_proxied`) satisfy a slot without being owned or needing to be bought.
- **The proxy UI is parked — do not rebuild it without asking.** Proxies are still a real, working part of the data model: the column, the `quantity_from_collection + quantity_proxied <= quantity` rule in `DeckStore`, `copiesToBuy`, Phase 24's `covered = min(required, available + proxied)`, the `quantityProxied` field on `PATCH /api/v1/decks/:id/cards/:cardId`, and the undo/redo snapshot all stay live and tested. What was removed is the *only* way to set the number from the UI — the ± stepper in `DeckRow`, taken out after Phase 24 because the feature is not yet decided on. Everything else that renders a proxy count (the `.tile-proxied` badge, the Proxied row in `DeckStatsPanel`) is already `> 0`-guarded and so renders nothing while no slot has proxies. Restoring the feature is a stepper calling `updateDeckCard(deckId, cardId, { quantityProxied })`; `setSlotAllocation` still enforces the invariant and yields the derived claim to an explicit proxy request. Nothing underneath needs rebuilding.
- **Each figure is computed in exactly one place.** "Available" in `server/src/decks/allocation.ts`; coverage (what this deck's collection can actually supply, its own claim excluded) in `buildability.ts`, from `allocation.ts`; the claim in `reconcile.ts`, from `allocation.ts`. Never re-derive any of the three in a store, a route, or a client — call it. Phases 23–27 all depend on this holding.
- A deck row shows one chip saying what to do about the slot — `Have it` / `Have all 4`, `Atraxa has 1`, `Buy 4` (`web/src/deckSlot.ts`, from Phase 24's coverage). The holder case leads, being the only one that is a decision rather than a purchase. Nothing on the row sets the claim.
- If a deck wants more copies than are available (other decks already claim them), flag it visually rather than blocking — you may be planning decks you don't intend to assemble simultaneously.
- From a card's detail view or the Collection view, show which decks currently use this card, how many copies, and where the rest physically live — e.g. "Deck A ×2 (home: Blue Tackle Box), Binder 3 ×2 available."
- **Deleting a deck releases its allocation** immediately, with no manual fix-up step.
- **Assembly resolves the claim to real lots only at assembly time** (Phase 25, `server/src/decks/assembly.ts`), as a run recorded on `deck_assembly_runs` / `deck_assembly_items`; the steady-state schema stays count-based and never links a slot to a lot. The per-card budget is Phase 24's coverage, never re-derived. Because the claim is derived, a run's shortfall — a copy the sheet sent you for that was not there — cannot live in the claim (the next write would raise it back); it lives on the run as the un-ticked lines, read back as `RunSummary.notFound`, and the deck header shows "N not found on last pull" from there. `assembly_moves_lots` (default off) makes completion physically relocate lots into the deck's `home_location_id`; a move carries the **whole** lot identity through `lotKey()`, which is the merge key for any lot move in this codebase — merging on anything less folds two purchases into one row and silently destroys P&L history.
- **Contention (Phase 26, `server/src/decks/contention.ts`) is two conditions under one alert**, and computes neither: *over-allocation* is `allocation.ts`'s `reserved > owned − tradeListed` (rare on purpose — it means the ground moved after a deck claimed: a trade out, a listing, a status flip), and *contention* is `buildability.ts`'s per-row `contested` lifted to the collection (a reserving deck is short while another reserving deck holds copies). A merely unfinished deck is neither. The `allocation_conflict` alert is evaluated wherever either input can change — nearly all of it hangs off the end of `reconcile.ts`'s claim pass, and the explicit calls are only the paths that deliberately do not reconcile claims (the trade's outgoing path, trade-list changes, deck delete, reassignment, a settings flip); the list is a comment on `reconcileAlerts` with a test per row. A deck **status change now reconciles** the deck and every deck sharing a card with it — the one write that used to leave stale claims behind. Reassignment (`reassign`) is the one hand-write the derived claim preserves; the what-if endpoint runs Phase 24's engine with a status override and writes nothing.
- **Phases 7–21 were written before Phase 22 and their allocation references are stale.** Anything in those files that computes availability, excludes basic lands, or assumes every deck reserves its copies must be reworked to call `allocation.ts` instead. The draft/sealed "add-and-allocate" mode in Phase 11 is the sharpest case — it carries its own basic-land rule that would silently disagree. If Phase 22 is already built when you pick up one of those phases, treat this file's rules as authoritative over that phase file's wording. **Phases 22–27 were specced before the claim became derived**; Phase 25's completion step was superseded at build time and its doc is annotated. Phase 26 was reworked at build time accordingly (see its bullet above and the annotated doc); Phase 27 should expect the claim to be derived and the contested set to come from `contention.ts`.

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