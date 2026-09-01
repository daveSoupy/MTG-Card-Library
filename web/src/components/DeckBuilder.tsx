import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addDeckCard, fetchDeck, imageUrl, removeDeckCard, searchCards, updateDeck, updateDeckCard,
  type Board, type CardSummary, type Deck, type DeckCard, type FormatRecord,
} from '../api.ts';
import { DeckStatsPanel } from './DeckStatsPanel.tsx';

/** Decklist grouping, in the order a printed decklist reads. */
const TYPE_ORDER = [
  'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery',
  'Artifact', 'Enchantment', 'Land',
] as const;

function groupOf(card: DeckCard): string {
  return TYPE_ORDER.find((type) => card.typeLine.includes(type)) ?? 'Other';
}

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
  const [results, setResults] = useState<CardSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{ printingId: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (!query && !ownedOnly) { setResults([]); return; }
      setSearching(true);
      searchCards(
        { q: query, ownedOnly, format: deck?.formatCode ?? undefined, limit: 40, sort: 'relevance' },
        controller.signal,
      )
        .then((r) => setResults(r.cards))
        .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => setSearching(false));
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, ownedOnly, deck?.formatCode]);

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
        {busy && <span className="count">saving…</span>}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="deck-panes">
        <div className="decklist" ref={listRef}>
          {boardsToShow.map((board) => {
            const cards = deck.cards.filter((c) => c.board === board);
            if (cards.length === 0 && board !== 'main') return null;
            const count = cards.reduce((total, c) => total + c.quantity, 0);

            const groups = new Map<string, DeckCard[]>();
            for (const card of cards) {
              const key = board === 'main' ? groupOf(card) : BOARD_LABEL[board];
              groups.set(key, [...(groups.get(key) ?? []), card]);
            }
            const ordered = [...groups.entries()].sort(
              (a, b) => TYPE_ORDER.indexOf(a[0] as any) - TYPE_ORDER.indexOf(b[0] as any),
            );

            return (
              <section className="board" key={board}>
                <h3>{BOARD_LABEL[board]} <span className="count">{count}</span></h3>
                {cards.length === 0 && (
                  <p className="note">Search on the right to add cards.</p>
                )}
                {ordered.map(([group, groupCards]) => (
                  <div key={group}>
                    {board === 'main' && (
                      <h4>
                        {group}
                        <span className="count">
                          {groupCards.reduce((t, c) => t + c.quantity, 0)}
                        </span>
                      </h4>
                    )}
                    {groupCards.map((card) => (
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
                    ))}
                  </div>
                ))}
              </section>
            );
          })}
        </div>

        <div className="picker">
          <div className="searchbox">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Add cards — name or Scryfall syntax"
              spellCheck={false}
              aria-label="Search cards to add"
            />
          </div>
          <label className="check" style={{ margin: '8px 0' }}>
            <input type="checkbox" checked={ownedOnly} onChange={(e) => setOwnedOnly(e.target.checked)} />
            Only cards I own
          </label>
          {deck.formatCode && (
            <p className="note">Showing cards legal in {deck.validation.formatName}.</p>
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
                  onClick={() => apply(() => addDeckCard(deck.id, card.oracleId))}
                  title={`Add ${card.name}`}
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
            <img
              className="picker-preview"
              src={imageUrl(preview.printingId, 'normal')}
              alt={preview.name}
            />
          )}
        </div>

        <DeckStatsPanel stats={deck.stats} validation={deck.validation} onJumpToCard={jumpToCard} />
      </div>
    </div>
  );
}
