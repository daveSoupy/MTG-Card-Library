import { useEffect, useState } from 'react';
import type { UndoStack } from '../undo.ts';

/**
 * "Removed Sol Ring · Undo", floated over the page for a few seconds after an
 * undoable action.
 *
 * The only undo a phone has: ⌘Z does not exist there, and the buttons that
 * used to carry it cost more header room than they were worth. Appearing at
 * the moment it is wanted also means it needs no discovering — which a
 * keyboard shortcut very much does.
 *
 * Deliberately only ever the last step. Reaching further back is what the
 * keyboard and the deck builder's buttons are for; a toast that outlived the
 * action it describes would be lying about what pressing it does.
 */
export function UndoToast({ stack, seconds = 7 }: { stack: UndoStack; seconds?: number }) {
  const [shown, setShown] = useState<{ label: string; seq: number } | null>(null);
  const seq = stack.recorded?.seq ?? null;

  useEffect(() => {
    if (!stack.recorded) { setShown(null); return; }
    setShown(stack.recorded);
    const timer = setTimeout(() => setShown(null), seconds * 1000);
    return () => clearTimeout(timer);
    // Keyed on the sequence number, so doing the same thing twice re-shows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq, seconds]);

  if (!shown) return null;

  return (
    <div className="undo-toast" role="status">
      <span className="undo-toast-label">{shown.label}</span>
      <button
        className="undo-toast-action"
        disabled={stack.busy || !stack.canUndo}
        onClick={() => {
          setShown(null);
          // A failed replay has already put its reason on screen.
          stack.undo().catch(() => undefined);
        }}
      >
        Undo
      </button>
      <button className="undo-toast-close" aria-label="Dismiss" onClick={() => setShown(null)}>×</button>
    </div>
  );
}
