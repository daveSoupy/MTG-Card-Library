# Codebase Map

A file-by-file guide to the repo: what each file does, what it imports, what imports it, and where a given kind of change belongs. Written so a session can go straight to the right file instead of searching for it.

**Keep this current.** When you add, rename, or move a source file, update its entry here in the same commit.

Generated from the import graph on 2026-09-15 (all of Phases 0–11 and 22–27 shipped, `PRAGMA user_version = 19`).

**Interactive version:** `docs/atlas/codebase-atlas.html` — the same graph as a clickable layered map (select a file → its imports and importers light up). Its Styles tab and `docs/CSS-INDEX.md` come from the same build. Rebuild with `python3 docs/atlas/build.py` after files move; the live copy is https://claude.ai/artifact/N9RBn22L9gnfhJBtixrKLg.

---

## 1. Where do I edit…? (start here)

| I want to change… | Go to | Notes |
|---|---|---|
| How "available / owned / reserved / trade-listed" is computed | `server/src/decks/allocation.ts` | The only place. Everything else calls it. |
| How a deck's claim (`quantity_from_collection`) gets set | `server/src/decks/reconcile.ts` | Derived, never hand-set. Runs after every write that could change it. |
| Buildable %, missing count, cost to complete, deck-list sorting | `server/src/decks/buildability.ts` | Coverage = what the collection can supply *this* deck, own claim excluded. |
| Contention alert, "give it to…" reassignment, what-if teardown | `server/src/decks/contention.ts` | Computes nothing itself; lifts allocation + buildability to the collection. |
| Pull sheets, assembly/disassembly runs, lot moves | `server/src/decks/assembly.ts` | `lotKey()` here is the merge key for *every* lot move in the codebase. |
| Owned substitutes ranking | `server/src/decks/substitutes.ts` (+ `roleHeuristics.ts` fallback) | Read-only. Accepting = two ordinary card edits from the client. |
| Deck CRUD, add/remove/patch a slot, duplicate, auto-maintain lands | `server/src/decks/store.ts` (`DeckStore`) | 1,131 lines. The biggest store. |
| Format legality rules (60-card, singleton, commander identity…) | `server/src/decks/validate.ts` | Reads the seeded `formats` table; no per-format branching. |
| Mana curve / type breakdown / colour stats | `server/src/decks/stats.ts` | Pure over `DeckCard[]`. |
| Mana-base analysis (pips vs sources) | `server/src/decks/manabase.ts` | Pure. |
| Recommended basic-land plan | `server/src/decks/lands.ts` | Pure; `DeckStore.addRecommendedLands` applies it. |
| Deck snapshots / history / restore | `server/src/decks/snapshots.ts` | Snapshot = copy of rows, includes the claim. |
| Deck templates ("follow a template") | `server/src/decks/templates.ts` | |
| The comma-list `deck_cards.category` column | `server/src/decks/categories.ts` | All reads/writes of that column go through here. |
| Collection lots: add/edit/remove/decrement, locations, cost pools, value | `server/src/collection/store.ts` (`CollectionStore`) | Lot-grained; aggregates card → printing → lot. |
| Want lists, want fulfilment on collection change | `server/src/collection/wants.ts` (`WantStore`, `reconcileWants`) | |
| A deck's shopping list; push to want list | `server/src/collection/shopping.ts` | Reads shortfall from allocation; no table of its own. |
| Trade drafts and completion (moves cards in/out) | `server/src/trades/store.ts` (`TradeStore`) | Draft never touches the collection; only `complete()` does. |
| Trade lists (copies flagged to trade away) | `server/src/tradelists/store.ts` | |
| In-app alerts (raise / ack / resolve, dedupe) | `server/src/alerts/store.ts` | |
| Price-target alerts after a sync | `server/src/pricing/alerts.ts` | |
| Events (draft nights) and the game log | `server/src/events/store.ts` | Gated by `show_game_log` setting. |
| Scryfall search syntax (`c:ur t:instant cmc<=2`) | `server/src/search/query.ts` | Tokenizer + compiler to SQL. |
| `owned:` / `available:` / `loc:` / `indeck:` predicates | `server/src/search/collection.ts` | Splices allocation's SQL in. |
| Running a search, sorting, paging, card detail | `server/src/search/store.ts` (`CardSearchStore`) | |
| Colour masks, name normalisation, rarity, copy limits | `server/src/model/mtg.ts` | Shared primitives; no DB. |
| Bulk sync from Scryfall (download, parse, upsert) | `server/src/sync/runSync.ts` → `importer.ts` | Runs in `syncWorker.ts` (worker thread). |
| Tagger categories (`card_categories`) | `server/src/sync/categories.ts` | |
| Rulings | `server/src/sync/rulings.ts` | |
| Scryfall HTTP client, User-Agent, bulk manifest | `server/src/sync/scryfall.ts` | |
| Card image cache / fetch / eviction / pre-download | `server/src/images/*` | `fetch.ts` writes; `cache.ts` evicts; `downloadManager.ts` bulk job. |
| Decklist text parse/format, CSV import mapping, name→card resolution | `server/src/porting/decklist.ts`, `csv.ts`, `resolve.ts` | All pure. `importer.ts` is preview+commit over them. |
| Backup / restore / scheduled backups | `server/src/porting/backup.ts`, `schedule.ts` | |
| Add or change a setting | `server/src/routes/settings.ts` | Add to `BOOLEAN_SETTINGS` / `ENUM_SETTINGS` / `NUMBER_SETTINGS`. Then `AppSettings` in `web/src/api.ts`. |
| Add a new API endpoint | `server/src/routes/<domain>.ts` + register in `server/src/index.ts` + client fn in `web/src/api.ts` | Routes hold no rules — they call a store. |
| Request body/param validation shapes | `server/src/routes/schema.ts` | Shared ajv fragments (`ID`, `COUNT`, `MONEY`, `body()`…). |
| Which errors become which HTTP status | `server/src/routes/errorHandler.ts` | Known error classes → 4xx; everything else 500. |
| Any DDL | `schema.sql` **and** `server/src/db/migrations.ts` | `migrations.test.ts` proves they agree. Bump `user_version`. |
| DB open, `getSetting`/`setSetting`, library status | `server/src/db/index.ts` | |
| Env vars (`MTG_DATA_DIR`, port, host) | `server/src/config.ts` | |
| **Web:** the HTTP client and every shared TS type | `web/src/api.ts` | Every component imports from here. Server type change → mirror here first. |
| **Web:** top-level views, nav, topbar, global state (settings/density/theme) | `web/src/App.tsx` | |
| **Web:** URL ↔ view mapping | `web/src/router.ts` | History-based; every route round-trips. |
| **Web:** the deck builder page (data loading, panels, dialogs, undo) | `web/src/components/DeckBuilder.tsx` | Orchestrator. Layout is in `DeckPanes.tsx`. |
| **Web:** deck builder three-pane layout, picker, lined-up view, hover preview | `web/src/components/DeckPanes.tsx` | 1,127 lines. Renders `DeckRow`/`DeckTile`/`DeckStatsPanel`/`CardDetailPane`. |
| **Web:** one row / one tile in a deck list | `web/src/components/DeckRow.tsx`, `DeckTile.tsx` | Chip text comes from `deckSlot.ts`. |
| **Web:** the "Have it / Need N / Atraxa has 1" chip | `web/src/deckSlot.ts` | |
| **Web:** the decks index page (cards, filters, buildability sort, tags) | `web/src/components/DeckList.tsx` | |
| **Web:** the collection page and its tabs (browse/add/sets/value/wants/tradelists) | `web/src/components/CollectionPage.tsx` | Tabs render `OwnedGrid`, `AddBySetTab`, `WantListsPage`, `TradeListsPage`. |
| **Web:** search filter sidebar (colours, types, sets, format…) | `web/src/components/FilterPanel.tsx` | `Filters` type lives here. |
| **Web:** grouping / sorting card lists, pane widths | `web/src/deckView.ts` | Pure; tested with `node --test`. |
| **Web:** display density (tile size) | `web/src/density.ts` + `CustomizeView.tsx` | |
| **Web:** undo/redo | `web/src/undo.ts` (stack), `deckHistory.ts` (deck snapshots), `UndoToast.tsx`, `UndoRedo.tsx` | |
| **Web:** trades / wants / trade-lists phone views | `TradesPage.tsx`, `WantListsPage.tsx`, `TradeListsPage.tsx` | |
| **Web:** backups, imports, storage, theme, settings UI | `web/src/components/DataPage.tsx` | |
| **Web:** all styling | `web/src/styles.css` | One file, 3,000 lines, `/* ---------- section ---------- */` headers. **Look the class up in `docs/CSS-INDEX.md` first** — the early sections ("results", "sync") hold the shared classes and their names don't say so. |
| **Web:** breakpoints / touch detection | `web/src/viewport.ts` | Mirrors the px values in `styles.css`. |

