import { useCallback, useEffect, useRef, useState } from 'react';
import {
  backupDownloadUrl, collectionCsvUrl, fetchImportBatches, fetchScheduledBackups,
  restoreBackup, takeScheduledBackup, undoImportBatch,
  type ImportBatch, type RestoreReport, type ScheduledBackup, type StorageLocation,
} from '../api.ts';
import { CollectionImportDialog } from './CollectionImportDialog.tsx';

const formatBytes = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

const formatWhen = (iso: string) => new Date(iso).toLocaleString();

/**
 * Backups, imports and exports in one place.
 *
 * Restoring is the only genuinely destructive thing in the app, so it is behind
 * an explicit confirmation that names what is about to be replaced.
 */
export function DataPage({ locations, onCollectionChanged }: {
  locations: StorageLocation[];
  onCollectionChanged: () => void;
}) {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [backups, setBackups] = useState<ScheduledBackup[]>([]);
  const [directory, setDirectory] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetchImportBatches().then(setBatches).catch(() => { /* history is not critical */ });
    fetchScheduledBackups()
      .then((r) => { setBackups(r.backups); setDirectory(r.directory); })
      .catch(() => { /* likewise */ });
  }, []);

  useEffect(reload, [reload]);

  const undo = async (batch: ImportBatch) => {
    if (!confirm(`Remove the ${batch.cardsRemaining} cards that “${batch.fileName ?? 'this import'}” added?`)) return;
    setBusy(true);
    try {
      const result = await undoImportBatch(batch.id);
      setBatches(result.batches);
      onCollectionChanged();
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!pending) return;
    setBusy(true); setError(null);
    try {
      const result = await restoreBackup(pending);
      setReport(result);
      setPending(null);
      if (fileInput.current) fileInput.current.value = '';
      reload();
      onCollectionChanged();
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-page">
      {error && <div className="error">{error}</div>}

      <section className="data-section">
        <h3>Backup</h3>
        <p className="hint">
          A backup holds your collection, decks, trades and lists — everything that is
          yours. The card database is not in it; it re-downloads from Scryfall in about
          seventeen seconds, which keeps the file small enough to keep anywhere.
        </p>
        <div className="btnrow">
          <a className="btn" href={backupDownloadUrl} download>Download a backup</a>
          <button
            className="btn secondary"
            disabled={busy}
            onClick={() => { setBusy(true); takeScheduledBackup()
              .then((r) => setBackups(r.backups))
              .catch((c) => setError(c.message))
              .finally(() => setBusy(false)); }}
          >
            Save one on the server
          </button>
        </div>

        {backups.length > 0 && (
          <>
            <h4>On the server</h4>
            {directory && <p className="hint mono">{directory}</p>}
            <div className="backup-list">
              {backups.map((backup) => (
                <div className="backup-row" key={backup.name}>
                  <span>{formatWhen(backup.takenAt)}</span>
                  <span className="dim">{formatBytes(backup.bytes)}</span>
                  <span className="dim mono">{backup.name}</span>
                </div>
              ))}
            </div>
            <p className="hint">
              Kept automatically, once a day, seven at a time. These live on the same
              machine as the database — download one as well if that matters.
            </p>
          </>
        )}
      </section>

      <section className="data-section danger">
        <h3>Restore</h3>
        <p className="hint">
          Replaces your collection, decks and lists with the contents of a backup file.
          What is in the app now is discarded.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".sqlite,.db,application/octet-stream"
          onChange={(e) => { setPending(e.target.files?.[0] ?? null); setReport(null); }}
        />
        {pending && (
          <div className="restore-confirm">
            <p>
              Restore from <strong>{pending.name}</strong> ({formatBytes(pending.size)})?
              This replaces everything currently in the app.
            </p>
            <div className="btnrow">
              <button className="btn danger" onClick={restore} disabled={busy}>
                {busy ? 'Restoring…' : 'Yes, replace my data'}
              </button>
              <button
                className="btn secondary"
                onClick={() => { setPending(null); if (fileInput.current) fileInput.current.value = ''; }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {report && (
          <div className="restore-report">
            <p><strong>Restored {report.totalRows} rows.</strong></p>
            {report.pendingCardReferences > 0 && (
              <p className="hint">
                {report.pendingCardReferences} rows refer to cards this machine has not
                synced yet. Run a card sync and they will resolve on their own.
              </p>
            )}
            {report.skipped.length > 0 && (
              <p className="hint">
                Skipped: {report.skipped.map((s) => s.table).join(', ')} — not present in
                that backup.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="data-section">
        <h3>Collection import and export</h3>
        <div className="btnrow">
          <button className="btn" onClick={() => setImporting(true)}>Import a CSV</button>
          <a className="btn secondary" href={collectionCsvUrl} download>Export as CSV</a>
        </div>
        <p className="hint">
          The export has one row per lot rather than per card, so condition and what you
          paid stay attached to the copies they belong to.
        </p>

        {batches.length > 0 && (
          <>
            <h4>Recent imports</h4>
            <div className="backup-list">
              {batches.map((batch) => (
                <div className="backup-row" key={batch.id}>
                  <span>{formatWhen(batch.importedAt)}</span>
                  <span>{batch.fileName ?? batch.source}</span>
                  <span className="dim">
                    {batch.rowsImported} of {batch.rowsTotal} rows
                    {batch.rowsUnmatched ? `, ${batch.rowsUnmatched} unmatched` : ''}
                  </span>
                  {batch.cardsRemaining > 0 ? (
                    <button className="btn secondary small" onClick={() => undo(batch)} disabled={busy}>
                      Undo ({batch.cardsRemaining})
                    </button>
                  ) : <span className="dim">undone</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {importing && (
        <CollectionImportDialog
          locations={locations}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); reload(); onCollectionChanged(); }}
        />
      )}
    </div>
  );
}
