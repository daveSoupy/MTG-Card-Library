# Phase 17 — Onboarding

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
