import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeckStatusPill } from './DeckStatusPill.tsx';

// jsdom lays nothing out: every rect is zeros unless a test says otherwise.
// The pill decides its popover edge from its rect against its row's, so a
// test that cares about the edge draws the geometry itself.
function placePill(rowLeft: number, rowWidth: number, pillLeft: number, pillWidth = 60) {
  const pill = document.querySelector('.status-pill-wrap') as HTMLElement;
  const row = pill.parentElement as HTMLElement;
  const rect = (left: number, width: number) => ({
    left, width, right: left + width, top: 0, bottom: 20, height: 20, x: left, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(rowLeft, rowWidth));
  vi.spyOn(pill, 'getBoundingClientRect').mockReturnValue(rect(pillLeft, pillWidth));
}

const menu = () => screen.queryByRole('listbox', { name: 'Deck status' });
const backdrop = () => document.querySelector('.status-sheet-backdrop');

describe('DeckStatusPill', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens a plain popover on a desktop, hung from whichever edge keeps it in the row', () => {
    window.innerWidth = 1400;
    render(<div><DeckStatusPill status="brew" onChange={() => {}} /></div>);
    placePill(0, 1000, 900);

    fireEvent.click(screen.getByRole('button', { name: 'Brew' }));
    expect(menu()).not.toBeNull();
    expect(backdrop()).toBeNull();
    expect(menu()!.getAttribute('data-align')).toBe('right');
    expect(screen.getAllByRole('option')).toHaveLength(4);

    // Clicking anywhere else closes it — the wrapper's outside-click path.
    fireEvent.mouseDown(document.body);
    expect(menu()).toBeNull();

    placePill(0, 1000, 100);
    fireEvent.click(screen.getByRole('button', { name: 'Brew' }));
    expect(menu()!.getAttribute('data-align')).toBe('left');
  });

  it('is a bottom sheet with a Done button on a phone, and the backdrop closes it', () => {
    window.innerWidth = 390;
    const onChange = vi.fn();
    render(<DeckStatusPill status="brew" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Brew' }));
    expect(backdrop()).not.toBeNull();
    // The same listbox and options as the desktop popover, so keyboard and
    // screen-reader behaviour is unchanged by the layout.
    expect(menu()).not.toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.getByRole('option', { name: /Brew/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(backdrop()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Brew' }));
    // A tap inside the sheet (not on an option) stays open; one on the
    // backdrop closes it.
    fireEvent.click(screen.getByText('Deck status', { selector: '.count' }));
    expect(backdrop()).not.toBeNull();
    fireEvent.click(backdrop()!);
    expect(backdrop()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a chosen status and closes, in either layout', () => {
    for (const width of [390, 1400]) {
      window.innerWidth = width;
      const onChange = vi.fn();
      const { unmount } = render(<DeckStatusPill status="brew" onChange={onChange} />);

      fireEvent.click(screen.getByRole('button', { name: 'Brew' }));
      fireEvent.click(screen.getByRole('option', { name: /Building/ }));
      expect(onChange).toHaveBeenCalledWith('building');
      expect(menu()).toBeNull();

      // Re-choosing the current status is a no-op rather than a spurious save.
      fireEvent.click(screen.getByRole('button', { name: 'Brew' }));
      fireEvent.click(screen.getByRole('option', { name: /^Brew/ }));
      expect(onChange).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('closes on Escape and does nothing while disabled', () => {
    window.innerWidth = 1400;
    const { rerender } = render(<DeckStatusPill status="assembled" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Assembled' }));
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(menu()).toBeNull();

    rerender(<DeckStatusPill status="assembled" onChange={() => {}} disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Assembled' }));
    expect(menu()).toBeNull();
  });
});
