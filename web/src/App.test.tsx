import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import App from './App.tsx';
import {
  ApiError, fetchSettings, updateSettings,
  type AppSettings, type CardSummary, type SearchParams, type Trade, type TradeSummary,
} from './api.ts';
import { HELP_TOPICS, HELP_TOPIC_ORDER } from './components/helpTopics.tsx';

const hit = (overrides: Partial<CardSummary> = {}): CardSummary => ({
  oracleId: 'O-1', name: 'Lightning Bolt', manaCost: '{R}', cmc: 1,
  typeLine: 'Instant', power: null, toughness: null, loyalty: null,
  colors: 'R', colorIdentity: 'R', rarity: 'common',
  setCode: 'lea', setName: 'Limited Edition Alpha', collectorNumber: '161',
  imageSmall: 'small.jpg', imageNormal: 'normal.jpg',
  priceUsd: 4.5, priceUsdFoil: null, printingId: 'P-1',
  ownedQuantity: 0, printingCount: 1,
  ...overrides,
});

const results = [
  hit({ oracleId: 'O-1', name: 'Lightning Bolt', typeLine: 'Instant' }),
  hit({ oracleId: 'O-2', name: 'Shock', typeLine: 'Instant' }),
  hit({ oracleId: 'O-3', name: 'Grizzly Bears', typeLine: 'Creature — Bear', cmc: 2 }),
];

// The parameter is typed so `searchCards.mock.calls[n][0]` is a SearchParams
// rather than an element of an empty tuple.
const searchCards = vi.fn(async (_params: SearchParams) => ({ cards: results, total: results.length }));

// Hoisted so the mock factory below, which vitest lifts above the imports,
// can read them without tripping the temporal dead zone.
const { TRADES, SETTINGS } = vi.hoisted(() => {
  // Mutable so a test can flip welcomeSeen before rendering; the defaults
  // match a library that has been in use, so nothing greets the other tests.
  const SETTINGS = {
    autoMaintainLands: false, showDeckTemplates: false, showGameLog: false,
    allocationIgnoresBasics: true, brewsReserveCopies: false, tradelistReducesAvailable: true,
    defaultCostMethod: 'unknown', defaultCostFixedUsd: 0, draftBoosterPriceUsd: 4,
    deckbuilderDefaultScope: 'all', assemblyMovesLots: false, substituteSuggestionCount: 6,
    welcomeSeen: true,
  };
  const summary = (overrides: Partial<TradeSummary> & Pick<TradeSummary, 'id' | 'counterpartyName'>): TradeSummary => ({
    counterpartyContact: null, status: 'completed', tradeDate: '2026-09-01', completedAt: '2026-09-01T12:00:00Z',
    locationNote: null, notes: null, valueOutUsd: 10, valueInUsd: 12,
    createdAt: '2026-09-01T12:00:00Z', updatedAt: '2026-09-01T12:00:00Z',
    ...overrides,
  });
  const TRADES: TradeSummary[] = [
    summary({ id: 6, counterpartyName: 'Bill' }),
    summary({ id: 8, counterpartyName: 'Alice', status: 'draft', completedAt: null }),
  ];
  return { TRADES, SETTINGS };
});

