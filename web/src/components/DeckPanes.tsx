import {
  useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject,
} from 'react';
import {
  addDeckCard, imageUrl, removeDeckCard, setDeckCover, updateDeckCard,
  type Board, type BuildabilityRow, type CardSummary, type Deck, type DeckCard,
  type FormatRecord, type SetRecord,
} from '../api.ts';
import { BackToTop } from './BackToTop.tsx';
import { CardDetailPane } from './CardDetailPane.tsx';
import { CascadePreview } from './CascadePreview.tsx';
import { CustomizeView } from './CustomizeView.tsx';
import { DeckRow } from './DeckRow.tsx';
import { ManaCost } from './ManaCost.tsx';
import { DeckTile } from './DeckTile.tsx';
import { DeckStatsPanel } from './DeckStatsPanel.tsx';
import { PaneDivider } from './PaneDivider.tsx';
import {
  DECK_SORTS, groupByField, groupCards, type DeckSort, type GroupBy,
} from '../deckView.ts';
import {
  DENSITIES_FOR, DENSITY_HINT, DENSITY_LABEL, type Density,
} from '../density.ts';
import { useCoarsePointer } from '../viewport.ts';
import { SCOPES, SCOPE_HINT, SCOPE_LABEL, scopeOf, withScope } from '../searchScope.ts';
import { PICKER_TYPES, PICKER_TYPE_LABEL, typeOf, withType } from '../pickerTypes.ts';
import { ownedBadge } from '../ownedBadge.ts';
import {
  FilterPanel, countActiveFilters, type FilterSection, type Filters,
} from './FilterPanel.tsx';

const BOARD_LABEL: Record<Board, string> = {
  command: 'Command zone',
  main: 'Deck',
  side: 'Sideboard',
  maybe: 'Maybeboard',
};

const BOARDS_TO_SHOW: Board[] = ['command', 'main', 'side', 'maybe'];

/** The picker searches full card records, so every universal grouping applies. */
const PICKER_GROUPS: GroupBy[] =
  ['none', 'type', 'subtype', 'rarity', 'color', 'colorIdentity', 'mana', 'set'];

/** Ordering for the picker's own results, applied client-side over the pages
 *  the server has returned so far. */
const PICKER_SORTS = [
  ['relevance', 'Best match'],
  ['name', 'Name'],
  ['manaValue', 'Mana value'],
  ['price', 'Price'],
] as const;

function sortPickerResults(cards: CardSummary[], sort: string): CardSummary[] {
  const byName = (a: CardSummary, b: CardSummary) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  switch (sort) {
    case 'name': return [...cards].sort(byName);
    case 'manaValue': return [...cards].sort((a, b) => a.cmc - b.cmc || byName(a, b));
    // Unpriced cards sort last rather than as free, the same as the decklist.
    case 'price': return [...cards].sort((a, b) =>
      (b.priceUsd ?? -1) - (a.priceUsd ?? -1) || byName(a, b));
    default: return cards;
  }
}

/**
 * A card image the picker is showing.
 *
 * `pinned` is how it was opened, which decides how it closes. A hover preview
 * (mouse only) sits under the results and goes when another row is hovered
 * or its ✕ is pressed; a pinned one — the row's art button, the only way on a
 * touch screen — is a sheet over the picker with its own ✕, so it never sits
 * on the bottom of a list you are trying to scroll.
 */
export type PickerPreview = {
  oracleId: string;
  printingId: string;
  name: string;
  pinned?: boolean;
  /** Where a hover preview floats. A picker row's sits just left of the
   *  picker, level with the row, and can be clicked; a deck card's sits
   *  beside the mouse as a tooltip. */
  anchor?: { top: number; left: number };
  /** Beside the cursor and click-through: it may overlap the next tile, so
   *  it must never take the pointer. Details are on the tile's own ⓘ. */
  tooltip?: boolean;
};

/** The hover popup's size, for keeping it on screen: a 240px-wide card plus
 *  its two buttons. Mirrors `.picker-hover` in styles.css. */
const HOVER_POPUP_WIDTH = 240;
const HOVER_POPUP_HEIGHT = 420;

export type DeckPickerState = {
  query: string;
  setQuery: (value: string) => void;
  /** The Browse filter panel's state. Its colours are also the picker's own
   *  chip row — one state, two views. */
  filters: Filters;
  setFilters: (next: Filters) => void;
  sets: SetRecord[];
  formats: FormatRecord[];
  results: CardSummary[];
  /** Total matches, of which `results` is the pages loaded so far. */
  resultsTotal: number;
  searching: boolean;
  loadingMore: boolean;
  /** Appends the next page; a no-op while one is loading or none is left. */
  loadMore: () => void;
  pickingCommander: boolean;
  setPickingCommander: (value: boolean) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  preview: PickerPreview | null;
  setPreview: (value: PickerPreview | null) => void;
  /** Set by a Template shortfall link. Invisible until now: it survived every
   *  later search with nothing on screen to say a filter was still applied. */
  pickerCategory: string | null;
  clearPickerCategory: () => void;
  categoryLabels: Record<string, string>;
};

