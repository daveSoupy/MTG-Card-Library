import { useEffect, useState } from 'react';
import { pushMissingToWantList, type BuildabilityDetail, type BuildabilityRow } from '../api.ts';
import { missingGroups, money, shortfallLine } from '../buildability.ts';

/**
 * What this deck is short of, what to do about each card, and what it costs.
 *
 * The one list. There used to be two — this one (with Swap) and a shopping
 * list beside it (with Want) — near-duplicates that counted and priced
 * differently: "9 missing" beside "Shopping list (7)", Craterhoof at $21.49 in
 * one and $28.33 in the other. Both now read Phase 24's coverage, so the count,
 * the prices and the total here are the deck header's, card for card.
 *
 * Grouped by what you would do: buy it, win it back from the deck holding it,
 * or take it off a trade list. The groups divide one count; they never re-count.
 */
export function MissingCardsPanel({
  detail,
  onClose,
  onSwap,
  swappable,
  onReassign,
}: {
  detail: BuildabilityDetail;
  onClose: () => void;
  /** Phase 27: "Swap for something I own" on a missing card. */
  onSwap?: (row: BuildabilityRow) => void;
  /** Rows the swap is offered on; default all. The deck builder says no for a commander. */
  swappable?: (row: BuildabilityRow) => boolean;
  /** Opens the contention screen, for a card two built decks are after. */
  onReassign?: (row: BuildabilityRow) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = missingGroups(detail.rows);
  const { summary } = detail;

  const push = async (oracleIds?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await pushMissingToWantList(detail.deckId, { oracleIds });
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

        {groups.length === 0 && (
          <p className="empty">
            {summary.buildablePct === null
              ? 'This deck has no cards in it yet.'
              : 'Nothing missing — every card here is covered by copies you own or proxied.'}
          </p>
        )}

        {groups.length > 0 && (
          <>
            <div className="playtest-summary">
              <span><strong>{summary.missingCards}</strong> cards missing</span>
              <span>about <strong>{money(summary.costToCompleteUsd)}</strong> to finish</span>
              {/* Never folded into the total: an unknown price rounded to zero
                  is how a deck that reads "$0 to finish" costs $80. */}
              {summary.unpricedCount > 0 && (
                <span className="tag warn">{summary.unpricedCount} unpriced</span>
              )}
            </div>

            {groups.map((group) => (
              <section className="missing-group" key={group.key}>
                <h3>{group.title} <span className="dim">{group.rows.length}</span></h3>
                <div className="shopping-rows">
                  {group.rows.map((row) => (
                    <div className="missing-row" key={row.oracleId}>
                      <div className="shopping-name">
                        <span>{row.missing}× {row.name}</span>
                        {/* Where the rest are — because "you need this" on a
                            card sitting in your own binder reads as a bug. */}
                        <span className="dim">{shortfallLine(row)}</span>
                      </div>
                      <span className="shopping-price">
                        {row.extendedUsd == null
                          ? <span className="tag warn">no price</span>
                          : money(row.extendedUsd)}
                      </span>
                      <span className="missing-actions">
                        {/* Only a fight between two built decks can be
                            settled by moving a claim; a brew holds nothing. */}
                        {onReassign && row.contested && (
                          <button
                            className="btn secondary small"
                            onClick={() => onReassign(row)}
                            title="Give this deck the copy another built deck holds"
                          >
                            Reassign
                          </button>
                        )}
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
                        <button
                          className="btn secondary small"
                          disabled={busy}
                          onClick={() => push([row.oracleId])}
                          title="Put this card on your want list"
                        >
                          Want
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ))}

            <div className="deck-card-actions" style={{ marginTop: 14 }}>
              <button className="btn" onClick={() => push()} disabled={busy}>
                {busy ? 'Adding…' : 'Add all to want list'}
              </button>
            </div>
            <p className="note">
              Priced at each card's cheapest printing, or the one you pinned. Want-list
              entries remember which deck needed them.
              {summary.exemptBasicCards > 0 && (
                <> {summary.exemptBasicCards} basic lands are not counted — they are left
                out of allocation.</>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
