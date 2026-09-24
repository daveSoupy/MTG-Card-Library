import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { AddBySetTab } from './AddBySetTab.tsx';
import type { StorageLocation } from '../api.ts';

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  fetchSettings: vi.fn().mockRejectedValue(new Error('no settings in this test')),
  fetchOpenCostPool: vi.fn().mockResolvedValue(null),
  fetchSetChecklist: vi.fn(),
  addCollectionLot: vi.fn(),
  decrementCollectionCopy: vi.fn(),
}));
import { addCollectionLot, decrementCollectionCopy, fetchSetChecklist } from '../api.ts';

const location: StorageLocation = {
  id: 1, name: 'Binder A', kind: 'binder', notes: null, is_default: 1,
  is_archived: 0, card_count: 0, distinct_printings: 0, value_usd: 0,
};
const sets = [{ code: 'mkm', name: 'Murders at Karlov Manor' }] as never;
const card = {
  printing_id: 'p1', collector_number: '1', rarity: 'common', price_usd: null, image_small: null,
  oracle_id: 'o1', name: 'Test Card', mana_cost: null, owned_qty: 0,
};

/** A promise the test settles by hand, standing in for a POST that is slow to answer. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function openSet() {
  fireEvent.change(screen.getByPlaceholderText('Search sets…'), { target: { value: 'Murders' } });
  fireEvent.click(await screen.findByText(/Murders at Karlov Manor/));
  await screen.findByText('Test Card');
}

describe('AddBySetTab', () => {
  beforeEach(() => {
    vi.mocked(fetchSetChecklist).mockResolvedValue([card] as never);
    vi.mocked(addCollectionLot).mockReset();
    vi.mocked(decrementCollectionCopy).mockReset();
  });

  it('renders the empty state and toggles "Hide ones I have"', () => {
    render(<AddBySetTab sets={[]} locations={[location]} onChanged={vi.fn()} />);

    expect(screen.getByText(/Pick a set to work through it/)).toBeInTheDocument();

    const checkbox = screen.getByLabelText('Hide ones I have') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it('shows the owned count on the tap, before the server has answered', async () => {
    const post = deferred<{ id: number }>();
    vi.mocked(addCollectionLot).mockReturnValue(post.promise);
    const onChanged = vi.fn();
    render(<AddBySetTab sets={sets} locations={[location]} onChanged={onChanged} />);
    await openSet();

    fireEvent.click(screen.getByTitle(/to add Test Card/));
    // The number and the toast are there while the POST is still in flight…
    expect(screen.getByText('1', { selector: '.tile-owned' })).toBeInTheDocument();
    expect(screen.getByText('Added Test Card')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    // …and stay once it lands; only then does the page refresh.
    await act(async () => post.resolve({ id: 42 }));
    expect(screen.getByText('1', { selector: '.tile-owned' })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addCollectionLot).mock.calls[0][0]).toMatchObject({ printingId: 'p1', locationId: 1, quantity: 1 });
  });

  it('takes the count back and says why when the server refuses', async () => {
    vi.mocked(addCollectionLot).mockRejectedValue(new Error('No such location'));
    const onChanged = vi.fn();
    render(<AddBySetTab sets={sets} locations={[location]} onChanged={onChanged} />);
    await openSet();

    fireEvent.click(screen.getByTitle(/to add Test Card/));
    await screen.findByText('No such location');
    expect(screen.queryByText('1', { selector: '.tile-owned' })).not.toBeInTheDocument();
    expect(screen.getByText('Not added: Test Card')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('picks the default location when the list arrives after the tab has mounted', async () => {
    vi.mocked(addCollectionLot).mockResolvedValue({ id: 7 });
    const { rerender } = render(<AddBySetTab sets={sets} locations={[]} onChanged={vi.fn()} />);
    rerender(<AddBySetTab sets={sets} locations={[location]} onChanged={vi.fn()} />);
    await openSet();

    fireEvent.click(screen.getByTitle(/to add Test Card/));
    await waitFor(() => expect(addCollectionLot).toHaveBeenCalled());
    expect(vi.mocked(addCollectionLot).mock.calls[0][0]).toMatchObject({ locationId: 1 });
  });

  it('offers no digital-only set — a paper collection has nowhere to put its cards', async () => {
    const withDigital = [
      { code: 'mkm', name: 'Murders at Karlov Manor', digital: 0 },
      { code: 'ymkm', name: 'Alchemy: Karlov Manor', digital: 1 },
    ] as never;
    render(<AddBySetTab sets={withDigital} locations={[location]} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Search sets…'), { target: { value: 'Karlov' } });
    expect(await screen.findByText(/Murders at Karlov Manor/)).toBeInTheDocument();
    expect(screen.queryByText(/Alchemy: Karlov Manor/)).not.toBeInTheDocument();
  });

  it('right-click removes one owned copy, the mouse equivalent of a long-press', async () => {
    vi.mocked(fetchSetChecklist).mockResolvedValue([{ ...card, owned_qty: 2 }] as never);
    vi.mocked(decrementCollectionCopy).mockResolvedValue({ removed: true } as never);
    const onChanged = vi.fn();
    render(<AddBySetTab sets={sets} locations={[location]} onChanged={onChanged} />);
    await openSet();

    const tile = screen.getByTitle(/to add Test Card/);
    expect(tile.querySelector('.entry-remove')).toBeInTheDocument();
    fireEvent.contextMenu(tile);
    await waitFor(() => expect(decrementCollectionCopy).toHaveBeenCalled());
    expect(screen.getByText('Removed Test Card')).toBeInTheDocument();
  });

  it('right-clicking an unowned tile removes nothing — there is no copy to take back', async () => {
    render(<AddBySetTab sets={sets} locations={[location]} onChanged={vi.fn()} />);
    await openSet();

    const tile = screen.getByTitle(/to add Test Card/);
    expect(tile.querySelector('.entry-remove')).not.toBeInTheDocument();
    fireEvent.contextMenu(tile);
    expect(decrementCollectionCopy).not.toHaveBeenCalled();
  });
});
