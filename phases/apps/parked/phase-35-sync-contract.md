# Phase 35 — Sync Contract (server side)

> **Parked with Phase 36.** Nothing here is needed while phones use a browser. It is pure server work and is the first session to run if the companion app is un-parked.

The server half of the companion app, built and tested before any phone exists: the snapshot the phone carries away, the idempotency table that makes a retried upload safe, and the one composite route a queued trade replays into. Everything here is `server/src` plus a migration; nothing here needs Android Studio, a device, or `mobile/`. It is split out of [Phase 36](phase-36-native-companion-app.md) because it is the one piece of that phase with a schema change, because every part of it is provable with `app.inject`, and because its two contracts are additive-only from the day they ship — they cannot be reworked once a phone has been built against them, so they deserve their own session and their own tests.

Phase 36 stays the umbrella: the two-modes design, what shop mode may and may not do, the version-skew rule. This doc is the server's side of that agreement, made concrete against the code as it stands.

## Prerequisites

- **Phase 33** — `instance_id` in `app_settings` and `GET /api/v1/instance`. The snapshot carries `instanceId` so a phone can refuse a snapshot from a library it is not paired with; that id is Phase 33's to create, not this phase's.
- **Not Phase 13.** The sale action is deferred with it; this phase leaves the door open (see *The replayable routes*) and builds nothing for it.
- **Not Phase 16.** OCR is a phone-side concern; nothing here touches it.

Sequencing within `phases/apps/`: after Phase 33, before Phase 36b (shop mode). It can be built before or after the Android home-mode session; neither depends on the other.

## Where it lives

`server/src/companion/` — new directory, three files:

| File | What |
| --- | --- |
| `snapshot.ts` | `buildSnapshot(db)` — assembles the document from the existing stores and `allocation.ts`. |
| `idempotency.ts` | `withIdempotencyKey(db, key, route, fn)` — the read-or-run helper the replayable routes wrap themselves in. |
| `routes/companion.ts` (in `routes/`) | `GET /api/v1/snapshot`, `POST /api/v1/trades/record`. Registered in `index.ts` like every other route file. |

**On the word "snapshot".** The codebase already has two: deck snapshots (`decks/snapshots.ts`, the undo/history rows) and the collection value snapshot (`CollectionStore.takeSnapshot()`, `collection_value_history`). This is a third, unrelated thing. The URL stays `GET /api/v1/snapshot` because Phases 36 and 37 both name it and the phone will address it by that path forever; the *code* is under `companion/` and never uses the bare word for a type or function — `CompanionSnapshot`, `buildSnapshot`. A session that reaches for `takeSnapshot()` here has the wrong one.

## The snapshot

`GET /api/v1/snapshot` returns one JSON document, gzipped (`zlib.gzipSync`, `Content-Encoding: gzip` — there is no compression plugin in the server and this is the only route that wants one; do not add `@fastify/compress` for it). Assembled on request; not cached. It is a handful of the queries the app already runs, and the phone fetches it on foreground and from background sync, so a large collection costs a few hundred milliseconds per sync — fine.

```
{
  "formatVersion": 1,
  "generatedAt":   "2026-09-15T21:04:00Z",
  "instanceId":    "<Phase 33 instance_id>",
  "serverVersion": "<server/package.json version>",

  "locations": [ { "id", "name", "kind", "isArchived" } ],

  "cards": [                       // one per oracle card the collection holds
    { "oracleId", "name", "isBasicLand",
      "owned", "reserved", "tradeListed", "available", "tracked",   // allocation.ts, verbatim
      "lots": [ { "id", "printingId", "setCode", "collectorNumber",
                  "locationId", "quantity", "finish", "condition", "language" } ] }
  ],

  "decks": [
    { "id", "name", "formatCode", "status", "reserves",              // reserves = allocation.ts reserves(status)
      "homeLocationId",
      "cards": [ { "oracleId", "name", "quantity", "isCommander", "board" } ] }
  ],

  "wantLists":  [ { "id", "name", "items": [ { "oracleId", "name", "quantity", "targetPriceUsd", "priority" } ] } ],
  "tradeLists": [ { "id", "name", "items": [ { "collectionItemId", "oracleId", "name", "quantity" } ] } ],

  "catalog": [ [ "<oracleId>", "<name>", 0|1 ] ]   // every oracle card: id, name, isBasicLand; ~35k rows
}
```

