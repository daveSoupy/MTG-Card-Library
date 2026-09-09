import { useCallback, useEffect, useRef, useState } from 'react';

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

export type UndoStack = ReturnType<typeof useUndoStack>;

export function useUndoStack() {
  const [past, setPast] = useState<UndoEntry[]>([]);
  const [future, setFuture] = useState<UndoEntry[]>([]);
  /**
   * The step just recorded, for anything that wants to react to one — the
   * undo toast, which is the only undo a phone has.
   *
   * Carries a sequence number as well as the label so that doing the same
   * thing twice still reads as two events rather than as no change at all.
   */
  const [recorded, setRecorded] = useState<{ label: string; seq: number } | null>(null);
  const seq = useRef(0);
  // A ref rather than the busy flag alone: two fast clicks would otherwise
  // both read the pre-render value and replay the same entry twice.
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  const record = useCallback((entry: UndoEntry) => {
    setPast((stack) => [...stack, entry].slice(-LIMIT));
    setFuture([]);
    seq.current += 1;
    setRecorded({ label: entry.label, seq: seq.current });
  }, []);

  const clear = useCallback(() => { setPast([]); setFuture([]); setRecorded(null); }, []);

  const step = useCallback(async (direction: 'undo' | 'redo') => {
    if (running.current) return;
    const from = direction === 'undo' ? past : future;
    const entry = from[from.length - 1];
    if (!entry) return;

    running.current = true;
    setBusy(true);
    try {
      await entry[direction]();
      // Undoing is not itself something to offer an undo for.
      setRecorded(null);
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
    recorded,
    undo: () => step('undo'),
    redo: () => step('redo'),
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past[past.length - 1]?.label ?? null,
    redoLabel: future[future.length - 1]?.label ?? null,
  };
}

/**
 * ⌘Z / ⌘⇧Z — Ctrl on anything that is not a Mac — for a stack.
 *
 * Bound by whichever page owns the stack, so the shortcut reaches the same
 * one its buttons would and only while that page is open.
 *
 * Keystrokes inside a text field are left alone: the browser's own undo is
 * what someone half-way through typing a location name or a price means, and
 * taking it over to revert a card edit instead would be a nasty surprise.
 */
export function useUndoShortcuts(stack: Pick<UndoStack, 'undo' | 'redo'>): void {
  // The stack is a fresh object every render, so the listener reads it through
  // a ref and binds once rather than re-subscribing on each keystroke's worth
  // of re-rendering.
  const latest = useRef(stack);
  latest.current = stack;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'z' || event.altKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, [contenteditable]')) return;

      event.preventDefault();
      const step = event.shiftKey ? latest.current.redo : latest.current.undo;
      // A failed replay has already put its reason on screen.
      step().catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
