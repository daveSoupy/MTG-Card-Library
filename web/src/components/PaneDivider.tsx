import { useRef } from 'react';

const STEP = 16;

/**
 * A draggable divider between two deck-builder panes.
 *
 * Each divider resizes the pane on one side of it (`side`) and lets the deck
 * list — the `1fr` column in the middle — absorb the difference, so the two
 * are independent: dragging one never moves the other. Widths are reported
 * continuously while dragging and committed once on release, which is what
 * gets written to localStorage.
 */
export function PaneDivider({
  label,
  width,
  min,
  max,
  className,
  side = 'right',
  onResize,
  onCommit,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  className?: string;
  /** Which side of the divider the pane it sizes is on. */
  side?: 'left' | 'right';
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);

  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));
  // Dragging towards the pane shrinks it: left for a pane on the right, right
  // for a pane on the left.
  const towards = side === 'right' ? -1 : 1;

  const nudge = (delta: number) => {
    const next = clamp(latest.current + delta);
    latest.current = next;
    onResize(next);
    onCommit(next);
  };

  return (
    <div
      className={`pane-divider${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        start.current = { x: event.clientX, width };
        latest.current = width;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const next = clamp(start.current.width + towards * (event.clientX - start.current.x));
        latest.current = next;
        onResize(next);
      }}
      onPointerUp={(event) => {
        if (!start.current) return;
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(latest.current);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(-towards * STEP); }
        if (event.key === 'ArrowRight') { event.preventDefault(); nudge(towards * STEP); }
      }}
    />
  );
}
