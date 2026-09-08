import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import App from './App.tsx';
import type { CardSummary } from './api.ts';

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

const searchCards = vi.fn(async () => ({ cards: results, total: results.length }));

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
  searchCards: (...args: unknown[]) => searchCards(...(args as [])),
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
