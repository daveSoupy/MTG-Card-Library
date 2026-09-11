import { useEffect, useState } from 'react';
import { fetchWhatIf, type WhatIfResult } from '../api.ts';
import { figuresLine, whatIfSentence } from '../contention.ts';

/**
 * "What would breaking this up free?"
 *
 * A simulation, not a change: the server runs Phase 24's engine with this
 * deck's status overridden to disassembled and reports the difference.
 * Nothing is written, which is why the dialog has no button that does
 * anything but close.
 */
export function WhatIfDialog({ deckId, onClose }: { deckId: number; onClose: () => void }) {
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchWhatIf(deckId, controller.signal)
      .then(setResult)
      .catch((e) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [deckId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="playtest-card whatif-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>{result ? `If you broke up ${result.deckName}` : 'What if…'}</h2>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}
        {!result && !error && <p className="loading">Working it out…</p>}

        {result && (
          <>
            <p className="whatif-sentence">{whatIfSentence(result)}</p>

            {result.changed.length > 0 && (
              <div className="whatif-rows">
                {result.changed.map((delta) => (
                  <div className="whatif-row" key={delta.deckId}>
                    <strong>{delta.deckName}</strong>
                    <span className="dim">{figuresLine(delta.before)}</span>
                    <span className="whatif-arrow" aria-hidden="true">→</span>
                    <span className={delta.after.missingCards === 0 ? 'good' : ''}>
                      {figuresLine(delta.after)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {result.freedCards.length > 0 && (
              <p className="hint">
                It is holding {result.freedCards.map((card) => `${card.quantity}× ${card.name}`).join(', ')}
                {' '}that another deck is waiting for.
              </p>
            )}

            <p className="hint">
              Nothing has changed. To actually free these, set the deck to Brew or put it away.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