vi.mock('./api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api.ts')>()),
  fetchStatus: vi.fn(async () => ({
    library: {
      hasCardData: true, oracleCards: 30000, printings: 90000, sets: 700,
      lastSyncedAt: null, loadedBulkType: null, loadedBulkUpdatedAt: null,
    },
    sync: { running: false, progress: null, lastError: null },
    bulkTypes: {},
  })),
  searchCards: (params: SearchParams) => searchCards(params),
  fetchTrades: vi.fn(async () => ({ trades: TRADES, totals: { count: TRADES.length, completedCount: 0, valueOutUsd: 0, valueInUsd: 0, unvaluedCount: 0 } })),
  // A 404 with the server's wording, so the page's own "No trade with that
  // id." line — not the message — is what the test looks for.
  fetchTrade: vi.fn(async (id: number): Promise<Trade> => {
    const found = TRADES.find((t) => t.id === id);
    if (!found) throw new ApiError(`No trade with id ${id}.`, 404, false);
    return { ...found, items: [] };
  }),
  fetchSettings: vi.fn(async () => ({ ...SETTINGS } as AppSettings)),
  updateSettings: vi.fn(async (changes: Partial<AppSettings>) => ({ ...SETTINGS, ...changes } as AppSettings)),
  fetchSets: vi.fn(async () => []),
  fetchFormats: vi.fn(async () => []),
  fetchLocations: vi.fn(async () => []),
  fetchWantLists: vi.fn(async () => []),
  fetchWantList: vi.fn(async () => ({ items: [] })),
  fetchPresets: vi.fn(async () => []),
  fetchAlerts: vi.fn(async () => ({ alerts: [], activeCount: 0 })),
  fetchCollection: vi.fn(async () => ({
    cards: [], distinctCards: 0, totalCards: 0, totalValue: 0, limit: 120, offset: 0,
  })),
  fetchCollectionValue: vi.fn(async () => ({ value: {}, history: [] })),
  fetchTradeLists: vi.fn(async () => []),
  fetchSetCompletion: vi.fn(async () => []),
  fetchDecks: vi.fn(async () => []),
  // Pending forever: the routing tests only need the deck builder to mount
  // for the id in the URL, not to render a deck.
  fetchDeck: vi.fn(() => new Promise(() => undefined)),
  fetchBuildability: vi.fn(async () => null),
  fetchRunHistory: vi.fn(async () => []),
  fetchDeckGames: vi.fn(async () => ({ record: null })),
  fetchTemplates: vi.fn(async () => []),
  imageUrl: (id: string) => `/api/v1/images/${id}`,
}));

/** Opens Browse and waits for the first page of results. */
async function browse() {
  const view = render(<App />);
  // "Browse" names both the top-level tab and one of the collection's own, so
  // reach for the one in the topbar specifically.
  const nav = view.container.querySelector('.topbar .tabs') as HTMLElement;
  fireEvent.click(within(nav).getByRole('button', { name: 'Browse' }));
  await screen.findByTitle(/Lightning Bolt/);
  return view;
}

