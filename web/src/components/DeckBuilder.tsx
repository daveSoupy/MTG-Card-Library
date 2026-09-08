import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addRecommendedLands, fetchDeck, imageUrl, searchCards, updateDeck,
  type Deck, type DeckCard, type FormatRecord,
} from '../api.ts';
import { effectivePickerColors } from '../pickerColors.ts';
import { DeckPanes } from './DeckPanes.tsx';
import { DeckExportDialog } from './DeckExportDialog.tsx';
import { DeckHistoryPanel } from './DeckHistoryPanel.tsx';
import { DeckImportDialog } from './DeckImportDialog.tsx';
import { PlaytestPanel } from './PlaytestPanel.tsx';
import { ShoppingListPanel } from './ShoppingListPanel.tsx';
import { DeckArtDialog } from './DeckArtDialog.tsx';
import { loadViewPreference, saveViewPreference, type DeckSort, type DeckViewMode } from '../deckView.ts';

export function DeckBuilder({
  deckId,
  formats,
  onBack,
}: {
  deckId: number;
  formats: FormatRecord[];
  onBack: () => void;
}) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [pickerColors, setPickerColors] = useState<string[]>([]);
  const [pickerGold, setPickerGold] = useState(false);
  const [pickerHybrid, setPickerHybrid] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchCards>>['cards']>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{ printingId: string; name: string } | null>(null);
  const [artFor, setArtFor] = useState<DeckCard | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [playtesting, setPlaytesting] = useState(false);
  const [shopping, setShopping] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState(false);
  const [coverNote, setCoverNote] = useState<string | null>(null);

  const [{ view, sort: cardSort }, setViewPref] = useState(loadViewPreference);
  const setView = (next: DeckViewMode) => {
    setViewPref({ view: next, sort: cardSort });
    saveViewPreference(next, cardSort);
  };
  const setCardSort = (next: DeckSort) => {
    setViewPref({ view, sort: next });
    saveViewPreference(view, next);
  };

  const listRef = useRef<HTMLDivElement>(null);

  // A commander's identity, as a stable string ("WU", "" for colourless, or
  // null when no commander sets one). Kept as the primitive rather than an
  // array: the picker effect depends on it, and a fresh `[...identity, 'C']`
  // array every render made that effect re-run on every render — each run
  // aborting the previous in-flight search, so nothing ever came back.
  const identity = deck?.validation.commanderIdentity ?? null;

  // Whether this format has a command zone at all. Read from the format list
  // rather than guessed from deck size — Gladiator is 100-card singleton and
  // has no commander.
  const requiresCommander = Boolean(
    formats.find((f) => f.code === deck?.formatCode)?.requiresCommander,
  );
  // Set by clicking the empty command slot: narrows the picker to cards that
  // can actually lead this deck, whatever "commander" means in this format.
  const [pickingCommander, setPickingCommander] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    fetchDeck(deckId).then(setDeck).catch((e) => setError(e.message));
  }, [deckId]);

  useEffect(load, [load]);

  /** Every mutation returns the whole deck, so validation never goes stale. */
  const apply = async (action: () => Promise<Deck>) => {
    setBusy(true);
    setError(null);
    try {
      setDeck(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Card picker. Scoped to the deck's format so a Modern deck does not offer
  // cards that would immediately be flagged illegal.
  const colorFilterActive = pickerColors.length > 0 || pickerGold || pickerHybrid;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Commander mode lists candidates with no query typed, since "show me what
      // can lead this deck" is the whole request; a colour filter alone is also
      // enough of a request to run a search.
      if (!query && !ownedOnly && !pickingCommander && !colorFilterActive) {
        setResults([]);
        return;
      }
      setSearching(true);
      searchCards(
        {
          q: query,
          ownedOnly,
          format: deck?.formatCode ?? undefined,
          commanderFor: pickingCommander ? (deck?.formatCode ?? undefined) : undefined,
          // The colour pills narrow within the commander's identity where the
          // format enforces one, so the picker never offers an illegal card.
          // 'C' is appended so colourless cards, which fit every deck, are kept.
          colors: effectivePickerColors(
            pickerColors,
            identity === null ? null : [...identity, 'C'],
          ),
          gold: pickerGold || undefined,
          hybrid: pickerHybrid || undefined,
          limit: 40,
          sort: 'relevance',
        },
        controller.signal,
      )
        .then((r) => {
          setResults(r.cards);
          // Warm the small art so a card's deck tile paints from cache the
          // instant it is added — the reason an owned card felt faster to add
          // was simply that its art was already on disk.
          for (const card of r.cards) {
            if (card.printingId) new Image().src = imageUrl(card.printingId, 'small');
          }
        })
        .catch((e) => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => setSearching(false));
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, ownedOnly, deck?.formatCode, identity, pickingCommander,
      pickerColors, pickerGold, pickerHybrid, colorFilterActive]);

  if (!deck) {
    return (
      <div className="deck-shell">
        {error ? <div className="error">{error}</div> : <p className="loading">Loading deck…</p>}
      </div>
    );
  }

  const problemFor = (card: DeckCard): 'error' | 'warning' | null => {
    const issue = deck.validation.issues.find((i) => i.oracleId === card.oracleId);
    return issue ? issue.severity : null;
  };

  const jumpToCard = (oracleId: string) => {
    const target = listRef.current?.querySelector<HTMLElement>(`[data-oracle="${oracleId}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target?.classList.add('flash');
    setTimeout(() => target?.classList.remove('flash'), 1200);
  };

  return (
    <div className="deck-shell">
      <div className="deck-header">
        <button className="btn secondary" onClick={onBack}>← Decks</button>

        {renaming ? (
          <input
            className="deck-title-input"
            defaultValue={deck.name}
            autoFocus
            onBlur={(e) => { setRenaming(false); apply(() => updateDeck(deck.id, { name: e.target.value })); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <button className="deck-title" onClick={() => setRenaming(true)} title="Click to rename">
            {deck.name}
          </button>
        )}

        <select
          value={deck.formatCode ?? ''}
          onChange={(e) => apply(() => updateDeck(deck.id, { formatCode: e.target.value || null }))}
          style={{ width: 190 }}
        >
          <option value="">No format</option>
          {formats.map((f) => (
            <option key={f.code} value={f.code}>{f.display_name}</option>
          ))}
        </select>

        <span className={`verdict-chip ${deck.validation.isLegal ? 'ok' : 'bad'}`}>
          {deck.validation.isLegal ? 'Legal' : `${deck.validation.issues.filter((i) => i.severity === 'error').length} problems`}
        </span>
        <button
          className="btn secondary"
          onClick={() => apply(() => addRecommendedLands(deck.id))}
          title="Fill the deck to a recommended land count with basics, split by colour"
        >
          Add lands
        </button>
        <button className="btn secondary" onClick={() => setPlaytesting(true)}>
          Playtest
        </button>
        <button className="btn secondary" onClick={() => setShopping(true)}>
          Shopping list
          {deck.stats.needToBuyCount > 0 && ` (${deck.stats.needToBuyCount})`}
        </button>
        <button className="btn secondary" onClick={() => setHistory(true)}>History</button>
        <button className="btn secondary" onClick={() => setExporting(true)}>Export</button>
        <button className="btn secondary" onClick={() => setImporting(true)}>Import</button>
        {busy && <span className="count">saving…</span>}
      </div>

      {error && <div className="error">{error}</div>}

      {playtesting && <PlaytestPanel deck={deck} onClose={() => setPlaytesting(false)} />}
      {exporting && (
        <DeckExportDialog deckId={deck.id} deckName={deck.name} onClose={() => setExporting(false)} />
      )}
      {history && (
        <DeckHistoryPanel
          deckId={deck.id}
          onRestored={load}
          onClose={() => setHistory(false)}
        />
      )}
      {importing && (
        <DeckImportDialog
          deckId={deck.id}
          deckName={deck.name}
          formats={formats}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); load(); }}
        />
      )}
      {shopping && <ShoppingListPanel deckId={deck.id} onClose={() => { setShopping(false); load(); }} />}
      {artFor && (
        <DeckArtDialog
          deckId={deck.id}
          card={artFor}
          onClose={() => setArtFor(null)}
          onDeck={(next) => setDeck(next)}
        />
      )}

      <DeckPanes
        deck={deck}
        apply={apply}
        problemFor={problemFor}
        requiresCommander={requiresCommander}
        identity={identity}
        view={view}
        cardSort={cardSort}
        setView={setView}
        setCardSort={setCardSort}
        listRef={listRef}
        setArtFor={setArtFor}
        setError={setError}
        jumpToCard={jumpToCard}
        picker={{
          query, setQuery, ownedOnly, setOwnedOnly,
          pickerColors, setPickerColors, pickerGold, setPickerGold, pickerHybrid, setPickerHybrid,
          results, searching, pickingCommander, setPickingCommander, searchInput,
          preview, setPreview, coverNote, setCoverNote,
        }}
      />
    </div>
  );
}
