# Phase 7 — OCR-Assisted Collection Entry (optional stretch goal)

Not core scope — build only if explicitly requested, after Phases 1–6 are solid. Assumes Phase 4's set-scoped entry and Phase 5's fuzzy-match resolve pattern already exist.

## Two capture paths, one pipeline

Everything after "we have some text" is shared. Only the capture and recognition step differs, and the app should be built so the second path can be added without touching the rest.

- **Web path (build this one).** `<input type="file" accept="image/*" capture="environment">` opens the phone's camera directly from the browser — no app install, and the phone camera is a far better capture device than a laptop webcam. The image is posted to the server, which runs OCR (Tesseract) and returns ranked candidates.
- **Native iOS path (only if an iOS client is ever built).** Apple's Vision framework (`VNRecognizeTextRequest`, the on-device OCR behind Live Text) does the recognition on the phone and posts just the recognised text to the same endpoint. This is meaningfully more accurate than Tesseract on card fonts, and it is the reason the endpoint should accept *either* an image or already-recognised text.

Server-side OCR will be less accurate than Vision was in the original macOS plan. That makes the correction memory below more important, not less.

## Session handling

- **Batch scanning session with preset attributes**: before scanning a stack, set session defaults — foil / non-foil, frame or border style (standard, borderless, extended art, showcase, etc.), Storage Location, and optionally condition. These stay fixed while you scan through the stack, so each capture only asks "which card is this," not "which card, and is it foil, and what frame, and where does it go" every single time. Change the defaults whenever the stack you're working through changes (e.g., finish the foils, switch the toggle, keep scanning). These live in `scan_sessions`.
- **Always-visible session-state banner**: show the currently-active defaults (e.g. "Foil · Borderless · Set: Foundations · → Binder 4") on-screen throughout scanning, not buried in a settings panel — so it's never ambiguous what's about to be applied to the next capture, especially useful right after switching sub-stacks. On a phone this belongs pinned above the capture button, where a thumb cannot miss it.
- **Per-card override, no session reset needed**: on each capture's confirm screen, allow a one-tap override of any single preset attribute for just that card (e.g., the stack is mostly non-foil but one card in the middle happens to be foil) — catches the mixed-pile case without forcing a full session-settings change and switch-back for one outlier.

## Matching

- The session's frame/border and foil presets aren't just typing-savers — feed them into candidate ranking too. Scryfall tracks frame/border/foil as real fields on each printing (`frame`, `frame_effects`, `border_color`, `finishes`, all already imported), and many sets have a "standard" and a "borderless" (or showcase, extended-art, etc.) version of the same card name — so telling the matcher "this stack is all borderless" helps it land on the exact printing, not just the exact name.
- Fuzzy-match the extracted text against `card_name_variants` (which already holds every face and flip name, normalised) and **present the top few ranked candidates as a pick-list**, not just a single best guess — the same resolve-ambiguity pattern already used for decklist import (Phase 5). OCR confidence varies enough that a forced single guess will be wrong more often than a short ranked list will be missing the right card. If this runs while set-scoped entry (Phase 4) is active, weight/filter candidates toward that set first — most reprints share a name across many sets, so the set scope does a lot of the disambiguation before fuzzy-matching even runs.
- Never auto-add without the user picking from that list — OCR misreads happen (unusual fonts, foil glare, non-English printings), so don't add silently even on a high-confidence single match.
- **Correction memory, not model retraining.** Whichever recogniser is in use, it is a fixed model this app cannot retrain. What *is* feasible: log each `(OCR text → card the user actually picked)` correction in `ocr_corrections`, and check that lookup before running fresh fuzzy-matching on future scans. If the same misread text comes up again — same card, same lighting, same set — the app immediately puts the previously-confirmed match at the top of the list instead of re-guessing from scratch. It's a personalized alias table that gets more accurate with use, not a change to the underlying OCR itself. This matters more on the web path, where recognition is weaker.

## Out of scope

Full recognition from card art alone (no text, e.g. for damaged or foreign cards) is explicitly out of scope — that needs a trained image-matching model or a third-party visual-search API, a much bigger undertaking than this app otherwise requires.
