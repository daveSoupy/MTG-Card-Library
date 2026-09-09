import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import {
  addDeckCard, fetchDeckCategories, imageUrl, removeDeckCard, setDeckCover, updateDeckCard,
  type Board, type CardSummary, type Deck, type DeckCard,
} from '../api.ts';
import { BackToTop } from './BackToTop.tsx';
import { CascadePreview } from './CascadePreview.tsx';
import { CustomizeView } from './CustomizeView.tsx';
import { DeckRow } from './DeckRow.tsx';
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

/** Ordering for the picker's own results, applied client-side over the shortlist
 *  the server already returned — this search is capped, not paginated. */
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

export type DeckPickerState = {
  query: string;
  setQuery: (value: string) => void;
  ownedOnly: boolean;
  setOwnedOnly: (value: boolean) => void;
  pickerColors: string[];
  setPickerColors: (fn: (prev: string[]) => string[]) => void;
  pickerGold: boolean;
  setPickerGold: (fn: (prev: boolean) => boolean) => void;
  pickerHybrid: boolean;
  setPickerHybrid: (fn: (prev: boolean) => boolean) => void;
  results: CardSummary[];
  /** Total matches, of which `results` is the capped shortlist. */
  resultsTotal: number;
  searching: boolean;
  pickingCommander: boolean;
  setPickingCommander: (value: boolean) => void;
  searchInput: RefObject<HTMLInputElement | null>;
  preview: { printingId: string; name: string } | null;
  setPreview: (value: { printingId: string; name: string } | null) => void;
  coverNote: string | null;
  setCoverNote: (value: string | null) => void;
};

