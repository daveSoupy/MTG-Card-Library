import { useSyncExternalStore } from 'react';

/**
 * The card image under the pointer, held outside React's tree.
 *
 * This is the one piece of state in the deck builder that changes on every
 * pointer movement, and it was a `useState` at the top of `DeckBuilder`. Each
 * `onPointerEnter` set a freshly allocated object, so the identity always
 * changed, so every row the mouse crossed committed state at the root and
 * re-rendered `DeckBuilder` → `DeckPanes` → every `DeckTile` and `DeckRow`.
 * Sliding down a 100-card Commander list fired about a hundred full-tree
 * reconciles, and inside each one the deck was regrouped and re-sorted from
 * scratch. On a 2015 laptop or a budget phone that is the difference between a
 * hover preview and a stutter.
 *
 * A store rather than a context: a context value still re-renders every
 * consumer's ancestors down from the provider, which is the thing to avoid.
 * With `useSyncExternalStore` only the components that actually subscribe —
 * the two popups and the stats panel's cover image — re-render, and the list
 * they float over is untouched.
 *
 * Module-level singleton on purpose. There is one pointer and one deck builder
 * mounted at a time, and the alternative (a provider) reintroduces exactly the
 * ancestor re-render this exists to remove. It resets to null on unmount via
 * `clearHoverPreview`, so a remount never inherits a stale card.
 */
export type PickerPreview = {
  oracleId: string;
  printingId: string;
  name: string;
  pinned?: boolean;
  /** Where a hover preview floats. A picker row's sits just left of the
   *  picker, level with the row, and can be clicked; a deck card's sits
   *  beside the mouse as a tooltip. */
  anchor?: { top: number; left: number };
  /** Beside the cursor and click-through: it may overlap the next tile, so
   *  it must never take the pointer. Details are on the tile's own ⓘ. */
  tooltip?: boolean;
};

let current: PickerPreview | null = null;
const listeners = new Set<() => void>();

export function setHoverPreview(next: PickerPreview | null): void {
  // Cheap identity guard. Leaving a row sets null, and a pointer crossing the
  // gap between two rows can set null twice; without this each of those wakes
  // every subscriber for no visible change.
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

/** The value without subscribing — for handlers that only need to read it. */
export function getHoverPreview(): PickerPreview | null {
  return current;
}

export function clearHoverPreview(): void {
  setHoverPreview(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Subscribe to the hovered card. Only call this in a component small enough
 * that re-rendering it on every pointer move is free — that is the whole point.
 */
export function useHoverPreview(): PickerPreview | null {
  // The same function for both snapshots: there is no server render here, and
  // returning a fresh object from either would loop.
  return useSyncExternalStore(subscribe, getHoverPreview, getHoverPreview);
}
