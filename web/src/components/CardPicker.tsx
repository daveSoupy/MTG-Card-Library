import { useEffect, useState } from 'react';
import { searchCards, type CardSummary } from '../api.ts';

/**
 * A compact "find a card" search, reused wherever the user needs to pick one
 * card from the database — adding a want, adding an incoming trade card. Full
 * Scryfall syntax, debounced, same as the deck-builder picker.
 */
export function CardPicker({ onPick, placeholder }: {
  onPick: (card: CardSummary) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CardSummary[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchCards({ q: query, limit: 25, sort: 'relevance' }, controller.signal)
        .then((r) => setResults(r.cards))
        .catch((e) => { if (e.name !== 'AbortError') setResults([]); })
        .finally(() => setSearching(false));
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  return (
    <div className="card-picker">
      <div className="searchbox">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder ?? 'Find a card — name or Scryfall syntax'}
          spellCheck={false}
          aria-label="Find a card"
        />
      </div>
      {searching && <p className="loading">Searching…</p>}
      <div className="picker-results">
        {results.map((card) => (
          <button
            key={card.oracleId}
            className="picker-name"
            onClick={() => { onPick(card); setQuery(''); setResults([]); }}
            title={card.typeLine}
          >
            <span>{card.name}</span>
            <span className="mana">{card.manaCost ?? ''}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
