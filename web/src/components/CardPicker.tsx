import { useEffect, useRef, useState } from 'react';
import { searchCards, type CardSummary } from '../api.ts';

/**
 * A "find a card" search that drops its matches into a floating, scrollable
 * dropdown — the same shape as the set picker. Reused wherever one card is
 * picked from the database (wants, trade items). Full Scryfall syntax, debounced.
 */
export function CardPicker({ onPick, placeholder, ownedOnly }: {
  onPick: (card: CardSummary) => void;
  placeholder?: string;
  /** Limit results to cards in the collection — for the "giving away" side. */
  ownedOnly?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CardSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Only load while the dropdown is open, and reload every time it opens — so
    // reopening after a pick repopulates the list without a type-and-delete.
    if (!open) return;
    // An owned-only picker browses the collection even before you type, so the
    // giving-away side opens straight onto the cards you own.
    if (!query.trim() && !ownedOnly) { setResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchCards({
        q: query,
        ownedOnly,
        limit: ownedOnly ? 60 : 25,
        sort: query.trim() ? 'relevance' : 'name',
      }, controller.signal)
        .then((r) => setResults(r.cards))
        .catch((e) => { if (e.name !== 'AbortError') setResults([]); })
        .finally(() => setSearching(false));
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, ownedOnly, open]);

  // Tap/click outside closes the dropdown (works on touch too).
  useEffect(() => {
    const onDown = (event: Event) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const pick = (card: CardSummary) => {
    onPick(card);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  return (
    <div className="card-picker" ref={ref}>
      <div className="searchbox">
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder ?? 'Find a card — name or Scryfall syntax'}
          spellCheck={false}
          aria-label="Find a card"
        />
      </div>
      {open && (
        <div className="combobox-list">
          {!ownedOnly && !query.trim() && <div className="combobox-empty">Type a card name or Scryfall syntax…</div>}
          {(query.trim() || ownedOnly) && searching && results.length === 0 && <div className="combobox-empty">Searching…</div>}
          {(query.trim() || ownedOnly) && !searching && results.length === 0 && (
            <div className="combobox-empty">{ownedOnly ? 'No matching cards you own.' : 'No matches'}</div>
          )}
          {results.map((card) => (
            <button
              key={card.oracleId}
              className="combobox-option picker-option"
              onClick={() => pick(card)}
              title={card.typeLine}
            >
              <span>{card.name}</span>
              <span className="mana">{card.manaCost ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
