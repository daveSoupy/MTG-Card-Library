import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addDeckCard, addRecommendedLands, fetchDeck, imageUrl, removeDeckCard, searchCards, setDeckCover,
  updateDeck, updateDeckCard,
  type Board, type CardSummary, type Deck, type DeckCard, type FormatRecord,
} from '../api.ts';
import { effectivePickerColors } from '../pickerColors.ts';
import { DeckStatsPanel } from './DeckStatsPanel.tsx';
import { DeckExportDialog } from './DeckExportDialog.tsx';
import { DeckHistoryPanel } from './DeckHistoryPanel.tsx';
import { DeckImportDialog } from './DeckImportDialog.tsx';
import { PlaytestPanel } from './PlaytestPanel.tsx';
import { ShoppingListPanel } from './ShoppingListPanel.tsx';
import {
  DECK_SORTS, groupCards, loadViewPreference, saveViewPreference,
  type DeckSort, type DeckViewMode,
} from '../deckView.ts';

const BOARD_LABEL: Record<Board, string> = {
  command: 'Command zone',
  main: 'Deck',
  side: 'Sideboard',
  maybe: 'Maybeboard',
};

function CardRow({
  card,
  problem,
  onQuantity,
  onBoard,
  onRemove,
  onToggleOwned,
  onPreview,
}: {
  card: DeckCard;
  problem: 'error' | 'warning' | null;
  onQuantity: (delta: number) => void;
  onBoard: (board: Board) => void;
  onRemove: () => void;
  onToggleOwned: () => void;
  onPreview: () => void;
}) {
  const claimed = card.quantityFromCollection;
  const shortfall = claimed > card.availableQuantity;

  return (
    <div className={`deck-row${problem ? ` ${problem}` : ''}`} onMouseEnter={onPreview}>
      <div className="qty">
        <button onClick={() => onQuantity(-1)} aria-label={`One fewer ${card.name}`}>−</button>
        <span>{card.quantity}</span>
        <button onClick={() => onQuantity(1)} aria-label={`One more ${card.name}`}>+</button>
      </div>

      <button className="deck-name" onClick={onPreview} title={card.typeLine}>
        {card.name}
        {card.legality === 'banned' && <span className="tag bad">banned</span>}
        {card.legality === 'restricted' && <span className="tag warn">restricted</span>}
      </button>

      <span className="mana">{card.manaCost ?? ''}</span>

      <button
        className={`owned-chip${claimed > 0 ? ' on' : ''}${shortfall ? ' short' : ''}`}
        onClick={onToggleOwned}
        title={
          card.ownedQuantity === 0
            ? 'You do not own this card yet — counted as "need to buy"'
            : `You own ${card.ownedQuantity}; ${card.availableQuantity} not claimed by other decks`
        }
      >
        {claimed > 0 ? `${claimed} owned` : 'to buy'}
      </button>

      <select
        className="board-select"
        value={card.board}
        onChange={(e) => onBoard(e.target.value as Board)}
        aria-label={`Move ${card.name}`}
      >
        <option value="main">Deck</option>
        <option value="side">Sideboard</option>
        <option value="command">Command zone</option>
        <option value="maybe">Maybeboard</option>
      </select>

      <button className="row-remove" onClick={onRemove} aria-label={`Remove ${card.name}`}>×</button>
    </div>
  );
}

