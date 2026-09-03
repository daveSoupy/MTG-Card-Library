import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchFormats, fetchLocations, fetchRandomCard, fetchSets, fetchStatus, imageUrl, searchCards,
  type CardSummary, type FormatRecord, type SetRecord, type StatusResponse,
  type StorageLocation,
} from './api.ts';
import { EMPTY_FILTERS, FilterPanel, filtersAreActive, type Filters } from './components/FilterPanel.tsx';
import { CardDetailPane } from './components/CardDetailPane.tsx';
import { SyncGate } from './components/SyncGate.tsx';
import { DeckList } from './components/DeckList.tsx';
import { DeckBuilder } from './components/DeckBuilder.tsx';
import { SyntaxHelp } from './components/SyntaxHelp.tsx';
import { CollectionPage } from './components/CollectionPage.tsx';
import { DataPage } from './components/DataPage.tsx';
import { TradesPage } from './components/TradesPage.tsx';
import { WantListsPage } from './components/WantListsPage.tsx';
import { TradeListsPage } from './components/TradeListsPage.tsx';
import { AlertsBell } from './components/AlertsBell.tsx';

const SORTS = [
  ['relevance', 'Best match'],
  ['name', 'Name'],
  ['manaValue', 'Mana value'],
  ['newest', 'Newest'],
  ['price', 'Price'],
  ['edhrec', 'Popularity'],
] as const;

const PAGE_SIZE = 60;

type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'mtg.theme';
const THEME_LABEL: Record<Theme, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

/**
 * Reads the saved theme.
 *
 * localStorage throws outright in some privacy modes rather than returning
 * null, so this must not be the thing that stops the app rendering.
 */
function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  } catch {
    return 'system';
  }
}

/** The filter panel's state as the search API wants it. Shared by the initial
 *  search and by "Load more", so the two cannot drift apart. */
function searchParamsFor(text: string, filters: Filters, sort: string) {
  return {
    q: text,
    ownedOnly: filters.ownedOnly,
    colors: filters.colors,
    colorsExact: filters.colorsExact,
    gold: filters.gold,
    hybrid: filters.hybrid,
    rarities: filters.rarities,
    set: filters.set || undefined,
    format: filters.format || undefined,
    minCmc: filters.minCmc === '' ? undefined : Number(filters.minCmc),
    maxCmc: filters.maxCmc === '' ? undefined : Number(filters.maxCmc),
    includeDigital: filters.includeDigital,
    includeExtras: filters.includeExtras,
    includeUnplayable: filters.includeUnplayable,
    excludeUniversesBeyond: filters.excludeUniversesBeyond,
    sort,
    limit: PAGE_SIZE,
  };
}

