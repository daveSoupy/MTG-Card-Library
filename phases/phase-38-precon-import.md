# Phase 38 — Precon Import

Add a whole preconstructed product — a Commander precon, a Challenger deck, a Jumpstart pack, a Secret Lair — to the collection in one action, as the exact printings it shipped with, and optionally as a deck that already knows it is assembled.

## The data source, and why it is not Scryfall

Scryfall has no decklists. It knows `ZNC` is a `commander`-type set and which cards are in it, but Zendikar Rising Commander is *two* decks sharing one set code and nothing on a Scryfall card says which. There is no endpoint for this and none is coming.

**MTGJSON** publishes exactly this, and every card in it carries Scryfall's id, so it joins onto the existing card database with no name matching:

- `https://mtgjson.com/api/v5/DeckList.json` — the catalogue. ~630 KB, ~3,050 products, rebuilt daily. Each entry: `code`, `name`, `fileName`, `releaseDate`, `type`, `source`.
- `https://mtgjson.com/api/v5/decks/{fileName}.json` — one product. ~100 KB. `commander[]`, `mainBoard[]`, `sideBoard[]`, `tokens[]`, each card with `setCode` (uppercase), `number`, `count`, `isFoil`, `finishes`, `language`, and `identifiers.scryfallId`.
- `AllDeckFiles.zip` also exists (260 MB). **Do not use it** — fetch per-deck files on demand and cache them.

`identifiers.scryfallId` **is** `card_printings.id`. That is the join. Fall back to `(lower(setCode), number, lang)` against `UNIQUE (set_code, collector_number, lang)` only when the id misses, and to `porting/resolve.ts`'s name resolution only after that, flagged as uncertain in the preview.

This is the project's second outbound dependency after Scryfall, and it gets the same treatment: a descriptive `User-Agent`, on-disk caching, and a stale cache that stays fully usable when the network is down. Credit MTGJSON in the UI where the catalogue is shown.

## Already built — confirm, don't rebuild

- **Lots.** `CollectionStore.addLot` with `importBatchId` and the fourteen-column merge rule. A precon is one `import_batches` row; the lots hang off it, so Phase 5's `undoImport` and the import-history screen already work for it.
- **Cost pools.** `import_batches.total_cost_usd` + `split_method` and the `costMethod: 'box'` re-split spread a lump sum across a batch's copies. "I paid $45 for this precon" is exactly a cost pool. Reuse it; do not add a second way to split a price.
- **Deck creation with pinned printings.** `DeckStore.create`, `deck_cards.preferred_printing_id`, `board IN ('main','side','command')`, `commander_role`. Everything a precon deck needs already has a column.
- **Deck lifecycle.** Phase 22's `status`. A precon you just bought is physically a deck: it is created `assembled` with `home_location_id` set, and Phase 25's assembly machinery is not involved — there is nothing to pull.
- **The derived claim.** `reconcile.ts` fills `quantity_from_collection` from what is available. The precon deck's claim is never written by this phase; it falls out of the reconcile pass — see the ordering rule below, which is the one subtle part.

## Schema

Next unused `user_version` at build time. Two simple additions, no rebuilds:

- `import_batches.deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL` — the deck this batch created, so one undo can take both back. `NULL` for every other kind of batch.
- `import_batches.source` gains the value `'precon'`. The column's allowed values are a comment, not a `CHECK`; extend the comment.

Nothing about the product itself is stored — no `precons` table. The catalogue and the deck files are a disk cache under `MTG_DATA_DIR/precons/`, the same category of thing as the image cache: re-downloadable, not backed up, not migrated.

## New: the MTGJSON client and cache

`server/src/precons/mtgjson.ts`:

- `fetchCatalogue()` → `DeckList.json` to `MTG_DATA_DIR/precons/DeckList.json`, keeping `meta.date`. Refresh when the cached copy is older than 7 days or on an explicit refresh; on a network failure, serve the cached copy and report `stale: true`. With no cached copy and no network, the catalogue endpoint returns 503 with a message saying so — the rest of the app is unaffected.
- `fetchDeck(fileName)` → `MTG_DATA_DIR/precons/decks/{fileName}.json`. Cached indefinitely once fetched (a printed product does not change; MTGJSON corrections are rare and picked up by the refresh action, which clears both). `fileName` is validated against `^[A-Za-z0-9_-]+$` before it touches a path or a URL.
- `USER_AGENT` from `sync/scryfall.ts`, reused.

`server/src/precons/catalogue.ts` — pure filtering over the catalogue:

