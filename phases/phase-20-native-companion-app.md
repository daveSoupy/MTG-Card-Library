# Phase 20 — Companion App (Home and Shop Modes)

The phone app. At home it is the whole web app with a home-screen icon and a camera; away from home it is a shop companion — look up what you own, record a trade, add a want — that syncs the moment the phone is back on the home wifi. It depends on nothing outside the house: no VPN, no account, no tunnel. Phase 29 is how it finds the server; this phase is what it does once it has, and what it does when it can't.

**Rewritten** after Phases 28 and 29 were specced. The original spec was iOS-only, reached the server over Tailscale's phone app, and hand-built its own collection screen. The reasons it gave for going native — real background sync, on-device OCR, fast capture — still hold and are kept below as the native plugin layer. What changed is the shell (the existing web client, wrapped), the connectivity model (home network only, with an offline mode for the rest), and the platform (both).

## Prerequisites

- **Phase 29** — pairing and discovery. This app's "am I home?" is Phase 29's discovery sequence.
- **Phase 13** for `sale_record`; until it ships the queue has two actions, not three.
- **Phase 16's scan endpoint** for OCR; until it ships, the camera captures for the collection add flow only.

Phase 19 (PWA install) is not a prerequisite and is not replaced — a phone without this app still gets the web app from the same QR code.

## Shape: one shell, two modes

**Capacitor** wrapping the existing `web/` build, for iOS and Android from one codebase. The web app is the UI; the shell adds a native origin (which browsers treat as secure, so camera and the rest need no HTTPS), native plugins, and a mode switch.

- **Home mode** — Phase 29's discovery found the paired server. The app is the web app, unchanged, against the live server. Deck building, collection, everything. This is the same client as the browser; it must never grow a branch of its own.
- **Shop mode** — discovery failed within its budget. The app renders a small offline surface from the last snapshot: search your collection and decks by name, see where copies live, browse and add to want lists, record a trade, record a sale (Phase 13). Every write goes into a local queue. A banner says *Shop mode · last synced 3 hours ago* and never pretends to be live.

The switch is automatic and re-evaluated on foreground. Shop mode is *not* a general offline mode: it cannot edit a deck, move a lot, or change a setting, and it never will. The no-offline rule in CLAUDE.md stands; this is the one carve-out it already allows, with a read-only snapshot added so the queued writes have something to be about.

### `web/src` changes the shell needs

- **A configurable API base.** `api.ts` builds relative `/api/v1/...` URLs; in the shell they must be prefixed with the paired server's origin. One `apiBase()` read by `apiFetch`, empty in the browser.
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

Replay runs whenever home mode is entered and via background sync, in queue order, stopping on the first connectivity failure and continuing on the next attempt. A `4xx` other than a replayed-key hit marks the item failed with the server's message and moves on; failures are listed in the app, never silently dropped.

### Server changes

- **`idempotency_keys` table** — `key TEXT PRIMARY KEY, route TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL`. A Fastify `preHandler` on exactly the replayed routes: a seen key returns the stored status and body without touching a store. Rows older than 30 days are pruned by the backup schedule's existing timer. Both `schema.sql` and `migrations.ts`; next unused `user_version` at build time.
- **`POST /api/v1/trades/record`** as above, in `routes/trades.ts` calling `TradeStore`.
- **Replay conflicts surface as alerts.** A queued sale whose lot no longer has enough quantity by sync time, or a trade against a card since traded away from the desktop, raises an `alerts` row (reusing the `trade_list_clamped` / `allocation_conflict` kinds) and is recorded as far as it validly can be — never a silent partial apply, never a crashed sync. Nothing can answer a confirmation prompt, so the store's `'alert'` mode is the only one a replay may use.

## Native plugin layer

The parts the original spec was right about, as Capacitor plugins rather than a hand-written app:

- **Background sync.** iOS `BGTaskScheduler` + background `URLSession`; Android `WorkManager`. Safari has no Background Sync API and never will, which is the single strongest reason this is an app and not the PWA. The task runs Phase 29 discovery, and if home, pushes the queue and pulls a snapshot.
- **OCR.** iOS Vision (`VNRecognizeTextRequest`), Android ML Kit text recognition. Both post recognised *text* to Phase 16's endpoint, which accepts text or an image for exactly this reason. In shop mode, recognised text resolves against the name index locally so a scan can feed a want or a trade offline.
- **Camera capture loop.** Native camera session for scanning a stack; the web `<input capture>` path remains the fallback.
- **Share target** (motivated by Phase 21): receive a CSV, a photo, or a screenshot from another app. Android via an intent filter; iOS needs a Share Extension target, which Capacitor allows but does not generate. Stretch — build after everything else in this phase works.

## Version skew

The desktop app (Phase 28) and this app update independently, so either can be ahead. Two contracts, additive-only from the day they ship:

- `formatVersion` on the snapshot: fields are added, never removed or renamed; the app ignores fields it does not know.
- The three replayed endpoints and the `Idempotency-Key` behaviour: request shapes may gain optional fields only.

The app reads `serverVersion` from Phase 29's instance endpoint and shows *Update the desktop app* rather than failing oddly when the server is older than the oldest version it supports.

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
9. Home mode is byte-for-byte the web client: no route, component, or style exists only in the shell.
10. An older app against a newer server (and the reverse) syncs; a server older than the app's floor shows the update message rather than an error.
11. `POST /api/v1/trades/record` completes atomically — a failing item leaves no draft trade behind.

## Out of scope

- Editing anything but the three queued inserts while offline. A deck edit in shop mode is not a queued action; it is not possible.
- Live access from outside the home network. Phase 29 explains why; `deploy/README.md` keeps "bring your own Tailscale" for anyone who wants it anyway.
- Rebuilding the web client's screens natively. The shell exists so that never has to happen.
- Push notifications.
