import { DeckImportDialog } from './DeckImportDialog.tsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addDeckTag, removeDeckTag, imageUrl,
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
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagging, setTagging] = useState<number | null>(null);

  // The tag list is derived from the decks rather than fetched separately —
  // one source of truth, and it stays right after an add or a remove.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const deck of decks ?? []) {
      for (const tag of deck.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, deckCount]) => ({ tag, deckCount }))
      .sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }));
  }, [decks]);

  // A deck has to carry every selected tag, so stacking them narrows.
  const shown = useMemo(
    () => (decks ?? []).filter((deck) => activeTags.every((tag) => deck.tags.includes(tag))),
    [decks, activeTags],
  );
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
      {decks !== null && decks.length > 0 && shown.length === 0 && (
        <p className="empty">No decks carry all of those tags.</p>
      )}
      {decks?.length === 0 && (
        <p className="empty">No decks yet. Name one above and start building.</p>
      )}

      {allTags.length > 0 && (
        <div className="deck-tag-filter">
          {allTags.map(({ tag, deckCount }) => (
            <button
              key={tag}
              className="deck-tag"
              aria-pressed={activeTags.includes(tag)}
              onClick={() => setActiveTags((current) => current.includes(tag)
                ? current.filter((t) => t !== tag)
                : [...current, tag])}
            >
              {tag} <span className="dim">{deckCount}</span>
            </button>
          ))}
          {activeTags.length > 0 && (
            <button className="linkish" onClick={() => setActiveTags([])}>Clear</button>
          )}
        </div>
      )}

      <div className="deck-cards">
        {shown?.map((deck) => (
          <div className="deck-card" key={deck.id}>
            <button className="deck-card-open" onClick={() => onOpen(deck.id)}>
              {deck.coverPrintingId && (
                <div className="deck-cover">
                  <img
                    src={imageUrl(deck.coverPrintingId, 'art_crop')}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                </div>
              )}
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

            {deck.tags.length > 0 && (
              <div className="deck-tags">
                {deck.tags.map((tag) => (
                  <button
                    key={tag}
                    className="deck-tag"
                    title={`Remove "${tag}"`}
                    onClick={() => run(() => removeDeckTag(deck.id, tag))}
                  >
                    {tag} <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}

            {tagging === deck.id && (
              <form
                className="deck-tag-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = event.currentTarget.elements.namedItem('tag') as HTMLInputElement;
                  const value = input.value.trim();
                  if (value) run(() => addDeckTag(deck.id, value));
                  setTagging(null);
                }}
              >
                <input name="tag" autoFocus placeholder="Tag name" aria-label="New tag"
                       onBlur={() => setTagging(null)} />
              </form>
            )}

            <div className="deck-card-actions">
              <button className="linkish" onClick={() => setTagging(deck.id)}>Tag</button>
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