export function DeckBuilder({
  deckId,
  formats,
  onBack,
}: {
  deckId: number;
  formats: FormatRecord[];
  onBack: () => void;
}) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [pickerColors, setPickerColors] = useState<string[]>([]);
  const [pickerGold, setPickerGold] = useState(false);
  const [pickerHybrid, setPickerHybrid] = useState(false);
  const [results, setResults] = useState<CardSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{ printingId: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [playtesting, setPlaytesting] = useState(false);
  const [shopping, setShopping] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState(false);
  const [coverNote, setCoverNote] = useState<string | null>(null);

  const [{ view, sort: cardSort }, setViewPref] = useState(loadViewPreference);
  const setView = (next: DeckViewMode) => {
    setViewPref({ view: next, sort: cardSort });
    saveViewPreference(next, cardSort);
  };
  const setCardSort = (next: DeckSort) => {
    setViewPref({ view, sort: next });
    saveViewPreference(view, next);
  };

  const listRef = useRef<HTMLDivElement>(null);

  // A commander's identity as filter colours. 'C' is included so colourless
  // cards — which fit in every deck — are not excluded along with off-colours.
  const identity = deck?.validation.commanderIdentity ?? null;
  const identityFilter = identity === null ? null : [...identity, 'C'];

  // Whether this format has a command zone at all. Read from the format list
  // rather than guessed from deck size — Gladiator is 100-card singleton and
  // has no commander.
  const requiresCommander = Boolean(
    formats.find((f) => f.code === deck?.formatCode)?.requiresCommander,
  );
  // Set by clicking the empty command slot: narrows the picker to cards that
  // can actually lead this deck, whatever "commander" means in this format.
  const [pickingCommander, setPickingCommander] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    fetchDeck(deckId).then(setDeck).catch((e) => setError(e.message));
  }, [deckId]);

  useEffect(load, [load]);

  /** Every mutation returns the whole deck, so validation never goes stale. */
  const apply = async (action: () => Promise<Deck>) => {
    setBusy(true);
    setError(null);
    try {
      setDeck(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Card picker. Scoped to the deck's format so a Modern deck does not offer
  // cards that would immediately be flagged illegal.
  const colorFilterActive = pickerColors.length > 0 || pickerGold || pickerHybrid;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Commander mode lists candidates with no query typed, since "show me what
      // can lead this deck" is the whole request; a colour filter alone is also
      // enough of a request to run a search.
      if (!query && !ownedOnly && !pickingCommander && !colorFilterActive) {
        setResults([]);
        return;
      }
      setSearching(true);
      searchCards(
        {
          q: query,
          ownedOnly,
          format: deck?.formatCode ?? undefined,
          commanderFor: pickingCommander ? (deck?.formatCode ?? undefined) : undefined,
          // The colour pills narrow within the commander's identity where the
          // format enforces one, so the picker never offers an illegal card.
          colors: effectivePickerColors(pickerColors, identityFilter),
          gold: pickerGold || undefined,
          hybrid: pickerHybrid || undefined,
          limit: 40,
          sort: 'relevance',
        },
        controller.signal,
      )
        .then((r) => {
          setResults(r.cards);
          // Warm the small art so a card's deck tile paints from cache the
          // instant it is added — the reason an owned card felt faster to add
          // was simply that its art was already on disk.
          for (const card of r.cards) {
            if (card.printingId) new Image().src = imageUrl(card.printingId, 'small');
          }
        })
        .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => setSearching(false));
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, ownedOnly, deck?.formatCode, identityFilter, pickingCommander,
      pickerColors, pickerGold, pickerHybrid, colorFilterActive]);

  if (!deck) {
    return (
      <div className="deck-shell">
        {error ? <div className="error">{error}</div> : <p className="loading">Loading deck…</p>}
      </div>
    );
  }

  const problemFor = (card: DeckCard): 'error' | 'warning' | null => {
    const issue = deck.validation.issues.find((i) => i.oracleId === card.oracleId);
    return issue ? issue.severity : null;
  };

  const jumpToCard = (oracleId: string) => {
    const target = listRef.current?.querySelector<HTMLElement>(`[data-oracle="${oracleId}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target?.classList.add('flash');
    setTimeout(() => target?.classList.remove('flash'), 1200);
  };

  const boardsToShow: Board[] = ['command', 'main', 'side', 'maybe'];

  return (
    <div className="deck-shell">
      <div className="deck-header">
        <button className="btn secondary" onClick={onBack}>← Decks</button>

        {renaming ? (
          <input
            className="deck-title-input"
            defaultValue={deck.name}
            autoFocus
            onBlur={(e) => { setRenaming(false); apply(() => updateDeck(deck.id, { name: e.target.value })); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button className="deck-title" onClick={() => setRenaming(true)} title="Click to rename">
            {deck.name}
          </button>
        )}

        <select
          value={deck.formatCode ?? ''}
          onChange={(e) => apply(() => updateDeck(deck.id, { formatCode: e.target.value || null }))}
          style={{ width: 190 }}
        >
          <option value="">No format</option>
          {formats.map((f) => (
            <option key={f.code} value={f.code}>{f.display_name}</option>
          ))}
        </select>

        <span className={`verdict-chip ${deck.validation.isLegal ? 'ok' : 'bad'}`}>
          {deck.validation.isLegal ? 'Legal' : `${deck.validation.issues.filter((i) => i.severity === 'error').length} problems`}
        </span>
        <button
          className="btn secondary"
          onClick={() => apply(() => addRecommendedLands(deck.id))}
          title="Fill the deck to a recommended land count with basics, split by colour"
        >
          Add lands
        </button>
        <button className="btn secondary" onClick={() => setPlaytesting(true)}>
          Playtest
        </button>
        <button className="btn secondary" onClick={() => setShopping(true)}>
          Shopping list
          {deck.stats.needToBuyCount > 0 && ` (${deck.stats.needToBuyCount})`}
        </button>
        <button className="btn secondary" onClick={() => setHistory(true)}>History</button>
        <button className="btn secondary" onClick={() => setExporting(true)}>Export</button>
        <button className="btn secondary" onClick={() => setImporting(true)}>Import</button>
        {busy && <span className="count">saving…</span>}
      </div>

      {error && <div className="error">{error}</div>}

      {playtesting && <PlaytestPanel deck={deck} onClose={() => setPlaytesting(false)} />}
      {exporting && (
        <DeckExportDialog deckId={deck.id} deckName={deck.name} onClose={() => setExporting(false)} />
      )}
      {history && (
        <DeckHistoryPanel
          deckId={deck.id}
          onRestored={load}
          onClose={() => setHistory(false)}
        />
      )}
      {importing && (
        <DeckImportDialog
          deckId={deck.id}
          deckName={deck.name}
          formats={formats}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); load(); }}
        />
      )}
      {shopping && <ShoppingListPanel deckId={deck.id} onClose={() => { setShopping(false); load(); }} />}

      <div className="deck-panes">
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

          {boardsToShow.map((board) => {
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
                    onClick={() => { setPickingCommander(true); searchInput.current?.focus(); }}
                  >
                    <strong>No commander yet</strong>
                    <span>Click to pick one, or add any eligible card first</span>
                  </button>
                )}
                {cards.length === 0 && board !== 'command' && (
                  <p className="note">Search on the right to add cards.</p>
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
                          <CardRow
                            card={card}
                            problem={problemFor(card)}
                            onQuantity={(delta) =>
                              apply(() => updateDeckCard(deck.id, card.id, { quantity: card.quantity + delta }))}
                            onBoard={(next) => apply(() => updateDeckCard(deck.id, card.id, { board: next }))}
                            onRemove={() => apply(() => removeDeckCard(deck.id, card.id))}
                            onToggleOwned={() =>
                              apply(() => updateDeckCard(deck.id, card.id, {
                                fromCollection: card.quantityFromCollection > 0 ? 0 : card.quantity,
                              }))}
                            onPreview={() =>
                              card.printingId && setPreview({ printingId: card.printingId, name: card.name })}
                          />
                        </div>
                      ))
                    ) : (
                      <div className="deck-grid">
                        {group.cards.map((card) => (
                          <div
                            className={`deck-tile${problemFor(card) ? ` ${problemFor(card)}` : ''}`}
                            data-oracle={card.oracleId}
                            key={card.id}
                            title={`${card.name} — ${card.typeLine}`}
                          >
                            {card.printingId && card.imageSmall ? (
                              <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
                            ) : (
                              <div className="placeholder">{card.name}</div>
                            )}

                            <span className="tile-qty">{card.quantity}</span>
                            {card.quantityFromCollection > 0 && (
                              <span className="tile-owned" title="Claimed from your collection">
                                {card.quantityFromCollection}
                              </span>
                            )}

                            {/* Controls sit over the art on hover so the grid
                                stays scannable when you are only reading it. */}
                            <div className="tile-controls">
                              <button
                                onClick={() =>
                                  apply(() => updateDeckCard(deck.id, card.id, { quantity: card.quantity - 1 }))}
                                aria-label={`One fewer ${card.name}`}
                              >−</button>
                              <button
                                onClick={() =>
                                  apply(() => updateDeckCard(deck.id, card.id, { quantity: card.quantity + 1 }))}
                                aria-label={`One more ${card.name}`}
                              >+</button>
                              <button
                                onClick={() => apply(() => removeDeckCard(deck.id, card.id))}
                                aria-label={`Remove ${card.name}`}
                              >×</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            );
          })}
        </div>

        <div className="picker">
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
                    apply(() => addDeckCard(deck.id, card.oracleId, options));
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
                  onClick={() => apply(() => addDeckCard(deck.id, card.oracleId, { board: 'side' }))}
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

        <DeckStatsPanel
          stats={deck.stats}
          validation={deck.validation}
          manaBase={deck.manaBase}
          onJumpToCard={jumpToCard}
        />
      </div>
    </div>
  );
}
