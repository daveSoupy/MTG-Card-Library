import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  addWantItem, fetchFormats, fetchLocations, fetchRandomCard, fetchSets, fetchSettings, fetchStatus,
  fetchWantItemsForOracle, fetchWantList, fetchWantLists, imageUrl, removeWantItem, searchCards,
  updateSettings,
  type AppSettings, type CardSummary, type FormatRecord, type NamedList, type SetRecord,
  type StatusResponse, type StorageLocation,
} from './api.ts';
import { EMPTY_FILTERS, FilterPanel, filtersAreActive, type Filters } from './components/FilterPanel.tsx';
import { CardDetailPane } from './components/CardDetailPane.tsx';
import { SyncGate } from './components/SyncGate.tsx';
import { DeckList } from './components/DeckList.tsx';
import { DeckBuilder } from './components/DeckBuilder.tsx';
import { HelpIndex, HelpTopicPanel, type HelpTopicId } from './components/helpTopics.tsx';
import { Welcome } from './components/Welcome.tsx';
import { CollectionPage } from './components/CollectionPage.tsx';
import { DataPage } from './components/DataPage.tsx';
import { TradesPage } from './components/TradesPage.tsx';
import { GamesPage } from './components/GamesPage.tsx';
import { AlertsBell } from './components/AlertsBell.tsx';
import { BackToTop } from './components/BackToTop.tsx';
import { ReconnectBanner } from './components/ReconnectBanner.tsx';
import { CustomizeView } from './components/CustomizeView.tsx';
import { groupByField, type GroupBy } from './deckView.ts';
import {
  DENSITY_HINT, DENSITY_LABEL, effectiveDensity, loadDensity, nextDensity,
  savePageDensity, saveGlobalDensity, type Density, type DensityPage,
} from './density.ts';
import { applyTheme, storedTheme, type Theme } from './theme.ts';
import { SCOPES, SCOPE_HINT, SCOPE_LABEL, scopeOf, withScope } from './searchScope.ts';
import { deckBadge, ownedBadge } from './ownedBadge.ts';
import { ManaCost } from './components/ManaCost.tsx';
import {
  DEFAULT_ROUTE, onRouteChange, pushRoute, readRoute, replaceRoute, type Route,
} from './router.ts';

const SORTS = [
  ['relevance', 'Best match'],
  ['name', 'Name'],
  ['manaValue', 'Mana value'],
  ['newest', 'Newest'],
  ['price', 'Price'],
  ['edhrec', 'Popularity'],
] as const;

const PAGE_SIZE = 60;

/** Browse hits are full card records, so every universal grouping applies. */
const BROWSE_GROUPS: GroupBy[] =
  ['none', 'type', 'subtype', 'rarity', 'color', 'colorIdentity', 'mana', 'set'];

const money = (value: number | null | undefined) =>
  value == null ? '—' : `$${Number(value).toFixed(2)}`;

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

/** The top-level view is the URL (`router.ts`): read from it on load, pushed
 *  to it on every navigation, and set from it on Back/Forward. */
type View = Route;

/** Which page's density the topbar toggle is currently setting. The views with
 *  no card grid at all have none, and report the global default instead. */