- **A physical-product allowlist** on `type`, so the default view is things you can buy in a shop: Commander Deck, Challenger Deck, Pioneer Challenger Deck, Starter Deck, Starter Kit, Theme Deck, Intro Pack, Planeswalker Deck, Duel Deck, Event Deck, Premium Deck, Game Night Deck, Brawl Deck, Jumpstart, Guild Kit, Clash Pack, Archenemy Deck, Planechase Deck, Secret Lair Drop, Box Set, Bundle Land Pack, Welcome Deck, Spellslinger Starter Kit, Enhanced Deck, Advanced Deck. Excluded by default: everything MTGO / Arena / Shandalar / redemption / "Sample Deck". One constant, one `all=true` query flag to bypass it.
- Search over `name`, `code`, `type`; sort by `releaseDate` desc then name.

## New: resolving a product against the card database

`server/src/precons/store.ts` (`PreconStore`), `preview(fileName)`:

- One line per `(card, isFoil)` across `commander` (→ board `command`), `mainBoard` (→ `main`), `sideBoard` (→ `side`), `tokens` (→ `token`, collection only, never a deck slot). Resolution order: `identifiers.scryfallId` → `(set, number, lang)` → name, with `confidence` 1 / 1 / <1 and the method recorded, so the preview can show exactly why a line is uncertain.
- `finish`: `isFoil` → `foil`; `isFoil` with `'etched'` in `finishes` and no `'foil'` → `etched`; otherwise `nonfoil`. `language`: MTGJSON's English word → ISO code through a tiny table; anything unmapped is `en` with a note.
- Each line also carries `ownedQty` (what the collection already holds of that oracle, informational only), `priceUsd` for the finish, and the sum is the product's current market value beside what you paid.
- **Unresolved lines are the sync signal.** A brand-new precon whose set the card database has not synced yet resolves nothing. The preview says so in one sentence — "N cards are not in the card database; run a sync" — rather than falling through to fuzzy name matching that would pin wrong printings. Name resolution is for the odd collector-number mismatch, not for a missing set.
- A **format suggestion** from `type`: Commander types → `commander`; Brawl → `brawl` if the `formats` table has it; everything else `null`. A suggestion only — a 2019 Challenger deck is not Standard-legal today and a format that shouts about it on creation helps nobody.
- Commander precons with two commanders: both go on the `command` board; `commander_role` is `partner` if `oracle_cards.partner_kind` says so, else `commander`, and Phase 3's validation reports whatever it reports. `displayCommander` is ignored — it is the face on the box, not a rule.

## New: the add

`PreconStore.add(fileName, options)`, one transaction:

```
options: {
  locationId?: number            // existing location, or
  newLocation?: { name, kind }   // create one — default name "<deck name> (<code>)", kind 'deck_box'
  createDeck: boolean            // default true
  deckName?: string              // default the product name
  formatCode?: string | null     // default the suggestion
  deckStatus?: 'assembled' | 'building' | 'brew'   // default 'assembled'
  paidUsd?: number | null        // opens a cost pool on the batch when set
  acquiredFrom?: string | null
  acquiredAt?: string | null     // default today
  includeTokens: boolean         // default false
  skipUnresolved: boolean        // default false — the add refuses while any line is unresolved
  overrides?: Array<{ line: number; printingId: string }>   // a picked printing for an uncertain line
  collectionOnly?: boolean       // add lots, no deck
  deckOnly?: boolean             // create a brew from the list, add nothing to the collection
}
```

1. Insert the `import_batches` row: `source='precon'`, `file_name=<product name>`, `total_cost_usd=paidUsd`, `split_method='even'` when paid.
2. Create the location if asked.
3. `addLot` per line (`acquisitionKind: 'purchase'`, `condition: 'NM'`, `costMethod: 'box'` when a pool is open, `importBatchId`) **with deck reconciliation suppressed** — `addLot` grows a `reconcileDecks?: boolean` option mirroring the one `removeLot` already has. Reason below.
4. If `createDeck`: `DeckStore.create`, `home_location_id` = the location, `status`, then the `deck_cards` rows with `preferred_printing_id` pinned to the precon's printing and `board` / `commander_role` as resolved. Set `import_batches.deck_id`.
5. Reconcile: `reconcileDeckClaims` on **the new deck first**, then `reconcileDeckAndSharers` for it.
6. Re-split the cost pool and close it (the same calls the add-by-set flow makes).

**The ordering rule (step 3 → 5) is the one place this phase touches allocation, and it touches only the order.** Reconciliation is first-come-first-served and never takes a copy from a deck already holding it. If lots reconciled as they landed, an existing deck short on `Sol Ring` would claim the precon's copy before the precon deck existed, and the deck you physically just bought would open showing "Atraxa has 1". Physically, the copy is in the precon's box; the honest first-comer is the precon deck. So the claim pass runs once, after the deck exists, with the precon deck first — and the existing short deck then sees the copy as held and contested, which is Phase 26's job to surface. Nothing writes `quantity_from_collection`; nothing calls anything but `reconcile.ts`.

