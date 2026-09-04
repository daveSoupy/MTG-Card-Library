import { useCallback, useEffect, useRef, useState } from 'react';
import {
  backupDownloadUrl, cancelImageDownload, collectionCsvUrl, fetchImageDownloadStatus,
  fetchImportBatches, fetchScheduledBackups, fetchSettings, fetchStorage, restoreBackup,
  setCacheLimit, startImageDownload, takeScheduledBackup, undoImportBatch, updateSettings,
  CacheTooSmallError,
  type AppSettings, type ImageDownloadScope, type ImageDownloadStatus, type ImportBatch,
  type RestoreReport, type ScheduledBackup, type StorageInfo, type StorageLocation,
} from '../api.ts';
import { formatBytes, percent } from '../format.ts';
import { CollectionImportDialog } from './CollectionImportDialog.tsx';

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
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [download, setDownload] = useState<ImageDownloadStatus | null>(null);
  const [capGb, setCapGb] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const loadStorage = useCallback(() => {
    fetchStorage()
      .then((s) => {
        setStorage(s);
        // Seed the cap editor once, so it does not fight the user's typing.
        setCapGb((prev) => prev || (s.imageCache.limitBytes / 1024 ** 3).toFixed(1));
      })
      .catch(() => { /* storage panel simply stays hidden */ });
  }, []);

  const reload = useCallback(() => {
    fetchImportBatches().then(setBatches).catch(() => { /* history is not critical */ });
    fetchScheduledBackups()
      .then((r) => { setBackups(r.backups); setDirectory(r.directory); })
      .catch(() => { /* likewise */ });
    fetchSettings().then(setSettings).catch(() => { /* fall back to controls hidden */ });
    fetchImageDownloadStatus().then(setDownload).catch(() => { /* no job yet */ });
    loadStorage();
  }, [loadStorage]);

  // Poll while a download runs, then refresh the storage figures once it stops.
  useEffect(() => {
    if (!download?.running) return;
    const timer = setInterval(() => {
      fetchImageDownloadStatus()
        .then((s) => { setDownload(s); if (!s.running) loadStorage(); })
        .catch(() => { /* transient */ });
    }, 1200);
    return () => clearInterval(timer);
  }, [download?.running, loadStorage]);

  const startDownload = async (scope: ImageDownloadScope) => {
    setError(null);
    try {
      setDownload(await startImageDownload(scope));
    } catch (cause: any) {
      if (cause instanceof CacheTooSmallError) {
        setError(
          `The full catalogue is about ${formatBytes(cause.estimateBytes)}, above the `
          + `${formatBytes(cause.limitBytes)} cache limit. Raise the limit below, then try again.`,
        );
        setCapGb(Math.ceil(cause.estimateBytes / 1024 ** 3).toString());
      } else {
        setError(cause.message);
      }
    }
  };

  const saveCap = async () => {
    const gb = Number.parseFloat(capGb);
    if (!Number.isFinite(gb) || gb <= 0) { setError('Enter a cache limit in GB.'); return; }
    setError(null);
    try {
      await setCacheLimit(Math.round(gb * 1024 ** 3));
      loadStorage();
    } catch (cause: any) {
      setError(cause.message);
    }
  };

  const stopDownload = async () => {
    try { setDownload(await cancelImageDownload()); } catch (cause: any) { setError(cause.message); }
  };

  const saveSetting = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    try {
      setSettings(await updateSettings({ [key]: value }));
    } catch (cause: any) {
      setError(cause.message);
      reload();
    }
  };

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

      {storage && (
        <section className="data-section">
          <h3>Storage</h3>
          <div className="storage-grid">
            <div><span className="dim">Database</span><strong>{formatBytes(storage.database.bytes)}</strong></div>
            <div>
              <span className="dim">Image cache</span>
              <strong>{formatBytes(storage.imageCache.bytes)}</strong>
              <span className="dim"> · {storage.imageCache.count.toLocaleString()} files · cap {formatBytes(storage.imageCache.limitBytes)}</span>
            </div>
            <div>
              <span className="dim">Cards stored</span>
              <strong>{storage.cards.oracleCards.toLocaleString()}</strong>
              <span className="dim"> unique · {storage.cards.printings.toLocaleString()} printings · {storage.cards.sets.toLocaleString()} sets</span>
            </div>
          </div>

          <label className="cap-editor">
            <span className="dim">Cache limit (GB)</span>
            <input
              type="number" min="0.1" step="0.1" value={capGb}
              onChange={(e) => setCapGb(e.target.value)}
            />
            <button className="btn secondary small" onClick={saveCap}>Set</button>
          </label>

          <h4>Download art ahead of time</h4>
          <p className="hint">
            Images are fetched from Scryfall the first time a card is shown and kept on
            disk. Pre-download to avoid that wait. Your decks and collection are small;
            the whole catalogue is large.
          </p>
          <p className="hint">
            Your decks &amp; collection: {storage.coverage.cached.toLocaleString()} of{' '}
            {storage.coverage.referenced.toLocaleString()} images cached
            {' '}({percent(storage.coverage.cached, storage.coverage.referenced)}%).
          </p>

          {download?.running ? (
            <div className="download-progress">
              <span>
                Downloading {download.scope === 'all' ? 'the whole catalogue' : 'your decks & collection'}:
                {' '}{download.processed.toLocaleString()} / {download.total.toLocaleString()}
                {' '}({percent(download.processed, download.total)}%)
                {download.failed > 0 && ` · ${download.failed} failed`}
              </span>
              <button className="btn secondary small" onClick={stopDownload}>Cancel</button>
            </div>
          ) : (
            <div className="btnrow">
              <button className="btn" onClick={() => startDownload('referenced')}>
                Download my decks &amp; collection
              </button>
              <button className="btn secondary" onClick={() => startDownload('all')}>
                Download entire catalogue (~{formatBytes(storage.fullEstimateBytes)})
              </button>
            </div>
          )}
          {download && !download.running && download.finishedAt && (
            <p className="hint">
              Last run: {download.downloaded.toLocaleString()} downloaded
              {download.failed > 0 && `, ${download.failed} failed`}
              {download.canceled && ' (cancelled)'}.
            </p>
          )}
        </section>
      )}

      <section className="data-section">
        <h3>Settings</h3>
        {settings && (
          <label className="check">
            <input
              type="checkbox"
              checked={settings.autoMaintainLands}
              onChange={(e) => saveSetting('autoMaintainLands', e.target.checked)}
            />
            Keep basic lands in step automatically
          </label>
        )}
        <p className="hint">
          When on, editing a deck adjusts its basic lands to a recommended count,
          split by colour — adding a dual removes a basic, and it stops once you have
          enough lands. The “Add lands” button in the deck builder does the same thing
          on demand and is always available.
        </p>

        {settings && (
          <div className="cost-default">
            <label>
              <span className="dim">Default cost basis when adding cards</span>
              <select
                value={settings.defaultCostMethod}
                onChange={(e) => saveSetting('defaultCostMethod', e.target.value as AppSettings['defaultCostMethod'])}
              >
                <option value="unknown">Unknown — record no cost</option>
                <option value="free">Free — $0 (gifts, pack pulls)</option>
                <option value="market">Market price when added</option>
                <option value="fixed">Fixed amount per card</option>
              </select>
            </label>
            {settings.defaultCostMethod === 'fixed' && (
              <label className="cost-fixed">
                <span className="dim">Amount ($)</span>
                <input
                  type="number" min="0" step="0.01"
                  value={settings.defaultCostFixedUsd}
                  onChange={(e) => saveSetting('defaultCostFixedUsd', Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
            )}
            <label className="cost-fixed">
              <span className="dim">Booster pack price ($)</span>
              <input
                type="number" min="0" step="0.01"
                value={settings.draftBoosterPriceUsd}
                onChange={(e) => saveSetting('draftBoosterPriceUsd', Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
          </div>
        )}
        <p className="hint">
          The starting assumption for a card’s cost when you don’t type a price in.
          The <strong>Add by set</strong> screen and the Add-cards dialog both begin
          from this, and you can override it per card or per session (including a
          “box split” that spreads one lump sum across everything you add). The
          <strong> Draft</strong> cost divides 3× the booster pack price above evenly
          across the cards you add; both the pack price here and the draft total on
          the Add screen are editable.
        </p>
      </section>

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
                    {batch.totalCostUsd != null ? (
                      <>
                        ${batch.totalCostUsd.toFixed(2)} · {batch.cardsRemaining} cards
                        {batch.cardsRemaining > 0 && ` · $${(batch.totalCostUsd / batch.cardsRemaining).toFixed(2)} each`}
                      </>
                    ) : (
                      <>
                        {batch.rowsImported} of {batch.rowsTotal} rows
                        {batch.rowsUnmatched ? `, ${batch.rowsUnmatched} unmatched` : ''}
                      </>
                    )}
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
