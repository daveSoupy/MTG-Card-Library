# Phase 16 — OCR-Assisted Entry (optional stretch goal)

Build only if explicitly requested. Assumes Phase 4's set-scoped entry, Phase 5's fuzzy-match resolve pattern, and Phase 11's add-and-allocate deck branch exist.

## Schema

`scan_sessions` and `ocr_corrections` **already exist in `schema.sql`** from the up-front design — do not recreate them. What's missing on `scan_sessions` is the scan target: add `target TEXT NOT NULL DEFAULT 'collection' CHECK (target IN ('collection','collection_deck'))` and `deck_id INTEGER REFERENCES decks(id) ON DELETE SET NULL`. Next unused `user_version` at build time.

## Two capture paths, one pipeline

Everything after "we have some text" is shared. Only capture and recognition differ.

- **Web path (this phase).** `<input type="file" accept="image/*" capture="environment">` opens the phone's camera from the browser. The image is posted to the server, which runs OCR (Tesseract) and returns ranked candidates.
- **Native iOS path (Phase 20).** Apple's Vision framework does recognition on-device and posts the recognised text to the same endpoint. This is why the endpoint accepts *either* an image or already-recognised text.

Server-side Tesseract is the weaker recogniser, which makes the correction memory below more important.

## Destination: Collection, or Collection + Deck

Every scan session has a **target**, chosen at session start with the other presets:

- **Collection only** — each confirmed card is added to the Collection at the session's preset location.
- **Collection + Deck** — each confirmed card is added to the Collection *and* to the chosen deck, allocated from that copy, in one action. This calls Phase 11's add-and-allocate branch in the deck store — not a scan-only insert — so legality and color-identity checks fire per card, a repeat scan increments the slot, and a duplicate in a singleton format flags immediately on the confirm screen. Phase 11's basic-land exception applies here too: basics get the deck slot but no collection row.

**Choosing the deck.** At session start, create a new deck (name + format) or resume one in progress, so a large deck can be scanned across sittings — the same sticky-session pattern as Phase 4's cost pools.

**Storage Location defaults to the deck's `home_location_id`** if set; overridable per the normal preset rules.

**Commander flag.** When the target deck is Commander, a one-tap "this is the commander" toggle on the confirm screen sets Phase 3's commander field and applies the color-identity rule to every subsequent scan.

**Ranking sharpens mid-session.** Once a commander is set, weight candidates toward its color identity, the same way the active set filter is weighted.

## Session handling

- **Presets:** foil/non-foil, frame or border style, Storage Location, target, optionally condition. Fixed while scanning a stack; change them when the stack changes. Stored in `scan_sessions`.
- **Always-visible session banner:** "Foil · Borderless · Set: Foundations · → Binder 4" or "→ Simic Ramp (Deck) · Commander: set". Pinned above the capture button on a phone.
- **Per-card override:** one-tap override of any single preset (foil, frame, or the commander flag) on the confirm screen, without resetting the session.

## Matching

- Feed the frame/border/foil presets into candidate ranking — `frame`, `frame_effects`, `border_color`, `finishes` are real imported columns, and many sets have a standard and a borderless/showcase version of the same name.
- Fuzzy-match extracted text against `card_name_variants` and **present the top few candidates as a pick-list**, the same resolve-ambiguity pattern as Phase 5's decklist import. Weight toward the active set scope; in deck mode, toward the commander's color identity.
- Never auto-add without the user picking — even on a high-confidence single match.
- **Correction memory.** Log each `(OCR text → card the user picked)` in `ocr_corrections` (already in the schema) and check it before fresh fuzzy-matching. A repeated misread puts the previously-confirmed match at the top.

## Verification

1. A "Collection + Deck" session for a Commander deck, with the commander toggle set on one card, sets that card as the deck's commander; subsequent matches weight toward its identity.
2. Scanning the same card twice in "Collection + Deck" for a non-singleton format increments the slot; in a singleton format the duplicate flags on the confirm screen.
3. A correction saved once in `ocr_corrections` is the top-ranked candidate the next time the same text appears.
4. A failed OCR request mid-session surfaces an error and lets scanning resume with presets intact.
5. A per-card foil override affects only that card; the next capture reverts to the session default.
6. Scanning a basic land in "Collection + Deck" creates the deck slot but no `collection_items` row.
7. `migrations.test.ts` passes with the `scan_sessions` column additions.

## Out of scope

Recognition from art alone (no text) — needs a trained image-matching model or a third-party visual-search API.
