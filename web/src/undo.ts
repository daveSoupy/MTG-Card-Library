import { useCallback, useRef, useState } from 'react';

/**
 * A per-context undo/redo stack.
 *
 * Each entry is a pair of thunks rather than a piece of state: everything this
 * app edits is autosaved server-side, so going back a step means issuing the
 * calls that reverse it, not restoring a local copy. What "reverse" means is
 * the caller's business — the deck builder replays a snapshot, the collection
 * sends the inverse of one lot edit.
 *
 * The stack is per open context (one deck, one collection session) and lives
 * only as long as that context is open.
 */
export interface UndoEntry {
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}

const LIMIT = 50;

export function useUndoStack() {
  const [past, setPast] = useState<UndoEntry[]>([]);
  const [future, setFuture] = useState<UndoEntry[]>([]);
  // A ref rather than the busy flag alone: two fast clicks would otherwise
  // both read the pre-render value and replay the same entry twice.
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  const record = useCallback((entry: UndoEntry) => {
    setPast((stack) => [...stack, entry].slice(-LIMIT));
    setFuture([]);
  }, []);

  const clear = useCallback(() => { setPast([]); setFuture([]); }, []);

  const step = useCallback(async (direction: 'undo' | 'redo') => {
    if (running.current) return;
    const from = direction === 'undo' ? past : future;
    const entry = from[from.length - 1];
    if (!entry) return;

    running.current = true;
    setBusy(true);
    try {
      await entry[direction]();
      // Only on success: a failed replay leaves the stack where it was, so the
      // same step can be retried once whatever blocked it is dealt with.
      if (direction === 'undo') {
        setPast((stack) => stack.slice(0, -1));
        setFuture((stack) => [...stack, entry]);
      } else {
        setFuture((stack) => stack.slice(0, -1));
        setPast((stack) => [...stack, entry]);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [past, future]);

  return {
    record,
    clear,
    busy,
    undo: () => step('undo'),
    redo: () => step('redo'),
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past[past.length - 1]?.label ?? null,
    redoLabel: future[future.length - 1]?.label ?? null,
  };
}
