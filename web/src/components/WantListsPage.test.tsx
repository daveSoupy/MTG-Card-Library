import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WantListsPage } from './WantListsPage.tsx';
import type { WantList, WantListItem } from '../api.ts';

const item = (id: number, name: string, status: 'active' | 'fulfilled' = 'active'): WantListItem => ({
  id, oracleId: `O${id}`, name, manaCost: null, colorIdentity: '', quantity: 1,
  targetPriceUsd: null, priority: 0, status, notes: null, priceUsd: 1,
  printingId: null, imageSmall: null, ownedQuantity: 0, neededFor: [],
});

// A fulfilled row that sorts *before* the active ones — the shape that made
// the arrow keys swap the wrong pair when the index was taken from one array
// and applied to the other.
const list: WantList = {
  id: 7, name: 'Wants',
  items: [item(1, 'Fulfilled One', 'fulfilled'), item(2, 'Alpha'), item(3, 'Beta'), item(4, 'Gamma')],
};

const api = vi.hoisted(() => ({
  fetchWantLists: vi.fn(),
  fetchWantList: vi.fn(),
  reorderWantItems: vi.fn(),
}));

vi.mock('../api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.ts')>()),
  fetchWantLists: api.fetchWantLists,
  fetchWantList: api.fetchWantList,
  reorderWantItems: api.reorderWantItems,
}));

async function renderPage() {
  render(
    <WantListsPage
      page="wants" density="full" onDensity={() => {}}
      densityOverridden={false} onResetDensity={() => {}}
    />,
  );
  await screen.findByRole('button', { name: /Reorder Alpha/ });
}

const handleFor = (name: string) => screen.getByRole('button', { name: new RegExp(`Reorder ${name}`) });
const rowOrder = () => Array.from(document.querySelectorAll('.want-rows .want-row .want-name'))
  .map((el) => el.textContent);

/** jsdom lays nothing out, so offsetHeight is 0 and the 52px fallback (+4 gap) applies. */
const ROW = 56;

// jsdom does not make pointer events bubble by default; real ones do.
const pointer = (type: string, init: PointerEventInit) => new PointerEvent(type, { bubbles: true, ...init });

describe('WantListsPage reorder', () => {
  beforeEach(() => {
    api.fetchWantLists.mockResolvedValue([{ id: 7, name: 'Wants', is_default: 1, active_count: 3 }]);
    api.fetchWantList.mockResolvedValue(list);
    api.reorderWantItems.mockImplementation(async (_id: number, ids: number[]) => ({
      ...list, items: ids.map((id) => list.items.find((i) => i.id === id)!),
    }));
  });
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

  it('arrow keys swap by position among the active rows and send the whole list', async () => {
    await renderPage();
    fireEvent.keyDown(handleFor('Alpha'), { key: 'ArrowDown' });
    // Alpha and Beta swap; the fulfilled row is neither moved nor forgotten.
    expect(api.reorderWantItems).toHaveBeenCalledWith(7, [3, 2, 4, 1]);
    await waitFor(() => expect(rowOrder()).toEqual(['Beta', 'Alpha', 'Gamma']));
  });

  it('a mouse drag persists even though pointerup lands off the handle', async () => {
    await renderPage();
    const handle = handleFor('Alpha');
    fireEvent(handle, pointer('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 100 }));
    expect(document.querySelector('.want-row.dragging')).not.toBeNull();

    // Two rows down. The row has moved in the DOM by now, so the rest of the
    // gesture reaches the window from wherever the pointer happens to be.
    act(() => { document.body.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 10, clientY: 100 + ROW })); });
    act(() => { document.body.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 10, clientY: 100 + 2 * ROW })); });
    expect(rowOrder()).toEqual(['Beta', 'Gamma', 'Alpha']);
    act(() => { document.body.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 10, clientY: 100 + 2 * ROW })); });

    expect(api.reorderWantItems).toHaveBeenCalledWith(7, [3, 4, 2, 1]);
    expect(document.querySelector('.want-row.dragging')).toBeNull();
    await waitFor(() => expect(rowOrder()).toEqual(['Beta', 'Gamma', 'Alpha']));
  });

  it('a pointerup before React has drawn the last move still commits the latest position', async () => {
    await renderPage();
    fireEvent(handleFor('Alpha'), pointer('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 100 }));
    // Move and release in one go, with no render in between.
    act(() => {
      document.body.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 10, clientY: 100 + ROW }));
      document.body.dispatchEvent(pointer('pointerup', { pointerId: 1, clientX: 10, clientY: 100 + ROW }));
    });
    expect(api.reorderWantItems).toHaveBeenCalledWith(7, [3, 2, 4, 1]);
  });

  it('a touch drags after the long press, and scrolls if it moves first', async () => {
    await renderPage();
    // After the load: testing-library's findBy polling does not see vitest's
    // fake clock, but the long-press timer is set at pointerdown and does.
    vi.useFakeTimers();
    const handle = handleFor('Alpha');

    // Moved before the hold registered: a scroll, no lift, nothing sent.
    fireEvent(handle, pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 10, clientY: 100 }));
    act(() => { document.body.dispatchEvent(pointer('pointermove', { pointerId: 2, clientX: 10, clientY: 130 })); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(document.querySelector('.want-row.dragging')).toBeNull();
    act(() => { document.body.dispatchEvent(pointer('pointerup', { pointerId: 2, clientX: 10, clientY: 130 })); });
    expect(api.reorderWantItems).not.toHaveBeenCalled();

    // Held still for the long press, then dragged one row down.
    fireEvent(handle, pointer('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 100 }));
    expect(document.querySelector('.want-row.dragging')).toBeNull();
    act(() => { vi.advanceTimersByTime(300); });
    expect(document.querySelector('.want-row.dragging')).not.toBeNull();
    act(() => { document.body.dispatchEvent(pointer('pointermove', { pointerId: 3, clientX: 10, clientY: 100 + ROW })); });
    act(() => { document.body.dispatchEvent(pointer('pointerup', { pointerId: 3, clientX: 10, clientY: 100 + ROW })); });
    expect(api.reorderWantItems).toHaveBeenCalledWith(7, [3, 2, 4, 1]);
    expect(document.querySelector('.want-row.dragging')).toBeNull();
  });

  it('a cancelled drag sends nothing and drops the row back', async () => {
    await renderPage();
    fireEvent(handleFor('Alpha'), pointer('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 100 }));
    act(() => { document.body.dispatchEvent(pointer('pointermove', { pointerId: 1, clientX: 10, clientY: 100 + ROW })); });
    act(() => { document.body.dispatchEvent(pointer('pointercancel', { pointerId: 1 })); });
    expect(api.reorderWantItems).not.toHaveBeenCalled();
    expect(document.querySelector('.want-row.dragging')).toBeNull();
    expect(rowOrder()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});
