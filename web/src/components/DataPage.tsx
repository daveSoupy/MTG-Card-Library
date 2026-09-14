import { useCallback, useEffect, useRef, useState } from 'react';
import {
  backupDownloadUrl, cancelImageDownload, collectionCsvUrl, fetchImageDownloadStatus,
  fetchImportBatches, fetchScheduledBackups, fetchSettings, fetchStatus, fetchStorage, reopenCostPool,
  resolveCategories, restoreBackup,
  setCacheLimit, startImageDownload, takeScheduledBackup, undoImportBatch, updateSettings,
  CacheTooSmallError,
  type AppSettings, type ImageDownloadScope, type ImageDownloadStatus, type ImportBatch,
  type RestoreReport, type ScheduledBackup, type StorageInfo, type StorageLocation,
} from '../api.ts';
import { formatBytes, percent } from '../format.ts';
import { CollectionImportDialog } from './CollectionImportDialog.tsx';
import { BackToTop } from './BackToTop.tsx';
import { THEME_LABEL, THEMES, type Theme } from '../theme.ts';

const formatWhen = (iso: string) => new Date(iso).toLocaleString();

/**
 * Backups, imports and exports in one place.
 *
 * Restoring is the only genuinely destructive thing in the app, so it is behind
 * an explicit confirmation that names what is about to be replaced.
 */
