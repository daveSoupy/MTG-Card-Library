# Phase 9 — Mobile Overhaul

The client was built hover-first and desktop-first; Phase 6 added real mobile passes to Collection and Trades, but the deck builder and a few interaction patterns never got the same treatment. This phase closes those gaps rather than redesigning anything that already works. (Display density was originally scoped here — split out to Phase 10.)

## Deck builder: the card picker disappears on phones

`.picker { display: none; }` fires at `max-width: 860px` (`styles.css`) with no fallback — below that width there is no way to add a card to a deck. The app already has the right pattern: `CardDetailPane` takes a `floating` prop and renders as a fixed overlay on narrow screens (`floating={!wide && selected !== null}` in `App.tsx`). Give `.picker` the same floating-overlay treatment, opened by a visible "Add cards" button.

## Tap doesn't open the per-card menu (cost / qty / art)

Root cause: `.deck-tile:hover .tile-controls` — the qty stepper and art-picker button render only on `:hover`, which never fires on touch. Add a tap/click toggle that shows `.tile-controls` the same way `:hover` does, dismissed by tapping elsewhere. Keep hover for desktop; add to it, don't replace it.

## Horizontal overflow ("cards cut off on the right")

A comment in `styles.css` already flags this: *"the topbar still sets the page's minimum width until the phone layouts land."* Audit `.topbar` and its flex/grid ancestors for whatever establishes that width floor, and let children wrap, shrink, or scroll internally the way `.tabs` already does (`overflow-x: auto`).

## Back to top

Phase 6 moved list/data pages to independently-scrolling containers. A back-to-top control must target each page's own scroll container — a single `window.scrollTo` handler does nothing on pages that scroll internally.

## Deck builder: full mobile layout

Beyond the picker: single-column stack, larger touch targets on the qty +/- controls, and the stats pane (hidden at ≤1200px) reachable behind a toggle instead of simply gone.

## Resizable panel dividers (desktop)

The picker is squeezed between the deck list and the stats pane, each around 300px — workable for adding by name, cramped for browsing. Add a drag handle on each divider (deck-list/picker, picker/stats-pane). No card-sizing logic: the existing `minmax(168px, 1fr)` auto-fill grid already shows more columns as its container widens. Persist each panel's width per-device in `localStorage`. Mobile has no equivalent — its picker is a floating overlay by this point.

## Undo / Redo — desktop and mobile alike

What exists today is narrower than a real history: a long-press on a Collection tile undoes only the single most recent add, and the Data page's "Undo" reverts one entire import batch.

Scope: a per-context undo/redo stack — per open deck, per collection session — covering add/remove/qty-change on a deck slot and collection lot edits. Surface a persistent, visible Undo/Redo pair in the deck builder's header or toolbar at every screen size. The existing import-batch undo and collection long-press stay as they are.

**Decks autosave server-side, so this is a stack of inverse API calls, not client state.** Undoing "remove this card" calls the add-card endpoint again with the same card, quantity, and allocation; the stack remembers which inverse call undoes which forward action.

**Auto-maintain-lands: undo reverts the whole step.** If adding a nonbasic card triggers `autoMaintainLands` to rebalance basics, the add and the rebalance are one undoable step — undoing the add also restores the basics to their pre-add counts. Reverting only the add would leave basics tuned for a card that's no longer there. Implement by recording the deck's basic-land counts before and after each mutation and restoring the "before" set on undo.

## Verification

1. On a ≤860px viewport, the deck builder shows the picker as the same floating overlay `CardDetailPane` uses — not a blank space where the docked panel was.
2. A simulated tap (no preceding hover) on a deck tile reveals `.tile-controls`; tapping elsewhere dismisses it; mouse hover still works as before.
3. At a phone-width viewport, `document.documentElement.scrollWidth` never exceeds the viewport width on any page.
4. Undoing "remove card" restores the exact quantity and allocation the slot had before removal, and restores any basic-land rebalance the removal triggered.
5. Dragging a panel divider persists the width in `localStorage` and restores it on next load, independently per panel.
6. A resized picker shows more grid columns at the same card size.

## Out of scope

- Reworking desktop layouts — this phase is additive for touch/narrow widths, with two exceptions: Undo/Redo and the resizable dividers.
- A packaged mobile app or PWA install flow — see Phases 33 and 36 (`phases/apps/`).