Decisions folded into that shape:

- **The allocation figures ride along, computed by the server.** Phase 36 says the phone applies no allocation, legality or basic-land logic, and it does not: `owned / reserved / tradeListed / available / tracked` are `allocation.ts`'s numbers as of `generatedAt`, delivered as data. This is what lets shop mode answer "can I trade this away without breaking a deck?" without a rule living on the phone. The Phase 36 overlay adjusts `owned` for queued actions and touches nothing else — `available` in shop mode is a stale server number with a pending badge, never a phone-side subtraction.
- **`catalog` is an array of tuples, not objects.** It is the one part of the document whose size is set by Scryfall rather than by the collection; tuples keep it to a few MB uncompressed and well under one gzipped. It is what makes *add to want list* work for a card you do not own. No oracle text, no prices, no image URIs — those are home-mode reads.
- **Lots are listed, not aggregated.** The phone shows "where copies live"; a lot is the unit that has a location. It never edits one.
- **Archived locations are included, flagged.** A lot in an archived box is still a card you own; `allocation.ts` already excludes it from `owned`, and the phone should show it the same way the web app does.
- **`formatVersion` is additive-only from `1`.** Fields are added, never removed or renamed; a phone ignores fields it does not know. Bumping the number is for a phone to detect a *floor* it cannot read, and should be rare enough that the first bump is a design conversation. Write this rule as a comment at the top of `snapshot.ts`.

Tests: the document round-trips through `JSON.parse(gunzipSync(...))`; a collection with one card in two lots across two locations reports `owned` matching `allocation.ts` for that card; a brew deck reports `reserves: false` and does not contribute to `reserved`; a basic land reports `tracked: false` while `allocation_ignores_basics` is on; `catalog` has one row per `oracle_cards` row.

## Idempotency

### The table

