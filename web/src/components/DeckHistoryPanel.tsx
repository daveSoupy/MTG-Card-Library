import { useCallback, useEffect, useState } from 'react';
import {
  createSnapshot, deleteSnapshot, fetchSnapshotDiff, fetchSnapshots, restoreSnapshot,
  type DeckDiff, type DeckSnapshot,
} from '../api.ts';

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * Deck history.
 *
 * The point is to make rebuilding safe: snapshot before you take a deck apart,
 * and you can see exactly what changed or put it back. Restoring takes its own
 * snapshot first, so it is never the destructive option either.
 */
export function DeckHistoryPanel({ deckId, onRestored, onClose }: {
  deckId: number;
  onRestored: () => void;
  onClose: () => void;
}) {
  const [snapshots, setSnapshots] = useState<DeckSnapshot[] | null>(null);
  const [diff, setDiff] = useState<{ id: number; diff: DeckDiff } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchSnapshots(deckId).then(setSnapshots).catch((e) => setError(e.message));
  }, [deckId]);

  useEffect(reload, [reload]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="porting-dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h3>Deck history</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="btnrow" style={{ marginTop: 0 }}>
          <button
            className="btn"
            disabled={busy}
            onClick={() => run(() => createSnapshot(deckId))}
          >
            Snapshot this deck now
          </button>
        </div>

        {snapshots === null && <p className="loading">Loading…</p>}
        {snapshots?.length === 0 && (
          <p className="empty">
            No snapshots yet. Take one before a rebuild and you can always get back to this.
          </p>
        )}

        <div className="backup-list">
          {snapshots?.map((snapshot) => (
            <div className="snapshot-row" key={snapshot.id}>
              <div>
                <strong>{snapshot.name}</strong>
                <div className="dim">
                  {when(snapshot.createdAt)} · {snapshot.cardCount} cards ·{' '}
                  {snapshot.uniqueCards} distinct
                </div>
                {snapshot.note && <div className="dim">{snapshot.note}</div>}
              </div>
              <div className="deck-card-actions">
                <button
                  className="linkish"
                  onClick={async () => {
                    if (diff?.id === snapshot.id) { setDiff(null); return; }
                    try {
                      setDiff({ id: snapshot.id, diff: await fetchSnapshotDiff(snapshot.id) });
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    }
                  }}
                >
                  {diff?.id === snapshot.id ? 'Hide changes' : 'What changed'}
                </button>
                <button
                  className="linkish"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`Put the deck back to "${snapshot.name}"? The current list is snapshotted first.`)) return;
                    run(async () => { await restoreSnapshot(snapshot.id); onRestored(); });
                  }}
                >
                  Restore
                </button>
                <button
                  className="linkish danger"
                  disabled={busy}
                  onClick={() => run(() => deleteSnapshot(snapshot.id))}
                >
                  Delete
                </button>
              </div>

              {diff?.id === snapshot.id && <DiffView diff={diff.diff} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Reads as "since that snapshot, this is what you did". */
function DiffView({ diff }: { diff: DeckDiff }) {
  const nothing = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  if (nothing) {
    return <p className="note">Identical to the deck as it stands.</p>;
  }
  return (
    <div className="snapshot-diff">
      {diff.added.map((e) => (
        <div key={`a${e.oracleId}${e.board}`} className="diff-line added">
          + {e.to}× {e.name}{e.board !== 'main' && <span className="dim"> ({e.board})</span>}
        </div>
      ))}
      {diff.removed.map((e) => (
        <div key={`r${e.oracleId}${e.board}`} className="diff-line removed">
          − {e.from}× {e.name}{e.board !== 'main' && <span className="dim"> ({e.board})</span>}
        </div>
      ))}
      {diff.changed.map((e) => (
        <div key={`c${e.oracleId}${e.board}`} className="diff-line changed">
          {e.name}: {e.from} → {e.to}
          {e.board !== 'main' && <span className="dim"> ({e.board})</span>}
        </div>
      ))}
      <div className="dim">{diff.unchanged} unchanged</div>
    </div>
  );
}
