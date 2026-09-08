import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BackToTop } from './BackToTop.tsx';

/** A page that scrolls inside its own container, the way every list page has
 *  since Phase 6 — the case a window.scrollTo handler does nothing for. */
function scrollingPage() {
  const view = render(
    <div className="results" style={{ overflowY: 'auto' }} data-testid="scroller">
      <p>content</p>
      <BackToTop />
    </div>,
  );
  return { view, container: screen.getByTestId('scroller') };
}

describe('BackToTop', () => {
  it('appears once its own container has scrolled, and scrolls that container', () => {
    const { container } = scrollingPage();
    // aria-hidden while it is out of sight, so it is found by title.
    const button = screen.getByTitle('Back to top');
    expect(button.className).not.toContain('shown');

    container.scrollTop = 900;
    act(() => { fireEvent.scroll(container); });
    expect(button.className).toContain('shown');

    let scrolledTo: unknown = null;
    container.scrollTo = ((options: ScrollToOptions) => { scrolledTo = options; }) as typeof container.scrollTo;
    fireEvent.click(button);
    expect(scrolledTo).toEqual({ top: 0, behavior: 'smooth' });
  });

  it('ignores scrolling in a container it does not live in', () => {
    render(<div style={{ overflowY: 'auto' }} data-testid="other"><p>elsewhere</p></div>);
    const { container } = scrollingPage();
    // aria-hidden while it is out of sight, so it is found by title.
    const button = screen.getByTitle('Back to top');

    const other = screen.getByTestId('other');
    other.scrollTop = 900;
    act(() => { fireEvent.scroll(other); });
    expect(button.className).not.toContain('shown');

    container.scrollTop = 900;
    act(() => { fireEvent.scroll(container); });
    expect(button.className).toContain('shown');
  });

  it('still reaches the top when the engine ignores smooth scrolling', async () => {
    const { container } = scrollingPage();
    const button = screen.getByTitle('Back to top');
    container.scrollTop = 900;
    act(() => { fireEvent.scroll(container); });

    // No scrollTo at all (jsdom, and some embedded engines silently drop a
    // smooth request) — the control must not be a dead button.
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(container.scrollTop).toBe(0);
  });
});