function densityPageFor(view: View): DensityPage | null {
  if (view.name === 'browse') return 'browse';
  if (view.name === 'collection') return 'collection';
  if (view.name === 'deck') return 'deck';
  return null;
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [showSync, setShowSync] = useState(false);
  const [view, setView] = useState<View>(readRoute);
  // A `/browse?q=` link seeds the box; otherwise the query starts empty.
  const [text, setText] = useState(() => (view.name === 'browse' ? view.q ?? '' : ''));

  /** Every deliberate move between views: a tab, opening a deck, the deck
   *  builder's back arrow. Pushes a history entry so Back retraces it. */
  const navigate = useCallback((route: View) => {
    pushRoute(route);
    setView(route);
  }, []);

  // The address bar is the truth on load and on Back/Forward. The one
  // replace on mount canonicalises what the user typed — `/` becomes
  // `/collection` — so the URL matches the page from the first paint.
  useEffect(() => {
    replaceRoute(readRoute());
    return onRouteChange((route) => {
      setView(route);
      if (route.name === 'browse') setText(route.q ?? '');
    });
  }, []);

  // Typing keeps the address bar current so a reload or a copied link
  // repeats the search — but as a replace, not a push: every keystroke as a
  // history entry would make Back a way to un-type a query one letter at a
  // time instead of a way to leave the page.
  useEffect(() => {
    if (view.name !== 'browse') return;
    replaceRoute({ name: 'browse', q: text || undefined });
  }, [view.name, text]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<string>('relevance');

  const [cards, setCards] = useState<CardSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Random draws against whatever the search box and filters currently say.
  // One element, rendered in two places: the top bar at desktop widths, and
  // the filter sheet's header on a phone, where the top bar had no room.
  const randomButton = (
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
  );
  // Phase 17. One slot for the app-level help overlays — the topbar index and
  // whichever topic it (or the search box's "syntax" link) opened — so opening
  // a topic from the index replaces the index rather than stacking on it.
  // The `?` beside each control owns its own panel and is not tracked here.
  const [help, setHelp] = useState<HelpTopicId | 'index' | null>(null);
  // Parse warnings from the last search — an unknown storage location, a count
  // that was not a number. Kept beside the results rather than raised as an
  // error: the search still ran.
  const [warnings, setWarnings] = useState<string[]>([]);

  const [sets, setSets] = useState<SetRecord[]>([]);
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  // Bumped after a restore or an import, so the collection view refetches.
  const [dataEpoch, setDataEpoch] = useState(0);
  const [alertKey, setAlertKey] = useState(0);
  // Bumped when the server comes back after the reconnect banner (Phase 31).
  // Every page is keyed on it, the way CollectionPage is on dataEpoch, so the
  // recovery refetches whatever was on screen by remounting it — no reload,
  // and no page needs its own "the server is back" handling. The deck
  // builder is the exception: a remount would drop its undo stack and the
  // picker's query, so it takes the epoch as a prop and reloads in place.
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [formats, setFormats] = useState<FormatRecord[]>([]);
  const [wide, setWide] = useState(() => window.innerWidth > 1100);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [densityPrefs, setDensityPrefs] = useState(loadDensity);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [wantLists, setWantLists] = useState<NamedList[]>([]);
  // Only for the settings that decide what the shell shows. Every page that
  // needs more of them still fetches its own copy.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // Overrides the "wanted" state a search result or card detail carries from
  // its own fetch, so an add/remove reflects immediately without waiting on
  // a refetch. Value is the item's id in the default want list once added
  // through here, or null once explicitly removed this session (removal
  // itself always sweeps every list a card is wanted on, default or not —
  // this id is only ever used to seed the default list's own adds/removes).
  // Oracle ids with no entry defer to the fetched quantity.
  const [wantOverride, setWantOverride] = useState<Map<string, number | null>>(new Map());

  useEffect(() => applyTheme(theme), [theme]);

  // The active page's density, which is what `data-density` on the app root
  // carries — Full and Compact are pure CSS off that attribute, while
  // Ultra-compact and Lined-up also change what each grid renders.
  const densityPage = densityPageFor(view);
  const density = effectiveDensity(densityPrefs, densityPage);

  /** Everything a page's Customize View panel needs to override the default. */
  const densityControlsFor = (page: DensityPage) => ({
    page,
    density: effectiveDensity(densityPrefs, page),
    densityOverridden: densityPrefs.overrides[page] !== undefined,
    onDensity: (next: Density) => {
      savePageDensity(page, next);
      setDensityPrefs((current) => ({
        ...current,
        overrides: { ...current.overrides, [page]: next },
      }));
    },
    onResetDensity: () => {
      savePageDensity(page, null);
      setDensityPrefs((current) => {
        const overrides = { ...current.overrides };
        delete overrides[page];
        return { ...current, overrides };
      });
    },
  });

  const browseDensity = densityControlsFor('browse');

  const searchInput = useRef<HTMLInputElement>(null);

  // The top bar's height, published to CSS as --topbar-h so the overlays that
  // start beneath it (the filter sheet, the tablet detail pane) can be pinned
  // to where it actually ends. It is one row at desktop width and three or
  // four once it wraps on a phone, so no constant is right at both. The
  // fallback in CSS covers a browser without ResizeObserver (and jsdom).
  const topbar = useRef<HTMLElement>(null);
  const [topbarHeight, setTopbarHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = topbar.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setTopbarHeight(Math.ceil(el.getBoundingClientRect().height)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  // Re-run on reconnect: a cold launch against an unreachable server never
  // got a status, and everything below waits on hasCardData.
  useEffect(loadStatus, [loadStatus, reconnectEpoch]);

  const loadSettings = useCallback(() => {
    fetchSettings().then(setSettings).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!status?.library.hasCardData) return;
    fetchSets().then(setSets).catch(() => undefined);
    fetchFormats().then(setFormats).catch(() => undefined);
    fetchLocations().then(setLocations).catch(() => undefined);
    fetchWantLists().then(setWantLists).catch(() => undefined);
    loadSettings();
  }, [status?.library.hasCardData, loadSettings, reconnectEpoch]);

  // Parked features hide their tab. Switching one off while looking at it would
  // otherwise leave the page on screen with no way back to it.
  const showGameLog = Boolean(settings?.showGameLog);
  const showWelcome = settings?.welcomeSeen === false
    && Boolean(status?.library.hasCardData) && !showSync;
  // A replace, not a push: the page went away under the user, so leaving
  // /games in the history would make Back a step onto a tab that isn't there.
  useEffect(() => {
    if (!showGameLog && view.name === 'games') {
      replaceRoute(DEFAULT_ROUTE);
      setView(DEFAULT_ROUTE);
    }
  }, [showGameLog, view.name]);

  const defaultWantListId = wantLists.find((l) => l.is_default)?.id ?? wantLists[0]?.id;

  // Seeds wantOverride with the default list's current item ids, so removing
  // a card that was already wanted before this page load — not just one
  // added this session — has an id to delete right away. Only fills in
  // oracle ids not already overridden, so it never clobbers a toggle the
  // user just made while this was in flight.
  useEffect(() => {
    if (defaultWantListId == null) return;
    fetchWantList(defaultWantListId).then((list) => {
      setWantOverride((current) => {
        const next = new Map(current);
        for (const item of list.items) {
          if (item.status !== 'active' || next.has(item.oracleId)) continue;
          next.set(item.oracleId, item.id);
        }
        return next;
      });
    }).catch(() => undefined);
  }, [defaultWantListId]);

  const isWanted = useCallback((oracleId: string, wantedQuantity: number | undefined) =>
    wantOverride.has(oracleId) ? wantOverride.get(oracleId) !== null : (wantedQuantity ?? 0) > 0,
  [wantOverride]);

  // A card mid-toggle — its request hasn't resolved, so wantOverride/the
  // "wanted" flag it renders from is still stale. Without this, a second
  // click before the first finishes reads that same stale value and repeats
  // the same action (add-then-add, never the add-then-remove it looks like)
  // instead of reversing it. `pendingWant` (state) drives the disabled/dimmed
  // look; `pendingWantRef` is the actual guard — two clicks in the same tick
  // both run before React re-renders with the new state, so a state-only
  // check would let both through regardless of how fast setState "already"
  // happened. A ref updates synchronously, so the guard can't lose that race.
  const pendingWantRef = useRef<Set<string>>(new Set());
  const [pendingWant, setPendingWant] = useState<Set<string>>(new Set());

  const toggleWantList = useCallback((oracleId: string, currentlyWanted: boolean) => {
    if (defaultWantListId == null || pendingWantRef.current.has(oracleId)) return;
    pendingWantRef.current.add(oracleId);
    setPendingWant(new Set(pendingWantRef.current));
    const settle = () => {
      pendingWantRef.current.delete(oracleId);
      setPendingWant(new Set(pendingWantRef.current));
    };
    if (currentlyWanted) {
      // Look up every active entry across every list rather than trusting
      // wantOverride's default-list id alone — a card added through some
      // other list (the Wants page, say) never gets one, and "remove" should
      // still mean gone, not "gone from whichever list happened to add it."
      fetchWantItemsForOracle(oracleId)
        .then((items) => Promise.all(items.map((i) => removeWantItem(i.wantListId, i.itemId))))
        .then(() => setWantOverride((current) => new Map(current).set(oracleId, null)))
        .catch((e) => setError(e.message))
        .finally(settle);
    } else {
      addWantItem(defaultWantListId, oracleId)
        .then((list) => {
          const item = list.items.find((i) => i.oracleId === oracleId);
          setWantOverride((current) => new Map(current).set(oracleId, item?.id ?? null));
        })
        .catch((e) => setError(e.message))
        .finally(settle);
    }
  }, [defaultWantListId]);

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
          setWarnings(result.warnings ?? []);
        })
        .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => setLoading(false));
    }, 180);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [text, filters, sort, status?.library.hasCardData, reconnectEpoch]);

  // "/" focuses search, the way every card database does it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement !== searchInput.current) {
        event.preventDefault();
        searchInput.current?.focus();
      } else if (event.key === '?' && document.activeElement !== searchInput.current) {
        // The same thing the topbar's ? opens; the search reference is the
        // first entry in it.
        event.preventDefault();
        setHelp('index');
      } else if (event.key === 'Escape') {
        setSelected(null);
        setFiltersOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="app"
      data-density={density}
      style={topbarHeight == null ? undefined : { '--topbar-h': `${topbarHeight}px` } as CSSProperties}
    >
      <header className="topbar" ref={topbar}>
        {/* Inside the header, as its own full-width row: the app grid gives
            the header one `auto` row and the view the rest, and the observer
            above folds the banner's height into --topbar-h so floating panes
            keep starting below it. */}
        <ReconnectBanner
          onReconnected={() => {
            setReconnectEpoch((n) => n + 1);
            setAlertKey((n) => n + 1);
          }}
        />
        <div className="brand">MTG <span>Library</span></div>

        <nav className="tabs">
          <button
            className={view.name === 'collection' ? 'on' : ''}
            onClick={() => navigate({ name: 'collection' })}
          >Collection</button>
          <button
            className={view.name === 'decks' || view.name === 'deck' ? 'on' : ''}
            onClick={() => navigate({ name: 'decks' })}
          >Decks</button>
          <button
            className={view.name === 'browse' ? 'on' : ''}
            // The query survives a trip to another tab (it is React state,
            // not the page's), so the URL pushed carries it too.
            onClick={() => navigate({ name: 'browse', q: text || undefined })}
          >Browse</button>
          <button
            className={view.name === 'trades' ? 'on' : ''}
            onClick={() => navigate({ name: 'trades' })}
          >Trade</button>
          {showGameLog && (
            <button
              className={view.name === 'games' ? 'on' : ''}
              onClick={() => navigate({ name: 'games' })}
            >Games</button>
          )}
          <button
            className={view.name === 'data' ? 'on' : ''}
            onClick={() => navigate({ name: 'data' })}
          >Data</button>
          {/* Phone only (styles.css hides it wider): the first row holds
              exactly the brand, five tabs and the bell, so the help index
              rides at the end of the tab strip and scrolls the way an
              optional sixth tab does. Desktop gets the button by the bell. */}
          <button
            className="tabs-help"
            onClick={() => setHelp('index')}
            title="Help"
            aria-label="Help"
          >?</button>
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
          <button className="hint syntax-link" onClick={() => setHelp('syntax')} title="Search syntax reference">
            syntax
          </button>
        </div>}

        {/* Scope chips. They write their term into the box above rather than
            setting a filter of their own, so the syntax is discoverable by
            using the buttons — and so a chip can only ever narrow a query. */}
        {view.name === 'browse' && (
          <div className="scope-chips" role="group" aria-label="Collection scope">
            {SCOPES.map((scope) => (
              <button
                key={scope}
                type="button"
                className="pill"
                aria-pressed={scopeOf(text) === scope}
                title={SCOPE_HINT[scope]}
                onClick={() => setText((current) => withScope(current, scope))}
              >
                {SCOPE_LABEL[scope]}
              </button>
            ))}
          </div>
        )}

        {view.name === 'browse' && (
          <>
            <CustomizeView
              {...browseDensity}
              groupBy={groupBy}
              onGroupBy={setGroupBy}
              groupOptions={BROWSE_GROUPS}
              sort={sort}
              onSort={setSort}
              sortOptions={SORTS}
            />
            <button className="btn secondary" onClick={() => setFiltersOpen((v) => !v)}>
              Filters{filtersAreActive(filters) ? ' •' : ''}
            </button>
          </>
        )}
        {view.name !== 'browse' && <div className="topbar-spacer" />}
        {/* Hidden at phone widths (styles.css, alongside the filter sheet):
            there it was a fourth top-bar row on its own, so the same button
            sits in the filter sheet's header instead — see randomButton. */}
        {view.name === 'browse' && <span className="topbar-random">{randomButton}</span>}
        {/* The global default. A page's own Customize View panel overrides it,
            and the cycle only offers what the page being looked at can show —
            Lined-up is the deck builder's alone. */}
        <button
          className="btn secondary density-toggle"
          title={`Card size: ${DENSITY_LABEL[density]} — ${DENSITY_HINT[density]}. Click to change.`}
          aria-label={`Card size: ${DENSITY_LABEL[density]}`}
          onClick={() => {
            const next = nextDensity(density, densityPage);
            saveGlobalDensity(next);
            // Setting the default from the topbar clears the page's override,
            // so the control the user just used is the one that took effect.
            setDensityPrefs((current) => {
              const overrides = { ...current.overrides };
              if (densityPage) delete overrides[densityPage];
              return { global: next, overrides };
            });
          }}
        >
          {density === 'full' ? '▢' : density === 'lined' ? '▤' : density === 'compact' ? '▦' : '☰'}
        </button>
        {/* Theme and Sync live on the Data page: neither is something you
            reach for mid-search, and the top bar was four rows of buttons on
            a phone. */}
        <AlertsBell refreshKey={alertKey} />
        <button
          className="btn secondary topbar-help"
          onClick={() => setHelp('index')}
          title="Help"
          aria-label="Help"
        >?</button>
      </header>

      {view.name === 'collection' && (
        <CollectionPage
          key={`${dataEpoch}.${reconnectEpoch}`}
          tab={view.tab ?? 'browse'}
          // A push, like the topbar tabs: a sub-tab is a place the user
          // chose to go, so Back should retrace it (router.ts's rule). Browse
          // is spelled `/collection` rather than `/collection/browse` because
          // the two are one view — a bare `/collection` already opens on it,
          // and giving the same page two URLs would let clicking Browse from
          // there push a duplicate entry that makes Back appear to do nothing.
          onTabChange={(tab) => navigate(tab === 'browse' ? { name: 'collection' } : { name: 'collection', tab })}
          {...densityControlsFor('collection')}
          wantsDensity={densityControlsFor('wants')}
        />
      )}

      {view.name === 'trades' && (
        <TradesPage
          key={reconnectEpoch}
          openId={view.id ?? null}
          // Opening pushes /trades/:id; the back arrow pushes /trades rather
          // than calling history.back(), for the same reason the deck
          // builder's does — a trade opened from a pasted link has no
          // /trades behind it, and Back would leave the app.
          onOpen={(id) => navigate(id === null ? { name: 'trades' } : { name: 'trades', id })}
          onAlertsChanged={() => { setAlertKey((n) => n + 1); setDataEpoch((n) => n + 1); }}
        />
      )}

      {view.name === 'games' && showGameLog && <GamesPage key={reconnectEpoch} formats={formats} />}

      {view.name === 'data' && (
        <DataPage
          key={reconnectEpoch}
          locations={locations}
          onCollectionChanged={() => { setDataEpoch((n) => n + 1); loadStatus(); }}
          onSettingsChanged={loadSettings}
          theme={theme}
          onTheme={setTheme}
          onSync={() => setShowSync(true)}
        />
      )}

      {view.name === 'decks' && (
        <DeckList key={reconnectEpoch} formats={formats} onOpen={(id) => navigate({ name: 'deck', id })} />
      )}

      {view.name === 'deck' && (
        <DeckBuilder
          deckId={view.id}
          reloadKey={reconnectEpoch}
          formats={formats}
          categoryLabels={status?.categoryLabels ?? {}}
          // A push to /decks rather than history.back(): a deck opened from
          // a pasted link has no /decks behind it, and Back would leave
          // the app.
          onBack={() => navigate({ name: 'decks' })}
          {...densityControlsFor('deck')}
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
          onClose={() => setFiltersOpen(false)}
          headActions={randomButton}
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

          {/* A typo in a name — loc:Binderrr — returns nothing, which is
              correct, but silently, which is not. */}
          {warnings.map((warning) => (
            <div className="notice" key={warning}>{warning}</div>
          ))}

          {!loading && cards.length === 0 && !error && (
            <p className="empty">
              {text || filtersAreActive(filters)
                ? 'No cards match that search.'
                : 'Type a card name, or use Scryfall syntax like t:creature c:rg cmc<=3.'}
            </p>
          )}

          {/* Grouping runs client-side over the rows that are loaded, so a
              header count is only ever "what you can see" until the last page
              lands — it says so rather than reading as a total. */}
          {groupByField(cards, groupBy).map((group) => (
            <div key={group.key}>
              {group.key !== 'all' && (
                <h4 className="group-head">
                  {group.label}
                  <span className="count">
                    {cards.length < total ? `${group.count} loaded` : group.count}
                  </span>
                </h4>
              )}
              <div className="grid">
                {group.cards.map((card) => {
                  const wanted = isWanted(card.oracleId, card.wantedQuantity);
                  const owned = ownedBadge(card);
                  const decks = deckBadge(card);
                  return (
                    <div
                      key={card.oracleId}
                      role="button"
                      tabIndex={0}
                      className="card"
                      aria-selected={card.oracleId === selected}
                      onClick={() => setSelected(card.oracleId)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(card.oracleId); } }}
                      title={`${card.name} — ${card.typeLine}`}
                    >
                      {/* Ultra-compact leaves the art out of the DOM rather
                          than hiding it: the point is not downloading a
                          thumbnail per row for a list you are scanning. */}
                      {density === 'ultra' ? (
                        <div className="text-row">
                          <span className="tr-name">{card.name}</span>
                          <span className="tr-set">
                            {card.setCode?.toUpperCase() ?? ''}
                            {card.collectorNumber ? ` #${card.collectorNumber}` : ''}
                          </span>
                          <span className="tr-qty" title={owned?.title}>
                            {owned ? `×${owned.text}` : ''}
                          </span>
                          <span className="tr-price">{money(card.priceUsd)}</span>
                        </div>
                      ) : (
                        <>
                          {card.printingId && card.imageSmall ? (
                            <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
                          ) : (
                            <div className="placeholder">{card.name}</div>
                          )}
                          {owned && (
                            <span className="owned-badge" title={owned.title}>{owned.text}</span>
                          )}
                          {/* Which decks already use it — the other half of
                              "do I own this?", and the reason a copy you own
                              may still not be one you can build with. */}
                          {decks && (
                            <span className="deck-badge" title={decks.title}>⛁{decks.text}</span>
                          )}
                          <div className="cname">
                            <span className="cname-text">{card.name}</span>
                            {/* Shown at Compact, where the art is too small to
                                read a cost off. Hidden at Full by the sheet. */}
                            <ManaCost cost={card.manaCost} cmc={card.cmc} className="cmana" />
                          </div>
                        </>
                      )}
                      {wantLists.length > 0 && (
                        <button
                          type="button"
                          className={`want-toggle${wanted ? ' wanted' : ''}`}
                          disabled={pendingWant.has(card.oracleId)}
                          title={wanted ? 'Remove from want list' : 'Add to want list'}
                          onClick={(e) => { e.stopPropagation(); toggleWantList(card.oracleId, wanted); }}
                        >
                          ★
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <BackToTop label="Back to the top of the results" />

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
          canToggleWantList={wantLists.length > 0}
          wantOverride={wantOverride}
          wantPending={selected != null && pendingWant.has(selected)}
          onToggleWantList={toggleWantList}
        />
      </div>
      )}

      {help === 'index' && (
        <HelpIndex onOpen={(topic) => setHelp(topic)} onClose={() => setHelp(null)} />
      )}
      {help !== null && help !== 'index' && (
        <HelpTopicPanel
          topic={help}
          onClose={() => setHelp(null)}
          onBack={() => setHelp('index')}
        />
      )}

      {/* Phase 17. Shown while the flag is false and there is card data —
          which is the moment the first sync lands (loadStatus flips
          hasCardData, the settings then load) and again after the Data
          page's "show it again" clears the flag. Never over the sync gate
          itself. Dismissing writes the flag before the request lands so the
          screen does not linger. */}
      {showWelcome && (
        <Welcome
          onGo={(to) => navigate({ name: to })}
          onDone={() => {
            setSettings((current) => (current ? { ...current, welcomeSeen: true } : current));
            updateSettings({ welcomeSeen: true }).catch(() => undefined);
          }}
        />
      )}

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
