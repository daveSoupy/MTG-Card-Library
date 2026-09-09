import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useUndoShortcuts } from './undo.ts';

function Probe({ undo, redo }: { undo: () => Promise<void>; redo: () => Promise<void> }) {
  useUndoShortcuts({ undo, redo });
  return (
    <div>
      <input aria-label="a text field" />
      <button>somewhere else</button>
    </div>
  );
}

function probe() {
  const undo = vi.fn(async () => {});
  const redo = vi.fn(async () => {});
  const view = render(<Probe undo={undo} redo={redo} />);
  return { ...view, undo, redo };
}

describe('useUndoShortcuts', () => {
  it('undoes on the platform modifier plus Z', () => {
    const { undo, redo } = probe();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    // Ctrl for anything that is not a Mac.
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(2);
    expect(redo).not.toHaveBeenCalled();
  });

  it('redoes when Shift is held', () => {
    const { undo, redo } = probe();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    expect(redo).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });

  it('takes Z whatever case the key arrives in', () => {
    // Shift+Z reports as 'Z' on most layouts.
    const { redo } = probe();
    fireEvent.keyDown(document.body, { key: 'Z', metaKey: true, shiftKey: true });
    expect(redo).toHaveBeenCalled();
  });

  it('leaves a text field to the browser own undo', () => {
    // Someone half-way through typing a location name means the field, not
    // a card edit three steps back.
    const { undo, redo, getByLabelText } = probe();
    fireEvent.keyDown(getByLabelText('a text field'), { key: 'z', metaKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
  });

  it('ignores the key on its own, and with Alt held', () => {
    const { undo } = probe();
    fireEvent.keyDown(document.body, { key: 'z' });
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, altKey: true });
    expect(undo).not.toHaveBeenCalled();
  });

  it('stops listening once the page owning the stack is gone', () => {
    const { undo, unmount } = probe();
    unmount();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(undo).not.toHaveBeenCalled();
  });
});
