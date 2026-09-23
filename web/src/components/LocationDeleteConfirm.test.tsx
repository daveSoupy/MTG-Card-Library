import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { StorageLocation } from '../api.ts';

const api = vi.hoisted(() => ({
  fetchLocationImpact: vi.fn(),
  deleteLocation: vi.fn(),
}));
vi.mock('../api.ts', () => api);

import { LocationDeleteConfirm } from './LocationDeleteConfirm.tsx';

const loc = (id: number, name: string, extra: Partial<StorageLocation> = {}): StorageLocation => ({
  id, name, kind: 'binder', notes: null, is_default: 0, is_archived: 0,
  card_count: 0, distinct_printings: 0, value_usd: 0, ...extra,
});
const BINDER = loc(7, 'Binder 2', { card_count: 1270 });
const LOCATIONS = [loc(1, 'Binder 1'), loc(2, 'Unsorted', { is_default: 1 }), BINDER];

describe('LocationDeleteConfirm', () => {
  beforeEach(() => {
    api.fetchLocationImpact.mockReset().mockResolvedValue({
      cards: 1270, lots: 861, homeOf: [{ id: 3, name: 'Atraxa' }],
    });
    api.deleteLocation.mockReset().mockResolvedValue({ locations: [], restore: {} });
  });

  it('names the count, the destination and the deck, and sends nothing until confirmed', async () => {
    const onDeleted = vi.fn();
    await act(async () => {
      render(<LocationDeleteConfirm location={BINDER} locations={LOCATIONS}
        onCancel={() => {}} onBusy={() => {}} onDeleted={onDeleted} />);
    });
    expect(screen.getByText(/1,270 cards \(861 lots\) move to/)).toBeInTheDocument();
    // The default location, not the first alphabetically.
    expect(screen.getByLabelText('Move its cards to')).toHaveValue('2');
    expect(screen.getByText(/Atraxa loses its home location/)).toBeInTheDocument();
    expect(api.deleteLocation).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Move its cards to'), { target: { value: '1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    expect(api.deleteLocation).toHaveBeenCalledWith(7, 1);
    expect(onDeleted).toHaveBeenCalled();
  });

  it('cancelling sends nothing', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      render(<LocationDeleteConfirm location={BINDER} locations={LOCATIONS}
        onCancel={onCancel} onBusy={() => {}} onDeleted={() => {}} />);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(api.deleteLocation).not.toHaveBeenCalled();
  });
});
