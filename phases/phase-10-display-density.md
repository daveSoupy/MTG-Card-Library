# Phase 10 — Display Density

Split out of Phase 9: this touches every card grid in the app, and there's no existing density concept to build on.

## Why this isn't one switch

There's no shared card-tile component. Tiles render independently in four places, each with its own markup:

- `App.tsx` — browse/search results grid (`.card`, inside `.grid`)
- `CollectionPage.tsx` — the "add by set" grid (`.entry-tile`)
- `CollectionPage.tsx` — owned lot tiles, including the foil overlay (`.card`, separate from browse's)
- `DeckBuilder.tsx` — cards inside an open deck in `'cards'` view mode (`.deck-tile`, inside `.deck-grid`)

A density toggle has to reach all four.

**Separate from the deck builder's existing List/Cards toggle.** `DeckBuilder.tsx`'s `view === 'list'` renders `.deck-row` (plain text, no art) and predates this phase. Density applies only within `'cards'` view; `'list'` is untouched.

## The four levels

- **Full** (current default) — unchanged, full-size art in a grid.
- **Lined-up** — full card art as an overlapping cascade, one column per group: each card overlaps the one below so only its name/mana-cost strip shows, except the last card in a group, which shows in full. Same idea as Moxfield's stack view. **Deck builder only** — see below.
- **Compact** — smaller thumbnail art in a grid; name + mana cost + qty on one line.
- **Ultra-compact** — no art; a single text row: name, set/printing, qty, and price where the page already shows one.

Full and Compact are pure CSS. Ultra-compact and Lined-up change what's rendered, not just how.

## Mechanism

One piece of shared state, not four toggles:

- A `data-density` attribute at the app root (the top-level container in `App.tsx`).
- **Full and Compact size the grid container, not the tile.** Tiles render at `width: 100%`; size comes from the container's column formula — `.grid { grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)) }` for browse, `.deck-grid { minmax(128px, 1fr) }` for the deck builder. Compact overrides that `minmax()` via `[data-density="compact"] .grid` / `.deck-grid`.
- **Ultra-compact skips the art element in the DOM** — each of the four render sites reads density and conditionally omits its `<img>`. Can't be CSS-only.
- **Lined-up is a container layout change.** The deck-tile container becomes a `flex-wrap` row of columns, one per `groupCards` group, each column sized to one card's width with `minmax(0, …)` so it can never push past the available width (same guard `styles.css` already uses elsewhere). Inside a column, every card past the first gets a large negative `margin-top` (derived from the 488:680 card aspect ratio, tuned so only the name/cost strip stays visible). No z-index needed — DOM order paints each later card over the previous; the last card is never covered. Columns end at different heights; sorts with one flat "All cards" bucket (`name`, `price`) fall out to a single column with no special-casing. Columns wrap within the center pane, which is narrower than the window because of the side panels.

## Where Lined-up applies

Deck builder only. A deck tops out around 100–250 cards across a handful of type buckets — a reasonable cascade. A Browse search or a real collection can return thousands of cards in a single group, which makes one cascade column absurdly tall regardless of grouping. This stays true after the Customize View panel below brings grouping to Browse and Collection.

## Interaction, in Lined-up specifically

- **Desktop: hover preview.** `.deck-row` already calls `onPreview` on `onMouseEnter` in list view. Reuse that callback for Lined-up's mostly-obscured tiles.
- **Mobile: tap opens the preview, not the controls.** Touch has no hover, so a tap shows the full card. Phase 9's qty/art/remove controls are reachable from a small button on that preview. A deliberate exception to Phase 9's tap-to-reveal pattern — one small branch in Lined-up's tap handler.

## Persistence & scope

- One global default in `localStorage` (per-device, like theme mode).
- Each page remembers its own override of that default — Collection can sit at Ultra-compact for scanning thousands of cards while the deck builder stays at Full.

## Where the control lives

- A global toggle in the topbar sets the default (three options on Browse and Collection; four on the deck builder).
- A small per-page control near each grid's existing sort/filter controls overrides it for that page.

## New: a shared "Customize View" panel for Browse, Collection, and the deck-builder picker

Generalizes `groupCards`/`DECK_SORTS` (`deckView.ts`, today scoped to the deck builder's card list) into a capability shared across three more places.

**What generalizes.** The universal groupings (Type, SubType, Rarity, Color, Color Identity, Mana Value, Set, Artist) work against any card-shaped object. Deck-only groupings (Category from `deck_cards.category`; anything keyed off `board`) stay deck-only. `groupCards`'s input type widens from deck-card-shaped objects to the narrower shape Browse results, Collection lots, and deck cards already share (name, type line, colors, rarity, cmc, set).

**Browse and Collection get the panel.** Replace Browse's flat six-option `SORTS` dropdown with one panel: Group By, Sort By, and View Style together. View Style *is* this phase's density levels (Full/Compact/Ultra-compact), not a separate concept. Collection gets the identical panel on whichever tab shows card tiles.

**Browse pagination and group counts — decided.** Browse is paginated server-side (`PAGE_SIZE = 60` in `App.tsx`, offset-based "Load more"). Grouping stays client-side over the loaded rows, and group headers show a visibly partial count — "Creature (12 loaded)" while more remains, dropping the qualifier once the last page has loaded — rather than a bare number that reads as a total. No new server aggregate. Check whether Collection's tile results are paginated the same way before assuming the same treatment applies there.

**The deck-builder picker gets it too.** The picker already does deck-aware filtering Browse doesn't (color identity, format legality, commander mode, owned-only). Add the same Customize View panel on top of those filters, rather than embedding Browse inside the deck builder.

## Color-identity tint and alphabetical grouping (deck list view)

- **Color-identity tint on `.deck-row`.** Tint the background (or a left-edge bar) by `card.colorIdentity` — mono-color gets that color's tint, multicolor a gold/blended treatment, colorless neutral. Reuse `deckView.ts`'s `COLOR_LABEL` / `COLOR_ORDER` mapping.
- **Alphabetical-within-group for `type` sort.** Today `type` sort orders each group by `curveThenName`. Add a `type-alpha` entry in `DECK_SORTS` so curve-order and alphabetical are both available.

## Verification

1. Ultra-compact removes the `<img>` element from the DOM on all four render sites (`querySelector('img')` is null) — not merely hidden via CSS.
2. In Lined-up, the last card in a group has no negative `margin-top` and nothing painted over it; every other card in the group does.
3. Narrowing the Lined-up container below one card's width still shows exactly one column — never zero, never a horizontal scroll.
4. Setting density while the deck builder is in `'list'` view produces no visible change.
5. A Group By selection on Browse shows "(N loaded)" counts until the final page is loaded, then plain counts.
6. Density set on one device is not reflected on another — confirms it stayed `localStorage`/per-device.

## Out of scope

No server or API changes — entirely client-side rendering. The API already returns everything needed at any density level.
