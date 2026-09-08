import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import {
  addDeckCard, fetchDeckCategories, imageUrl, removeDeckCard, setDeckCover, updateDeckCard,
  type Board, type CardSummary, type Deck, type DeckCard,
} from '../api.ts';
import { BackToTop } from './BackToTop.tsx';
import { DeckRow } from './DeckRow.tsx';
import { DeckTile } from './DeckTile.tsx';
import { DeckStatsPanel } from './DeckStatsPanel.tsx';
import { PaneDivider } from './PaneDivider.tsx';
import {
  DECK_SORTS, groupCards, type DeckSort, type DeckViewMode,
} from '../deckView.ts';

const BOARD_LABEL: Record<Board, string> = {
  command: 'Command zone',
  main: 'Deck',
  side: 'Sideboard',
  maybe: 'Maybeboard',
};

const BOARDS_TO_SHOW: Board[] = ['command', 'main', 'side', 'maybe'];

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
  view,
  cardSort,
  setView,
  setCardSort,
  listRef,
  picker,
  setArtFor,
  setError,
  jumpToCard,
  onFilterShortfall,
  showTemplates,
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
  view: DeckViewMode;
  cardSort: DeckSort;
  setView: (view: DeckViewMode) => void;
  setCardSort: (sort: DeckSort) => void;
  listRef: RefObject<HTMLDivElement | null>;
  picker: DeckPickerState;
  setArtFor: (card: DeckCard | null) => void;
  setError: (message: string | null) => void;
  jumpToCard: (oracleId: string) => void;
  onFilterShortfall: (category: string) => void;
  showTemplates: boolean;
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
    results, searching, pickingCommander, setPickingCommander, searchInput,
    preview, setPreview, coverNote, setCoverNote,
  } = picker;

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
          <div className="tabs small">
            <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
              List
            </button>
            <button className={view === 'cards' ? 'on' : ''} onClick={() => setView('cards')}>
              Cards
            </button>
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

              {groups.map((group) => (
                <div key={group.key}>
                  {/* A single "All cards" heading adds nothing over the board
                      heading directly above it. */}
                  {group.key !== 'all' && (
                    <h4>{group.label}<span className="count">{group.count}</span></h4>
                  )}

                  {view === 'list' ? (
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

        <div className="picker-results">
          {results.map((card) => (
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

      <DeckStatsPanel
        stats={deck.stats}
        validation={deck.validation}
        manaBase={deck.manaBase}
        templateProgress={deck.templateProgress}
        showTemplates={showTemplates}
        onJumpToCard={jumpToCard}
        onFilterShortfall={onFilterShortfall}
        floating={statsFloating}
        onClose={onCloseStats}
      />
    </div>
  );
}