---

## 2. The shape of the thing

```
  Browser (React)                    Server (Fastify)                         SQLite
  ───────────────                    ────────────────                         ──────
  components/*.tsx ─┐
  *.ts helpers ─────┼─► api.ts ──HTTP──► routes/*.ts ──► <domain>/store.ts ──► db/index.ts ──► library.sqlite
  App.tsx ──────────┘   (only file        (validate,        (all the rules)        (schema.sql +
                         that fetches)     call a store)         │                  migrations.ts)
                                                                 ▼
                                                      decks/allocation.ts
                                                      (the one formula everyone reads)
```

**Rules that decide where code goes** (from `CLAUDE.md`, restated as file placement):

1. **Routes hold no logic.** A route file validates (via `routes/schema.ts`), calls one store/module function, and maps a thrown error class to a status. If you're writing an `if` about cards in a route, it belongs in a store.
2. **The client computes nothing.** `web/src/*.ts` helper modules (`buildability.ts`, `contention.ts`, `assembly.ts`, `deckSlot.ts`) *choose words* for server-supplied numbers. They never derive a figure. If a number is wrong on screen, the bug is on the server.
3. **One place per figure.** `available` → `allocation.ts`. Coverage → `buildability.ts`. The claim → `reconcile.ts`. Contention → `contention.ts`. Never re-derive; import and call.
4. **Pure modules are pure on purpose.** `decklist.ts`, `csv.ts`, `lands.ts`, `manabase.ts`, `validate.ts`, `deckView.ts`, `density.ts`, `router.ts` take data and return data, no DB and no React, so they're tested with plain `node --test`.

---

## 3. Server — `server/src/`

### Dependency layers (bottom is imported by everything above it)

```
routes/*  ─────────────────────────────────────────────  index.ts registers these
   │
stores:  decks/store  collection/store  trades/store  tradelists/store  collection/wants  events/store  alerts/store
   │
engines: decks/reconcile → decks/contention → decks/buildability → decks/allocation
         decks/assembly (→ buildability, reconcile)   decks/substitutes (→ allocation, roleHeuristics)
         search/store → search/collection → allocation      search/query
   │
pure:    model/mtg   decks/validate   decks/stats   decks/manabase   decks/lands   decks/types   decks/categories
   │
db/index (openLibrary, getSetting, setSetting) → db/migrations → schema.sql
```

### `index.ts` — bootstrap
Opens the DB, instantiates every store once, registers every `register*Routes`, installs `errorHandler`, serves `web/dist` for non-API paths, starts the backup schedule, listens. **Adding a route file means adding a line here.** Store construction order matters only for `TradeStore`, which takes `CollectionStore` and `AlertStore`.

### `config.ts`
`resolveDataDir` (`MTG_DATA_DIR`), `resolvePort`, `resolveHost`. Nothing imports it but `index.ts`.

### `db/`
| File | Does | Imports | Imported by |
|---|---|---|---|
| `index.ts` | `openLibrary()` runs `schema.sql` verbatim on an empty DB or the migrations on an existing one; `getSetting`/`setSetting` over `app_settings`; `libraryStatus`. | `migrations.ts` | Every store and engine that opens its own statements; `routes/settings`, `routes/storage`, `routes/sync`, `sync/*`. |
| `migrations.ts` | `MIGRATIONS[]` — ordered upgrade steps for a DB that already has data. Every DDL change is written here **and** in `schema.sql`. | — | `db/index.ts` |
| `migrations.test.ts` | Migrates an old DB and asserts it is structurally identical to a fresh `schema.sql` load. The test that catches the two drifting. | | |

### `model/mtg.ts`
Magic primitives with no DB: colour bitmask (`colorMask`, `colorsFromMask`, `parseColors`), `normalizeName`, `splitCollectorNumber`, `manaSymbols`, rarities, `EXTRA_LAYOUTS` (tokens/art cards to exclude), `UNLIMITED_COPIES`, `LIMITED_FORMATS`, `parseDeckCopyLimit`. **Imported by:** `decks/{lands,manabase,stats,store,substitutes,validate}`, `porting/{importer,resolve}`, `search/{query,store}`, `sync/importer`.