describe('browse results', () => {
  beforeEach(() => {
    localStorage.clear();
    searchCards.mockClear();
    searchCards.mockResolvedValue({ cards: results, total: results.length });
  });

  it('drops the art from the DOM at Ultra-compact, and puts it back', async () => {
    const { container } = await browse();
    expect(container.querySelectorAll('.card img').length).toBe(3);

    // Two clicks of the topbar toggle: Full → Compact → Ultra-compact.
    const toggle = screen.getByLabelText(/^Card size/);
    fireEvent.click(toggle);
    expect(container.querySelectorAll('.card img').length).toBe(3);
    fireEvent.click(toggle);

    expect(container.querySelectorAll('.card img').length).toBe(0);
    // The row still carries what the art was standing in for.
    expect(container.querySelectorAll('.text-row').length).toBe(3);
    expect(container.querySelector('.tr-price')!.textContent).toBe('$4.50');
    expect(container.querySelector('.tr-set')!.textContent).toBe('LEA #161');
    expect(container.querySelector('.app')!.getAttribute('data-density')).toBe('ultra');

    fireEvent.click(toggle);
    expect(container.querySelectorAll('.card img').length).toBe(3);
  });

  it('qualifies group counts until the last page has loaded', async () => {
    // 3 rows loaded of 90 matches: what a group header can honestly report is
    // how many of them are on screen.
    searchCards.mockResolvedValue({ cards: results, total: 90 });
    const { container } = await browse();

    fireEvent.click(screen.getByRole('button', { name: /^View/ }));
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'type' } });

    const heads = [...container.querySelectorAll('.group-head')];
    expect(heads.map((h) => h.textContent)).toEqual(['Creature1 loaded', 'Instant2 loaded']);
  });

  it('drops the qualifier once every match is loaded', async () => {
    const { container } = await browse();
    fireEvent.click(screen.getByRole('button', { name: /^View/ }));
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'type' } });

    const heads = [...container.querySelectorAll('.group-head')];
    expect(heads.map((h) => h.textContent)).toEqual(['Creature1', 'Instant2']);
  });

  it('keeps density per device, and never sends it anywhere', async () => {
    await browse();
    fireEvent.click(screen.getByLabelText(/^Card size/));

    // Written to this browser's storage only — a second device reads its own.
    expect(localStorage.getItem('mtg.density')).toBe('compact');
    // Nothing about density reaches the server: the only request the page makes
    // is the search it would have made anyway.
    for (const call of searchCards.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('density');
    }
  });

  it('a page override beats the topbar default and survives a remount', async () => {
    const { unmount } = await browse();

    fireEvent.click(screen.getByRole('button', { name: /^View/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Ultra-compact' }));
    expect(localStorage.getItem('mtg.density.browse')).toBe('ultra');
    unmount();

    const { container } = await browse();
    expect(container.querySelector('.app')!.getAttribute('data-density')).toBe('ultra');
    expect(container.querySelectorAll('.card img').length).toBe(0);
  });
});

describe('routing', () => {
  /** The topbar's tab buttons, which are the only reliable "which view" signal. */
  const tabs = (container: HTMLElement) => container.querySelector('.topbar .tabs') as HTMLElement;
  const activeTab = (container: HTMLElement) => tabs(container).querySelector('button.on')?.textContent;
  const url = () => window.location.pathname + window.location.search;

  beforeEach(() => {
    localStorage.clear();
    searchCards.mockClear();
    searchCards.mockResolvedValue({ cards: results, total: results.length });
    window.history.replaceState(null, '', '/');
  });

  it('reads the view from the URL on load, and canonicalises the root', async () => {
    const { container, unmount } = render(<App />);
    expect(activeTab(container)).toBe('Collection');
    expect(url()).toBe('/collection');
    unmount();

    window.history.replaceState(null, '', '/data');
    const second = render(<App />);
    expect(activeTab(second.container)).toBe('Data');
  });

  it('a deck link opens that deck', async () => {
    window.history.replaceState(null, '', '/decks/12');
    const { container } = render(<App />);
    expect(activeTab(container)).toBe('Decks');
    expect(await screen.findByText('Loading deck…')).toBeInTheDocument();
    expect(url()).toBe('/decks/12');
  });

  it('a tab pushes its URL, and Back returns to the previous view', async () => {
    const { container } = render(<App />);
    fireEvent.click(within(tabs(container)).getByRole('button', { name: 'Decks' }));
    expect(url()).toBe('/decks');
    expect(activeTab(container)).toBe('Decks');

    // jsdom's history.back() is asynchronous; drive popstate the way the
    // browser would after it has moved.
    window.history.replaceState(null, '', '/collection');
    fireEvent.popState(window);
    expect(activeTab(container)).toBe('Collection');
  });

  it('clicking the tab you are on leaves no duplicate history entry', () => {
    const { container } = render(<App />);
    const before = window.history.length;
    fireEvent.click(within(tabs(container)).getByRole('button', { name: 'Collection' }));
    expect(window.history.length).toBe(before);
  });

  it('a browse link seeds the search box, and typing keeps the URL current', async () => {
    window.history.replaceState(null, '', '/browse?q=bolt');
    render(<App />);
    const box = await screen.findByLabelText('Search cards') as HTMLInputElement;
    expect(box.value).toBe('bolt');
    await screen.findByTitle(/Lightning Bolt/);
    expect(searchCards.mock.calls.at(-1)?.[0]).toMatchObject({ q: 'bolt' });

    const before = window.history.length;
    fireEvent.change(box, { target: { value: 'shock' } });
    expect(url()).toBe('/browse?q=shock');
    // A replace, not a push.
    expect(window.history.length).toBe(before);

    fireEvent.change(box, { target: { value: '' } });
    expect(url()).toBe('/browse');
  });

  it('the query survives a trip to another tab and rides in the pushed URL', async () => {
    window.history.replaceState(null, '', '/browse?q=bolt');
    const { container } = render(<App />);
    await screen.findByLabelText('Search cards');
    fireEvent.click(within(tabs(container)).getByRole('button', { name: 'Data' }));
    expect(url()).toBe('/data');
    fireEvent.click(within(tabs(container)).getByRole('button', { name: 'Browse' }));
    expect(url()).toBe('/browse?q=bolt');
    expect((screen.getByLabelText('Search cards') as HTMLInputElement).value).toBe('bolt');
  });

  /** The collection's own tab row, beneath the topbar. */
  const subtabs = (container: HTMLElement) => container.querySelector('.subtabs') as HTMLElement;
  const activeSubtab = (container: HTMLElement) => subtabs(container).querySelector('button.on')?.textContent;

  it('a collection link opens on that sub-tab', () => {
    window.history.replaceState(null, '', '/collection/wants');
    const { container } = render(<App />);
    expect(activeTab(container)).toBe('Collection');
    expect(activeSubtab(container)).toBe('Wants');
    expect(url()).toBe('/collection/wants');
  });

  it('a sub-tab pushes its URL, Cards is spelled /collection, and Back retraces', () => {
    const { container } = render(<App />);
    expect(activeSubtab(container)).toBe('Cards');

    const before = window.history.length;
    fireEvent.click(within(subtabs(container)).getByRole('button', { name: 'Value' }));
    expect(url()).toBe('/collection/value');
    expect(activeSubtab(container)).toBe('Value');
    expect(window.history.length).toBe(before + 1);

    // Cards and the bare /collection are one view: a single URL, so
    // clicking Cards while on it cannot leave a duplicate entry.
    fireEvent.click(within(subtabs(container)).getByRole('button', { name: 'Cards' }));
    expect(url()).toBe('/collection');
    fireEvent.click(within(subtabs(container)).getByRole('button', { name: 'Cards' }));
    expect(window.history.length).toBe(before + 2);

    window.history.replaceState(null, '', '/collection/value');
    fireEvent.popState(window);
    expect(activeSubtab(container)).toBe('Value');
  });

  it('a trade link opens that trade', async () => {
    window.history.replaceState(null, '', '/trades/6');
    const { container } = render(<App />);
    expect(activeTab(container)).toBe('Trade');
    expect(await screen.findByText('Bill')).toBeInTheDocument();
    expect(container.querySelector('.trade-editor')).not.toBeNull();
    expect(url()).toBe('/trades/6');
  });

  it('opening a trade pushes its id, and Back returns to the list', async () => {
    window.history.replaceState(null, '', '/trades');
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Alice/ }));
    expect(url()).toBe('/trades/8');
    expect(await screen.findByText('draft', { selector: '.verdict-chip' })).toBeInTheDocument();

    window.history.replaceState(null, '', '/trades');
    fireEvent.popState(window);
    expect(url()).toBe('/trades');
    expect(container.querySelector('.trade-editor')).toBeNull();
    expect(await screen.findByRole('button', { name: /Bill/ })).toBeInTheDocument();
  });

  it('the back arrow inside a trade pushes /trades rather than leaving the app', async () => {
    window.history.replaceState(null, '', '/trades/6');
    render(<App />);
    await screen.findByText('Bill');
    fireEvent.click(screen.getByRole('button', { name: '← Trades' }));
    expect(url()).toBe('/trades');
    expect(await screen.findByRole('button', { name: /Bill/ })).toBeInTheDocument();
  });

  it('a trade id that does not exist says so, like a deck id that does not', async () => {
    window.history.replaceState(null, '', '/trades/999999');
    render(<App />);
    expect(await screen.findByText('No trade with that id.')).toBeInTheDocument();
    expect(url()).toBe('/trades/999999');
  });
});

