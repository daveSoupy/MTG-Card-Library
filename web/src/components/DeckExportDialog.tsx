import { useEffect, useState } from 'react';
import { fetchDeckExport, deckExportFileUrl, type DeckExport, type ExportFormat } from '../api.ts';

const FORMATS: Array<[ExportFormat, string, string]> = [
  ['simple', 'Plain list', 'Quantity and name. What most sites and TCGplayer accept.'],
  ['withSet', 'With printings', 'Adds the set and collector number of each copy.'],
  ['arena', 'Arena', 'Section headers, including the command zone.'],
  ['mtgo', 'MTGO', 'Sideboard separated by a blank line.'],
];

/**
 * Copying a decklist out.
 *
 * Clipboard writes need a user gesture and can be refused outright, so the text
 * is always on screen in a selectable box: the button is the convenience, not
 * the mechanism.
 */
export function DeckExportDialog({ deckId, deckName, onClose }:
  { deckId: number; deckName: string; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('simple');
  const [data, setData] = useState<DeckExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetchDeckExport(deckId, format, controller.signal)
      .then(setData)
      .catch((cause) => { if (cause.name !== 'AbortError') setError(cause.message); });
    return () => controller.abort();
  }, [deckId, format]);

  useEffect(() => { setCopied(false); }, [format]);

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.text);
      setCopied(true);
    } catch {
      // Denied, or an insecure origin. The textarea is still right there.
      setError('Could not reach the clipboard — select the text below and copy it.');
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="porting-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h3>Export “{deckName}”</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        <div className="format-picker">
          {FORMATS.map(([value, label, hint]) => (
            <button
              key={value}
              className={`format-choice${format === value ? ' active' : ''}`}
              onClick={() => setFormat(value)}
            >
              <strong>{label}</strong>
              <span>{hint}</span>
            </button>
          ))}
        </div>

        {error && <div className="error">{error}</div>}

        <textarea
          className="export-text"
          readOnly
          value={data?.text ?? ''}
          onFocus={(e) => e.currentTarget.select()}
          rows={14}
        />

        <div className="btnrow">
          <button className="btn" onClick={copy} disabled={!data}>
            {copied ? 'Copied' : 'Copy to clipboard'}
          </button>
          <a className="btn secondary" href={deckExportFileUrl(deckId, format)} download>
            Download .txt
          </a>
          {data?.tcgplayerUrl && (
            <a className="btn secondary" href={data.tcgplayerUrl} target="_blank" rel="noreferrer">
              Buy on TCGplayer
            </a>
          )}
          {data?.cardKingdomUrl && (
            <a className="btn secondary" href={data.cardKingdomUrl} target="_blank" rel="noreferrer">
              Card Kingdom
            </a>
          )}
        </div>

        {data?.tcgplayerTooLong && (
          <p className="hint">
            This list is too long for a TCGplayer link. Copy it and paste it into their
            mass entry page instead.
          </p>
        )}
      </div>
    </div>
  );
}
