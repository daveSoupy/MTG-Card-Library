# Phase 36 — Companion App (Home and Shop Modes)

> **Parked.** The phone reaches the desktop app through a browser instead (see `../README.md`, *Parked*). This spec stays valid; un-park it when someone wants to record a trade away from home and can't. Build Phase 35 first.

The phone app. At home it is the whole web app with a home-screen icon and a camera; away from home it is a shop companion — look up what you own, record a trade, add a want — that syncs the moment the phone is back on the home wifi. It depends on nothing outside the house: no VPN, no account, no tunnel. Phase 32 is how it finds the server; this phase is what it does once it has, and what it does when it can't.

**Rewritten** after Phases 31 and 32 were specced. The original spec was iOS-only, reached the server over Tailscale's phone app, and hand-built its own collection screen. The reasons it gave for going native — real background sync, on-device OCR, fast capture — still hold and are kept below as the native plugin layer. What changed is the shell (the existing web client, wrapped), the connectivity model (home network only, with an offline mode for the rest), and the platform (both).

## Prerequisites

- **Phase 32** — pairing and discovery. This app's "am I home?" is Phase 32's discovery sequence.
- **Phase 13** for `sale_record`; until it ships the queue has two actions, not three.
- **Phase 16's scan endpoint** for OCR; until it ships, the camera captures for the collection add flow only.

Phase 33 (PWA install) is not a prerequisite and is not replaced — a phone without this app still gets the web app from the same QR code.

## Shape: one shell, two modes

**Capacitor** wrapping the existing `web/` build, for iOS and Android from one codebase. The web app is the UI; the shell adds a native origin (which browsers treat as secure, so camera and the rest need no HTTPS), native plugins, and a mode switch.

- **Home mode** — Phase 32's discovery found the paired server. The app is the web app, unchanged, against the live server. Deck building, collection, everything. This is the same client as the browser; it must never grow a branch of its own.

  **Home mode loads the UI from the server, not from a copy bundled in the app.** After discovery the WebView navigates to the server's origin, and what renders is whatever `web/dist` that server is serving. A change to `web/` or `server/` reaches the phone the next time it opens the app, with no app-store build in between — the app only needs rebuilding when the pairing screen, the shop-mode surface or a native plugin changes. The bundled copy of `web/dist` exists for shop mode, which has no server to load from. Capacitor's `server.allowNavigation` must list the paired origins; whether plugins are reachable from the server's origin is verified at build time, and home mode needs none of them in any case.
- **Shop mode** — discovery failed within its budget. The app renders a small offline surface from the last snapshot: search your collection and decks by name, see where copies live, browse and add to want lists, record a trade, record a sale (Phase 13). Every write goes into a local queue. A banner says *Shop mode · last synced 3 hours ago · 4 actions waiting* and never pretends to be live.

### The snapshot shows your own pending actions

The snapshot is what the desktop knew at the last sync; the queue is what the phone has done since. Shown separately, the phone contradicts itself — a card traded away last week still reads as owned, a want added yesterday is missing from the list — and that self-contradiction, not staleness, is what makes an offline view feel untrustworthy.

