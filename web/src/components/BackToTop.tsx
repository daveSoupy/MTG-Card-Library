import { useEffect, useRef, useState } from 'react';

const SHOW_AFTER = 400;

/**
 * "Back to top" for the page it is rendered inside.
 *
 * Phase 6 moved the list and data pages into independently-scrolling
 * containers, so a `window.scrollTo` handler is a no-op on most of them — the
 * window never scrolled in the first place. Rather than every page passing a
 * ref down, this listens for scrolls in the capture phase (scroll events do
 * not bubble, but they do capture) and reacts to the one container that
 * actually holds it. A page only has to render it inside the thing that
 * scrolls.
 */
function scrollParent(from: HTMLElement | null): HTMLElement | null {
  for (let node = from?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

export function BackToTop({ label = 'Back to top' }: { label?: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const container = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = (event: Event) => {
      const node = event.target instanceof HTMLElement
        ? event.target
        : (document.scrollingElement as HTMLElement | null);
      if (!node || !anchor.current || !node.contains(anchor.current)) return;
      container.current = node;
      setShown(node.scrollTop > SHOW_AFTER);
    };

    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);

  return (
    <span className="back-to-top-anchor" ref={anchor}>
      <button
        type="button"
        className={`back-to-top${shown ? ' shown' : ''}`}
        // Hidden rather than absent, so appearing does not move anything.
        aria-hidden={!shown}
        tabIndex={shown ? 0 : -1}
        title={label}
        aria-label={label}
        onClick={() => {
          const target = container.current ?? scrollParent(anchor.current);
          if (!target) return;
          // Hidden as soon as it is pressed rather than waiting for the scroll
          // to land: it has done its job, and a smooth scroll can outlast the
          // click by half a second.
          setShown(false);
          const from = target.scrollTop;
          target.scrollTo?.({ top: 0, behavior: 'smooth' });
          // Smooth scrolling is a request, not a guarantee — some engines
          // ignore it entirely. If nothing has moved a moment later, jump,
          // so the button is never simply dead.
          window.setTimeout(() => {
            if (target.scrollTop === from && from > 0) target.scrollTop = 0;
          }, 300);
        }}
      >
        ↑
      </button>
    </span>
  );
}
