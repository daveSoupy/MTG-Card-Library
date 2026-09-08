# Phase 20 — Native Companion App (Scanning & Offline Recording)

A thin native iOS client for two things that turn out to be the same real-world moment — a shop or draft table, phone in hand, signal iffy: OCR scanning (Phase 16's native path) and offline want/trade/sale recording. Everything else stays in the web app. Phase 19's PWA install flow is unaffected; this phase replaces nothing, it adds the one client that can work offline.

## Why native

- **Real background sync.** `BGTaskScheduler` and background `URLSession` let iOS retry and complete queued uploads even when the app isn't open. Safari has no Background Sync API and WebKit has rejected it permanently, so a PWA could never do this cleanly.
- **Better OCR.** Apple's Vision framework (`VNRecognizeTextRequest`) beats Tesseract on card fonts, foil glare, and unusual layouts. Phase 16's scan endpoint already accepts recognised text instead of an image for exactly this reason.
- **Faster capture.** `AVFoundation` supports a tight capture loop through a stack of cards.
- **Distribution as a real app** keeps the option to charge for it later.

## Scope: three write actions and the reads they need

- **Actions queued offline:** `want_add`, `trade_record`, `sale_record` — against `addWantItem`, the composite trade endpoint from Phase 6, and Phase 13's sell route. Inserts only; nothing shared can conflict with itself (CLAUDE.md, Scope Note).
- **Local queue:** Core Data or a local file.
- **Sync:** `BGTaskScheduler` for periodic attempts, background `URLSession` for the uploads.
- **Read cache** for picking what to trade or sell: a local copy of the collection and card search, refreshed whenever online.
- **A real collection-browsing screen.** Recording a trade or sale means choosing which of your cards are involved. This is the one piece of real UI in the app — small, purpose-built, not a port of the web collection page.
- **iOS Share Extension** (motivated by Phase 21): from Messages/Photos/Files, share a CSV, a binder photo, or a want-list screenshot into this app and pick which known player it's for. Images route into the OCR pipeline; text/CSV into Phase 5's import parser. This phase owns the extension target, entitlements, and share-sheet registration; Phase 21 owns the known-player destination it feeds.

## Server changes this phase requires

The server side is *nearly* untouched, with one exception that isn't optional:

- **Idempotency keys on the three replayed endpoints.** Background `URLSession` can deliver a request the server already applied — a timeout after commit, a retry on reconnect. Without a guard, a queued sale or trade applies twice. Each queued action carries a client-generated UUID sent as an `Idempotency-Key` header; the server stores seen keys (a small `idempotency_keys` table: key, route, response, created_at) and returns the stored response on a repeat instead of re-applying. Next unused `user_version` at build time.
- **Replay conflicts surface as alerts.** A queued sale whose lot no longer has enough quantity by sync time, or a trade against a card since sold from another device, raises an `alerts` row (reusing `trade_list_clamped` / `allocation_conflict` kinds) — replays always call the trade store with `conflictMode: 'alert'`, since nothing can answer a confirmation prompt and is recorded as far as it validly can be — never a silent partial apply, never a crashed sync.
- **Connectivity.** The phone reaches the server over Tailscale's iOS app, same as the web client. No auth is added; the token-header note in CLAUDE.md applies only if the perimeter ever changes.

## Distribution (open decision)

- **App Store** — supports charging later; requires the $99/year Apple Developer Program.
- **Sideloading via Xcode** — free; re-sign every 7 days without the paid program. Fine for personal use.

Doesn't need deciding now.

## Verification

1. A trade queued offline replays on reconnect and produces the same `collection_disposals` and allocation result as entering it live.
2. Replaying the same queued action twice (simulate a retry after a timeout) applies it exactly once — the second request returns the stored response.
3. A queued sale that no longer has enough lot quantity raises an alert and does not partially apply.
4. A trade queued offline against a card since sold from another device surfaces as an alert on replay.
5. Vision-framework OCR on a known test card resolves through the same fuzzy-match and `ocr_corrections` path the web OCR flow uses.
6. Backgrounding the app mid-scan-session and returning resumes the session with unsynced scans intact.
7. Sharing a CSV via the Share Extension lands it in the chosen known player's snapshot (once Phase 21 exists).

## Out of scope

- Rebuilding the rest of the app natively. Browsing, deck building, and collection management stay in the web app.
- Android. Vision and `BGTaskScheduler` are Apple APIs; an Android equivalent is its own phase.