So shop mode renders the **snapshot with the queue overlaid**: a queued trade reduces the shown quantity of what went out and adds what came in; a queued want appears in its list; a queued sale reduces the lot. Each affected row carries a *pending* badge, and tapping it shows the queued action. The overlay is presentation only — it never writes to the snapshot store, so a failed replay leaves nothing to undo on the phone; the snapshot after the next sync is the truth and the overlay is discarded. Basic-land and allocation rules are not applied on the phone (they are the server's); the overlay adjusts counts, nothing else.

The switch is automatic and re-evaluated on foreground. Shop mode is *not* a general offline mode: it cannot edit a deck, move a lot, or change a setting, and it never will. The no-offline rule in CLAUDE.md stands; this is the one carve-out it already allows, with a read-only snapshot added so the queued writes have something to be about.

### `web/src` changes the shell needs

- **A configurable API base.** `api.ts` builds relative `/api/v1/...` URLs. In home mode they resolve against the server's origin because the page *came from* that origin; the shop-mode surface, served from the bundled copy, needs an `apiBase()` read by `apiFetch` — empty in the browser and in home mode, the paired origin otherwise.
- **`CONNECTIVITY_MESSAGE`** names the tailnet. In the shell, an unreachable server is not an error, it is shop mode; the message becomes context-aware or the shell intercepts before it renders.
- **The shop-mode surface** lives in `web/src` too (it is React), gated on the shell's mode flag, and reads from the snapshot store rather than `api.ts`. Kept deliberately small — a few screens, phone layout only, reusing the Phase 9 one-handed patterns.

## The snapshot

`GET /api/v1/snapshot` — one gzipped JSON document the server assembles on request:

- `formatVersion` (additive-only; see *Version skew*), `generatedAt`, `instanceId`, `serverVersion`.
- **Collection**: every lot, aggregated the way `CollectionStore` already does — card, printing, location, quantity, foil, condition. Read-only on the phone.
- **Decks**: each deck's name, format, status, and card list with quantities. Enough to answer "is this in a deck?"; nothing that would let the phone edit one.
- **Want lists and trade lists**: names and items.
- **Storage locations.**
- **A catalog name index**: `(oracleId, name, isBasicLand)` for every oracle card — ~35k rows, a few MB. This is what lets *add to want list* work offline for a card you do not own. Oracle text, prices, and images are not in the snapshot; they are home-mode reads.

Sizes: tens of MB uncompressed for a large collection, a few MB gzipped. Fetched on every foreground in home mode and by background sync; stored in the app's local database (Capacitor SQLite plugin). The server does not cache it; assembling it is a handful of the queries the app already runs.

## The queue

Three actions, inserts only, each carrying a client-generated UUID as the `Idempotency-Key` header:

| Action | Endpoint | Notes |
| --- | --- | --- |
| `want_add` | `POST /api/v1/want-lists/:id/items` | Resolved to an `oracleId` from the name index at capture time. |
| `trade_record` | `POST /api/v1/trades/record` — **new, this phase** | The existing trade API is a draft, item posts, and a complete call across several requests; a replay must be one atomic request. This composite takes counterparty and items and completes in one transaction with `conflictMode: 'alert'`. The web UI keeps using the draft flow. |
| `sale_record` | Phase 13's sell route | Deferred until Phase 13. |

Replay runs in queue order, stopping on the first connectivity failure and continuing on the next attempt. It is triggered by every event that could mean the phone is home, so a queue rarely waits for the app to be opened:

- app foreground;
- **the phone joining a wifi network** (iOS `NWPathMonitor` / Android `ConnectivityManager` network callback, via the same plugin as background sync) — the walk-in-the-door case, and the one that closes most of the gap between the two devices;
- the platform's periodic background task;
- a manual *Sync now* in the banner.

Each trigger runs Phase 32 discovery first; "not home" is a silent no-op, not an error. A `4xx` other than a replayed-key hit marks the item failed with the server's message and moves on; failures are listed in the app, never silently dropped.

### Server changes

- **`idempotency_keys` table** — `key TEXT PRIMARY KEY, route TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL`. A Fastify `preHandler` on exactly the replayed routes: a seen key returns the stored status and body without touching a store. Rows older than 30 days are pruned by the backup schedule's existing timer. Both `schema.sql` and `migrations.ts`; next unused `user_version` at build time.
- **`POST /api/v1/trades/record`** as above, in `routes/trades.ts` calling `TradeStore`.
- **Replay conflicts surface as alerts.** A queued sale whose lot no longer has enough quantity by sync time, or a trade against a card since traded away from the desktop, raises an `alerts` row (reusing the `trade_list_clamped` / `allocation_conflict` kinds) and is recorded as far as it validly can be — never a silent partial apply, never a crashed sync. Nothing can answer a confirmation prompt, so the store's `'alert'` mode is the only one a replay may use.

## Native plugin layer

The parts the original spec was right about, as Capacitor plugins rather than a hand-written app:

- **Background sync.** iOS `BGTaskScheduler` + background `URLSession`; Android `WorkManager`. Safari has no Background Sync API and never will, which is the single strongest reason this is an app and not the PWA. The task runs Phase 32 discovery, and if home, pushes the queue and pulls a snapshot.
- **OCR.** iOS Vision (`VNRecognizeTextRequest`), Android ML Kit text recognition. Both post recognised *text* to Phase 16's endpoint, which accepts text or an image for exactly this reason. In shop mode, recognised text resolves against the name index locally so a scan can feed a want or a trade offline.
- **Camera capture loop.** Native camera session for scanning a stack; the web `<input capture>` path remains the fallback.
- **Share target** (motivated by Phase 21): receive a CSV, a photo, or a screenshot from another app. Android via an intent filter; iOS needs a Share Extension target, which Capacitor allows but does not generate. Stretch — build after everything else in this phase works.

## Version skew

The desktop app (Phase 31) and this app update independently, so either can be ahead. Two contracts, additive-only from the day they ship:

- `formatVersion` on the snapshot: fields are added, never removed or renamed; the app ignores fields it does not know.
- The three replayed endpoints and the `Idempotency-Key` behaviour: request shapes may gain optional fields only.

The app reads `serverVersion` from Phase 32's instance endpoint and shows *Update the desktop app* rather than failing oddly when the server is older than the oldest version it supports.

## Distribution

- **iOS** — TestFlight for friends (Apple Developer Program, $99/yr; builds expire after 90 days) or the App Store. Sideloading via Xcode re-signs weekly and is for the developer only.
- **Android** — an APK on the GitHub release page, sideloaded; Play Store optional.

## Verification

1. A trade queued in shop mode replays on reconnect and produces the same `collection_disposals` and allocation result as entering it live.
2. Replaying the same queued action twice (simulate a timeout after commit) applies it exactly once; the second request returns the stored response with the stored status.
3. A queued sale that no longer has enough lot quantity raises an alert and does not partially apply.
4. A trade queued offline against a card since traded away from the desktop surfaces as an alert on replay.
5. Native OCR on a known test card resolves through the same fuzzy-match and `ocr_corrections` path the web OCR flow uses; in shop mode the same text resolves against the name index.
6. Backgrounding the app mid-scan-session and returning resumes the session with unsynced scans intact.
7. Sharing a CSV via the share target lands it in the chosen known player's snapshot (once Phase 21 exists).
8. Wifi off → the app enters shop mode within the discovery budget with the last snapshot and its age shown; wifi on at home → home mode on the next foreground, queue pushed, snapshot refreshed, banner gone.
12. In shop mode, a queued trade-away shows the card's quantity reduced with a *pending* badge, and a queued want appears in its list; after replay the badge is gone and the figures match the server's. A queued action that fails on replay is listed as failed and the overlay for it is removed.
13. Joining the home wifi with the app in the background pushes the queue and refreshes the snapshot without the app being opened (observable on the desktop within the platform's background budget).
9. Home mode is byte-for-byte the web client: no route, component, or style exists only in the shell.
10. An older app against a newer server (and the reverse) syncs; a server older than the app's floor shows the update message rather than an error.
11. `POST /api/v1/trades/record` completes atomically — a failing item leaves no draft trade behind.

## Out of scope

- Editing anything but the three queued inserts while offline. A deck edit in shop mode is not a queued action; it is not possible.
- Live access from outside the home network. Phase 32 explains why; `deploy/README.md` keeps "bring your own Tailscale" for anyone who wants it anyway.
- Syncing when the two devices are never home at the same time. Phase 37 (optional) adds a cloud folder as a second transport for exactly that; this phase's LAN path must work without it.
- Rebuilding the web client's screens natively. The shell exists so that never has to happen.
- Push notifications.
