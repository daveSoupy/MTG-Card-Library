import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { HelpPanel } from './HelpPanel.tsx';
import { HelpButton, HELP_TOPICS } from './helpTopics.tsx';

/**
 * The shell's three exits and its independence from whatever it opened over.
 */

/** A stand-in for the import dialogs: an overlay that closes on Escape the way they do. */
function DialogWithHelp({ onDialogClose }: { onDialogClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDialogClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDialogClose]);
  return (
    <div className="sync-overlay" role="dialog" aria-label="Import a decklist">
      <p>hint <HelpButton topic="importFormats" /></p>
    </div>
  );
}

describe('HelpPanel', () => {
  it('closes on Escape, on the backdrop, and on Close — but not on a click inside', () => {
    const onClose = vi.fn();
    render(<HelpPanel title="Topic" sections={[{ title: 'A', body: <p>inside</p> }]} onClose={onClose} />);

    fireEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector('.help-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('renders both section shapes: syntax rows and prose', () => {
    render(
      <HelpPanel
        title="Mixed"
        intro="One line."
        sections={[
          { title: 'Rows', entries: [{ syntax: 'c:rg', meaning: 'both colours' }] },
          { title: 'Prose', body: <p>Some words.</p> },
        ]}
        onClose={() => {}}
      />,
    );
    const panel = screen.getByRole('dialog', { name: 'Mixed' });
    expect(within(panel).getByText('One line.')).toBeInTheDocument();
    expect(within(panel).getByText('c:rg').tagName).toBe('CODE');
    expect(within(panel).getByText('both colours')).toBeInTheDocument();
    expect(within(panel).getByText('Some words.')).toBeInTheDocument();
  });

  it('Escape over a dialog closes only the help panel, and the dialog stays', () => {
    const onDialogClose = vi.fn();
    render(<DialogWithHelp onDialogClose={onDialogClose} />);

    fireEvent.click(screen.getByRole('button', { name: `Help: ${HELP_TOPICS.importFormats.title}` }));
    const panel = screen.getByRole('dialog', { name: HELP_TOPICS.importFormats.title });
    expect(within(panel).getByText('4x Lightning Bolt')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: HELP_TOPICS.importFormats.title })).toBeNull();
    expect(onDialogClose).not.toHaveBeenCalled();

    // With no panel open, Escape reaches the dialog as before.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDialogClose).toHaveBeenCalledTimes(1);
  });

  it('each ? owns its own panel: opening and closing one leaves the others untouched', () => {
    function Two() {
      const [n, setN] = useState(0);
      return (
        <div>
          <HelpButton topic="allocation" />
          <HelpButton topic="costPools" />
          <button onClick={() => setN(n + 1)}>rerender {n}</button>
        </div>
      );
    }
    render(<Two />);
    const open = (topic: 'allocation' | 'costPools') =>
      fireEvent.click(screen.getByRole('button', { name: `Help: ${HELP_TOPICS[topic].title}` }));
    const dialog = (topic: 'allocation' | 'costPools') =>
      screen.queryByRole('dialog', { name: HELP_TOPICS[topic].title });

    open('allocation');
    expect(dialog('allocation')).not.toBeNull();
    expect(dialog('costPools')).toBeNull();
    fireEvent.click(within(dialog('allocation')!).getByRole('button', { name: 'Close' }));
    expect(dialog('allocation')).toBeNull();

    open('costPools');
    expect(dialog('costPools')).not.toBeNull();
    expect(dialog('allocation')).toBeNull();
    fireEvent.click(screen.getByText(/rerender/));
    expect(dialog('costPools')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.help-overlay')).toBeNull();
  });
});
