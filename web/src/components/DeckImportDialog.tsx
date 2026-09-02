import { useMemo, useState } from 'react';
import {
  previewDecklist, importIntoDeck, importAsNewDeck,
  type DecklistPreview, type PreviewLine, type ImportBoard, type FormatRecord,
} from '../api.ts';

const BOARDS: Array<[ImportBoard, string]> = [
  ['main', 'Deck'], ['side', 'Sideboard'], ['command', 'Command zone'], ['maybe', 'Maybe'],
];

/**
 * Pasting a decklist in.
 *
 * Two steps, because a list copied off a website will contain names this
 * database spells differently, and quietly importing a near-miss is worse than
 * asking. Every line is shown with what it resolved to before anything is
 * written, and an uncertain match is opt-in rather than opt-out.
 */
export function DeckImportDialog({ deckId, deckName, formats, onClose, onImported }: {
  deckId?: number;
  deckName?: string;
  formats: FormatRecord[];
  onClose: () => void;
  onImported: (deckId: number) => void;
}) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<DecklistPreview | null>(null);
  const [choice, setChoice] = useState<Record<number, string | null>>({});
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  const [boards, setBoards] = useState<Record<number, ImportBoard>>({});
  const [newName, setNewName] = useState('Imported deck');
  const [newFormat, setNewFormat] = useState<string>('commander');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      const result = await previewDecklist(text);
      setPreview(result);
      // An uncertain match starts unticked, so nothing lands without a look.
      setSkipped(Object.fromEntries(
        result.lines.filter((l) => !l.match).map((l) => [l.lineNumber, true]),
      ));
      setChoice(Object.fromEntries(
        result.lines.map((l) => [l.lineNumber, l.match?.oracleId ?? l.candidates[0]?.oracleId ?? null]),
      ));
      setBoards(Object.fromEntries(result.lines.map((l) => [l.lineNumber, l.board])));
    } catch (cause: any) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };

  const entries = useMemo(() => {
    if (!preview) return [];
    return preview.lines
      .filter((line) => !skipped[line.lineNumber] && choice[line.lineNumber])
      .map((line) => ({
        oracleId: choice[line.lineNumber]!,
        quantity: line.quantity,
        board: boards[line.lineNumber] ?? line.board,
      }));
  }, [preview, choice, skipped, boards]);

  const cardCount = entries.reduce((sum, e) => sum + e.quantity, 0);

  const commit = async () => {
    setBusy(true); setError(null);
    try {
      if (deckId !== undefined) {
        await importIntoDeck(deckId, entries);
        onImported(deckId);
      } else {
        const { deck } = await importAsNewDeck(newName, newFormat || null, entries);
        onImported(deck.id);
      }
    } catch (cause: any) {
      setError(cause.message);
      setBusy(false);
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="porting-dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h3>{deckId !== undefined ? `Import into “${deckName}”` : 'Import a decklist'}</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}

        {!preview && (
          <>
            <p className="hint">
              Paste a list from anywhere — Moxfield, Archidekt, Arena, MTGO, or just
              “4 Lightning Bolt” a line at a time. Set codes and section headers are
              understood if they are there.
            </p>
            <textarea
              className="export-text"
              rows={14}
              value={text}
              placeholder={'4 Lightning Bolt\n2 Sol Ring (CMR) 472\n\nSideboard\n2 Pyroblast'}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="btnrow">
              <button className="btn" onClick={run} disabled={busy || text.trim() === ''}>
                {busy ? 'Reading…' : 'Preview'}
              </button>
            </div>
          </>
        )}

        {preview && (
          <>
            <div className="import-counts">
              <span className="tally ok">{preview.counts.resolved} matched</span>
              {preview.counts.uncertain > 0 &&
                <span className="tally warn">{preview.counts.uncertain} uncertain</span>}
              {preview.counts.unresolved > 0 &&
                <span className="tally bad">{preview.counts.unresolved} not found</span>}
              {preview.unparsed.length > 0 &&
                <span className="tally bad">{preview.unparsed.length} unreadable</span>}
            </div>

            <div className="import-rows">
              {preview.lines.map((line) => (
                <ImportRow
                  key={line.lineNumber}
                  line={line}
                  chosen={choice[line.lineNumber] ?? null}
                  skipped={skipped[line.lineNumber] ?? false}
                  board={boards[line.lineNumber] ?? line.board}
                  onChoose={(id) => setChoice((c) => ({ ...c, [line.lineNumber]: id }))}
                  onSkip={(value) => setSkipped((s) => ({ ...s, [line.lineNumber]: value }))}
                  onBoard={(b) => setBoards((v) => ({ ...v, [line.lineNumber]: b }))}
                />
              ))}
              {preview.unparsed.map((line) => (
                <div className="import-row bad" key={`u${line.lineNumber}`}>
                  <span className="import-line">{line.lineNumber}</span>
                  <span className="import-raw">{line.raw}</span>
                  <span className="import-note">Could not read this line — it will be ignored.</span>
                </div>
              ))}
            </div>

            {deckId === undefined && (
              <div className="row import-newdeck">
                <label>
                  Deck name
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} />
                </label>
                <label>
                  Format
                  <select value={newFormat} onChange={(e) => setNewFormat(e.target.value)}>
                    <option value="">No format</option>
                    {formats.map((f) => (
                      <option key={f.code} value={f.code}>{f.display_name}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <div className="btnrow">
              <button className="btn" onClick={commit} disabled={busy || entries.length === 0}>
                {busy ? 'Importing…' : `Import ${cardCount} card${cardCount === 1 ? '' : 's'}`}
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

function ImportRow({ line, chosen, skipped, board, onChoose, onSkip, onBoard }: {
  line: PreviewLine;
  chosen: string | null;
  skipped: boolean;
  board: ImportBoard;
  onChoose: (id: string) => void;
  onSkip: (value: boolean) => void;
  onBoard: (board: ImportBoard) => void;
}) {
  const confident = line.match !== null && line.match.confidence === 1;
  const uncertain = line.match !== null && line.match.confidence < 1;
  const state = confident ? 'ok' : uncertain ? 'warn' : 'bad';

  return (
    <div className={`import-row ${state}${skipped ? ' skipped' : ''}`}>
      <input
        type="checkbox"
        checked={!skipped}
        disabled={line.candidates.length === 0 && !line.match}
        onChange={(e) => onSkip(!e.target.checked)}
      />
      <span className="import-qty">{line.quantity}×</span>
      <span className="import-raw">{line.name}</span>

      {line.candidates.length > 1 || !confident ? (
        <select
          className="import-choice"
          value={chosen ?? ''}
          onChange={(e) => onChoose(e.target.value)}
        >
          {line.candidates.length === 0 && <option value="">No match found</option>}
          {line.candidates.map((candidate) => (
            <option key={candidate.oracleId} value={candidate.oracleId}>
              {candidate.name}
              {candidate.confidence < 1 ? ` — ${Math.round(candidate.confidence * 100)}% match` : ''}
            </option>
          ))}
        </select>
      ) : (
        <span className="import-match">{line.match!.name}</span>
      )}

      <select className="import-board" value={board} onChange={(e) => onBoard(e.target.value as ImportBoard)}>
        {BOARDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
  );
}
