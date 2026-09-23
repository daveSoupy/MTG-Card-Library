import { money } from '../format.ts';
import { useMemo, useState } from 'react';
import {
  previewCollectionCsv, importCollectionCsv,
  type CsvPreview, type CsvPreviewRow, type ColumnRole, type StorageLocation,
} from '../api.ts';
import { HelpButton } from './helpTopics.tsx';

const ROLES: Array<[ColumnRole, string]> = [
  ['ignore', 'Ignore'],
  ['name', 'Card name'],
  ['quantity', 'Quantity'],
  ['setCode', 'Set code'],
  ['setName', 'Set name'],
  ['collectorNumber', 'Collector number'],
  ['finish', 'Foil / finish'],
  ['condition', 'Condition'],
  ['language', 'Language'],
  ['price', 'Purchase price'],
  ['scryfallId', 'Scryfall ID'],
];

/**
 * Importing a collection CSV.
 *
 * Every exporter names its columns differently, so the mapping is guessed and
 * then shown for correction — a wrong guess about which column is the quantity
 * would otherwise multiply a collection silently.
 */
export function CollectionImportDialog({ locations, onClose, onImported }: {
  locations: StorageLocation[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<ColumnRole[] | null>(null);
  // What the user picked, if anything. Until they do, the default location is
  // worked out on every render rather than once: the page's location list can
  // still be loading when the dialog opens, and a default taken at mount would
  // stay null while the select showed its first option as if it were chosen.
  const [pickedLocation, setLocationId] = useState<number | null>(null);
  const locationId = pickedLocation
    ?? (locations.find((l) => l.is_default) ?? locations[0])?.id ?? null;
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  const [choice, setChoice] = useState<Record<number, string | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (contents: string, override?: ColumnRole[]) => {
    setBusy(true); setError(null);
    try {
      const result = await previewCollectionCsv(contents, override);
      setPreview(result);
      setMapping(result.mapping);
      // Only a certain match starts ticked: a 75% guess is a question, not
      // an answer, and picking a candidate below is what ticks it.
      setSkipped(Object.fromEntries(
        result.rows.filter((r) => r.match?.confidence !== 1).map((r) => [r.lineNumber, true]),
      ));
      setChoice(Object.fromEntries(result.rows.map((r) => [r.lineNumber, r.printingId])));
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const contents = await file.text();
    setFileName(file.name);
    setText(contents);
    await load(contents);
  };

  const changeMapping = (index: number, role: ColumnRole) => {
    if (!mapping) return;
    const next = [...mapping];
    next[index] = role;
    setMapping(next);
    void load(text, next);
  };

  const rows = useMemo(() => {
    if (!preview) return [];
    return preview.rows
      .filter((row) => !skipped[row.lineNumber] && choice[row.lineNumber])
      .map((row) => ({
        printingId: choice[row.lineNumber]!,
        quantity: row.quantity,
        finish: row.finish,
        condition: row.condition,
        language: row.language,
        acquiredUnitCost: row.price,
      }));
  }, [preview, skipped, choice]);

  const commit = async () => {
    if (locationId === null) { setError('Choose where these cards live.'); return; }
    setBusy(true); setError(null);
    try {
      await importCollectionCsv({
        locationId,
        rows,
        fileName,
        unmatched: (preview?.rows.length ?? 0) - rows.length,
      });
      onImported();
    } catch (cause: any) {
      setError(cause.message);
      setBusy(false);
    }
  };

  const cards = rows.reduce((sum, r) => sum + r.quantity, 0);
  // A condition column whose values all came back 'unknown' is a vocabulary
  // miss, and should be said out loud rather than left in the grey row text.
  const unreadConditions = preview && mapping?.includes('condition')
    ? preview.rows.filter((r) => r.condition === 'unknown').length : 0;

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="porting-dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h3>Import a collection CSV</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}

        {!preview && (
          <>
            <p className="hint">
              An export from Deckbox, ManaBox, TCGplayer, Moxfield or a spreadsheet of your
              own. The columns are matched by name, and you can correct them next.
              {' '}<HelpButton topic="importFormats" />
            </p>
            <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
            {busy && <p className="loading">Reading…</p>}
          </>
        )}

        {preview && mapping && (
          <>
            <div className="mapping-grid">
              {preview.headers.map((header, index) => (
                <label key={`${header}-${index}`} className="mapping-cell">
                  <span className="mapping-header">{header || <em>(no name)</em>}</span>
                  <select value={mapping[index]} onChange={(e) => changeMapping(index, e.target.value as ColumnRole)}>
                    {ROLES.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="import-counts">
              <span className="tally ok">{preview.counts.resolved} matched</span>
              {preview.counts.uncertain > 0 &&
                <span className="tally warn">{preview.counts.uncertain} uncertain</span>}
              {preview.counts.unresolved > 0 &&
                <span className="tally bad">{preview.counts.unresolved} not found</span>}
              {preview.skipped.length > 0 &&
                <span className="tally bad">{preview.skipped.length} skipped</span>}
              {unreadConditions > 0 &&
                <span className="tally warn" title="These rows' condition was blank or not recognised; they import as unknown condition.">
                  {unreadConditions} without a recognised condition
                </span>}
            </div>

            <div className="import-rows">
              {preview.rows.map((row) => (
                <CsvRow
                  key={row.lineNumber}
                  row={row}
                  chosen={choice[row.lineNumber] ?? null}
                  skipped={skipped[row.lineNumber] ?? false}
                  onSkip={(value) => setSkipped((s) => ({ ...s, [row.lineNumber]: value }))}
                  onChoose={(printingId) => {
                    setChoice((c) => ({ ...c, [row.lineNumber]: printingId }));
                    setSkipped((s) => ({ ...s, [row.lineNumber]: !printingId }));
                  }}
                />
              ))}
            </div>

            <div className="row import-newdeck">
              <label>
                Put these in
                <select
                  value={locationId ?? ''}
                  onChange={(e) => setLocationId(Number(e.target.value))}
                >
                  {locations.filter((l) => !l.is_archived || l.id === locationId).map((location) => (
                    <option key={location.id} value={location.id}>{location.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="btnrow">
              <button className="btn" onClick={commit} disabled={busy || rows.length === 0}>
                {busy ? 'Importing…' : `Import ${cards} card${cards === 1 ? '' : 's'}`}
              </button>
              <button className="btn secondary" onClick={() => setPreview(null)} disabled={busy}>
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One CSV row. A settled match shows its name; anything less offers the
 * candidates, each a printing, so a typo is fixed here rather than dropped.
 * The choice is keyed by printing id — `choice` is what gets imported.
 */
function CsvRow({ row, chosen, skipped, onSkip, onChoose }: {
  row: CsvPreviewRow;
  chosen: string | null;
  skipped: boolean;
  onSkip: (value: boolean) => void;
  onChoose: (printingId: string | null) => void;
}) {
  const state = row.match?.confidence === 1 ? 'ok' : row.match ? 'warn' : 'bad';
  const options = row.candidates.filter((c) => c.printingId);
  const picked = options.find((c) => c.printingId === chosen);
  const exact = picked ? picked.printingExact : row.printingExact;

  return (
    <div className={`import-row ${state}${skipped ? ' skipped' : ''}`}>
      <input
        type="checkbox"
        checked={!skipped}
        disabled={!chosen}
        onChange={(e) => onSkip(!e.target.checked)}
      />
      <span className="import-qty">{row.quantity}×</span>
      <span className="import-raw">{row.name}</span>
      {options.length > 0 ? (
        <select
          className="import-choice"
          value={chosen ?? ''}
          onChange={(e) => onChoose(e.target.value || null)}
        >
          <option value="">{row.match ? 'Choose a card…' : 'No match — choose a card…'}</option>
          {options.map((candidate) => (
            <option key={candidate.oracleId} value={candidate.printingId!}>
              {candidate.name}
              {candidate.confidence < 1 ? ` — ${Math.round(candidate.confidence * 100)}% match` : ''}
            </option>
          ))}
        </select>
      ) : (
        <span className="import-match">{row.match ? row.match.name : 'No match found'}</span>
      )}
      <span className="import-note">
        {row.setCode ? row.setCode.toUpperCase() : '—'}
        {row.finish !== 'nonfoil' ? ` ${row.finish}` : ''}
        {` ${row.condition}`}
        {row.price !== null ? ` ${money(row.price)}` : ''}
        {chosen && !exact && <em title="The exact printing was not in the local card data; a default was used."> approx. printing</em>}
      </span>
    </div>
  );
}
