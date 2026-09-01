# Phase 4 — Collection & Pricing

(Assumes Phase 1 is complete. References the Collection entity and Allocation Tracking in `CLAUDE.md`.)

- Add/edit/remove owned quantities of any card (with foil/non-foil, condition, specific printing, and an optional manual price override), assigned to a specific Storage Location. Support splitting one card's copies across multiple locations and printings.
- **Scope entry to a set**: when adding cards by hand, pick a set first and the search/add view filters to just that set's cards (ideally sortable by collector number to match binder/box order) — avoids searching the full ~30,000-card database while working through one binder page or box at a time. Stay in "add another from this set" mode after each add so the set doesn't need re-picking for every card.
- Manage Storage Locations: create/rename/delete named places (binders, boxes, deck boxes, etc.); optionally set a "home location" per deck.
- Filter/browse the Collection by location (e.g., "show everything in Binder 3") and see a per-card location breakdown in the card/collection view.
- Collection value: total based on current cached prices (or a row's price override, if set), updated whenever bulk data is refreshed.
- **Value over time**: store a periodic snapshot of total collection value (e.g., once per day alongside the price sync) and show it as a simple trend chart, so you can see appreciation/depreciation over time rather than only ever seeing today's number.
- **Set-completion tracking (optional)**: for any given set, show what percentage of it you own based on Collection rows matching that set — a simple checklist view for anyone filling out a set.
- Per-deck "shopping list": cards in a deck marked "need to buy" (not covered by available collection copies), with a running cost estimate at current prices — this falls out naturally from allocation tracking rather than being a separate feature.
- **Add missing deck cards to the Want List in one action** — from a deck's shopping list, a single "add all to Want List" (or per-card) button pushes each missing card and its needed quantity onto the Want List, tagged with which deck it's for (see Phase 6).