```sql
CREATE TABLE idempotency_keys (
    key         TEXT PRIMARY KEY,
    route       TEXT NOT NULL,        -- 'trades/record', 'want-lists/items'
    status      INTEGER NOT NULL,     -- the HTTP status that was returned
    response    TEXT NOT NULL,        -- the JSON body that was returned
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

In both `schema.sql` and `migrations.ts`, next unused `user_version` at build time. No index beyond the primary key; the table never holds more than a month of a person's shop visits.

### The helper, and why it is not a `preHandler`

Phase 36 describes "a Fastify `preHandler` on exactly the replayed routes." A `preHandler` can only do the *read* side — return the stored response when the key is seen. The write side would then be an `onResponse` hook storing the result after the handler commits, and the gap between those two is the whole problem: a trade committed, then the process killed before the key row is written, replays as a second trade. The point of the table is that this cannot happen.

So the unit is a function, not a hook, and it wraps the store call in the same transaction as the key row:

```ts
// companion/idempotency.ts
export function withIdempotencyKey<T>(
  db: Database.Database, key: string, route: string,
  run: () => { status: number; body: T },
): { status: number; body: T; replayed: boolean }
```

Inside one `db.transaction`: look the key up — if present, return the stored status and body with `replayed: true` and run nothing; otherwise call `run()`, insert the key with what it returned, and return it. `better-sqlite3` nests transactions as savepoints, so the store's own transaction inside `run()` is fine. Because the lookup and the insert are in one transaction there is no race between two uploads of the same key, and a crash anywhere leaves either both the trade and the key or neither.

`run()` returns a status and a body rather than throwing, so a **4xx is stored too**: a queued action the server has answered is final, whichever way it answered, and a retry gets the same answer rather than a second attempt against a changed collection. Phase 36's phone-side rule ("a 4xx other than a replayed-key hit marks the item failed and moves on") depends on this. Ajv validation failures happen before the handler and are not stored — a retry re-validates and fails the same way, which is equivalent.

Pruning: **on insert**, `DELETE FROM idempotency_keys WHERE created_at < <30 days ago>` — one statement against a tiny table, inside the same transaction. Phase 36 assigned this to the backup schedule's hourly timer; that couples `companion/` to `porting/schedule.ts` for no gain, and a table that is only ever written through one function can prune itself there. Note the deviation in the umbrella doc when this ships.

### The header

`Idempotency-Key`, a client-generated UUID. **Required** on `POST /api/v1/trades/record` — the route exists only for replay, and a call without a key is a call that can double-apply, so it is a 400. **Optional** on `POST /api/v1/want-lists/:id/items` — the web UI calls it today without one and keeps doing so; when the header is present the route wraps itself in the helper, when absent it behaves exactly as now. `WantStore.addItem` is already one-row-per-card-per-list and a re-add reactivates, so the want path is idempotent even without the key; it still goes through the helper so the phone gets a stored response and both replayable routes behave the same way.

## The replayable routes

| Action | Route | Status |
| --- | --- | --- |
| `want_add` | `POST /api/v1/want-lists/:id/items` (existing, gains the optional header) | This phase |
| `trade_record` | `POST /api/v1/trades/record` (new) | This phase |
| `sale_record` | `POST /api/v1/collection/items/:id/sell` (Phase 13's route) | Phase 13 wraps it in the helper when it is built; nothing to do here |

### `POST /api/v1/trades/record`

```
Idempotency-Key: <uuid>
{
  "counterpartyName": "…",       required
  "counterpartyContact": "…",    optional
  "tradeDate": "YYYY-MM-DD",     optional, defaults to today
  "locationNote": "…",           optional
  "notes": "…",                  optional
  "items": [                     required, non-empty
    { "direction": "out"|"in", "printingId", "quantity",
      "finish"?, "condition"?, "language"?,
      "sourceCollectionItemId"?, "destinationLocationId"?, "unitValueUsd"? }
  ]
}
→ 201 { "trade": <TradeStore.get(id)>, "result": <CompleteResult> }
```

One transaction: `TradeStore.create` → `addItem` for each → `complete(id, { conflictMode: 'alert' })`. The existing web flow (draft, item posts, complete) is untouched; this is the same three store calls the UI makes over several requests, made atomically because a replay must be one request. `conflictMode: 'alert'` is the only mode a replay may use — nothing on the phone can answer a confirmation prompt — and it behaves as `TradeStore` already documents: the trade completes, decks are left as they are, and each outgoing card a reserving deck was using gets an `allocation_conflict` alert. That path deliberately does not reconcile claims (CLAUDE.md, *Allocation tracking*), and this route changes nothing about that.

**The shortfall case is a refusal, not a partial apply.** Phase 36 says a trade queued against a card since traded away "raises an alert and is recorded as far as it validly can be." The store does not do that and should not start: under `'alert'`, an outgoing item the collection does not hold throws `TradeShortfallError` before anything is written (`trades/store.ts`, `complete()`), because a trade whose `value_out_usd`, disposal log and collection disagree is worse than no trade. The route catches it and returns **409** `{ error, shortfalls }` with nothing applied — the draft is rolled back with the transaction, so verification item 11 holds — and the helper stores the 409 so the phone marks the item failed with the store's own message. `errorHandler.ts` gains `TradeShortfallError → 409` alongside `TradeNotDraftError`; it is not mapped today and would surface as a 500.

**The desktop hears about it too.** A failure listed only on the phone is a failure nobody at the desk sees. The route raises an alert:

- **New alert kind `replay_failed`.** `alerts.kind` is a `CHECK` constraint, so the migration rebuilds the table with the widened list and recreates `idx_alerts_active` identically (`migrations.test.ts` will insist). `AlertKind` in `alerts/store.ts` and its mirror in `web/src/api.ts` gain the value; `AlertsBell.tsx` gets a label for it.
- `dedupe_key = 'replay_failed:<idempotency key>'`, so a phone that re-uploads a failed item does not pile up alerts. `subject_type` null (there is no trade). `title` names the counterparty and the date; `message` is the store's shortfall sentence; `payload` is the request body, so the user can re-enter it by hand from the alert.
- Raised for the 409 only. A trade that completes with `allocation_conflict` alerts already has those; a validation 400 never reaches the route.

Not reused: `trade_list_clamped` and `allocation_conflict` each mean one specific thing in `contention.ts` and `reconcileAlerts`, and a replay failure is neither.

## Version skew

Both apps update independently (Phase 32's shell, Phase 36's phone), so either can be ahead. The contract this phase commits to, additive-only from the day it ships:

- `formatVersion` on the snapshot — see above.
- The request and response shapes of the replayable routes, and the `Idempotency-Key` behaviour. Request bodies may gain optional fields only; responses may gain fields only.

`serverVersion` is `server/package.json`'s version, read the same way Phase 33's instance endpoint reads it (share the one function; do not read the file twice). The phone compares it against its floor and shows *Update the desktop app* rather than failing oddly. The floor is the phone's to hold; the server does not know or care what phones exist.

## What this phase does not change

- Any store's rules. `TradeStore`, `WantStore`, `allocation.ts` are called, not edited. The one code change outside `companion/` and `routes/` is the `errorHandler.ts` mapping and the alert kind.
- The web client's trade flow. Draft → items → complete stays as it is; `trades/record` is not called from `web/src`.
- The no-offline rule. This phase gives the phone a document to read and two inserts to replay, which is the carve-out CLAUDE.md already describes. It adds no edit path.

## Verification

Numbers in brackets are the umbrella doc's items this satisfies.

1. `GET /api/v1/snapshot` gunzips to a document whose `cards[].owned/reserved/tradeListed/available` equal `allocation.ts` for every card, with a brew deck contributing nothing to `reserved` and a basic land reporting `tracked: false` under `allocation_ignores_basics`.
2. A trade posted to `/api/v1/trades/record` produces the same `trades`, `trade_items`, `collection_disposals` rows and the same allocation result as the same trade entered through draft → items → complete. **[1]**
3. The same body posted twice with the same `Idempotency-Key` applies once; the second response carries the stored status and body and `replayed: true`; `collection_disposals` has one set of rows. **[2]**
4. Two concurrent posts with the same key (two `app.inject` calls without awaiting between them) apply once.
5. A `trades/record` whose outgoing item the collection does not hold returns 409, writes no `trades` row, no `trade_items`, no disposals, and raises one `replay_failed` alert; posting it again returns the stored 409 and raises no second alert. **[4, 11]**
6. A `trades/record` whose outgoing card a reserving deck is using completes, leaves the deck's claim untouched, and raises an `allocation_conflict` alert — the existing `'alert'` behaviour, confirmed through the new route.
7. `POST /api/v1/want-lists/:id/items` with a key applies once across two posts; without a key it behaves exactly as before (existing route tests still pass unchanged).
8. `trades/record` without an `Idempotency-Key` header is a 400 and writes nothing.
9. Keys older than 30 days are gone after the next insert; keys younger are not.
10. `migrations.test.ts` passes: the rebuilt `alerts` table matches `schema.sql`, `idx_alerts_active` included; a database at the previous `user_version` with active alerts of every existing kind migrates with those rows intact.
11. A snapshot from a database with `instance_id` set carries it; `serverVersion` matches `server/package.json`. **[10, server half]**

Item [3] (a queued sale that no longer has enough lot quantity) waits for Phase 13; items [5–9, 12, 13] are phone-side.

## Out of scope

- Anything in `mobile/` or `web/src` beyond the alert label. The phone-side queue, replay loop, snapshot store and shop-mode surface are Phase 36b.
- The sale route (Phase 13) and its wrapping.
- Caching or diffing the snapshot. A few hundred milliseconds per sync does not justify invalidation logic; if a collection ever makes it slow, the fix is a `generatedAt`-keyed `If-None-Match`, still built here, still additive.
- Pushing anything to the phone. The server is polled; it never initiates.
- Authentication on these routes. Phase 33's trust model applies: the home network is the perimeter, and a token only the phone sends while the browser walks in freely would be theatre.

## After this ships

Update `phase-36-native-companion-app.md` in three places: the *Server changes* section becomes a pointer here; the "recorded as far as it validly can be" sentence becomes "refused with a 409 and a `replay_failed` alert, nothing applied"; and the "pruned by the backup schedule's existing timer" line becomes "pruned on insert." Add the new kind to Phase 37's consumer notes — the mailbox injects into these same routes and inherits the behaviour unchanged.