Response: `{ batchId, deckId, locationId, lotsAdded, copiesAdded, skipped }`.

**Undo** — `POST /api/v1/precons/imports/:batchId/undo`: `undoImport(batchId)` (Phase 5, removes only lots still carrying the batch id) and, if `import_batches.deck_id` still points at a live deck, deletes it, which releases its allocation the normal way. The created location is left alone — an empty deck box is harmless and deleting a location the user may have already put other cards in is not.

## API

- `GET /api/v1/precons?q=&type=&all=` → `{ decks, catalogueDate, stale }`
- `POST /api/v1/precons/refresh` → re-fetches the catalogue, clears the deck-file cache
- `GET /api/v1/precons/:fileName` → the preview
- `POST /api/v1/precons/:fileName/add` → the add
- `POST /api/v1/precons/imports/:batchId/undo`

Routes in `server/src/routes/precons.ts`, registered in `index.ts`, validation shapes in `routes/schema.ts`, client functions and types in `web/src/api.ts`. Routes hold no rules.

## Client

A **Precon** mode on the Collection page's Add tab beside the existing by-set entry (`AddBySetTab.tsx` stays as it is; this is a sibling, `AddPreconTab.tsx`).

- A search box over the catalogue, results grouped by release year, each row `name · code · type · date`. A "show digital products" toggle for `all=true`. The MTGJSON credit and the catalogue date in the footer, with the refresh action.
- Selecting a product opens the preview: the commander(s) on top, then main / side / tokens, each line with the printing, finish badge, "own N" if `ownedQty > 0`, and price. Uncertain lines get the same printing picker `CollectionImportDialog.tsx` uses for CSV rows; unresolved lines are red with the sync sentence.
- The options form: location (existing, or "new deck box" prefilled), paid, acquired from, date, create-deck toggle with name / format / status underneath it, include tokens. A `?` help topic in `helpTopics.tsx` explaining what MTGJSON is and that the printings are exact.
- Confirm → an `UndoToast` that calls the undo endpoint. Then a link to the new deck.
- **This is a phone flow.** "I just bought this at the shop" happens at the counter. It has to work one-handed at phone width, which the Add tab already does; the preview list virtualises like `OwnedGrid`.

## Verification

1. Fetching a Commander precon resolves every `mainBoard` and `commander` line by `scryfallId` with confidence 1 and no name resolution — assert the method on each line.
2. A foil commander lands as a `finish = 'foil'` lot and the rest as `nonfoil`; an etched-only printing lands as `etched`.
3. Adding a 100-card Commander precon produces exactly the expected lots (merging same-printing lines such as basics into one lot per finish), one `import_batches` row with `source = 'precon'`, and one deck with `status = 'assembled'`, `home_location_id` set, the commander on the `command` board with `commander_role = 'commander'`, and every slot's `preferred_printing_id` pinned.
4. **The ordering rule:** with an existing `building` deck already short one `Sol Ring`, adding a precon that contains one leaves the precon deck's slot at `quantity_from_collection = 1` and the existing deck still short and contested. Adding the same precon with the reconcile order reversed would give the opposite answer — the test pins the right one.
5. With `paidUsd` set, every lot in the batch carries a non-null `acquired_unit_cost` and they sum to `paidUsd` (within rounding), through the existing pool re-split.
6. Undo removes the lots, deletes the deck, leaves the location, and a second undo is a no-op.
7. A product whose set is missing from the card database previews with unresolved lines and the add is refused unless `skipUnresolved`; with it, `rows_unmatched` records the count.
8. With the network unavailable and a cached catalogue, `GET /api/v1/precons` returns `stale: true` and the cached list; with no cache, 503 and nothing else in the app changes.
9. `fileName` containing `/`, `..` or `%` is rejected before any filesystem or network call.
10. `migrations.test.ts` passes; `docs/CODEBASE-MAP.md` has entries for `server/src/precons/*`, `routes/precons.ts` and `AddPreconTab.tsx`; `python3 docs/atlas/build.py` rerun.

## Out of scope

- **Sealed product tracking.** MTGJSON's `sealedProductUuids` link to boosters, bundles and boxes. Owning unopened product is a different concept from owning cards and is not on the data model.
- **Bulk "add every precon from set X".** One product per add; the undo is per product and the cost is per product.
- **Precons as deck templates.** Phase 7's templates are category targets, not card lists; a precon you don't own and want to study is a `deckOnly` brew.
- **Anything that writes the claim.** The precon deck's claim is derived like every other deck's.
