import { useEffect, useState } from 'react';
import { imageUrl, type Deck } from '../api.ts';
import {
  bottomCard, cardsToBottom, drawCard, mulligan, openingHand, summarizeHand,
  startGame, nextTurn, playLand, castCard, canCast, isLandCard, summarizeMana,
  type GameState,
} from '../playtest.ts';

/**
 * Opening hands and goldfishing.
 *
 * Draw seven, mulligan, then play it out: a land a turn, cast what the mana
 * allows, and see whether the curve works. Still not a rules engine — no stack,
 * no combat, no abilities and no opponent — so a card that resolves simply
 * sits on the battlefield.
 */
export function PlaytestPanel({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const [state, setState] = useState<GameState | null>(null);

  useEffect(() => {
    setState(startGame(openingHand(deck.cards)));
  }, [deck.cards]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!state) return null;

  const mustBottom = cardsToBottom(state);
  const summary = summarizeHand(state.hand);
  const mana = summarizeMana(state);
  const emptyDeck = state.deckSize === 0;
  // Turn one is still the opening hand; the board only matters after that.
  const started = state.turn > 1 || state.battlefield.length > 0;

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="playtest-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>{started ? `Turn ${state.turn}` : 'Opening hand'}</h2>
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
              {started && (
                <span>
                  mana <strong>{mana.available}/{mana.total}</strong>
                  {mana.colors.length > 0 && ` (${mana.colors.join('')})`}
                </span>
              )}
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
                  onClick={() => {
                    if (mustBottom > 0) { setState(bottomCard(state, index)); return; }
                    setState(isLandCard(card) ? playLand(state, index) : castCard(state, index));
                  }}
                  title={
                    mustBottom > 0 ? `Put ${card.name} on the bottom`
                      : isLandCard(card)
                        ? (state.landPlayedThisTurn ? 'Already played a land this turn' : `Play ${card.name}`)
                        : (canCast(state, index) ? `Cast ${card.name}` : `Not enough mana for ${card.name}`)
                  }
                  data-playable={
                    mustBottom > 0 ? undefined
                      : isLandCard(card) ? !state.landPlayedThisTurn : canCast(state, index)
                  }
                  disabled={
                    mustBottom === 0 && (isLandCard(card)
                      ? state.landPlayedThisTurn
                      : !canCast(state, index))
                  }
                >
                  {card.printingId && card.imageSmall ? (
                    <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
                  ) : (
                    <div className="placeholder">{card.name}</div>
                  )}
                </button>
              ))}
            </div>

            {state.battlefield.length > 0 && (
              <>
                <h3 className="playtest-zone">Battlefield</h3>
                <div className="playtest-hand battlefield">
                  {state.battlefield.map((card, index) => (
                    <div
                      className={`playtest-card-tile${state.tapped.includes(index) ? ' tapped' : ''}`}
                      key={`bf-${card.oracleId}-${index}`}
                      title={state.tapped.includes(index) ? `${card.name} (tapped)` : card.name}
                    >
                      {card.printingId && card.imageSmall ? (
                        <img src={imageUrl(card.printingId, 'small')} alt={card.name}
                             loading="lazy" decoding="async" />
                      ) : (
                        <div className="placeholder">{card.name}</div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="btnrow">
              <button
                className="btn"
                onClick={() => setState(nextTurn(state))}
                disabled={mustBottom > 0 || state.library.length === 0}
              >
                Next turn
              </button>
              <button className="btn secondary" onClick={() => setState(startGame(openingHand(deck.cards)))}>
                New hand
              </button>
              <button
                className="btn secondary"
                onClick={() => setState(startGame(mulligan(deck.cards, state)))}
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
              After that, click a land to play it and a spell to cast it; dimmed cards are ones
              the mana will not currently pay for. No stack, no combat, no opponent.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