export function DataPage({
  locations, onCollectionChanged, onSettingsChanged, theme, onTheme, onSync,
}: {
  locations: StorageLocation[];
  onCollectionChanged: () => void;
  /** Some settings decide what the app shell shows, so App re-reads them. */
  onSettingsChanged?: () => void;
  /** Per device, so it is App's state rather than an app_settings row. */
  theme: Theme;
  onTheme: (theme: Theme) => void;
  /** Opens the sync dialog, which App owns because it can also open itself
   *  on a first run with no card data at all. */
  onSync: () => void;
}) {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [backups, setBackups] = useState<ScheduledBackup[]>([]);
  const [directory, setDirectory] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  // Whether the library held card data once the restore landed. A backup
  // carries decks and lots but no cards, so on a fresh install every deck
  // reads as empty until a sync runs — the report has to say so, or the
  // restore looks like it lost everything.
  const [restoredWithoutCards, setRestoredWithoutCards] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [resolving, setResolving] = useState(false);
  const [download, setDownload] = useState<ImageDownloadStatus | null>(null);
  const [capGb, setCapGb] = useState('');
  // The pool just reopened, so the row can say where to go next.
  const [reopened, setReopened] = useState<number | null>(null);
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
      onSettingsChanged?.();
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

  /**
   * Points the open cost pool back at a past batch — a draft entered across two
   * sittings, or a box you kept opening the next evening. Cards added from
   * Collection afterwards join the same batch, and its total re-divides across
   * the combined set.
   */
  const reopen = async (batch: ImportBatch) => {
    const when = formatWhen(batch.importedAt);
    const detail = `opened ${when} with ${batch.cardsRemaining} card`
      + `${batch.cardsRemaining === 1 ? '' : 's'} for $${(batch.totalCostUsd ?? 0).toFixed(2)}`;
    if (!confirm(`Reopen “${batch.fileName ?? 'this pool'}” — ${detail}. Add more to it now?`)) return;
    setBusy(true);
    setError(null);
    try {
      await reopenCostPool(batch.id);
      setReopened(batch.id);
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
      fetchStatus()
        .then((status) => setRestoredWithoutCards(!status.library.hasCardData))
        .catch(() => setRestoredWithoutCards(false));
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-page">
      {error && <div className="error">{error}</div>}

      {/* Outside the storage gate below: syncing is how a library with nothing
          in it gets anything, so it must not depend on a panel that needs
          data to render. */}
      <section className="data-section">
        <h3>Card data</h3>
        <p className="hint">
          Scryfall publishes a bulk file daily. A sync downloads it and updates the local
          catalogue, then refreshes prices, categories and rulings from the same run.
          Everything stays searchable while it works.
        </p>
        <div className="btnrow">
          <button className="btn" onClick={onSync}>Sync card data</button>
        </div>
      </section>

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
            {/* An empty card_categories is invisible everywhere else — the deck
                template tracker just reads "0 removal", which looks like a
                verdict on the deck. This is where it can be seen and fixed. */}
            <div>
              <span className="dim">Card categories</span>
              <strong>{storage.categories.cards.toLocaleString()}</strong>
              <span className="dim">
                {' '}cards tagged
                {storage.categories.syncedAt
                  ? ` · resolved ${new Date(storage.categories.syncedAt).toLocaleString()}`
                  : ' · never resolved'}
              </span>
              {storage.categories.error && (
                <span className="hint bad">Last attempt failed: {storage.categories.error}</span>
              )}
              <button
                className="btn secondary small"
                style={{ marginTop: 6 }}
                disabled={resolving}
                onClick={() => {
                  setResolving(true);
                  resolveCategories()
                    // The work happens in the sync worker, so re-read once it
                    // has had time to write rather than trusting the response.
                    .then(() => setTimeout(() => { loadStorage(); setResolving(false); }, 5000))
                    .catch((e: unknown) => {
                      setError(e instanceof Error ? e.message : String(e));
                      setResolving(false);
                    });
                }}
              >
                {resolving ? 'Resolving…' : 'Resolve categories'}
              </button>
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

        <label className="setting-row">
          <span>Appearance</span>
          <div className="tabs small">
            {THEMES.map((option) => (
              <button
                key={option}
                className={option === theme ? 'on' : ''}
                aria-pressed={option === theme}
                onClick={() => onTheme(option)}
              >
                {THEME_LABEL[option]}
              </button>
            ))}
          </div>
        </label>
        <p className="hint">
          Auto follows the operating system. Unlike the settings below, this is remembered
          per device rather than in the library — a phone can be dark while the desktop is not.
        </p>

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
          <label className="check">
            <input
              type="checkbox"
              checked={settings.showDeckTemplates}
              onChange={(e) => saveSetting('showDeckTemplates', e.target.checked)}
            />
            Show deck templates
          </label>
        )}
        <p className="hint">
          Adds a “Follow a template” picker to every deck and a Template section to its
          stats pane, tracking the deck against a shape like “38 lands, 10 ramp, 10 draw” —
          a starting point, not a rule. Off hides the control entirely rather than
          resetting each deck’s choice; turn it back on and prior choices come back.
        </p>

        {settings && (
          <label className="check">
            <input
              type="checkbox"
              checked={settings.showGameLog}
              onChange={(e) => saveSetting('showGameLog', e.target.checked)}
            />
            Show the game log
          </label>
        )}
        <p className="hint">
          Adds the Games tab — events (a draft night’s spend, the deck built from it and
          its rounds) and the match log, plus a Games button on every deck. Off hides all
          of it; nothing already logged is deleted, and switching it back on brings every
          event and game back exactly as they were.
        </p>

        {settings && (
          <label className="check">
            <input
              type="checkbox"
              checked={settings.allocationIgnoresBasics}
              onChange={(e) => saveSetting('allocationIgnoresBasics', e.target.checked)}
            />
            Leave basic lands out of allocation
          </label>
        )}
        <p className="hint">
          On, a basic land is never claimed by a deck, never short, and never lands on a
          want list — so a Commander deck with 38 Islands reports 0 missing rather than 38.
          Off, basics are counted like every other card, and two decks playing the same
          Islands will read as fighting over them.
        </p>

        {settings && (
          <label className="check">
            <input
              type="checkbox"
              checked={settings.tradelistReducesAvailable}
              onChange={(e) => saveSetting('tradelistReducesAvailable', e.target.checked)}
            />
            Copies on a trade list are not available to build with
          </label>
        )}
        <p className="hint">
          A card you have promised to someone is not a card you can sleeve. On, trade-listed
          copies are subtracted from what is free, so the deck that takes one cannot quietly
          scuttle the trade. Off, they count as available and the trade-list badge is the
          only warning.
        </p>

        {settings && (
          <label className="check">
            <input
              type="checkbox"
              checked={settings.brewsReserveCopies}
              onChange={(e) => saveSetting('brewsReserveCopies', e.target.checked)}
            />
            Brews claim copies too
          </label>
        )}
        <p className="hint">
          Normally only decks marked Building or Assembled hold on to your cards, so a
          half-formed idea cannot starve the deck you actually intend to build. Turn this
          on to go back to every deck claiming its copies whatever its status.
        </p>

        {settings && (
          <label className="check">
            <input
              type="checkbox"
              checked={settings.assemblyMovesLots}
              onChange={(e) => saveSetting('assemblyMovesLots', e.target.checked)}
            />
            Assembling a deck moves its cards into the deck&rsquo;s home location
          </label>
        )}
        <p className="hint">
          Off, a pull sheet is a checklist: it tells you which binder to open and changes
          nothing. On, finishing one physically relocates each ticked copy into the deck&rsquo;s
          home location, keeping what you paid for it, and putting the deck away moves them
          all back. Only decks with a home location can move anything.
        </p>

        {settings && (
          <label className="cost-fixed">
            <span className="dim">Substitutes to suggest</span>
            <input
              type="number" min="1" max="24" step="1"
              value={settings.substituteSuggestionCount}
              onChange={(e) => saveSetting('substituteSuggestionCount',
                Math.min(24, Math.max(1, Math.round(Number(e.target.value) || 6))))}
            />
          </label>
        )}
        <p className="hint">
          How many cards you already own the <strong>Swap</strong> sheet offers for a card a
          deck is short of. Fewer is usually better: the list is ranked, and the honest
          answer is sometimes that nothing you own fills the role.
        </p>

        {settings && (
          <div className="cost-default">
            <label>
              <span className="dim">Deck builder search opens in</span>
              <select
                value={settings.deckbuilderDefaultScope}
                onChange={(e) => saveSetting(
                  'deckbuilderDefaultScope',
                  e.target.value as AppSettings['deckbuilderDefaultScope'],
                )}
              >
                <option value="all">All cards</option>
                <option value="owned">Cards I own</option>
                <option value="available">Cards available to build with</option>
              </select>
            </label>
          </div>
        )}
        <p className="hint">
          Which scope chip the deck builder&rsquo;s search pane starts on. The chip writes its
          term into the search box, so you can always see and edit what it did. Browse always
          opens on all cards.
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
            {restoredWithoutCards && (
              <p className="hint">
                Your decks and collection are restored; sync card data to see them.{' '}
                <button className="btn small" onClick={onSync}>Sync now</button>
              </p>
            )}
            {report.pendingCardReferences > 0 && !restoredWithoutCards && (
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
                  {/* One cell, so the row keeps its four columns whether or
                      not this batch is a reopenable cost pool. */}
                  <span className="backup-actions">
                    {/* Only a cost pool can be reopened; an ordinary CSV import
                        has no total to re-divide across new cards. */}
                    {batch.totalCostUsd != null && (
                      reopened === batch.id
                        ? <span className="dim">reopened — add cards from Collection</span>
                        : (
                          <button className="btn secondary small" onClick={() => reopen(batch)} disabled={busy}>
                            Reopen
                          </button>
                        )
                    )}
                    {batch.cardsRemaining > 0 ? (
                      <button className="btn secondary small" onClick={() => undo(batch)} disabled={busy}>
                        Undo ({batch.cardsRemaining})
                      </button>
                    ) : <span className="dim">undone</span>}
                  </span>
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

      <BackToTop />
    </div>
  );
}
