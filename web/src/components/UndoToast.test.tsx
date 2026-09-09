import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { UndoToast } from './UndoToast.tsx';
import { useUndoStack, type UndoEntry } from '../undo.ts';

/** Drives a real stack, so the toast is tested against what it actually gets. */
function Harness({ entry, onUndo }: { entry?: UndoEntry; onUndo?: () => void }) {
  const stack = useUndoStack();
  useEffect(() => {
    if (entry) stack.record(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);
  return (
    <>
      <button onClick={() => stack.record({
        label: 'Removed Sol Ring',
        undo: async () => { onUndo?.(); },
        redo: async () => {},
      })}>remove</button>
      <UndoToast stack={stack} seconds={0.2} />
    </>
  );
}

describe('UndoToast', () => {
  it('says nothing until something undoable happens', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('names the step and offers to reverse it', async () => {
    const onUndo = vi.fn();
    render(<Harness onUndo={onUndo} />);
    fireEvent.click(screen.getByText('remove'));

    expect(screen.getByText('Removed Sol Ring')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })); });
    expect(onUndo).toHaveBeenCalled();
    // Gone once used: pressing it twice must not replay a step already reversed.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('gets out of the way on its own', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      fireEvent.click(screen.getByText('remove'));
      expect(screen.getByText('Removed Sol Ring')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.queryByText('Removed Sol Ring')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('can be dismissed without undoing', () => {
    const onUndo = vi.fn();
    render(<Harness onUndo={onUndo} />);
    fireEvent.click(screen.getByText('remove'));
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('reappears for the same action done twice', () => {
    // Keyed on a sequence number rather than the label, so two identical
    // removals read as two events instead of as no change at all.
    render(<Harness />);
    fireEvent.click(screen.getByText('remove'));
    fireEvent.click(screen.getByLabelText('Dismiss'));
    fireEvent.click(screen.getByText('remove'));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });
});
