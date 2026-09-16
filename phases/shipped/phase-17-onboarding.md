# Phase 17 — Onboarding

> **Shipped 2026-09-15.** Built as specced, with these build-time notes:
>
> - **`welcomeSeen` is read on load, not only after a sync.** `App` shows the welcome while the flag is false *and* card data exists, which covers the first-sync moment, the Data-page reset, and a tab closed mid-welcome, with one rule. So an existing library would have been greeted as new on its next load — migration **v21** (data-only, `PRAGMA user_version = 21`) marks `welcome_seen = '1'` on any database that already holds `oracle_cards`. A fresh install runs `schema.sql`, never the migration, and gets the welcome.
> - **The shared shell is `HelpPanel.tsx`; the six topics live in `helpTopics.tsx`** as data (`HELP_TOPICS`), with `HelpButton` as the `?` beside a control and `HelpIndex` as the topbar list. `SyntaxHelp.tsx` keeps only its content and exports it as `SYNTAX_HELP` so the index lists seven panels, not six.
> - **The shell listens for Escape in the capture phase and stops propagation.** The import dialogs are overlays of their own; a help panel over one must close alone, and the existing dialogs all listen in the bubble phase on `window`.
> - **`HelpButton` portals its panel to `<body>`, and the `?` must never sit inside a `<label>`.** A `<button>` is a labelable element: inside `<label><span>Cost</span><select/></label>` it became the label's implicit control, so clicking "Cost" opened help and the help backdrop's click bubbled back through the label and reopened it. Found by the browser check, not the unit tests. `CostPoolFields` now uses an explicit `<label htmlFor>`, and `CostPoolControls.test.tsx` pins it.
> - **The topbar `?` is two buttons.** The phone's first row holds exactly the brand, five tabs and the bell (styles.css says so), so at ≤620px the `?` rides at the end of the tab strip and scrolls the way an optional sixth tab does; at desktop width it sits beside the bell. The `?` *keyboard* shortcut, which used to open the syntax panel, now opens the index (the syntax panel is its first entry).
> - **The "Decklist import dialects" panel covers both dialogs** with one topic: decklist lines and section headers for `DeckImportDialog`, CSV header spellings for `CollectionImportDialog`.
> - Verification 1–6 are covered by `server/src/routes/settings.test.ts`, `server/src/db/migrations.test.ts` (v21), `web/src/components/HelpPanel.test.tsx`, `CostPoolControls.test.tsx` and the Phase 17 block in `web/src/App.test.tsx`; the visual pass ran in Chrome at 1400px and 390px against a copy of the live database.

The app already does a lot of onboarding — distributed, not centralized.

## What already exists

- **Specific, actionable empty states** on nearly every page: *"No decks yet. Name one above and start building."* (`DeckList.tsx`), *"No trades yet. Start one when you're at the table."* (`TradesPage.tsx`), and equivalents in `TradeListsPage.tsx` and `WantListsPage.tsx`.
- **`SyntaxHelp.tsx`** — a focused reference panel for one dense feature (search syntax).
- **`SyncGate.tsx`** owns the true first-run moment: blocks only until the card database exists, with distinct first-run copy, and doesn't reappear once data exists. **Its first-run copy says the local card copy "works offline" — change that wording**; it contradicts the no-offline rule in CLAUDE.md. "Stays instant" is enough.

A click-through tour bolted on top would duplicate this and be the one piece of UI that works nothing like the rest. This phase extends what's working.

## New: a first-run welcome, right after the first sync

- When `SyncGate`'s first-run flow finishes, show one short welcome step: here's Browse, here's your Collection, here's where decks live — linking straight to each page's empty state.
- One-time, tracked as a `welcomeSeen` entry in `BOOLEAN_SETTINGS` (`server/src/routes/settings.ts`) — not a raw key written to `app_settings`.
- **A reset action on the Data page** — "Show the welcome walkthrough again" — clears the flag and shows the step immediately, without waiting for a sync.

## New: fill the `SyntaxHelp`-shaped gaps

Small `?`-triggered panels next to the control each explains:

- **Allocation** — "from my collection" vs. "need to buy," and why a card shows as unavailable when another deck claims it.
- **Cost pools** — how a Box/Draft split works and why changing quantity mid-pool re-divides the total.
- **Reopening a closed cost pool** (Phase 11) — what "Reopen" next to "Undo" actually does.
- **Commander color identity** — why some cards are greyed out.
- **Why a basic land didn't get added to your collection** (Phase 11) — the one silent exception when building a limited deck.
- **Decklist import dialects** — `4x`, `(SET) 123`, the blank-line sideboard convention. Phase 5 documents these in code comments; surface them in `DeckImportDialog.tsx` / `CollectionImportDialog.tsx`.

**Extract the shared shell.** `SyntaxHelp.tsx` has its overlay, centered card, header-with-close, and Escape handling built in alongside its content. Pull that into a reusable component taking a title and sections as props; refactor `SyntaxHelp` to render into it; all six new panels use the same shell.

## New: a single findable help index

A `?` in the topbar linking to every panel, for someone who'd rather read ahead than discover as they go.

## Verification

1. The welcome step shows exactly once after the first sync and not on subsequent loads.
2. "Show the welcome walkthrough again" displays it immediately.
3. Each help panel opens and closes independently; opening one while another is open doesn't leave the first stuck underneath.
4. The refactored `SyntaxHelp` shows its original content and still dismisses on Escape and backdrop click.
5. The topbar `?` index reaches every one of the six panels.
6. `SyncGate`'s first-run copy no longer says "offline."

## Out of scope

A guided click-through tour with spotlighted elements — it ages separately from the features it documents and rots first.