type View = { name: 'browse' } | { name: 'decks' } | { name: 'deck'; id: number }
  | { name: 'collection' } | { name: 'trades' } | { name: 'wants' } | { name: 'tradelists' }
  | { name: 'data' };

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [showSync, setShowSync] = useState(false);
  const [view, setView] = useState<View>({ name: 'browse' });

  const [text, setText] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<string>('relevance');

  const [cards, setCards] = useState<CardSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [showSyntax, setShowSyntax] = useState(false);

  const [sets, setSets] = useState<SetRecord[]>([]);
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  // Bumped after a restore or an import, so the collection view refetches.
  const [dataEpoch, setDataEpoch] = useState(0);
  const [alertKey, setAlertKey] = useState(0);
  const [formats, setFormats] = useState<FormatRecord[]>([]);
  const [wide, setWide] = useState(() => window.innerWidth > 1100);
  const [theme, setTheme] = useState<Theme>(storedTheme);

  // 'system' removes the attribute rather than setting one, so the stylesheet's
  // prefers-color-scheme rule takes over again.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  }, [theme]);

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
    fetchLocations().then(setLocations).catch(() => undefined);
  }, [status?.library.hasCardData]);

  // Debounced search. Every keystroke aborts the previous request so results
  // cannot arrive out of order.
  useEffect(() => {
    if (!status?.library.hasCardData) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchCards(searchParamsFor(text, filters, sort), controller.signal)
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
      } else if (event.key === '?' && document.activeElement !== searchInput.current) {
        event.preventDefault();
        setShowSyntax(true);
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

        <nav className="tabs">
          <button
            className={view.name === 'browse' ? 'on' : ''}
            onClick={() => setView({ name: 'browse' })}
          >Browse</button>
          <button
            className={view.name === 'decks' || view.name === 'deck' ? 'on' : ''}
            onClick={() => setView({ name: 'decks' })}
          >Decks</button>
          <button
            className={view.name === 'collection' ? 'on' : ''}
            onClick={() => setView({ name: 'collection' })}
          >Collection</button>
          <button
            className={view.name === 'trades' ? 'on' : ''}
            onClick={() => setView({ name: 'trades' })}
          >Trades</button>
          <button
            className={view.name === 'wants' ? 'on' : ''}
            onClick={() => setView({ name: 'wants' })}
          >Wants</button>
          <button
            className={view.name === 'tradelists' ? 'on' : ''}
            onClick={() => setView({ name: 'tradelists' })}
          >For trade</button>
          <button
            className={view.name === 'data' ? 'on' : ''}
            onClick={() => setView({ name: 'data' })}
          >Data</button>
        </nav>

        {view.name === 'browse' && <div className="searchbox">
          <input
            ref={searchInput}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search — try  t:creature c:rg cmc<=3  or just a card name"
            spellCheck={false}
            aria-label="Search cards"
          />
          <button className="hint syntax-link" onClick={() => setShowSyntax(true)} title="Search syntax reference">
            syntax
          </button>
        </div>}

        {view.name === 'browse' && (
          <>
            <select value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 140 }}>
              {SORTS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <button className="btn secondary" onClick={() => setFiltersOpen((v) => !v)}>
              Filters{filtersAreActive(filters) ? ' •' : ''}
            </button>
          </>
        )}
        {view.name !== 'browse' && <div style={{ flex: 1 }} />}
        {view.name === 'browse' && (
          <button
            className="btn secondary"
            title="Show a random card matching the current filters"
            onClick={() => {
              fetchRandomCard(searchParamsFor(text, filters, sort))
                .then((card) => setSelected(card.oracleId))
                .catch((cause) => setError(cause.message));
            }}
          >
            Random
          </button>
        )}
        <button
          className="btn secondary theme-toggle"
          title={`Theme: ${THEME_LABEL[theme]} — click to change`}
          onClick={() => setTheme((current) =>
            current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system')}
        >
          {theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}
        </button>
        <AlertsBell refreshKey={alertKey} />
        <button className="btn secondary" onClick={() => setShowSync(true)}>Sync</button>
      </header>

      {view.name === 'collection' && <CollectionPage key={dataEpoch} />}

      {view.name === 'trades' && (
        <TradesPage onAlertsChanged={() => { setAlertKey((n) => n + 1); setDataEpoch((n) => n + 1); }} />
      )}
      {view.name === 'wants' && <WantListsPage />}
      {view.name === 'tradelists' && <TradeListsPage key={dataEpoch} />}

      {view.name === 'data' && (
        <DataPage
          locations={locations}
          onCollectionChanged={() => { setDataEpoch((n) => n + 1); loadStatus(); }}
        />
      )}

      {view.name === 'decks' && (
        <DeckList formats={formats} onOpen={(id) => setView({ name: 'deck', id })} />
      )}

      {view.name === 'deck' && (
        <DeckBuilder
          deckId={view.id}
          formats={formats}
          onBack={() => setView({ name: 'decks' })}
        />
      )}

      {view.name === 'browse' && (
      <div className="panes">
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          sets={sets}
          formats={formats}
          open={filtersOpen}
          queryText={text}
          onApplyPreset={(nextFilters, nextQuery) => {
            setFilters(nextFilters);
            setText(nextQuery);
          }}
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
                  <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
                ) : (
                  <div className="placeholder">{card.name}</div>
                )}
                {card.ownedQuantity > 0 && <span className="owned-badge">{card.ownedQuantity}</span>}
                {(card.wantedQuantity ?? 0) > 0 && <span className="wanted-badge" title="On your want list">★</span>}
                <div className="cname">{card.name}</div>
              </button>
            ))}
          </div>

          {cards.length < total && (
            <div className="load-more">
              <button
                className="btn secondary"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  searchCards({
                    ...searchParamsFor(text, filters, sort),
                    offset: cards.length,
                    // The count cannot change while paging one result set, and
                    // recomputing it is the expensive half of the query.
                    knownTotal: total,
                  })
                    // Append rather than replace, and guard against a card
                    // arriving twice if the underlying data shifted mid-scroll.
                    .then((result) => setCards((current) => {
                      const seen = new Set(current.map((c) => c.oracleId));
                      return [...current, ...result.cards.filter((c) => !seen.has(c.oracleId))];
                    }))
                    .catch((e) => setError(e.message))
                    .finally(() => setLoadingMore(false));
                }}
              >
                {loadingMore
                  ? 'Loading…'
                  : `Load ${Math.min(PAGE_SIZE, total - cards.length)} more`}
              </button>
              <span className="count">{cards.length.toLocaleString()} of {total.toLocaleString()}</span>
            </div>
          )}
        </main>

        <CardDetailPane
          oracleId={selected}
          floating={!wide && selected !== null}
          onClose={() => setSelected(null)}
        />
      </div>
      )}

      {showSyntax && <SyntaxHelp onClose={() => setShowSyntax(false)} />}

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
