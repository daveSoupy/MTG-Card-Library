import { useEffect, useState } from 'react';
import {
  fetchDeckSubstitutes, fetchSubstitutes, imageUrl,
  type SubstituteCandidate, type SubstitutesResult,
} from '../api.ts';
import { availableBadge, emptyNotice, reasonLine, sourceNotice } from '../substitutes.ts';
import { ManaCost } from './ManaCost.tsx';

/** One thing a tap on a candidate can do. The first is the primary action. */
export interface SubstituteAction {
  label: string;
  title?: string;
  run: (candidate: SubstituteCandidate) => Promise<void>;
}

/**
 * "Swap for something I own."
 *
 * Owned cards that could fill the role of one you are short of, as art tiles
 * with the server's reason line under each. Nothing here decides anything:
 * the ranking, the reasons and the pool all arrive computed, and the only
 * thing the sheet does on its own is put the words "Nothing you own fills
 * this role" on screen — which is a better answer than five bad tiles.
 *
 * Never auto-swaps. A candidate is replaced only by the explicit tap the host
 * wires into `actions`, and what that tap does is the host's business — the
 * deck builder swaps a slot; the want list can also keep the want.
 */
export function SubstitutesSheet({
  oracleId,
  targetName,
  deckId,
  actions,
  onClose,
}: {
  oracleId: string;
  targetName: string;
  /** Supplies colour identity and format. Null for a want with no deck behind it. */
  deckId: number | null;
  /** Empty when there is nothing sensible to do but look. */
  actions: SubstituteAction[];
  onClose: () => void;
}) {
  const [result, setResult] = useState<SubstitutesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    (deckId == null
      ? fetchSubstitutes(oracleId, null, controller.signal)
      : fetchDeckSubstitutes(deckId, oracleId, controller.signal))
      .then(setResult)
      .catch((e) => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [oracleId, deckId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = async (action: SubstituteAction, candidate: SubstituteCandidate) => {
    setBusy(candidate.oracleId);
    setError(null);
    try {
      await action.run(candidate);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const notice = result ? sourceNotice(result) : null;

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="playtest-card substitutes-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>Instead of {targetName}</h2>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {result?.context.deckName && (
          <p className="substitutes-context dim">
            From your collection, for {result.context.deckName}
            {result.context.colorIdentity !== null && (
              <> · {result.context.colorIdentity === '' ? 'colourless' : result.context.colorIdentity}</>
            )}
            {result.context.formatCode && <> · {result.context.formatCode}</>}
          </p>
        )}

        {/* The one quiet line about how the match was made. Absent when it was
            made the good way — on role, from the Tagger data. */}
        {notice && <p className="hint substitutes-notice">{notice}</p>}

        {error && <div className="error">{error}</div>}
        {!result && !error && <p className="loading">Looking through your collection…</p>}

        {result && result.candidates.length === 0 && (
          <p className="empty">{emptyNotice(result)}</p>
        )}

        {result && result.candidates.length > 0 && (
          <div className="substitutes-grid">
            {result.candidates.map((candidate) => (
              <div
                className="substitute-tile"
                key={candidate.oracleId}
                data-busy={busy === candidate.oracleId || undefined}
              >
                <div className="substitute-art" title={`${candidate.name} — ${candidate.typeLine}`}>
                  {candidate.printingId && candidate.imageSmall ? (
                    <img
                      src={imageUrl(candidate.printingId, 'normal')}
                      alt={candidate.name}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <div className="placeholder">{candidate.name}</div>
                  )}
                  <span className="substitute-available" title="Copies free to build with">
                    {availableBadge(candidate)}
                  </span>
                </div>

                <div className="substitute-name">
                  <strong>{candidate.name}</strong>
                  <ManaCost cost={candidate.manaCost} cmc={candidate.cmc} />
                </div>
                {/* The reason the card came up, in the server's words. A
                    recommendation you cannot audit is one you will not trust. */}
                <div className="substitute-reason">{reasonLine(candidate)}</div>

                {actions.length > 0 && (
                  <div className="substitute-actions">
                    {actions.map((action, index) => (
                      <button
                        key={action.label}
                        className={index === 0 ? 'btn small' : 'btn secondary small'}
                        title={action.title}
                        disabled={busy !== null}
                        onClick={() => act(action, candidate)}
                      >
                        {busy === candidate.oracleId ? '…' : action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