/** Shared so an absent `coverage` prop does not allocate a map per render. */
const NO_COVERAGE: Map<string, BuildabilityRow> = new Map();

/** The `.decklist` / `.picker` / `.stats-pane` layout shell. */
export function DeckPanes({
  deck,
  apply,
  problemFor,
  requiresCommander,
  limitedFormat = false,
  singleton = false,
  identity,
  cardSort,
  setCardSort,
  categoryLabels,
  coverage = NO_COVERAGE,
  density,
  onDensity,
  listRef,
  picker,
  setArtFor,
  setError,
  jumpToCard,
  onFilterShortfall,
  showTemplates,
  onResolveCategories,
  pickerFloating = false,
  statsFloating = false,
  onRequestPicker,
  onClosePicker,
  onCloseStats,
  paneWidths,
  onPaneResize,
  onPaneCommit,
  onSwap,
}: {
  deck: Deck;
  /** A label makes the mutation undoable; unlabelled calls are not recorded. */
  apply: (action: () => Promise<Deck>, label?: string) => void;
  problemFor: (card: DeckCard) => 'error' | 'warning' | null;
  requiresCommander: boolean;
  /** Draft or sealed: no legality filter, and adds also buy the card. */
  limitedFormat?: boolean;
  /** One copy per card, from the format record the server returns: a card
   *  already in the deck reads "In deck" in the picker and cannot be re-added. */
  singleton?: boolean;
  identity: string | null;
  cardSort: DeckSort;
  setCardSort: (sort: DeckSort) => void;
  categoryLabels: Record<string, string>;
  /** Phase 24's per-card coverage, keyed by oracle id. Omitted while the deck's
   *  figures are in flight, which simply means no shortfall chips yet. */
  coverage?: Map<string, BuildabilityRow>;
  /** Phase 27: opens the substitutes sheet for a card the deck is short of.
   *  Never offered for the command zone — a commander is the deck, not a slot. */
  onSwap?: (card: DeckCard) => void;
  /** The decklist's whole layout, not a size within one: Ultra-compact is the
   *  text list that used to be its own "List" view mode. */
  density: Density;
  onDensity: (density: Density) => void;
  listRef: RefObject<HTMLDivElement | null>;
  picker: DeckPickerState;
  setArtFor: (card: DeckCard | null) => void;
  setError: (message: string | null) => void;
  jumpToCard: (oracleId: string) => void;
  onFilterShortfall: (category: string) => void;
  showTemplates: boolean;
  /** Kicks off the tag resolution the Template panel offers when it has none. */
  onResolveCategories: () => void;
  /** Narrow widths render the picker and the stats pane as overlays instead of
   *  columns — the same treatment CardDetailPane already gets. */
  pickerFloating?: boolean;
  statsFloating?: boolean;
  onRequestPicker?: () => void;
  onClosePicker?: () => void;
  onCloseStats?: () => void;
  paneWidths?: { picker: number; stats: number };
  onPaneResize?: (pane: 'picker' | 'stats', width: number) => void;
  onPaneCommit?: (pane: 'picker' | 'stats', width: number) => void;
}) {
  const {
    query, setQuery, filters, setFilters, sets, formats,
    results, resultsTotal, searching, loadingMore, loadMore,
    pickingCommander, setPickingCommander, searchInput,
    preview, setPreview,
    pickerCategory, clearPickerCategory, categoryLabels: pickerCategoryLabels,
  } = picker;

  const [pickerGroupBy, setPickerGroupBy] = useState<GroupBy>('none');
  const [pickerSort, setPickerSort] = useState('relevance');
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Lined-up covers all but a name strip and touch has no hover, so a tap
  // opens the card whole instead of the tile controls.
  const coarsePointer = useCoarsePointer();
  const [cascadeCard, setCascadeCard] = useState<DeckCard | null>(null);

  // Sections of the filter panel the picker has its own view of, or cannot
  // honour. Collection: the scope chips already write `owned>=1`. Format: the
  // deck's own format applies and cannot be widened past. Presets: a preset
  // carries query text, which would replace the search box — not offered here.
  const omitSections = useMemo<FilterSection[]>(
    () => ['presets', 'collection', ...(deck.formatCode ? ['format' as const] : [])],
    [deck.formatCode],
  );
  const activeFilterCount = countActiveFilters(filters, omitSections);
  const toggleColor = (code: string) => setFilters({
    ...filters,
    colors: filters.colors.includes(code)
      ? filters.colors.filter((c) => c !== code)
      : [...filters.colors, code],
  });

  // Copies of each card already in this deck, by oracle id, so a picker row
  // can say so — and update in the same render the deck does, which is the
  // tap feedback on a phone. The command zone counts as the main deck: a
  // commander is in the deck. The maybeboard does not.
  const inDeck = useMemo(() => {
    const map = new Map<string, { main: number; side: number }>();
    for (const card of deck.cards) {
      if (card.board === 'maybe') continue;
      const entry = map.get(card.oracleId) ?? { main: 0, side: 0 };
      if (card.board === 'side') entry.side += card.quantity;
      else entry.main += card.quantity;
      map.set(card.oracleId, entry);
    }
    return map;
  }, [deck.cards]);

  /** The results in the order they are on screen — what ↓/↑ walk through. */
  const visibleGroups = useMemo(
    () => groupByField(sortPickerResults(results, pickerSort), pickerGroupBy),
    [results, pickerSort, pickerGroupBy],
  );
  const visible = useMemo(() => visibleGroups.flatMap((g) => g.cards), [visibleGroups]);

  // The keyboard highlight, as an oracle id rather than an index: a card that
  // drops out of the results takes the highlight with it, and a page appended
  // below leaves it where it was.
  const [activeId, setActiveId] = useState<string | null>(null);
  const optionId = (oracleId: string) => `picker-option-${oracleId}`;
  useEffect(() => {
    if (!activeId) return;
    document.getElementById(optionId(activeId))?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const heldInSingleton = (card: CardSummary) =>
    singleton && (inDeck.get(card.oracleId)?.main ?? 0) > 0;

  const addFromRow = (card: CardSummary) => {
    // One copy is the limit and it is already here; nothing to do.
    if (heldInSingleton(card)) return;
    // In commander mode the destination is explicit. Otherwise no board is
    // sent and the server decides — which is what makes the first card into
    // an empty deck lead it. printingId is the copy on screen: it pins the
    // slot's art, and in a draft or sealed deck it is the printing that goes
    // into the collection along with the slot.
    const options = {
      printingId: card.printingId,
      ...(pickingCommander ? { board: 'command' as const } : {}),
    };
    setPickingCommander(false);
    apply(() => addDeckCard(deck.id, card.oracleId, options), `adding ${card.name}`);
  };
  const addToSideboard = (card: CardSummary) => apply(
    () => addDeckCard(deck.id, card.oracleId, { board: 'side', printingId: card.printingId }),
    `adding ${card.name} to the sideboard`,
  );

  // A hover preview is for a pointer that can hover. iOS fires mouse events as
  // a finger scrolls over rows, which is how an image used to appear and stay;
  // touch and pen get the row's art button instead.
  //
  // It floats beside the row, over the deck list, and goes when the mouse
  // leaves the results — so it never covers the rows below the one hovered.
  // The leave is on a short fuse rather than immediate, so the pointer can
  // cross the gap into the popup to press "Use as deck cover".
  const pickerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLeave = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  const leaveResults = () => {
    cancelLeave();
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      // Only a hover preview goes on leave; a pinned one has its own close.
      if (previewRef.current?.anchor) setPreview(null);
    }, 160);
  };
  useEffect(() => cancelLeave, []);
  const clampTop = (top: number) =>
    Math.max(8, Math.min(top, window.innerHeight - HOVER_POPUP_HEIGHT - 8));
  const hoverPreview = (event: PointerEvent, card: CardSummary) => {
    if (event.pointerType !== 'mouse' || !card.printingId) return;
    cancelLeave();
    const row = event.currentTarget.getBoundingClientRect();
    const pickerLeft = pickerRef.current?.getBoundingClientRect().left ?? window.innerWidth;
    setPreview({
      oracleId: card.oracleId,
      printingId: card.printingId,
      name: card.name,
      anchor: { top: clampTop(row.top), left: pickerLeft - 4 - HOVER_POPUP_WIDTH },
    });
  };
  /**
   * A deck card under the mouse — Ultra-compact rows and Lined-up strips,
   * the two layouts that show no art of their own: the card, beside the
   * cursor, as a click-through tooltip. To the right of the pointer, or to
   * its left near the deck list's right edge so it stays over the list rather
   * than the picker. No event means a tap on a Lined-up strip on a touch
   * screen: the card opens whole in a panel, with its controls, and stays
   * until closed. (A mouse click raises the tile in place instead.)
   */
  const hoverDeckCard = (card: DeckCard, event?: PointerEvent<HTMLElement>) => {
    if (!event) {
      cancelLeave();
      setPreview(null);
      setCascadeCard(card);
      return;
    }
    if (event.pointerType !== 'mouse' || !card.printingId) return;
    cancelLeave();
    const list = listRef.current?.getBoundingClientRect();
    const listRight = list && list.width > 0 ? list.right : window.innerWidth;
    let left = event.clientX + 16;
    if (left + HOVER_POPUP_WIDTH > listRight) left = event.clientX - 16 - HOVER_POPUP_WIDTH;
    setPreview({
      oracleId: card.oracleId,
      printingId: card.printingId,
      name: card.name,
      anchor: { top: clampTop(event.clientY - 60), left: Math.max(8, left) },
      tooltip: true,
    });
  };
  const pinPreview = (card: CardSummary) => {
    if (!card.printingId) return;
    setPreview({ oracleId: card.oracleId, printingId: card.printingId, name: card.name, pinned: true });
  };

  // The card's details — oracle text, printings, prices, who holds it — as
  // the overlay Browse uses on narrow screens, opened from a preview.
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const openDetail = (oracleId: string) => {
    cancelLeave();
    setPreview(null);
    setDetailFor(oracleId);
  };
  useEffect(() => {
    if (!detailFor) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Ours to close; the builder's own Escape must not also fold the picker.
      event.stopImmediatePropagation();
      setDetailFor(null);
    };
    // Capture, so it runs before the builder's bubbling window listener.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [detailFor]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const index = activeId ? visible.findIndex((c) => c.oracleId === activeId) : -1;
    switch (event.key) {
      case 'ArrowDown':
        if (visible.length === 0) return;
        event.preventDefault();
        setActiveId(visible[Math.min(index + 1, visible.length - 1)].oracleId);
        return;
      case 'ArrowUp':
        if (visible.length === 0) return;
        event.preventDefault();
        setActiveId(index <= 0 ? null : visible[index - 1].oracleId);
        return;
      case 'Enter': {
        const card = index >= 0 ? visible[index] : null;
        if (!card) return;
        event.preventDefault();
        if (event.shiftKey) addToSideboard(card);
        else addFromRow(card);
        return;
      }
      case 'Escape':
        // Stopped here so the builder's own Escape (close the sheet) waits its
        // turn: highlight first, then the query, then the sheet.
        if (activeId) {
          event.preventDefault();
          event.stopPropagation();
          setActiveId(null);
        } else if (query) {
          event.stopPropagation();
          setQuery('');
        }
        return;
      default:
    }
  };

  // Paging without a tap: a sentinel at the end of the list asks for the next
  // page as it scrolls into view. The button below it is the same request for
  // anyone who would rather ask, and the only one where the observer is absent.
  const sentinel = useRef<HTMLDivElement>(null);
  const hasMore = results.length < resultsTotal;
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const inDeckTag = (card: CardSummary) => {
    const entry = inDeck.get(card.oracleId);
    if (!entry || (entry.main === 0 && entry.side === 0)) return null;
    const parts: string[] = [];
    if (entry.main > 0) parts.push(singleton ? 'In deck' : `×${entry.main}`);
    if (entry.side > 0) parts.push(`SB ×${entry.side}`);
    return (
      <span className="tag in-deck" title="Already in this deck">{parts.join(' · ')}</span>
    );
  };


  // Dividers belong to the docked layout only: an overlay picker has no
  // column edge to drag, and the stats pane is not a column at that width.
  const resizable = paneWidths !== undefined && !pickerFloating && !statsFloating;

  return (
    <div
      className="deck-panes"
      style={paneWidths
        ? ({ '--picker-w': `${paneWidths.picker}px`, '--stats-w': `${paneWidths.stats}px` } as CSSProperties)
        : undefined}
    >
      <div className="decklist" ref={listRef}>
        <div className="deck-toolbar">
          {/* The four levels are the decklist's view modes, in the segmented
              control the List/Cards pair used to sit in — Ultra-compact is
              that old List view, so this is one control rather than two that
              overlapped. Overrides the topbar default for this page alone,
              and it is the only page that offers Lined-up. */}
          <div className="tabs small">
            {DENSITIES_FOR.deck.map((option) => (
              <button
                key={option}
                className={option === density ? 'on' : ''}
                aria-pressed={option === density}
                title={DENSITY_HINT[option]}
                onClick={() => onDensity(option)}
              >
                {DENSITY_LABEL[option]}
              </button>
            ))}
          </div>
          <label className="toolbar-sort">
            <span>Sort</span>
            <select value={cardSort} onChange={(e) => setCardSort(e.target.value as DeckSort)}>
              {DECK_SORTS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        {BOARDS_TO_SHOW.map((board) => {
          const cards = deck.cards.filter((c) => c.board === board);
          // The command zone stays on screen even when empty: choosing a
          // commander is the first thing you do, and it used to be the one
          // board you could not put a card into directly.
          const alwaysShow = board === 'main' || (board === 'command' && requiresCommander);
          if (cards.length === 0 && !alwaysShow) return null;
          const count = cards.reduce((total, c) => total + c.quantity, 0);
          // Grouped the way the template lists its categories where one is
          // set, so a template-shaped deck reads in the template's order.
          const groupOptions = {
            labels: categoryLabels,
            templateCategories: deck.templateProgress?.rows.map((r) => r.category),
          };
          const groups = groupCards(cards, cardSort, groupOptions);

          return (
            <section className="board" key={board}>
              <h3>{BOARD_LABEL[board]} <span className="count">{count}</span></h3>
              {cards.length === 0 && board === 'command' && (
                <button
                  className="command-empty"
                  onClick={() => {
                    setPickingCommander(true);
                    onRequestPicker?.();
                    searchInput.current?.focus();
                  }}
                >
                  <strong>No commander yet</strong>
                  <span>Click to pick one, or add any eligible card first</span>
                </button>
              )}
              {cards.length === 0 && board !== 'command' && (
                <p className="note">
                  {pickerFloating ? 'Use “Add cards” to search.' : 'Search on the right to add cards.'}
                </p>
              )}

              {density === 'lined' ? (
                /* Lined-up: one column per group, wrapping within the centre
                   pane. A sort with a single "All cards" bucket falls out to
                   one column with no special-casing. */
                <div className="deck-cascade">
                  {groups.map((group) => (
                    <div className="cascade-col" key={group.key}>
                      {group.key !== 'all' && (
                        <h4>{group.label}<span className="count">{group.count}</span></h4>
                      )}
                      {group.cards.map((card, index) => (
                        <DeckTile
                          key={card.id}
                          card={card}
                          problem={problemFor(card)}
                          density={density}
                          cascade={index === 0 ? 'first' : 'stacked'}
                          // Only the name strip shows, so a mouse over it gets
                          // the card beside the cursor, and a click raises the
                          // tile out of the pile, controls and all (the tile's
                          // own toggle). Touch has no hover and thumb-sized
                          // needs, so a tap opens the card in a panel instead.
                          onPreview={(event) => hoverDeckCard(card, event)}
                          onPreviewEnd={leaveResults}
                          onDetail={() => openDetail(card.oracleId)}
                          tapOpensPreview={coarsePointer}
                          onQuantity={(delta) =>
                            apply(
                              () => updateDeckCard(deck.id, card.id, { quantity: card.quantity + delta }),
                              `${delta > 0 ? 'adding' : 'removing'} a copy of ${card.name}`,
                            )}
                          onArt={() => setArtFor(card)}
                          onRemove={() => apply(
                            () => removeDeckCard(deck.id, card.id),
                            `removing ${card.name}`,
                          )}
                          coverage={coverage.get(card.oracleId) ?? null}
                          onSwap={onSwap && card.board !== 'command' ? () => onSwap(card) : undefined}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ) : groups.map((group) => (
                <div key={group.key}>
                  {/* A single "All cards" heading adds nothing over the board
                      heading directly above it. */}
                  {group.key !== 'all' && (
                    <h4>{group.label}<span className="count">{group.count}</span></h4>
                  )}

                  {/* Ultra-compact: no art, one text row per card. That row is
                      `DeckRow`, which is where the board, category and
                      collection controls live — the reason it stays a row
                      rather than an artless tile. */}
                  {density === 'ultra' ? (
                    group.cards.map((card) => (
                      <div data-oracle={card.oracleId} key={card.id}>
                        <DeckRow
                          card={card}
                          problem={problemFor(card)}
                          onQuantity={(delta) =>
                            apply(
                              () => updateDeckCard(deck.id, card.id, { quantity: card.quantity + delta }),
                              `${delta > 0 ? 'adding' : 'removing'} a copy of ${card.name}`,
                            )}
                          onBoard={(next) => apply(
                            () => updateDeckCard(deck.id, card.id, { board: next }),
                            `moving ${card.name} to ${BOARD_LABEL[next].toLowerCase()}`,
                          )}
                          onRemove={() => apply(
                            () => removeDeckCard(deck.id, card.id),
                            `removing ${card.name}`,
                          )}
                          onPreview={(event) => hoverDeckCard(card, event)}
                          onPreviewEnd={leaveResults}
                          onDetail={() => openDetail(card.oracleId)}
                          onArt={() => setArtFor(card)}
                          categoryLabels={categoryLabels}
                          coverage={coverage.get(card.oracleId) ?? null}
                          onSwap={onSwap && card.board !== 'command' ? () => onSwap(card) : undefined}
                        />
                      </div>
                    ))
                  ) : (
                    <div className="deck-grid">
                      {group.cards.map((card) => (
                        <DeckTile
                          key={card.id}
                          card={card}
                          problem={problemFor(card)}
                          density={density}
                          onDetail={() => openDetail(card.oracleId)}
                          onQuantity={(delta) =>
                            apply(
                              () => updateDeckCard(deck.id, card.id, { quantity: card.quantity + delta }),
                              `${delta > 0 ? 'adding' : 'removing'} a copy of ${card.name}`,
                            )}
                          onArt={() => setArtFor(card)}
                          onRemove={() => apply(
                            () => removeDeckCard(deck.id, card.id),
                            `removing ${card.name}`,
                          )}
                          coverage={coverage.get(card.oracleId) ?? null}
                          onSwap={onSwap && card.board !== 'command' ? () => onSwap(card) : undefined}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </section>
          );
        })}
        <BackToTop label="Back to the top of the deck" />
      </div>

      {resizable && (
        <PaneDivider
          label="Card picker width"
          className="picker-divider"
          width={paneWidths.picker}
          min={220}
          max={640}
          onResize={(width) => onPaneResize?.('picker', width)}
          onCommit={(width) => onPaneCommit?.('picker', width)}
        />
      )}

      <div className={`picker${pickerFloating ? ' floating' : ''}`} ref={pickerRef}>
        {pickerFloating && (
          <div className="floating-head">
            <strong>Add cards</strong>
            <button className="btn secondary small" onClick={() => onClosePicker?.()}>Done</button>
          </div>
        )}
        <div className="searchbox">
          <input
            ref={searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={pickingCommander
              ? 'Choose a commander…'
              : 'Add cards — name or Scryfall syntax'}
            spellCheck={false}
            aria-label="Search cards to add"
            role="combobox"
            aria-expanded={visible.length > 0}
            aria-controls="picker-listbox"
            aria-activedescendant={activeId ? optionId(activeId) : undefined}
            aria-autocomplete="list"
          />
        </div>
        {pickerCategory && (
          <div className="picker-chip">
            <span>{pickerCategoryLabels[pickerCategory] ?? pickerCategory}</span>
            <button
              onClick={clearPickerCategory}
              aria-label={`Stop filtering by ${pickerCategoryLabels[pickerCategory] ?? pickerCategory}`}
              title="Clear this filter"
            >×</button>
          </div>
        )}
        {pickingCommander && (
          <div className="picking-note">
            <span>Showing cards that can lead this deck.</span>
            <button className="linkish" onClick={() => setPickingCommander(false)}>Cancel</button>
          </div>
        )}

        {/* Colour filter — the browse pills, laid out to fit the picker. M is
            "two or more colours", H is a hybrid symbol in the cost. The same
            state as the filter panel's colour section, so a pill pressed here
            reads as pressed there. */}
        <div className="picker-filters pills">
          {(['W', 'U', 'B', 'R', 'G', 'C'] as const).map((code) => (
            <button
              key={code}
              className={`pill color ${code}`}
              aria-pressed={filters.colors.includes(code)}
              title={code === 'C' ? 'Colourless' : code}
              onClick={() => toggleColor(code)}
            >
              {code}
            </button>
          ))}
          <button
            className="pill color M"
            aria-pressed={filters.gold}
            title="Gold — two or more colours"
            onClick={() => setFilters({ ...filters, gold: !filters.gold })}
          >
            M
          </button>
          <button
            className="pill color H"
            aria-pressed={filters.hybrid}
            title="Hybrid mana, like {G/W}"
            onClick={() => setFilters({ ...filters, hybrid: !filters.hybrid })}
          >
            H
          </button>
          <button
            type="button"
            className="btn secondary small picker-filters-btn"
            aria-expanded={filtersOpen}
            aria-pressed={activeFilterCount > 0}
            title="Rarity, mana value, set and more"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filters{activeFilterCount > 0 && ` · ${activeFilterCount}`}
          </button>
        </div>

        {/* Scope chips. They write their term into the box above, so what the
            chip does is visible and editable — and so the chip can only add to
            the picker's identity and legality filters, never replace them. */}
        <div className="scope-chips" role="group" aria-label="Collection scope">
          {SCOPES.map((scope) => (
            <button
              key={scope}
              type="button"
              className="pill"
              aria-pressed={scopeOf(query) === scope}
              title={scope === 'available'
                ? 'Copies free to build with — this deck\u2019s own claim does not count'
                : SCOPE_HINT[scope]}
              onClick={() => setQuery(withScope(query, scope))}
            >
              {SCOPE_LABEL[scope]}
            </button>
          ))}
        </div>
        {/* Card-type chips, the same way: `t:creature` goes into the box. */}
        <div className="scope-chips picker-type-chips" role="group" aria-label="Card type">
          {PICKER_TYPES.map((type) => {
            const on = typeOf(query) === type;
            return (
              <button
                key={type}
                type="button"
                className="pill"
                aria-pressed={on}
                onClick={() => setQuery(withType(query, on ? null : type))}
              >
                {PICKER_TYPE_LABEL[type]}
              </button>
            );
          })}
        </div>
        {deck.formatCode && (
          <p className="note">
            {limitedFormat
              // Limited has no legality list to filter by, and adding a card
              // here is also an acquisition — say so before it happens rather
              // than leaving a collection row to be discovered later.
              ? `Every card is legal in ${deck.validation.formatName}. Adding one here also adds `
                + 'it to your collection, allocated to this deck — basic lands excepted.'
              : (
                <>
                  Showing cards legal in {deck.validation.formatName}
                  {identity !== null && ` and within ${identity || 'colourless'} colour identity`}.
                </>
              )}
          </p>
        )}

        {/* The Browse filter panel, in place of the results while open: a
            sheet over the whole picker on a phone (the .filters.open rule),
            a panel in the column with its own Done at desktop widths. The
            deck's identity, legality and commander narrowing still apply on
            top of whatever it says — it can only narrow further. */}
        {filtersOpen && (
          <div className="picker-filter-panel">
            <FilterPanel
              filters={filters}
              onChange={setFilters}
              sets={sets}
              formats={formats}
              open
              onClose={() => setFiltersOpen(false)}
              queryText={query}
              onApplyPreset={() => undefined}
              omit={omitSections}
            />
          </div>
        )}

        {!filtersOpen && (
          <>
            {searching && <p className="loading">Searching…</p>}
            {!searching && results.length === 0 && query && (
              <p className="empty">No matches.</p>
            )}

            {/* The picker's own filters (colour identity, legality, commander
                mode, scope) stay where they are — this sits on top of them
                rather than embedding Browse in the deck builder. No View
                style: these rows carry no art for a density to act on. */}
            <div className="picker-customize">
              <CustomizeView
                page="deck"
                density={density}
                onDensity={onDensity}
                densityOverridden={false}
                onResetDensity={() => undefined}
                showDensity={false}
                groupBy={pickerGroupBy}
                onGroupBy={setPickerGroupBy}
                groupOptions={PICKER_GROUPS}
                sort={pickerSort}
                onSort={setPickerSort}
                sortOptions={PICKER_SORTS}
              />
            </div>

            {results.length > 0 && (
              <div className="picker-results-head">
                <span className="count">
                  {hasMore
                    ? `${results.length.toLocaleString()} of ${resultsTotal.toLocaleString()}`
                    : `${results.length.toLocaleString()} card${results.length === 1 ? '' : 's'}`}
                </span>
              </div>
            )}

            <div
              className="picker-results"
              id="picker-listbox"
              role="listbox"
              aria-label="Matching cards"
              onPointerLeave={leaveResults}
            >
              {visibleGroups.map((group) => (
                <div key={group.key} role="presentation">
                  {group.key !== 'all' && (
                    <h4 className="group-head">
                      {group.label}
                      {/* A group's count is of the pages loaded, so it says
                          "shown" whenever more matched than is on screen. */}
                      <span className="count">
                        {hasMore ? `${group.count} shown` : group.count}
                      </span>
                    </h4>
                  )}
                  {group.cards.map((card) => {
                    const held = heldInSingleton(card);
                    const active = card.oracleId === activeId;
                    return (
                      <div
                        className={`picker-row${active ? ' active' : ''}`}
                        key={card.oracleId}
                        id={optionId(card.oracleId)}
                        role="option"
                        aria-selected={active}
                        data-oracle={card.oracleId}
                      >
                        <button
                          className={`picker-name${held ? ' held' : ''}`}
                          onPointerEnter={(event) => hoverPreview(event, card)}
                          onClick={() => addFromRow(card)}
                          aria-disabled={held || undefined}
                          title={held
                            ? `${card.name} is already in this deck`
                            : pickingCommander
                              ? `Make ${card.name} the commander`
                              : `Add ${card.name}`}
                        >
                          <span>{card.name}</span>
                          <ManaCost cost={card.manaCost} cmc={card.cmc} />
                        </button>
                        {inDeckTag(card)}
                        {(() => {
                          const badge = ownedBadge(card);
                          return badge ? <span className="tag ok" title={badge.title}>{badge.text}</span> : null;
                        })()}
                        {/* Touch has no hover, so the preview is a button. */}
                        {coarsePointer && card.printingId && (
                          <button
                            className="picker-art"
                            onClick={() => pinPreview(card)}
                            aria-label={`Show ${card.name}`}
                            title="Show the card"
                          >◆</button>
                        )}
                        <button
                          className="picker-add"
                          onClick={() => addToSideboard(card)}
                          title="Add to sideboard"
                        >SB</button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {hasMore && (
              <div className="load-more picker-load-more">
                <div className="picker-sentinel" ref={sentinel} aria-hidden="true" />
                <button
                  className="btn secondary"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
                <span className="count">
                  {results.length.toLocaleString()} of {resultsTotal.toLocaleString()}
                </span>
              </div>
            )}

          </>
        )}

        {/* The pinned preview: a sheet over the picker with a ✕, tap outside
            to dismiss. Fixed, so it never takes the bottom of the list. */}
        {preview?.pinned && (
          <div className="picker-preview-backdrop" onClick={() => setPreview(null)}>
            <div
              className="picker-preview-sheet"
              role="dialog"
              aria-label={preview.name}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="picker-preview-head">
                <strong>{preview.name}</strong>
                <button
                  className="picker-preview-close"
                  onClick={() => setPreview(null)}
                  aria-label="Close preview"
                  title="Close"
                >✕</button>
              </div>
              <img
                src={imageUrl(preview.printingId, 'normal')}
                alt={preview.name}
                decoding="async"
              />
              <button className="btn secondary small" onClick={() => openDetail(preview.oracleId)}>
                Details
              </button>
            </div>
          </div>
        )}
      </div>

      {/* The hover popup, for a picker row or a deck card: floated over a
          column other than the one being worked in, gone when the pointer
          leaves. Clicking the card opens its details. */}
      {preview?.anchor && !preview.pinned && (
        <div
          className={`picker-hover${preview.tooltip ? ' tooltip' : ''}`}
          style={{ top: preview.anchor.top, left: preview.anchor.left }}
          onPointerEnter={cancelLeave}
          onPointerLeave={() => setPreview(null)}
        >
          {preview.tooltip ? (
            <img
              src={imageUrl(preview.printingId, 'normal')}
              alt={preview.name}
              decoding="async"
            />
          ) : (
            <>
              <button
                className="picker-hover-open"
                onClick={() => openDetail(preview.oracleId)}
                aria-label={`Open ${preview.name}`}
                title="Details"
              >
                <img
                  src={imageUrl(preview.printingId, 'normal')}
                  alt={preview.name}
                  decoding="async"
                />
              </button>
            </>
          )}
        </div>
      )}

      {detailFor && (
        <CardDetailPane
          oracleId={detailFor}
          floating
          onClose={() => setDetailFor(null)}
          // The cover is the deck's choice of a printing's picture, so it is
          // offered where the printings are listed.
          onMakeCover={(printingId) => setDeckCover(deck.id, printingId)}
        />
      )}

      {resizable && (
        <PaneDivider
          label="Stats pane width"
          className="stats-divider"
          width={paneWidths.stats}
          min={220}
          max={640}
          onResize={(width) => onPaneResize?.('stats', width)}
          onCommit={(width) => onPaneCommit?.('stats', width)}
        />
      )}

      {cascadeCard && (
        <CascadePreview
          card={cascadeCard}
          onClose={() => setCascadeCard(null)}
          onArt={() => { setArtFor(cascadeCard); setCascadeCard(null); }}
          onDetail={() => { setCascadeCard(null); openDetail(cascadeCard.oracleId); }}
          onQuantity={(delta) => apply(
            () => updateDeckCard(deck.id, cascadeCard.id, { quantity: cascadeCard.quantity + delta }),
            `${delta > 0 ? 'adding' : 'removing'} a copy of ${cascadeCard.name}`,
          )}
          onRemove={() => apply(
            () => removeDeckCard(deck.id, cascadeCard.id),
            `removing ${cascadeCard.name}`,
          )}
        />
      )}

      <DeckStatsPanel
        stats={deck.stats}
        validation={deck.validation}
        manaBase={deck.manaBase}
        templateProgress={deck.templateProgress}
        showTemplates={showTemplates}
        onResolveCategories={onResolveCategories}
        onJumpToCard={jumpToCard}
        onFilterShortfall={onFilterShortfall}
        floating={statsFloating}
        onClose={onCloseStats}
      />
    </div>
  );
}
