import { HelpPanel } from './HelpPanel.tsx';

/**
 * Phase 17. The one welcome step, shown once the card database exists and the
 * `welcomeSeen` setting is still false — which is right after the first sync,
 * or after "Show the welcome walkthrough again" on the Data page.
 *
 * Deliberately one screen and three links: each lands on a page whose own
 * empty state says what to do next, so nothing here has to be kept in step
 * with the pages as they change. A click-through tour would age separately
 * from the features it documents and rot first.
 */

export type WelcomeDestination = 'browse' | 'collection' | 'decks';

const STOPS: Array<{ to: WelcomeDestination; title: string; blurb: string }> = [
  {
    to: 'browse',
    title: 'Browse',
    blurb: 'Every Magic card, searchable the Scryfall way — t:creature c:rg cmc<=3 — '
      + 'all from the local copy you just downloaded.',
  },
  {
    to: 'collection',
    title: 'Collection',
    blurb: 'The cards you own, by box or binder, with what they are worth and what you paid. '
      + 'Add a set at a time, or import a CSV from wherever you tracked them before.',
  },
  {
    to: 'decks',
    title: 'Decks',
    blurb: 'Build against the whole database, and see which cards you already have, '
      + 'which another deck is holding, and what is left to buy.',
  },
];

export function Welcome({
  onGo,
  onDone,
}: {
  /** Open a page; the welcome dismisses itself as it goes. */
  onGo: (to: WelcomeDestination) => void;
  onDone: () => void;
}) {
  return (
    <HelpPanel
      title="Welcome"
      intro="The card database is in. Three places to start:"
      onClose={onDone}
      className="help-single welcome"
    >
      <div className="welcome-stops">
        {STOPS.map((stop) => (
          <button
            key={stop.to}
            type="button"
            className="welcome-stop"
            onClick={() => { onDone(); onGo(stop.to); }}
          >
            <strong>{stop.title}</strong>
            <span>{stop.blurb}</span>
          </button>
        ))}
      </div>
      <p className="note">
        The <code>?</code> in the top bar lists every help panel, and one sits beside each of
        the denser controls. You can bring this screen back from Data → Settings.
      </p>
    </HelpPanel>
  );
}
