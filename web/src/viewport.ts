import { useEffect, useState } from 'react';

/**
 * Whether the window is at or below a breakpoint, kept in step with resizes.
 *
 * Deliberately window.innerWidth rather than matchMedia: the breakpoints here
 * mirror ones in styles.css, and reading the same number both places keeps a
 * layout that CSS has already switched from disagreeing with the component
 * deciding whether to render an overlay.
 */
/**
 * Whether this is a touch screen — a pointer that cannot hover.
 *
 * Not a width test: a tablet at desktop width still has no hover, and that is
 * exactly what makes Lined-up's mostly-covered tiles unreadable there. Guarded
 * because matchMedia is absent in jsdom unless a test stubs it.
 */
export function useCoarsePointer(): boolean {
  const query = () => typeof window.matchMedia === 'function'
    && window.matchMedia('(hover: none)').matches;
  const [coarse, setCoarse] = useState(query);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(hover: none)');
    const onChange = () => setCoarse(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return coarse;
}

export function useNarrow(maxWidth: number): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= maxWidth);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= maxWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [maxWidth]);

  return narrow;
}
