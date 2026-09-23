import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CollectionPage, COLLECTION_PAGE } from './CollectionPage.tsx';
import type { CollectionCard, StorageLocation } from '../api.ts';

const card = (n: number): CollectionCard => ({
  oracleId: `O${n}`, name: `Card ${String(n).padStart(4, '0')}`, manaCost: null, cmc: 0,
  typeLine: 'Artifact', colorIdentity: '', ownedQuantity: 1, allocatedQuantity: 0,
  printingId: `P${n}`, finish: 'nonfoil', setCode: 'tst', setName: 'Test', collectorNumber: String(n),
  valueUsd: 1, locationCount: 1, imageSmall: null,
} as unknown as CollectionCard);

/** A collection of 300 printings, served a page at a time like the route does. */
const TOTAL = 300;
const ALL = Array.from({ length: TOTAL }, (_, i) => card(i + 1));

const location = (id: number, name: string, kind = 'binder', extra: Partial<StorageLocation> = {}): StorageLocation => ({
  id, name, kind, notes: null, is_default: 0, is_archived: 0,
  card_count: 10, distinct_printings: 5, value_usd: 1, ...extra,
});

const api = vi.hoisted(() => ({
  fetchCollection: vi.fn(),
  fetchLocations: vi.fn(),
  fetchCollectionValue: vi.fn(),
  fetchSets: vi.fn(),
  updateLocation: vi.fn(),
}));

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  ...api,
}));

function renderPage() {
  return render(
    <CollectionPage
      tab="browse" onTabChange={() => {}} page="collection" density="ultra"
      onDensity={() => {}} densityOverridden={false} onResetDensity={() => {}}
      wantsDensity={{ page: 'wants', density: 'full', onDensity: () => {}, densityOverridden: false, onResetDensity: () => {} }}
    />,
  );
}

const tileNames = () => Array.from(document.querySelectorAll('.owned-grid .tr-name')).map((el) => el.textContent);

describe('CollectionPage', () => {
  beforeEach(() => {
    api.fetchCollection.mockImplementation(async (params: { limit?: number; offset?: number }) => {
      const offset = params.offset ?? 0;
      return {
        cards: ALL.slice(offset, offset + (params.limit ?? 100)),
        distinctCards: TOTAL, totalCards: TOTAL, totalValue: TOTAL, limit: params.limit, offset,
      };
    });
    api.fetchLocations.mockResolvedValue([
      location(1, 'Unsorted', 'other', { is_default: 1 }),
      location(2, 'Red binder'),
      location(3, 'Bulk box', 'box'),
    ]);
    api.fetchCollectionValue.mockResolvedValue({ value: { total_cards: TOTAL, total_value_usd: 1 } });
    api.fetchSets.mockResolvedValue([]);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('pages: says how much is showing, asks for the next offset and appends', async () => {
    renderPage();
    await waitFor(() => expect(tileNames()).toHaveLength(COLLECTION_PAGE), { timeout: 5000 });
    expect(screen.getByText(/Showing 120 of 300 printings/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load 120 more' }));
    await waitFor(() => expect(tileNames()).toHaveLength(240), { timeout: 5000 });
    expect(api.fetchCollection).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 120, limit: 120 }));
    // Appended, not replaced: the first page is still at the top.
    expect(tileNames()[0]).toBe('Card 0001');
    expect(tileNames()[239]).toBe('Card 0240');

    // The last page is short, and then there is nothing more to load.
    fireEvent.click(screen.getByRole('button', { name: 'Load 60 more' }));
    await waitFor(() => expect(tileNames()).toHaveLength(TOTAL), { timeout: 5000 });
    expect(api.fetchCollection).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 240 }));
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
    expect(screen.getByText(/^300 printings/)).toBeInTheDocument();
    // Three renders of up to 300 rows: slow under a parallel run, not wrong.
  }, 20_000);

  it('renames a location through the location client, and the sidebar shows the new name', async () => {
    api.updateLocation.mockResolvedValue([
      location(1, 'Unsorted', 'other', { is_default: 1 }),
      location(2, 'Blue binder'),
      location(3, 'Bulk box', 'box'),
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Red binder' }));
    const form = screen.getByRole('form', { name: 'Edit Red binder' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Location name' }), { target: { value: 'Blue binder' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateLocation).toHaveBeenCalledWith(2, { name: 'Blue binder' }));
    expect(await screen.findByRole('button', { name: /^Blue binder/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Red binder/ })).toBeNull();
  });

  it('groups the sidebar by kind and archives from the editor', async () => {
    api.updateLocation.mockResolvedValue([
      location(1, 'Unsorted', 'other', { is_default: 1 }),
      location(2, 'Red binder', 'binder', { is_archived: 1 }),
      location(3, 'Bulk box', 'box'),
    ]);
    renderPage();
    await screen.findByRole('button', { name: 'Edit Red binder' });
    expect(Array.from(document.querySelectorAll('.loc-kind')).map((h) => h.firstChild?.textContent?.trim()))
      .toEqual(['Binders', 'Boxes', 'Other']);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Red binder' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Archived' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateLocation).toHaveBeenCalledWith(2, { isArchived: true }));
    await waitFor(() => expect(document.querySelector('.loc-archived')?.textContent).toContain('Red binder'));
  });

  it('the default location can be renamed but not archived or deleted', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unsorted' }));
    expect(screen.queryByRole('checkbox', { name: 'Archived' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete…' })).toBeNull();
  });
});
