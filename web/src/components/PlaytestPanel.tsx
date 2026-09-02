import { useEffect, useState } from 'react';
import { imageUrl, type Deck } from '../api.ts';
import {
  bottomCard, cardsToBottom, drawCard, mulligan, openingHand, summarizeHand,
  type HandState,
} from '../playtest.ts';

/**
 * Opening hands, so a curve and a mana base can be judged by what they
 * actually draw rather than only by their charts.
 *
 * Deliberately not a game engine: no casting, no stack, no board.
 */
export function PlaytestPanel({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const [state, setState] = useState<HandState | null>(null);

  useEffect(() => {
    setState(openingHand(deck.cards));
  }, [deck.cards]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!state) return null;

  const mustBottom = cardsToBottom(state);
  const summary = summarizeHand(state.hand);
  const emptyDeck = state.deckSize === 0;

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="playtest-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>Opening hand</h2>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {emptyDeck ? (
          <p className="empty">This deck has no cards in the maindeck yet.</p>
        ) : (
          <>
            <div className="playtest-summary">
              <span><strong>{summary.lands}</strong> lands</span>
              <span><strong>{summary.spells}</strong> spells</span>
              <span>avg MV <strong>{summary.averageManaValue ?? '—'}</strong></span>
              <span>{state.library.length} left in library</span>
              {state.mulligans > 0 && (
                <span className="tag warn">mulligan {state.mulligans}</span>
              )}
            </div>

            {mustBottom > 0 && (
              <div className="verdict bad" style={{ marginBottom: 10 }}>
                Put {mustBottom} card{mustBottom === 1 ? '' : 's'} on the bottom —
                click {mustBottom === 1 ? 'one' : 'them'} to choose.
              </div>
            )}

            <div className="playtest-hand">
              {state.hand.map((card, index) => (
                <button
                  className="playtest-card-tile"
                  key={`${card.oracleId}-${index}`}
                  onClick={() => mustBottom > 0 && setState(bottomCard(state, index))}
                  title={mustBottom > 0 ? `Put ${card.name} on the bottom` : `${card.name} — ${card.typeLine}`}
                  disabled={mustBottom === 0}
                >
                  {card.printingId && card.imageSmall ? (
                    <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
                  ) : (
                    <div className="placeholder">{card.name}</div>
                  )}
                </button>
              ))}
            </div>

            <div className="btnrow">
              <button className="btn" onClick={() => setState(openingHand(deck.cards))}>
                New hand
              </button>
              <button
                className="btn secondary"
                onClick={() => setState(mulligan(deck.cards, state))}
              >
                Mulligan to {Math.max(0, 7 - state.mulligans - 1)}
              </button>
              <button
                className="btn secondary"
                onClick={() => setState(drawCard(state))}
                disabled={state.library.length === 0 || mustBottom > 0}
              >
                Draw
              </button>
            </div>
            <p className="note">
              London mulligan: each one draws a fresh seven, then that many cards go to the bottom.
              Only the maindeck is shuffled — sideboard, commanders and maybeboard are left out.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
