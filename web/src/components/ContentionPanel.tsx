import { useCallback, useEffect, useState } from 'react';
import {
  fetchContention, fetchDecks, reassignClaim, type ContestedCard, type DeckBuildability,
  type HoldingDeck, type ReassignResult, type ShortDeck,
} from '../api.ts';
import { money } from '../buildability.ts';
import { cardsInScope, contestedFigures, contestedReason, figuresLine } from '../contention.ts';

/**
 * Which decks are fighting over which copies.
 *
 * One row per contested card, worst first. Each row names who holds the
 * copies and who is short, and every holder carries a "give to…" control for
 * each deck that is short — the one-tap action this screen exists for. The
 * confirmation shows both decks' figures before and after, because moving a
 * copy is not free: the loser drops, and you should see by how much before
 * you do it.
 */
export function ContentionPanel({ onClose, onChanged, scope }: {
  onClose: () => void;
  /** Something moved; whoever opened this should reload their figures. */
  onChanged?: () => void;
  /** Opened from a deck: show only the fights that deck is in, with a way out
   *  to the whole collection's. */
  scope?: { deckId: number; deckName: string };
}) {
  const [cards, setCards] = useState<ContestedCard[] | null>(null);
  const [showAll, setShowAll] = useState(!scope);
  // Every deck's current figures, so the confirmation can show where each
  // side stands before the copy moves. The result shows where they landed.
  const [figures, setFigures] = useState<Map<number, DeckBuildability>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ card: ContestedCard; from: HoldingDeck; to: ShortDeck } | null>(null);
  const [done, setDone] = useState<ReassignResult & { cardName: string; fromName: string; toName: string } | null>(null);

  const reload = useCallback(() => {
    fetchContention().then(setCards).catch((e) => setError(e.message));
    fetchDecks({ buildability: true })
      .then((decks) => setFigures(new Map(
        decks.flatMap((deck) => (deck.buildability ? [[deck.id, deck.buildability]] : [])),
      )))
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (pending) setPending(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const quantity = Math.min(pending.from.quantity, pending.to.missing);
      const result = await reassignClaim({
        oracleId: pending.card.oracleId,
        fromDeckId: pending.from.deckId,
        toDeckId: pending.to.deckId,
        quantity,
      });
      setDone({
        ...result, cardName: pending.card.name,
        fromName: pending.from.deckName, toName: pending.to.deckName,
      });
      setPending(null);
      reload();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scoped = scope && !showAll;
  const shown = cards && scoped ? cardsInScope(cards, scope.deckId) : cards;

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="playtest-card contention-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>{scoped ? `Contested in ${scope.deckName}` : 'Contested cards'}</h2>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        <p className="hint">
          Cards more than one built deck wants and you own too few of. A claim goes to
          whichever deck took it first; give it to the other, buy another, or take a
          deck apart.
        </p>

        {scope && cards && (
          <p className="hint">
            {scoped ? (
              <>
                Showing {shown!.length} of {cards.length} contested — the ones{' '}
                {scope.deckName} holds or is short of.{' '}
                {cards.length > shown!.length && (
                  <button className="linkish" onClick={() => setShowAll(true)}>Show all</button>
                )}
              </>
            ) : (
              <button className="linkish" onClick={() => setShowAll(false)}>
                Only {scope.deckName}'s
              </button>
            )}
          </p>
        )}

        {error && <div className="error">{error}</div>}
        {done && (
          <div className="verdict ok">
            Gave {done.quantity}× {done.cardName} to {done.toName}. {done.toName} is now{' '}
            {figuresLine(done.to)}; {done.fromName} is {figuresLine(done.from)}.
          </div>
        )}

        {cards === null && <p className="loading">Loading…</p>}
        {shown?.length === 0 && (
          <p className="empty">
            {scoped
              ? `Nothing ${scope.deckName} holds or needs is contested.`
              : 'Nothing contested — no two built decks are after the same copy.'}
          </p>
        )}

        <div className="contention-rows">
          {shown?.map((card) => (
            <div className="contention-row" key={card.oracleId}>
              <div className="contention-card-head">
                <strong>{card.name}</strong>
                <span className="dim">{contestedFigures(card)}</span>
                <span className="tag warn">{card.shortfall} short</span>
                {card.unitPriceUsd != null && (
                  <span className="dim" title="What one more copy costs">
                    {money(card.unitPriceUsd)} each
                  </span>
                )}
              </div>
              <div className="dim">{contestedReason(card)}</div>

              <div className="contention-decks">
                {card.holders.map((holder) => (
                  <div className="contention-deck holds" key={`h${holder.deckId}`}>
                    <span>
                      <span className="status-dot" data-status={holder.status} aria-hidden="true" />
                      {holder.deckName} <span className="dim">has {holder.quantity}</span>
                    </span>
                    {/* One control per deck that is short and is not this one:
                        "give it to…" reads better than a dropdown when there
                        are two or three decks, which is all there ever are. */}
                    <span className="contention-give">
                      {card.shortDecks
                        .filter((short) => short.deckId !== holder.deckId)
                        .map((short) => (
                          <button
                            key={short.deckId}
                            className="btn secondary small"
                            disabled={busy}
                            onClick={() => setPending({ card, from: holder, to: short })}
                          >
                            Give to {short.deckName}
                          </button>
                        ))}
                    </span>
                  </div>
                ))}
                {card.shortDecks
                  .filter((short) => !card.holders.some((h) => h.deckId === short.deckId))
                  .map((short) => (
                    <div className="contention-deck short" key={`s${short.deckId}`}>
                      <span>
                        <span className="status-dot" data-status={short.status} aria-hidden="true" />
                        {short.deckName}{' '}
                        <span className="dim">needs {short.missing} more</span>
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>

        {pending && (
          <div className="sync-overlay" onClick={() => setPending(null)}>
            <div className="playtest-card contention-confirm" onClick={(e) => e.stopPropagation()}>
              <h3>
                Give {Math.min(pending.from.quantity, pending.to.missing)}× {pending.card.name} from{' '}
                {pending.from.deckName} to {pending.to.deckName}?
              </h3>
              <p className="hint">
                {pending.from.deckName} will drop a copy it is built with. The claim moves;
                no card is moved anywhere until you pull the deck.
              </p>
              <div className="contention-before">
                <div>
                  <span className="dim">{pending.from.deckName} now</span>
                  <strong>{figures.has(pending.from.deckId) ? figuresLine(figures.get(pending.from.deckId)!) : '…'}</strong>
                </div>
                <div>
                  <span className="dim">{pending.to.deckName} now</span>
                  <strong>{figures.has(pending.to.deckId) ? figuresLine(figures.get(pending.to.deckId)!) : '…'}</strong>
                </div>
              </div>
              <div className="deck-card-actions">
                <button className="btn" onClick={confirm} disabled={busy}>
                  {busy ? 'Moving…' : 'Give it'}
                </button>
                <button className="btn secondary" onClick={() => setPending(null)} disabled={busy}>
                  Keep it
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
