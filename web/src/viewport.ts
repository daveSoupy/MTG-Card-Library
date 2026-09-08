import { useEffect, useState } from 'react';

/**
 * Whether the window is at or below a breakpoint, kept in step with resizes.
 *
 * Deliberately window.innerWidth rather than matchMedia: the breakpoints here
 * mirror ones in styles.css, and reading the same number both places keeps a
 * layout that CSS has already switched from disagreeing with the component
 * deciding whether to render an overlay.
 */
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
