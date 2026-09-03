import { useEffect, useState } from 'react';
import { startSync, subscribeToSync, type StatusResponse, type SyncProgress } from '../api.ts';

/**
 * First-run and manual sync.
 *
 * Blocks the app only when there is no card data at all; a refresh of existing
 * data runs in the background, because a stale cache is still perfectly usable.
 */
export function SyncGate({
  status,
  onFinished,
  onDismiss,
}: {
  status: StatusResponse;
  onFinished: () => void;
  onDismiss: () => void;
}) {
  const [progress, setProgress] = useState<SyncProgress | null>(status.sync.progress);
  const [running, setRunning] = useState(status.sync.running);
  const [error, setError] = useState<string | null>(status.sync.lastError);
  const [bulkType, setBulkType] = useState(status.library.loadedBulkType ?? 'default_cards');

  useEffect(() => {
    if (!running) return;
    return subscribeToSync(
      (next) => {
        setProgress(next);
        if (next.error) setError(next.error);
      },
      () => {
        setRunning(false);
        onFinished();
      },
    );
  }, [running, onFinished]);

  const begin = async () => {
    setError(null);
    setProgress({ phase: 'checking', message: 'Starting…', fraction: null });
    setRunning(true);
    try {
      await startSync(bulkType);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  };

  const isFirstRun = !status.library.hasCardData;
  const fraction = progress?.fraction ?? null;

  return (
    <div className="sync-overlay">
      <div className="sync-card">
        <h2>{isFirstRun ? 'Download the card database' : 'Refresh card data'}</h2>
        <p>
          {isFirstRun
            ? 'The app keeps a local copy of every Magic card so search stays instant and works offline. This runs once.'
            : `Currently holding ${status.library.oracleCards.toLocaleString()} cards from ` +
              `${status.library.sets.toLocaleString()} sets.`}
        </p>

        {error && <div className="error">{error}</div>}

        {running ? (
          <>
            <div className={`bar${fraction === null ? ' indeterminate' : ''}`}>
              <div style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }} />
            </div>
            <div className="sync-msg">{progress?.message ?? 'Working…'}</div>
            {!isFirstRun && (
              <div className="btnrow">
                <button className="btn secondary" onClick={onDismiss}>
                  Continue in the background
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="fgroup">
              <h3>What to download</h3>
              <select value={bulkType} onChange={(e) => setBulkType(e.target.value)}>
                {Object.entries(status.bulkTypes).map(([value, meta]) => (
                  <option key={value} value={value}>{meta.label}</option>
                ))}
              </select>
              <p style={{ fontSize: 12.5, marginTop: 8 }}>
                {status.bulkTypes[bulkType]?.detail}
              </p>
            </div>
            <div className="btnrow">
              <button className="btn" onClick={begin}>
                {isFirstRun ? 'Download now' : 'Refresh now'}
              </button>
              {!isFirstRun && (
                <button className="btn secondary" onClick={onDismiss}>Cancel</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