### `decks/` — the rules engine

| File | Does | Imports | Imported by |
|---|---|---|---|
| `allocation.ts` | **Single source of truth for owned / reserved / trade-listed / available.** Exposes both TS functions (`allocationFor`, `allocationForMany`, `availableFor`, `copiesToBuy`, `assertSlotFits`) and SQL CTE builders (`allocationCtes`, `OWNED_CTE`, `RESERVED_CTE`, `LISTED_CTE`, `ownedSemiJoinSql`) so search can splice the same formula into its queries. Also owns `DECK_STATUSES`, `RESERVING_STATUSES`, the three allocation settings keys, and `SlotOverfilledError`. | `db/index` | 15 files: `collection/{shopping,store}`, `decks/{buildability,contention,reconcile,stats,store,substitutes,types}`, `routes/{decks,settings}`, `search/{collection,store}`, `tradelists/store`, `trades/store` |
| `reconcile.ts` | Sets each reserving slot's `quantity_from_collection = min(need, available-excluding-self)`. `reconcileDeckClaims`, `reconcileDeckAndSharers`, `reconcileDecksHolding`, `reconcileAllDecks`. Ends by calling `contention.reconcileAlerts`. **Called inside every write that could change the answer; never on a read.** | `allocation`, `contention` | `collection/store`, `decks/{assembly,snapshots,store}` |
| `buildability.ts` | Coverage per slot (`covered = min(required, available + proxied)`), buildable %, missing, cost to complete, `contested` flag, `compareBuildability` sort, `missingForWantList`, `StatusOverrides` for what-if. `buildabilityForDecks` (list) and `buildabilityDetail` (one deck). | `allocation` | `decks/{assembly,contention}`, `routes/decks` |
| `contention.ts` | `contestedCards` (over-allocation ∪ contention), `reconcileAlerts` / `reconcileAllAlerts` (the `allocation_conflict` alert), `reassign` (the one preserved hand-write), `whatIf` (status override, writes nothing), `cardHolders` (the "Deck A ×2, Binder 3 ×2 available" line). The comment on `reconcileAlerts` lists every explicit caller. | `alerts/store`, `allocation`, `buildability` | `decks/{reconcile,store}`, `routes/{allocation,settings}`, `tradelists/store`, `trades/store` |
| `assembly.ts` | Phase 25. `resolveLots` (which physical lots, in what order, budget from buildability), `openAssemblyRun` / `openDisassemblyRun`, `assemblySheet` (grouped by location), `setItemPicked`, `completeRun` (optionally moves lots via `lotKey()` when `assembly_moves_lots` is on), `cancelRun`. Writes `deck_assembly_runs` / `deck_assembly_items`. `RunSummary.notFound` is the un-ticked lines. | `db/index`, `buildability`, `reconcile` | `decks/store`, `routes/{assembly,settings}` |
| `substitutes.ts` | Phase 27. `substitutesFor` — SQL pool (owned, available-excluding-this-deck, colour-legal, format-legal) then TS ranking (`scoreCandidate`: shared category / type / CMC). `suggestionCount` setting. | `db/index`, `model/mtg`, `sync/categories`, `allocation`, `roleHeuristics` | `routes/{substitutes,settings}` |
| `roleHeuristics.ts` | Regex-over-oracle-text stand-in for `card_categories` when the tag sync has never run. `ROLE_PATTERNS` is data. Only consulted when `card_categories` is empty. | `sync/categories` | `substitutes` |
| `store.ts` | `DeckStore`: `list`, `get` (joins cards + validation + stats + manabase + template progress), `create`, `update` (status change → reconcile deck + sharers), `duplicate`, `delete`, `addCard`, `setQuantity` / `setFromCollection` / `setProxied` / `setSlotAllocation` (enforces `from_collection + proxied <= quantity`), `setBoard`, `setCategory`, `setPreferredPrinting`, `removeCard`, `applyRecommendedLands`, `autoMaintainLands`, tags (`addTag`/`removeTag`/`allTags`), `setCover`, `categories`. Every mutation ends by reconciling. | `collection/store`, `db/index`, `model/mtg`, `sync/categories`, `allocation`, `assembly`, `categories`, `contention`, `lands`, `manabase`, `reconcile`, `stats`, `templates`, `types`, `validate` | `index`, `porting/importer`, `routes/{decks,errorHandler,porting,settings}` |
| `validate.ts` | `validateDeck` against the `formats` row: size, copy limit, legality, commander identity, partner/background pairing (`canLeadDeck`, `pairingIsLegal`, `isSignatureSpell`). Errors vs warnings; never blocks saving. | `model/mtg`, `types` | `store` |
| `stats.ts` | `deckStats`: curve buckets (cap 7), type breakdown, colour distribution, owned/proxied counts. | `model/mtg`, `allocation`, `types` | `store` |
| `manabase.ts` | `countPips`, `analyseManaBase` — demand (pips) vs supply (producers) per colour. | `model/mtg`, `types` | `lands`, `store` |
| `lands.ts` | `recommendedLandTotal` (24/17/37 rules of thumb), `planBasics` — split a basic budget across colours by pip demand, net of lands already present. | `model/mtg`, `manabase`, `types` | `store` |
| `snapshots.ts` | `takeSnapshot`, `listSnapshots`, `diffSnapshot`, `restoreSnapshot` (takes its own snapshot first, then reconciles), `deleteSnapshot`. | `reconcile` | `routes/decks` |
| `templates.ts` | `TemplateStore` CRUD + `computeTemplateProgress` (how a deck measures against its template's targets). `SHOW_DECK_TEMPLATES` setting. | `sync/categories`, `categories`, `types` | `index`, `store`, `routes/{templates,settings}` |
| `categories.ts` | `parseCategoryList` / `formatCategoryList` / `normalizeCategoryInput` / `categoryListMatches` for the comma-separated `deck_cards.category` override. | — | `store`, `templates` |
| `types.ts` | `Board`, `FormatRules`, `DeckCard`, `Deck`, `DeckWithCards`, `DeckIssue`, `DeckValidation`, `DeckStats`. The shared shapes. | `allocation` (for `DeckStatus`) | `lands`, `manabase`, `stats`, `store`, `templates`, `validate`, `routes/decks` |

### `collection/`
| File | Does | Imports | Imported by |
|---|---|---|---|
| `store.ts` | `CollectionStore`: locations (`locations`, `createLocation`, `updateLocation`, `deleteLocation`, `moveLocationContents`; `LocationInUseError`), lots (`addLot`, `updateLot`, `removeLot`, `decrementCopy`), `browse` + `cardDetail` three-tier reads with `CollectionFilters` + `CollectionSort`, `value` / `history` / `takeSnapshot`, `setCompletion` / `setChecklist`, **cost pools** (`OPEN_COST_POOL_ID`, box-split / draft cost allocation, `COST_METHODS`), `FINISHES` / `CONDITIONS` / `ACQUISITION_KINDS` enums. Every lot or location change calls `reconcileDecksHolding`. | `db/index`, `decks/allocation`, `decks/reconcile` | `index`, `decks/store`, `porting/importer`, `routes/{collection,errorHandler,porting,settings,trades,wants}`, `sync/runSync`, `trades/store` |
| `wants.ts` | `WantStore` (lists, items, reorder, `ListNameTakenError`) and `reconcileWants` — marks wants fulfilled once owned ≥ wanted, raises an alert. Shared by trade completion and collection edits. | `alerts/store`, `shopping` | `index`, `routes/{collection,errorHandler,tradeLists,wants}`, `tradelists/store`, `trades/store` |
| `shopping.ts` | `shoppingList(deckId)` from allocation's shortfall; `pushToWantList`, `pushEntriesToWantList`, `wantList`. No table. | `decks/allocation` | `wants`, `routes/{collection,decks}` |

### `trades/store.ts`
`TradeStore`: drafts (`create`, `update`, `addItem`/`updateItem`/`removeItem`, `cancel`, `delete`) never touch the collection; `complete()` applies deltas — outgoing lots consumed (`LotConsumption`, `DisposalRequest` → `collection_disposals`), incoming lots added, `reconcileWants`, trade lists reconciled, `conflictMode: 'block' | 'alert'` for deck-allocated copies (`Conflict`, `AllocationShortfall`). `TradeShortfallError` when the collection can't supply an outgoing card (handled in `routes/trades.ts`, not the global handler). `disposeFromLot` for sales/losses → `collection_disposals`. **Imports:** `alerts/store`, `collection/{store,wants}`, `decks/{allocation,contention}`. **Imported by:** `index`, `routes/{trades,errorHandler}`.

### `tradelists/store.ts`
`TradeListStore`: named lists of owned copies with own quantity + asking price; reorder; plaintext export; deck-conflict flag via `v_trade_list_status`. Changes call `contention.reconcileAlerts`. **Imports:** `collection/wants`, `decks/{allocation,contention}`. **Imported by:** `index`, `routes/tradeLists`.

### `alerts/store.ts`
`AlertStore`: `raise` (with `dedupe_key`), `resolveByKey`, `list`, `activeCount`, `setState`, `acknowledge`, `resolve`. Kinds: price target, want fulfilled, deck claim reduced, trade-list clamped, `allocation_conflict`. **Imported by:** `collection/wants`, `decks/contention`, `pricing/alerts`, `routes/{alerts,collection}`, `trades/store`, `index`.

### `pricing/alerts.ts`
`checkPriceTargets` — run after each price sync; raises/resolves `price_target` alerts per want. **Imports:** `alerts/store`. **Imported by:** `sync/runSync`.

### `events/store.ts`
`EventStore`: events (name/format/date, linked to a cost pool and a deck — never copied), games (`GameInput`, `GameFilters`, `MatchRecord` W-L-D), `SHOW_GAME_LOG` setting. **Imported by:** `index`, `routes/{events,settings}`.

### `search/`
| File | Does | Imports | Imported by |
|---|---|---|---|
| `query.ts` | `tokenize` → `parseQuery` → `compileQuery` (Scryfall syntax → SQL `WHERE` + params). Unknown terms fall back to text match. `mentionsLegality`, `mentionsDigital`. | `model/mtg`, `collection` | `search/{collection,store}` |
| `collection.ts` | Phase 23: `owned:` `available:` `loc:` `indeck:` predicates and the bare `owned`/`available` words, joining `card_printings.oracle_id`. `SearchContext` (which deck to exclude). Uses allocation's SQL builders. | `decks/allocation`, `query` | `query`, `store` |
| `store.ts` | `CardSearchStore`: `search(filters, sort, page)` over FTS5 word index + trigram index, `detail(oracleId)` (faces, printings, legalities, rulings, owned/deck usage), `random`, `sets`, `formats`, `setArtPreference`. | `decks/allocation`, `model/mtg`, `collection`, `query` | `index`, `routes/cards` |

### `sync/`
| File | Does | Imports | Imported by |
|---|---|---|---|
| `scryfall.ts` | HTTP client: `fetchBulkEntry` (manifest), `fetchSets`, `USER_AGENT`, `ScryfallError`. Only two live endpoints. | — | `images/fetch`, `sync/{categories,importer,rulings,runSync,syncManager,syncWorker}`, `routes/{sync,errorHandler}` |
| `importer.ts` | `CardImporter`: streams the gzipped bulk JSON and upserts `oracle_cards` / `card_printings` / `card_faces` / `card_legalities` / `card_name_variants`; `partnerPairing`. | `model/mtg`, `scryfall` | `runSync` |
| `runSync.ts` | `runSync` orchestration (download → import → sets → sideloads → price history → price alerts), `SyncProgress` phases, `recordPriceHistory`, `runSideloads`. | `collection/store`, `db/index`, `pricing/alerts`, `categories`, `importer`, `rulings`, `scryfall` | `syncManager`, `syncWorker`, `routes/sync` |
| `syncWorker.ts` | Worker-thread entry: opens its own DB connection, runs `runSync`, posts `SyncWorkerMessage` progress. | `db/index`, `categories`, `runSync`, `scryfall`, `syncFailure` | `syncManager` (spawns it) |
| `syncManager.ts` | `SyncManager`: one sync at a time, spawns the worker, fans progress out to SSE subscribers. | `runSync`, `scryfall`, `syncFailure`, `syncWorker` | `index`, `routes/sync` |
| `syncFailure.ts` | `describeSyncFailure` — turns `fetch failed` into a sentence naming the network cause. | — | `syncManager`, `syncWorker` |
| `categories.ts` | Tagger `oracle_tags` bulk file → `card_categories`. `CATEGORY_ROOTS`, `CATEGORY_LABELS`, `hasCardCategories`, `syncCardCategories`. Best-effort; never fails the card sync. | `db/index`, `scryfall` | `decks/{roleHeuristics,store,substitutes,templates}`, `routes/sync`, `runSync`, `syncWorker` |
| `rulings.ts` | `rulings` bulk file → `card_rulings`. Best-effort. | `db/index`, `scryfall` | `runSync` |

### `images/`
| File | Does | Imports | Imported by |
|---|---|---|---|
| `fetch.ts` | `cachePathFor` (hash-sharded), `remoteUrlFor`, `fetchAndCacheImage` — one file per (printing, face, size) + `image_cache` row. | `sync/scryfall`, `fetchQueue` | `downloadManager`, `routes/images` |
| `fetchQueue.ts` | `FetchQueue` — dedupes concurrent requests for the same image, limits concurrency. | — | `fetch`, `downloadManager`, `routes/images` |
| `cache.ts` | `cacheLimitBytes`, `cacheSizeBytes`, `evictImages` (LRU, deletes files), `UsageRecorder`. | — | `downloadManager`, `routes/{images,storage}` |
| `downloadManager.ts` | `ImageDownloadManager` — pre-download job, scope `'referenced'` (decks/collection/covers) or `'all'` (gated by cap, `CacheLimitError`). Main-thread async, not a worker. | `cache`, `fetch`, `fetchQueue` | `index`, `routes/{storage,errorHandler}` |

### `porting/`
| File | Does | Imports | Imported by |
|---|---|---|---|
| `decklist.ts` | Pure: `parseDecklist` (every common dialect, board headers, `(SET) 123`), `formatDecklist` (`ExportFormat`), `tcgplayerMassEntryUrl`, `CARD_KINGDOM_DECKBUILDER`. | — | `importer`, `routes/porting` |
| `csv.ts` | Pure: `parseCsv`, `guessMapping` (header spellings from Deckbox/ManaBox/TCGplayer/Moxfield), headerless detection, `applyMapping`, `normalizeCondition/Language/Finish`. | — | `importer`, `routes/porting` |
| `resolve.ts` | `CardResolver` — name → card in three passes (exact variant, normalised, trigram fuzzy with `similarity` threshold); `resolvePrinting`. Excludes `EXTRA_LAYOUTS`. | `model/mtg` | `importer` |
| `importer.ts` | Preview-then-commit for decklists (`previewDecklist` / `commitDecklist`) and collection CSV (`previewCollectionCsv` / `commitCollectionCsv`), `importBatches`, `undoImport`. | `collection/store`, `decks/store`, `model/mtg`, `csv`, `decklist`, `resolve` | `routes/porting` |
| `backup.ts` | `backupTo` / `backupToTemp` (user tables only, `USER_TABLES` in FK order), `restoreFrom` (`InvalidBackupError`, `RestoreReport`), `pruneBackups`. | `db/index` | `schedule`, `routes/{porting,errorHandler}` |
| `schedule.ts` | `startBackupSchedule` — unattended local backups, few kept. | `backup` | `index`, `routes/porting` |

### `routes/` — the HTTP surface

All under `/api/v1`. Each file exports one `register*Routes(app, …)`; `index.ts` calls them. Rules live in the stores; a route validates, calls, and maps error classes to statuses.

| File | Endpoints | Calls into |
|---|---|---|
| `cards.ts` | `GET /cards` (search), `GET /cards/random`, `GET /cards/:oracleId`, `PUT /cards/:oracleId/art`, `GET /sets`, `GET /formats` | `search/store` |
| `sync.ts` | `GET /status`, `POST /sync`, `POST /sync/categories`, `GET /sync/events` (SSE) | `sync/{syncManager,runSync,categories}`, `db/index` |
| `images.ts` | `GET /images/:printingId/:size` | `images/{cache,fetch,fetchQueue}` |
| `decks.ts` | `GET/POST /decks`, `GET/PATCH/DELETE /decks/:id`, `POST /decks/:id/duplicate`, `POST /decks/:id/cards`, `PATCH/DELETE /decks/:id/cards/:cardId`, `POST /decks/:id/recommended-lands`, `GET /decks/:id/categories`, `PUT /decks/:id/cover`, `GET /deck-tags`, `POST/DELETE /decks/:id/tags[/:tag]`, `GET /decks/:id/buildability`, `POST /decks/:id/buildability/want`, snapshots: `GET/POST /decks/:id/snapshots`, `GET /snapshots/:id/diff`, `POST /snapshots/:id/restore`, `DELETE /snapshots/:id` | `decks/{store,buildability,snapshots,allocation,types}`, `collection/shopping` |
| `assembly.ts` | `POST /decks/:id/assembly`, `POST /decks/:id/disassembly`, `GET /decks/:id/assembly` (open run), `GET /decks/:id/assembly/runs`, `GET /assembly/:runId` (sheet), `PATCH /assembly/:runId/items/:itemId`, `POST /assembly/:runId/complete`, `POST /assembly/:runId/cancel` | `decks/assembly` |
| `allocation.ts` | `GET /allocation/contention`, `POST /allocation/reassign`, `GET /allocation/what-if`, `GET /allocation/holders/:oracleId` | `decks/contention` |
| `substitutes.ts` | `GET /decks/:id/cards/:oracleId/substitutes`, `GET /substitutes` | `decks/substitutes` |
| `templates.ts` | `GET/POST /deck-templates`, `GET/PATCH/DELETE /deck-templates/:id`, `POST /deck-templates/:id/clone` | `decks/templates` |
| `presets.ts` | `GET/POST /filter-presets`, `PATCH/DELETE /filter-presets/:id` | `db` directly (opaque JSON) |
| `collection.ts` | `GET/POST /locations`, `PATCH/DELETE /locations/:id`, `GET /collection`, `GET /collection/cards/:oracleId`, `POST /collection/items`, `PATCH/DELETE /collection/items/:id`, `POST /collection/items/decrement`, cost pools: `GET /collection/cost-pools/open`, `POST /collection/cost-pools`, `PATCH /collection/cost-pools/:id`, `POST /collection/cost-pools/close`, `POST /collection/cost-pools/:id/reopen`, `GET /collection/value`, `POST /collection/snapshot`, `GET /collection/sets[/:setCode]`, `GET /decks/:id/shopping-list`, `POST /decks/:id/shopping-list/want` | `collection/{store,shopping,wants}`, `alerts/store` |
| `porting.ts` | `GET /decks/:id/export[.txt]`, `POST /decks/import/preview`, `POST /decks/:id/import`, `POST /decks/import` (new deck), `POST /collection/import/preview`, `POST /collection/import`, `GET /collection/export.csv`, `GET /imports`, `POST /imports/:id/undo`, `GET /backup`, `GET/POST /backup/scheduled`, `POST /backup/restore` | `porting/*`, `decks/store`, `collection/store` |
| `settings.ts` | `GET /settings`, `PUT /settings`. **The allowlists** `BOOLEAN_SETTINGS` / `ENUM_SETTINGS` / `NUMBER_SETTINGS`; flipping an allocation setting reconciles all decks + alerts. | `db/index`, `decks/{allocation,assembly,contention,store,substitutes,templates}`, `collection/store`, `events/store` |
| `storage.ts` | `GET /storage`, `PUT /storage/cache-limit`, `POST /images/download`, `GET /images/download/status`, `POST /images/download/cancel` | `images/{cache,downloadManager}` |
| `trades.ts` | `GET/POST /trades`, `GET/PATCH/DELETE /trades/:id`, `POST /trades/:id/cancel`, `POST /trades/:id/items`, `PATCH/DELETE /trades/:id/items/:itemId`, `POST /trades/:id/complete` | `trades/store` |
| `wants.ts` | `GET/POST /want-lists`, `GET/PATCH/DELETE /want-lists/:id`, `POST /want-lists/reorder`, `POST /want-lists/:id/items`, `PATCH/DELETE /want-lists/:id/items/:itemId`, `POST /want-lists/:id/reorder`, `GET /want-lists/items/by-oracle/:oracleId` | `collection/wants` |
| `tradeLists.ts` | Same shape as wants under `/trade-lists`, plus `GET /trade-lists/:id/export` | `tradelists/store` |
| `alerts.ts` | `GET /alerts`, `POST /alerts/:id/acknowledge`, `POST /alerts/:id/resolve` | `alerts/store` |
| `events.ts` | `GET/POST /events`, `GET/PATCH/DELETE /events/:id`, `GET/POST /games`, `PATCH/DELETE /games/:id`, `GET /decks/:id/games` | `events/store` |
| `schema.ts` | Shared ajv fragments: `ID`, `COUNT`, `MONEY`, `NAME`, `TEXT`, `FLAG`, `DATE`, `CATEGORY_LIST`, `enumOrNull`, `idParams`, `body`. | — |
| `errorHandler.ts` | Global handler: known error classes (`DeckNotFoundError`, `CardNotFoundError`, `UnknownFormatError`, `LocationInUseError`, `ListNameTakenError`, `TradeNotFoundError`, `TradeNotDraftError`, `InvalidBackupError`, `CacheLimitError`, `ScryfallError`, SQLite FK failures) → 4xx; else 500, stack to log only. Errors with extra detail to report (`TradeShortfallError`, `AssemblyError`, `ContentionError`, `SlotOverfilledError`) are caught in their own route file. | Every store's error classes |

### `server/scripts/` (run by hand)
`check-sqlite.mjs` (FTS5/trigram present? run after `npm rebuild`), `sync.mjs` (CLI bulk sync), `search-check.mjs` (query parity), `reassign-art.mjs` (recompute default printings), `repair-claims.mjs` (one-time: settle every deck's claim after the chip was removed).

---

## 4. Web — `web/src/`

### Dependency layers

```
main.tsx → App.tsx → pages: CollectionPage, DeckList, DeckBuilder, TradesPage, GamesPage, DataPage
                        │
                     panels/dialogs/rows (components/*.tsx)
                        │
                     presentation helpers (*.ts: deckView, density, deckSlot, buildability, contention, assembly, substitutes, …)
                        │
                     api.ts  ← the only file that calls fetch(); every shared type lives here
```

### Top level

| File | Does | Imports | Imported by |
|---|---|---|---|
| `main.tsx` | Mounts `<App/>`. | `App` | — |
| `App.tsx` | The shell: topbar, nav tabs, route → view switch, global settings load, density/theme init, `SyncGate` wrapper, browse view (search + `FilterPanel` + results + `CardDetailPane`), `AlertsBell`. Route names: `collection` (with tab), `decks`, `deck/:id`, `browse`, `trades`, `games`, `data`. | `api`, `router`, `deckView`, `density`, `ownedBadge`, `searchScope`, `theme`, and the page components | `main` |
| `api.ts` | **The HTTP client and every shared type** (`CardSummary`, `Deck`, `DeckCard`, `BuildabilityDetail`, `AssemblySheet`, `ContestedCard`, `CollectionCard`, `Trade`, `WantList`, `Alert`, `AppSettings`, …). One exported function per endpoint. `ApiError`, `isConnectivityError`, `imageUrl`, `subscribeToSync` (SSE). | — | Everything |
| `router.ts` | `Route` union, `parseRoute` / `formatRoute` (pure, round-trip), `readRoute` / `pushRoute` / `replaceRoute` / `onRouteChange` (window). | — | `App`, `CollectionPage` |
| `styles.css` | All CSS. Sections are `/* ---------- name ---------- */`. `docs/CSS-INDEX.md` (generated) maps every class → section + line → components using it. Breakpoints (760px etc.) are mirrored in `viewport.ts`. | | |

### Presentation helpers (pure `.ts`, `node --test`-tested)

| File | Does | Used by |
|---|---|---|
| `deckView.ts` | `groupCards` / `groupByField` (type, subtype, rarity, colour, identity, CMC, set, category, template), `DECK_SORTS`, sort preference storage, pane widths (`loadPaneWidths` / `savePaneWidth`, `PANE_MIN/MAX`). | `App`, `CollectionPage`, `CustomizeView`, `DeckBuilder`, `DeckPanes`, `DeckRow` |
| `density.ts` | `Density` levels per page, `loadDensity` / `saveGlobalDensity` / `savePageDensity` / `effectiveDensity` / `nextDensity`. | `App`, `AddBySetTab`, `CollectionPage`, `CustomizeView`, `DeckBuilder`, `DeckPanes`, `DeckTile`, `OwnedGrid`, `WantListsPage` |
| `deckSlot.ts` | `slotAction` — the one chip per deck row ("Have it", "Need 2", "Atraxa has 1"), `canSwap`, `swapTitle`. | `DeckRow`, `DeckTile` |
| `buildability.ts` | `money`, `percent`, `summarySegments`, `missingRows` — words for server figures. | `assembly`, `contention`, `AssemblyPanel`, `Buildability`, `ContentionPanel`, `MissingCardsPanel` |
| `contention.ts` | `holdersLine`, `contestedFigures`, `contestedReason`, `whatIfSentence`, `figuresLine`. | `CardDetailPane`, `ContentionPanel`, `WhatIfDialog` |
| `assembly.ts` | `lineLabel`, `progressText`, `runIntent`, `completionFacts`, `notFoundNotice`, `runHistoryLabel`. | `AssemblyPanel`, `DeckBuilder`, `DeckHistoryPanel` |
| `substitutes.ts` | `swapPlan` / `performSwap` (remove N of A, add N of B via the ordinary card routes), `reasonLine`, `availableBadge`. | `DeckBuilder`, `SubstitutesSheet`, `WantListsPage` |
| `deckHistory.ts` | Deck undo: `snapshotDeck`, `planRestore`, `restoreSnapshot` (replays as API calls). | `DeckBuilder` |
| `undo.ts` | `useUndoStack` (pairs of thunks, per context), `useUndoShortcuts` (⌘Z / ⇧⌘Z). | `CollectionPage`, `DeckBuilder`, `TradeListsPage`, `TradesPage`, `WantListsPage`, `UndoToast` |
| `ownedBadge.ts` | `ownedBadge` / `deckBadge` on search results (blank for exempt basics; split form only when something is claimed). | `App`, `DeckPanes` |
| `searchScope.ts` | All / Owned / Available chips as `owned>=1` / `available>=1` query terms. | `App`, `DeckBuilder`, `DeckPanes` |
| `pickerTypes.ts` | Picker card-type chips as `t:` query terms. | `DeckPanes` |
| `pickerColors.ts` | `effectivePickerColors` — intersect user's colour pick with commander identity. | `DeckBuilder` |
| `mana.ts` | `manaDisplay` — `{3}{W}{W}` → `5 ●●`. | `ManaCost` |
| `playtest.ts` | Opening hands, mulligans, goldfish turns (pure, no rules engine). | `PlaytestPanel`, `mana` |
| `theme.ts` | light / dark / system, `applyTheme`, `storedTheme`. | `App`, `DataPage` |
| `viewport.ts` | `useNarrow(px)`, `useCoarsePointer()`. | `DeckBuilder`, `DeckPanes`, `DeckStatusPill`, `WantListsPage` |
| `format.ts` | `formatBytes`, `percent`. | `DataPage` |

### Components — pages

| File | Does | Renders | Uses |
|---|---|---|---|
| `DeckBuilder.tsx` | Orchestrator for one deck: loads deck/settings/templates/buildability/sheet/runs/locations/record, owns picker query + filters + results, undo stack, and every dialog toggle. Hands layout to `DeckPanes`. `pickerSearchParams` builds the picker's search. | `DeckPanes`, `AssemblyPanel`, `Buildability` (strip), `ContentionPanel`, `DeckArtDialog`, `DeckExportDialog`, `DeckGamesPanel`, `DeckHistoryPanel`, `DeckImportDialog`, `DeckStatusPill`, `FilterPanel`, `MissingCardsPanel`, `PlaytestPanel`, `ShoppingListPanel`, `SubstitutesSheet`, `UndoRedo` | `api`, `assembly`, `deckHistory`, `deckView`, `density`, `pickerColors`, `searchScope`, `substitutes`, `undo`, `viewport` |
| `DeckPanes.tsx` | The three-pane layout (`.decklist` / `.picker` / `.stats-pane`): the deck list in list or lined-up (cascade) view, grouped via `deckView`; the picker with scope/type chips and hover/pinned art preview (`PickerPreview`); pane dividers; phone overlays. | `DeckRow`, `DeckTile`, `DeckStatsPanel`, `CardDetailPane`, `CascadePreview`, `CustomizeView`, `FilterPanel`, `ManaCost`, `PaneDivider`, `BackToTop` | `api`, `deckView`, `density`, `ownedBadge`, `pickerTypes`, `searchScope`, `viewport` |
| `DeckList.tsx` | The decks index: tiles with buildability bar, status filter, tag filter, sort by buildability, duplicate/delete, import-as-new, contention panel, what-if. | `Buildability` (bar), `ContentionPanel`, `DeckImportDialog`, `WhatIfDialog`, `BackToTop` | `api` |
| `CollectionPage.tsx` | Tabs: **browse** (owned grid, location filter, grouping, value strip, lot detail `CardLots` with trade-list push), **add** (`AddBySetTab`), **sets** (completion), **value**, **wants**, **tradelists**. Undo for lot edits. | `OwnedGrid`, `AddBySetTab`, `AddCardsDialog`, `CollectionValuePanel`, `CustomizeView`, `WantListsPage`, `TradeListsPage`, `UndoToast`, `BackToTop` | `api`, `deckView`, `density`, `router`, `undo` |
| `TradesPage.tsx` | Trade list + one trade's draft editor; complete with conflict handling. | `CardPicker`, `TradeItemDialog`, `UndoToast`, `BackToTop` | `api`, `undo` |
| `WantListsPage.tsx` | Want lists, drag reorder (long-press on touch), target prices, substitutes for a want. | `CardPicker`, `CardDetailPane`, `CustomizeView`, `SubstitutesSheet`, `UndoToast`, `BackToTop` | `api`, `density`, `substitutes`, `undo`, `viewport` |
| `TradeListsPage.tsx` | Trade lists, plaintext export. | `CardPicker`, `UndoToast`, `BackToTop` | `api`, `undo` |
| `GamesPage.tsx` | Events tab + Record tab; `GameRows` shared with `DeckGamesPanel`. | `GameLogDialog`, `BackToTop` | `api` |
| `DataPage.tsx` | Backups (download/restore/scheduled), decklist & CSV import history + undo, storage & image cache, settings toggles, theme. | `CollectionImportDialog`, `BackToTop` | `api`, `format`, `theme` |

### Components — deck builder pieces

| File | Does |
|---|---|
| `DeckRow.tsx` | One list row: qty ±, name, `ManaCost`, category, the `deckSlot` chip, art/remove buttons. |
| `DeckTile.tsx` | One lined-up tile (art strip) with the same controls, density-aware. |
| `DeckStatsPanel.tsx` | Size progress vs format, curve, colours, mana base, template progress, proxied row (`> 0`-guarded). |
| `DeckStatusPill.tsx` | brew / building / assembled / disassembled pill + menu (popover on desktop, sheet on phone). |
| `Buildability.tsx` | `BuildabilityBar` (deck list) and `BuildabilityStrip` (deck header). |
| `MissingCardsPanel.tsx` | What coverage can't supply, with holder names and a Swap button per row. |
| `ShoppingListPanel.tsx` | Shortfall to buy; push to want list; TCGplayer / Card Kingdom links. |
| `ContentionPanel.tsx` | Contested cards, worst first, "give to…" per holder with before/after confirmation. |
| `WhatIfDialog.tsx` | Read-only teardown simulation. |
| `AssemblyPanel.tsx` | The pull sheet (grouped by location, sticky progress, server-side ticks), complete/cancel. |
| `DeckHistoryPanel.tsx` | Snapshots (take/diff/restore/delete) and assembly run history. |
| `SubstitutesSheet.tsx` | Owned substitutes as art tiles with the server's reason line; tap → `performSwap`. |
| `PlaytestPanel.tsx` | Draw seven / mulligan / goldfish. |
| `DeckGamesPanel.tsx` | The deck's match record + games (reuses `GameRows`, `GameLogDialog`). |
| `DeckArtDialog.tsx` | Pick a printing's art for one slot (`preferred_printing_id`). |
| `DeckExportDialog.tsx` / `DeckImportDialog.tsx` | Text out (selectable box + copy) / text in (preview every line before commit). |
| `CascadePreview.tsx` | The clicked lined-up card, held still, with its controls under it. |
| `PaneDivider.tsx` | Drag handle between panes; commits width to localStorage on release. |
| `UndoRedo.tsx` | The two buttons. |

### Components — shared

| File | Does |
|---|---|
| `FilterPanel.tsx` | Structured search filters (colours, identity, types, sets, rarity, format, CMC…); exports `Filters`, `EMPTY_FILTERS`, `filtersAreActive`, `countActiveFilters`. Hosts `PresetBar`. |
| `PresetBar.tsx` | Saved filter presets (query + filters). |
| `CardDetailPane.tsx` | Full card: faces, printings, legalities, rulings, prices, owned/deck usage via `contention.holdersLine`, buy links. |
| `CardPicker.tsx` | Search-to-dropdown single-card chooser (wants, trade items). |
| `Combobox.tsx` | Filterable dropdown (sets, locations). |
| `CustomizeView.tsx` | Group By / Sort By / View Style (density) in one panel. |
| `OwnedGrid.tsx` | Owned-lot tiles with foil overlay and badges. |
| `AddBySetTab.tsx` | Set-scoped entry in collector order; `CostPoolControls` for box splits / drafts. |
| `AddCardsDialog.tsx` | Add a lot: printing, finish, condition, location, paid. |
| `CostPoolControls.tsx` | `useCostPool`, `CostPoolFields`, `CostPoolBanner`. |
| `CollectionValuePanel.tsx` | Value + P&L + inline SVG sparkline. |
| `CollectionImportDialog.tsx` | CSV import with correctable column mapping. |
| `TradeItemDialog.tsx` | Choose printing/finish/price for a trade line. |
| `GameLogDialog.tsx` | Log a game. |
| `AlertsBell.tsx` | Topbar inbox. |
| `SyncGate.tsx` | Blocks only when there's no card data; background refresh otherwise. |
| `SyntaxHelp.tsx` | Search syntax reference (only what's implemented). |
| `ManaCost.tsx` | `5 ●●` with the full cost as tooltip. |
| `BackToTop.tsx` | Works inside any scrolling container (capture-phase listener). |
| `UndoToast.tsx` | "Removed X · Undo", last step only. |

---

## 5. How a typical change flows through the files

**A new figure on a deck row** (e.g. "copies in other decks"):
1. Compute it in `server/src/decks/buildability.ts` (or read it from `allocation.ts` if it's already there) → add to `BuildabilityRow`.
2. It reaches the client through `GET /decks/:id/buildability` (`routes/decks.ts`) — usually no route change.
3. Mirror the field on `BuildabilityRow` in `web/src/api.ts`.
4. Choose the words in `web/src/deckSlot.ts` or `web/src/buildability.ts`; render in `DeckRow.tsx` / `DeckTile.tsx`; style in `styles.css` under the deck-builder section.
5. Tests: `buildability.test.ts` (server), `deckSlot.test.ts` (web).

**A new setting:**
1. `server/src/routes/settings.ts` → add to the right allowlist map; export a `SETTING_KEY` const from the module that reads it (convention: `decks/allocation.ts` exports `ALLOCATION_IGNORES_BASICS`, etc.).
2. Read it via `getSetting(db, KEY)` where it applies.
3. `web/src/api.ts` → `AppSettings`; `DataPage.tsx` → a toggle.

**A new table or column:**
1. `schema.sql` and a new entry in `server/src/db/migrations.ts`; bump `PRAGMA user_version` in both.
2. Run `npm test` in `server/` — `migrations.test.ts` fails if they disagree.
3. Add to `porting/backup.ts` `USER_TABLES` if it's user data.

**A new endpoint:**
1. Store method in `server/src/<domain>/store.ts` (or a pure module in `decks/`).
2. Handler in `server/src/routes/<domain>.ts` using `routes/schema.ts` fragments; throw a named error class and map it in `routes/errorHandler.ts` if it's new.
3. Register in `server/src/index.ts` if it's a new route file.
4. Client function + types in `web/src/api.ts`.

---

## 6. Tests and commands

- **Server:** `cd server && npm test` — `node --test` over `src/**/*.test.ts`, colocated with the file under test. `npm run dev` for tsx watch; `npm run typecheck`.
- **Web:** `cd web && npm test` — `test:unit` (`node --test` over pure `.ts` helpers) then `test:dom` (`vitest` over `.tsx` components). `npm run dev` for Vite.
- **Storage:** `server/src/db/migrations.test.ts` is the one to run after any DDL.
- **Manual checks:** `server/scripts/check-sqlite.mjs` after `npm rebuild`; `server/scripts/sync.mjs` to sync from the CLI.
- **Deploy:** `deploy/mtg-library.service` (systemd) + `deploy/README.md`. Data dir from `MTG_DATA_DIR`.
