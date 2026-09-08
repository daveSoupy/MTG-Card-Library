import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaneDivider } from './PaneDivider.tsx';
import { DEFAULT_PANE_WIDTHS, loadPaneWidths, savePaneWidth } from '../deckView.ts';

describe('PaneDivider', () => {
  it('reports a drag continuously and commits once on release', () => {
    const onResize = vi.fn();
    const onCommit = vi.fn();
    render(
      <PaneDivider
        label="Card picker width" width={300} min={220} max={640}
        onResize={onResize} onCommit={onCommit}
      />,
    );

    const divider = screen.getByRole('separator', { name: 'Card picker width' });
    divider.setPointerCapture = () => {};
    divider.releasePointerCapture = () => {};

    fireEvent.pointerDown(divider, { clientX: 900, pointerId: 1 });
    fireEvent.pointerMove(divider, { clientX: 860, pointerId: 1 });
    // Dragging left widens the pane on the right.
    expect(onResize).toHaveBeenLastCalledWith(340);
    fireEvent.pointerMove(divider, { clientX: 500, pointerId: 1 });
    // Clamped at the maximum rather than swallowing the deck list.
    expect(onResize).toHaveBeenLastCalledWith(640);

    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(divider, { clientX: 500, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(640);
  });

  it('persists each pane width independently of the other', () => {
    localStorage.clear();
    expect(loadPaneWidths()).toEqual(DEFAULT_PANE_WIDTHS);

    savePaneWidth('picker', 420);
    expect(loadPaneWidths()).toEqual({ picker: 420, stats: DEFAULT_PANE_WIDTHS.stats });

    savePaneWidth('stats', 240);
    expect(loadPaneWidths()).toEqual({ picker: 420, stats: 240 });

    // A width stored from a wider screen still lands inside the allowed range.
    localStorage.setItem('mtg.deck.pickerWidth', '4000');
    expect(loadPaneWidths().picker).toBe(640);
  });
});
