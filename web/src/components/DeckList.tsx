import { DeckImportDialog } from './DeckImportDialog.tsx';
import { useCallback, useEffect, useState } from 'react';
import {
  createDeck, deleteDeck, duplicateDeck, fetchDecks,
  type DeckSummary, type FormatRecord,
} from '../api.ts';

const COLOR_PIP: Record<string, string> = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G' };

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

export function DeckList({
  formats,
  onOpen,
}: {
  formats: FormatRecord[];
  onOpen: (id: number) => void;
}) {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState('');
  const [formatCode, setFormatCode] = useState('commander');
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = useCallback(() => {
    fetchDecks().then(setDecks).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    setError(null);
    try {
      const deck = await createDeck(name.trim(), formatCode || null);
      setName('');
      onOpen(deck.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main className="decks-page">
      {importing && (
        <DeckImportDialog
          formats={formats}
          onClose={() => setImporting(false)}
          onImported={(id) => { setImporting(false); onOpen(id); }}
        />
      )}
      <div className="decks-head">
        <h1>Decks</h1>
        <div className="new-deck">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="New deck name"
            aria-label="New deck name"
          />
          <select value={formatCode} onChange={(e) => setFormatCode(e.target.value)} aria-label="Format">
            <option value="">No format</option>
            {formats.map((f) => (
              <option key={f.code} value={f.code}>{f.display_name}</option>
            ))}
          </select>
          <button className="btn" onClick={create} disabled={!name.trim()}>Create</button>
          <button className="btn secondary" onClick={() => setImporting(true)}>Paste a list</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {decks === null && <p className="loading">Loading…</p>}
      {decks?.length === 0 && (
        <p className="empty">No decks yet. Name one above and start building.</p>
      )}

      <div className="deck-cards">
        {decks?.map((deck) => (
          <div className="deck-card" key={deck.id}>
            <button className="deck-card-open" onClick={() => onOpen(deck.id)}>
              <div className="deck-card-title">
                <span>{deck.name}</span>
                <span className="pips">
                  {[...deck.colorIdentity].map((c) => (
                    <span key={c} className={`pip ${COLOR_PIP[c] ?? ''}`}>{c}</span>
                  ))}
                </span>
              </div>
              <div className="deck-card-meta">
                {deck.formatName ?? 'No format'} · {deck.cardCount} cards · {deck.uniqueCards} distinct
              </div>
              {deck.commanderNames.length > 0 && (
                <div className="deck-card-meta commander">{deck.commanderNames.join(' & ')}</div>
              )}
              <div className="deck-card-meta subtle">Edited {relativeDate(deck.updatedAt)}</div>
            </button>

            <div className="deck-card-actions">
              <button className="linkish" onClick={() => run(() => duplicateDeck(deck.id))}>
                Duplicate
              </button>
              {confirming === deck.id ? (
                <>
                  <button
                    className="linkish danger"
                    onClick={() => run(async () => { await deleteDeck(deck.id); setConfirming(null); })}
                  >
                    Really delete
                  </button>
                  <button className="linkish" onClick={() => setConfirming(null)}>Cancel</button>
                </>
              ) : (
                <button className="linkish danger" onClick={() => setConfirming(deck.id)}>Delete</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {decks && decks.length > 0 && (
        <p className="note" style={{ marginTop: 18 }}>
          Deleting a deck immediately frees any collection copies it had claimed.
        </p>
      )}
    </main>
  );
}