/** The `.decklist` / `.picker` / `.stats-pane` layout shell. */
export function DeckPanes({
  deck,
  apply,
  problemFor,
  requiresCommander,
  identity,
  cardSort,
  setCardSort,
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
}: {
  deck: Deck;
  /** A label makes the mutation undoable; unlabelled calls are not recorded. */
  apply: (action: () => Promise<Deck>, label?: string) => void;
  problemFor: (card: DeckCard) => 'error' | 'warning' | null;
  requiresCommander: boolean;
  identity: string | null;
  cardSort: DeckSort;
  setCardSort: (sort: DeckSort) => void;
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
    query, setQuery, ownedOnly, setOwnedOnly,
    pickerColors, setPickerColors, pickerGold, setPickerGold, pickerHybrid, setPickerHybrid,
    results, resultsTotal, searching, pickingCommander, setPickingCommander, searchInput,
    preview, setPreview, coverNote, setCoverNote,
  } = picker;

  const [pickerGroupBy, setPickerGroupBy] = useState<GroupBy>('none');
  const [pickerSort, setPickerSort] = useState('relevance');
  // Lined-up covers all but a name strip and touch has no hover, so a tap
  // opens the card whole instead of the tile controls.
  const coarsePointer = useCoarsePointer();
  const [cascadeCard, setCascadeCard] = useState<DeckCard | null>(null);

  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  useEffect(() => {
    fetchDeckCategories(deck.id).then(setCategoryOptions).catch(() => undefined);
  }, [deck.id]);

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
          const groups = groupCards(cards, cardSort);

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
                          onPreview={() => {
                            if (coarsePointer) { setCascadeCard(card); return; }
                            if (card.printingId) setPreview({ printingId: card.printingId, name: card.name });
                          }}
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
                          onToggleOwned={() =>
                            apply(() => updateDeckCard(deck.id, card.id, {
                              fromCollection: card.quantityFromCollection > 0 ? 0 : card.quantity,
                            }), `changing what ${card.name} draws from`)}
                          onPreview={() =>
                            card.printingId && setPreview({ printingId: card.printingId, name: card.name })}
                          onArt={() => setArtFor(card)}
                          onCategory={(category) =>
                            apply(
                              () => updateDeckCard(deck.id, card.id, { category }),
                              `categorising ${card.name}`,
                            )}
                          categoryOptions={categoryOptions}
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

      <div className={`picker${pickerFloating ? ' floating' : ''}`}>
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
            placeholder={pickingCommander
              ? 'Choose a commander…'
              : 'Add cards — name or Scryfall syntax'}
            spellCheck={false}
            aria-label="Search cards to add"
          />
        </div>
        {pickingCommander && (
          <div className="picking-note">
            <span>Showing cards that can lead this deck.</span>
            <button className="linkish" onClick={() => setPickingCommander(false)}>Cancel</button>
          </div>
        )}

        {/* Colour filter — the browse pills, laid out to fit the picker. M is
            "two or more colours", H is a hybrid symbol in the cost. */}
        <div className="picker-filters pills">
          {(['W', 'U', 'B', 'R', 'G', 'C'] as const).map((code) => (
            <button
              key={code}
              className={`pill color ${code}`}
              aria-pressed={pickerColors.includes(code)}
              title={code === 'C' ? 'Colourless' : code}
              onClick={() => setPickerColors((prev) =>
                prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code])}
            >
              {code}
            </button>
          ))}
          <button
            className="pill color M"
            aria-pressed={pickerGold}
            title="Gold — two or more colours"
            onClick={() => setPickerGold((v) => !v)}
          >
            M
          </button>
          <button
            className="pill color H"
            aria-pressed={pickerHybrid}
            title="Hybrid mana, like {G/W}"
            onClick={() => setPickerHybrid((v) => !v)}
          >
            H
          </button>
        </div>

        <label className="check" style={{ margin: '8px 0' }}>
          <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} />
          Only cards I own
        </label>
        {deck.formatCode && (
          <p className="note">
            Showing cards legal in {deck.validation.formatName}
            {identity !== null && ` and within ${identity || 'colourless'} colour identity`}.
          </p>
        )}

        {searching && <p className="loading">Searching…</p>}
        {!searching && results.length === 0 && (query || ownedOnly) && (
          <p className="empty">No matches.</p>
        )}

        {/* The picker's own filters (colour identity, legality, commander mode,
            owned-only) stay where they are — this sits on top of them rather
            than embedding Browse in the deck builder. No View style: these
            rows carry no art for a density to act on. */}
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

        <div className="picker-results">
          {groupByField(sortPickerResults(results, pickerSort), pickerGroupBy).map((group) => (
            <div key={group.key}>
              {group.key !== 'all' && (
                <h4 className="group-head">
                  {group.label}
                  {/* The picker is a capped shortlist, never paginated — so a
                      count is "of what is shown" whenever more matched. */}
                  <span className="count">
                    {resultsTotal > results.length ? `${group.count} shown` : group.count}
                  </span>
                </h4>
              )}
              {group.cards.map((card) => (
            <div className="picker-row" key={card.oracleId}>
              <button
                className="picker-name"
                onMouseEnter={() => card.printingId && setPreview({ printingId: card.printingId, name: card.name })}
                onClick={() => {
                  // In commander mode the destination is explicit. Otherwise
                  // no board is sent and the server decides — which is what
                  // makes the first card into an empty deck lead it.
                  const options = pickingCommander ? { board: 'command' as const } : {};
                  setPickingCommander(false);
                  apply(() => addDeckCard(deck.id, card.oracleId, options), `adding ${card.name}`);
                }}
                title={pickingCommander
                  ? `Make ${card.name} the commander`
                  : `Add ${card.name}`}
              >
                <span>{card.name}</span>
                <span className="mana">{card.manaCost ?? ''}</span>
              </button>
              {card.ownedQuantity > 0 && <span className="tag ok">{card.ownedQuantity}</span>}
              <button
                className="picker-add"
                onClick={() => apply(
                  () => addDeckCard(deck.id, card.oracleId, { board: 'side' }),
                  `adding ${card.name} to the sideboard`,
                )}
                title="Add to sideboard"
              >SB</button>
            </div>
              ))}
            </div>
          ))}
        </div>

        {preview && (
          <>
            <img
              className="picker-preview"
              src={imageUrl(preview.printingId, 'normal')}
              alt={preview.name}
              decoding="async"
            />
            {/* Here rather than on the deck row: you are already looking at
                the art, which is the thing being chosen. */}
            <button
              className="btn secondary small"
              onClick={() => setDeckCover(deck.id, preview.printingId)
                .then(() => setCoverNote(preview.name))
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)))}
            >
              Use as deck cover
            </button>
            {coverNote && <p className="note">Cover set to {coverNote}.</p>}
          </>
        )}
      </div>

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
