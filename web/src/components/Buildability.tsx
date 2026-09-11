import type { DeckBuildability } from '../api.ts';
import { money, percent, summarySegments } from '../buildability.ts';

/**
 * The two ways buildability shows up: a bar on a deck-list row, and a strip in
 * the deck header.
 *
 * Both render server-computed numbers and derive nothing. The bar is the
 * anti-buying mechanism the phase is really about — a deck reading "94% · 6
 * missing · $23" is a deck you finish this week instead of starting a fourth
 * one.
 */

/** How close to done a deck is, as a colour. */
function tone(pct: number): 'done' | 'close' | 'far' {
  if (pct >= 1) return 'done';
  return pct >= 0.9 ? 'close' : 'far';
}

export function BuildabilityBar({ figures }: { figures: DeckBuildability | null | undefined }) {
  if (!figures) return null;

  if (figures.buildablePct === null) {
    // An empty deck is not a finished one, so it gets no bar to misread.
    return <div className="deck-build empty">Empty — nothing to count yet</div>;
  }

  const pct = figures.buildablePct;
  const unpriced = figures.unpricedCount > 0 ? ` + ${figures.unpricedCount} unpriced` : '';

  return (
    <div
      className="deck-build"
      title={`${figures.coveredCards} of ${figures.requiredCards} cards covered.`}
    >
      <div className="build-bar" data-tone={tone(pct)}>
        <span style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
      <div className="build-figures">
        <strong>{percent(pct)}</strong>
        {figures.missingCards > 0 ? (
          <>
            <span>{figures.missingCards} missing</span>
            <span>{money(figures.costToCompleteUsd)}{unpriced}</span>
          </>
        ) : (
          <span className="good">ready to build</span>
        )}
        {figures.contestedCount > 0 && (
          <span
            className="tag warn"
            title="Another built deck is holding copies of these."
          >
            {figures.contestedCount} contested
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * `94% • 6 missing • $23 • 2 contested` for the deck header.
 *
 * The missing and cost segments go to the missing-card list; contested goes
 * to Phase 26's contention screen, which is where the fight can actually be
 * settled.
 */
export function BuildabilityStrip({
  figures,
  onShowMissing,
  onShowContention,
}: {
  figures: DeckBuildability | null | undefined;
  onShowMissing: () => void;
  onShowContention?: () => void;
}) {
  if (!figures) return null;

  return (
    <span className="build-strip">
      {summarySegments(figures).map((segment) => (
        segment.actionable && (segment.key !== 'contested' || onShowContention) ? (
          <button
            key={segment.key}
            className="build-seg linkish"
            title={segment.title}
            onClick={segment.key === 'contested' ? onShowContention : onShowMissing}
          >
            {segment.text}
          </button>
        ) : (
          <span key={segment.key} className="build-seg" title={segment.title}>
            {segment.text}
          </span>
        )
      ))}
    </span>
  );
}