describe('help and welcome (Phase 17)', () => {
  const dialog = (name: string) => screen.queryByRole('dialog', { name });

  beforeEach(() => {
    localStorage.clear();
    SETTINGS.welcomeSeen = true;
    vi.mocked(fetchSettings).mockClear();
    vi.mocked(updateSettings).mockClear();
    window.history.replaceState(null, '', '/collection');
  });

  it('the topbar ? opens an index that reaches every panel, one panel at a time', async () => {
    const { container } = render(<App />);
    // Two ? buttons exist — one by the bell for desktop, one at the end of
    // the tab strip for phones; CSS shows one at a time. Both open the index.
    const helpButtons = screen.getAllByRole('button', { name: 'Help' });
    expect(helpButtons.map((b) => b.className)).toEqual(['tabs-help', 'btn secondary topbar-help']);
    expect(container.querySelector('.topbar .tabs .tabs-help')).not.toBeNull();
    fireEvent.click(helpButtons[1]);
    expect(dialog('Help')).not.toBeNull();

    for (const id of HELP_TOPIC_ORDER) {
      const { title } = HELP_TOPICS[id];
      fireEvent.click(within(dialog('Help')!).getByRole('button', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }));
      // The topic replaces the index rather than stacking on it.
      expect(dialog('Help')).toBeNull();
      expect(dialog(title)).not.toBeNull();
      expect(document.querySelectorAll('.help-overlay').length).toBe(1);
      // And the way back is the index again.
      fireEvent.click(within(dialog(title)!).getByRole('button', { name: 'All topics' }));
      expect(dialog(title)).toBeNull();
      expect(dialog('Help')).not.toBeNull();
    }

    fireEvent.click(within(dialog('Help')!).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('.help-overlay')).toBeNull();

    fireEvent.click(helpButtons[0]);
    expect(dialog('Help')).not.toBeNull();
  });

  it('the search box link opens the syntax reference with its original content, and Escape dismisses it', async () => {
    window.history.replaceState(null, '', '/browse');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'syntax' }));
    const panel = dialog('Search syntax');
    expect(panel).not.toBeNull();
    expect(within(panel!).getByText('c:azorius')).toBeInTheDocument();
    expect(within(panel!).getByText('Your collection')).toBeInTheDocument();
    // App-level panels always offer the index, whichever way they were opened.
    expect(within(panel!).getByRole('button', { name: 'All topics' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog('Search syntax')).toBeNull();
  });

  it('shows the welcome while the flag is off and card data exists; dismissing writes the flag', async () => {
    SETTINGS.welcomeSeen = false;
    render(<App />);
    const welcome = await screen.findByRole('dialog', { name: 'Welcome' });
    expect(within(welcome).getByRole('button', { name: /^Browse/ })).toBeInTheDocument();

    fireEvent.click(within(welcome).getByRole('button', { name: 'Close' }));
    expect(dialog('Welcome')).toBeNull();
    expect(updateSettings).toHaveBeenCalledWith({ welcomeSeen: true });
  });

  it('does not show the welcome once the flag is set', async () => {
    render(<App />);
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled());
    // Give the settings promise a turn to land before asserting the negative.
    await screen.findAllByRole('button', { name: 'Help' });
    await waitFor(() => expect(vi.mocked(fetchSettings).mock.results[0]?.value).resolves.toBeTruthy());
    expect(dialog('Welcome')).toBeNull();
  });

  it('a welcome link lands on that page and dismisses the welcome', async () => {
    SETTINGS.welcomeSeen = false;
    const { container } = render(<App />);
    const welcome = await screen.findByRole('dialog', { name: 'Welcome' });
    fireEvent.click(within(welcome).getByRole('button', { name: /^Decks/ }));
    expect(dialog('Welcome')).toBeNull();
    expect(window.location.pathname).toBe('/decks');
    const nav = container.querySelector('.topbar .tabs') as HTMLElement;
    expect(within(nav).getByRole('button', { name: 'Decks' }).className).toBe('on');
  });
});
