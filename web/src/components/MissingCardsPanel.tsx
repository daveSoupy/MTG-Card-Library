import { useEffect, useState } from 'react';
import { pushMissingToWantList, type BuildabilityDetail, type BuildabilityRow } from '../api.ts';
import { money, missingRows } from '../buildability.ts';

/**
 * What this deck is short of, and who has the rest.
 *
 * Distinct from the shopping list beside it, and deliberately so. The shopping
 * list shows the copies you *marked* as "need to buy"; this shows the copies
 * your collection cannot actually supply — including cards you own that another
 * built deck is holding. The second number is the one that decides whether you
 * buy anything this week, and it is the one you cannot get by looking at a
 * single deck slot.
 */
export function MissingCardsPanel({
  detail,
  onClose,
  onSwap,
  swappable,
}: {
  detail: BuildabilityDetail;
  onClose: () => void;
  /** Phase 27: "Swap for something I own" on a missing card. */
  onSwap?: (row: BuildabilityRow) => void;
  /** Rows the swap is offered on; default all. The deck builder says no for a commander. */
  swappable?: (row: BuildabilityRow) => boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = missingRows(detail.rows);
  const { summary } = detail;

  const push = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await pushMissingToWantList(detail.deckId);
      const total = result.added + result.updated;
      setPushed(`${total} card${total === 1 ? '' : 's'} on "${result.listName}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="playtest-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>Missing from {detail.deckName}</h2>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}
        {pushed && <div className="verdict ok">Added {pushed}</div>}

        {rows.length === 0 && (
          <p className="empty">
            {summary.buildablePct === null
              ? 'This deck has no cards in it yet.'
              : 'Nothing missing — every card here is covered by copies you own or proxied.'}
          </p>
        )}

        {rows.length > 0 && (
          <>
            <div className="playtest-summary">
              <span><strong>{summary.missingCards}</strong> cards missing</span>
              <span>about <strong>{money(summary.costToCompleteUsd)}</strong> to finish</span>
              {/* Never folded into the total: an unknown price rounded to zero
                  is how a deck that reads "$0 to finish" costs $80. */}
              {summary.unpricedCount > 0 && (
                <span className="tag warn">{summary.unpricedCount} unpriced</span>
              )}
              {summary.contestedCount > 0 && (
                <span className="tag warn">{summary.contestedCount} held by other decks</span>
              )}
            </div>

            <div className="shopping-rows">
              {rows.map((row) => (
                <div className="missing-row" key={row.oracleId}>
                  <div className="shopping-name">
                    <span>{row.missing}× {row.name}</span>
                    {/* Where the rest live — because "you need this" on a card
                        sitting in your own binder reads as a bug otherwise. */}
                    {row.holdingDecks.length > 0 && (
                      <span className="dim">
                        held by {row.holdingDecks
                          .map((deck) => `${deck.deckName} ×${deck.quantity}`)
                          .join(', ')}
                      </span>
                    )}
                    {row.holdingDecks.length === 0 && row.tradeListed > 0 && (
                      <span className="dim">{row.tradeListed} on a trade list</span>
                    )}
                  </div>
                  <span className="shopping-price">
                    {row.extendedUsd == null
                      ? <span className="tag warn">no price</span>
                      : money(row.extendedUsd)}
                  </span>
                  {/* The alternative to buying: something you already own
                      that does the same job. Never automatic. */}
                  {onSwap && (swappable?.(row) ?? true) && (
                    <button
                      className="btn secondary small"
                      onClick={() => onSwap(row)}
                      title="Cards you own that could fill this slot"
                    >
                      Swap
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="deck-card-actions" style={{ marginTop: 14 }}>
              <button className="btn" onClick={push} disabled={busy}>
                {busy ? 'Adding…' : 'Add all to want list'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
