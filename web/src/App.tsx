import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchFormats, fetchSets, fetchStatus, imageUrl, searchCards,
  type CardSummary, type FormatRecord, type SetRecord, type StatusResponse,
} from './api.ts';
import { EMPTY_FILTERS, FilterPanel, filtersAreActive, type Filters } from './components/FilterPanel.tsx';
import { CardDetailPane } from './components/CardDetailPane.tsx';
import { SyncGate } from './components/SyncGate.tsx';

const SORTS = [
  ['relevance', 'Best match'],
  ['name', 'Name'],
  ['manaValue', 'Mana value'],
  ['newest', 'Newest'],
  ['price', 'Price'],
  ['edhrec', 'Popularity'],
] as const;

const PAGE_SIZE = 60;

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [showSync, setShowSync] = useState(false);

  const [text, setText] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<string>('relevance');

  const [cards, setCards] = useState<CardSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [sets, setSets] = useState<SetRecord[]>([]);
  const [formats, setFormats] = useState<FormatRecord[]>([]);
  const [wide, setWide] = useState(() => window.innerWidth > 1100);

  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth > 1100);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadStatus = useCallback(() => {
    fetchStatus()
      .then((next) => {
        setStatus(next);
        // Only block on a truly empty library; a refresh can run in the
        // background while the existing data stays searchable.
        if (!next.library.hasCardData) setShowSync(true);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(loadStatus, [loadStatus]);

  useEffect(() => {
    if (!status?.library.hasCardData) return;
    fetchSets().then(setSets).catch(() => undefined);
    fetchFormats().then(setFormats).catch(() => undefined);
  }, [status?.library.hasCardData]);

  // Debounced search. Every keystroke aborts the previous request so results
  // cannot arrive out of order.
  useEffect(() => {
    if (!status?.library.hasCardData) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchCards(
        {
          q: text,
          ownedOnly: filters.ownedOnly,
          colors: filters.colors,
          colorsExact: filters.colorsExact,
          rarities: filters.rarities,
          set: filters.set || undefined,
          format: filters.format || undefined,
          minCmc: filters.minCmc === '' ? undefined : Number(filters.minCmc),
          maxCmc: filters.maxCmc === '' ? undefined : Number(filters.maxCmc),
          includeDigital: filters.includeDigital,
          includeExtras: filters.includeExtras,
          sort,
          limit: PAGE_SIZE,
        },
        controller.signal,
      )
        .then((result) => {
          setCards(result.cards);
          setTotal(result.total);
        })
        .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => setLoading(false));
    }, 180);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [text, filters, sort, status?.library.hasCardData]);

  // "/" focuses search, the way every card database does it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement !== searchInput.current) {
        event.preventDefault();
        searchInput.current?.focus();
      } else if (event.key === 'Escape') {
        setSelected(null);
        setFiltersOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">MTG <span>Library</span></div>

        <div className="searchbox">
          <input
            ref={searchInput}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search — try  t:creature c:rg cmc<=3  or just a card name"
            spellCheck={false}
            aria-label="Search cards"
          />
          <span className="hint">press /</span>
        </div>

        <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 140 }}>
          {SORTS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>

        <button className="btn secondary" onClick={() => setFiltersOpen((v) => !v)}>
          Filters{filtersAreActive(filters) ? ' •' : ''}
        </button>
        <button className="btn secondary" onClick={() => setShowSync(true)}>Sync</button>
      </header>

      <div className="panes">
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          sets={sets}
          formats={formats}
          open={filtersOpen}
        />

        <main className="results">
          <div className="results-head">
            <span className="count">
              {loading ? 'Searching…' : `${total.toLocaleString()} card${total === 1 ? '' : 's'}`}
              {total > cards.length ? ` · showing ${cards.length}` : ''}
            </span>
            {status?.library.hasCardData && (
              <span className="count">
                library: {status.library.oracleCards.toLocaleString()} cards
              </span>
            )}
          </div>

          {error && <div className="error">{error}</div>}

          {!loading && cards.length === 0 && !error && (
            <p className="empty">
              {text || filtersAreActive(filters)
                ? 'No cards match that search.'
                : 'Type a card name, or use Scryfall syntax like t:creature c:rg cmc<=3.'}
            </p>
          )}

          <div className="grid">
            {cards.map((card) => (
              <button
                key={card.oracleId}
                className="card"
                aria-selected={card.oracleId === selected}
                onClick={() => setSelected(card.oracleId)}
                title={`${card.name} — ${card.typeLine}`}
              >
                {card.printingId && card.imageSmall ? (
                  <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" />
                ) : (
                  <div className="placeholder">{card.name}</div>
                )}
                {card.ownedQuantity > 0 && <span className="owned-badge">{card.ownedQuantity}</span>}
                <div className="cname">{card.name}</div>
              </button>
            ))}
          </div>
        </main>

        <CardDetailPane
          oracleId={selected}
          floating={!wide && selected !== null}
          onClose={() => setSelected(null)}
        />
      </div>

      {showSync && status && (
        <SyncGate
          status={status}
          onFinished={() => { loadStatus(); setShowSync(false); }}
          onDismiss={() => setShowSync(false)}
        />
      )}
    </div>
  );
}
