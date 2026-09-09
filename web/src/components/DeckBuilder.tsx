import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addRecommendedLands, fetchDeck, fetchSettings, fetchTemplates, imageUrl, resolveCategories,
  searchCards, updateDeck,
  type AppSettings, type Deck, type DeckCard, type DeckTemplate, type FormatRecord,
} from '../api.ts';
import { effectivePickerColors } from '../pickerColors.ts';
import { DeckPanes } from './DeckPanes.tsx';
import { DeckExportDialog } from './DeckExportDialog.tsx';
import { DeckHistoryPanel } from './DeckHistoryPanel.tsx';
import { DeckImportDialog } from './DeckImportDialog.tsx';
import { PlaytestPanel } from './PlaytestPanel.tsx';
import { ShoppingListPanel } from './ShoppingListPanel.tsx';
import { DeckArtDialog } from './DeckArtDialog.tsx';
import { UndoRedo } from './UndoRedo.tsx';
import {
  loadPaneWidths, loadSortPreference, savePaneWidth, saveSortPreference,
  type DeckSort, type PaneWidths,
} from '../deckView.ts';
import { restoreSnapshot, snapshotDeck } from '../deckHistory.ts';
import { useUndoShortcuts, useUndoStack } from '../undo.ts';
import { useNarrow } from '../viewport.ts';
import { type Density } from '../density.ts';

export function DeckBuilder({
  deckId,
  formats,
  categoryLabels,
  onBack,
  density,
  onDensity,
}: {
  deckId: number;
  formats: FormatRecord[];
  /** From /status — 'sweeper' heads a group as "Board wipes". */
  categoryLabels: Record<string, string>;
  onBack: () => void;
  /** The deck builder's own density — the one page that offers Lined-up. */
  density: Density;
  onDensity: (density: Density) => void;
}) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [templates, setTemplates] = useState<DeckTemplate[]>([]);

  const [query, setQuery] = useState('');
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [pickerCategory, setPickerCategory] = useState<string | null>(null);
  const [pickerColors, setPickerColors] = useState<string[]>([]);
  const [pickerGold, setPickerGold] = useState(false);
  const [pickerHybrid, setPickerHybrid] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchCards>>['cards']>([]);
  const [resultsTotal, setResultsTotal] = useState(0);
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

  // Mirrors the two deck-builder breakpoints in styles.css: below 860px the
  // picker is an overlay rather than a column, below 1200px so is the stats
  // pane. The overlays are opened from buttons in the header.
  const pickerFloating = useNarrow(860);
  const statsFloating = useNarrow(1200);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(loadPaneWidths);

  const undoStack = useUndoStack();
  useUndoShortcuts(undoStack);

  const [cardSort, setCardSortState] = useState(loadSortPreference);
  const setCardSort = (next: DeckSort) => {
    setCardSortState(next);
    saveSortPreference(next);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setPickerOpen(false);
      setStatsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The stack is per open deck: switching decks reuses this component, and a
  // step recorded against one deck's slots must never be replayed into
  // another's.
  useEffect(() => { undoStack.clear(); }, [deckId, undoStack.clear]);

  const load = useCallback(() => {
    fetchDeck(deckId).then(setDeck).catch((e) => setError(e.message));
  }, [deckId]);

  useEffect(load, [load]);

  // Global on/off (settings.showDeckTemplates) alongside the per-deck picker;
  // the template list is small and rarely changes, so one fetch per visit is
  // plenty.
  useEffect(() => {
    fetchSettings().then(setSettings).catch(() => undefined);
    fetchTemplates().then(setTemplates).catch(() => undefined);
  }, []);

  /** Puts the deck back to a recorded set of slots, as API calls. */
  const replay = async (target: ReturnType<typeof snapshotDeck>) => {
    setBusy(true);
    setError(null);
    try {
      // Fetched rather than taken from state: the stack outlives any single
      // render, and the deck may have moved on since the step was recorded.
      const live = await fetchDeck(deckId);
      setDeck(await restoreSnapshot(deckId, target, live));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Every mutation returns the whole deck, so validation never goes stale.
   *
   * A `label` also makes the mutation undoable. What is stacked is the deck's
   * slots either side of the call rather than one inverse call, because a
   * single edit is not always a single change: with auto-maintain-lands on,
   * adding a nonbasic rebalances the basics in the same request, and undoing
   * the add has to put those back too.
   */
  const apply = async (action: () => Promise<Deck>, label?: string) => {
    const before = deck ? snapshotDeck(deck) : null;
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setDeck(next);
      if (before && label) {
        const after = snapshotDeck(next);
        undoStack.record({
          label,
          undo: () => replay(before),
          redo: () => replay(after),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resizePane = (pane: keyof PaneWidths, width: number) =>
    setPaneWidths((current) => ({ ...current, [pane]: width }));

  // Card picker. Scoped to the deck's format so a Modern deck does not offer
  // cards that would immediately be flagged illegal.
  const colorFilterActive = pickerColors.length > 0 || pickerGold || pickerHybrid;
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Commander mode lists candidates with no query typed, since "show me what
      // can lead this deck" is the whole request; a colour filter alone is also
      // enough of a request to run a search.
      if (!query && !ownedOnly && !pickingCommander && !colorFilterActive && !pickerCategory) {
        setResults([]);
        setResultsTotal(0);
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
          // Set by clicking a shortfall in the Template stats panel.
          category: pickerCategory ?? undefined,
          limit: 40,
          sort: 'relevance',
        },
        controller.signal,
      )
        .then((r) => {
          setResults(r.cards);
          setResultsTotal(r.total);
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
      pickerColors, pickerGold, pickerHybrid, colorFilterActive, pickerCategory]);

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

  // A shortfall row's "N short" in the Template panel: pre-filters the picker
  // to that category, the deck's colour identity and its format, reusing the
  // same identity/format narrowing the picker already applies. Lands and
  // creatures are resolved from type_line, not card_categories, so they go
  // through the Scryfall-syntax box instead of the category filter.
  const filterPickerByCategory = (category: string) => {
    setPickingCommander(false);
    setStatsOpen(false);
    if (pickerFloating) setPickerOpen(true);
    if (category === 'lands' || category === 'creatures') {
      setPickerCategory(null);
      setQuery(category === 'lands' ? 'is:land' : 'is:creature');
    } else {
      setQuery('');
      setPickerCategory(category);
    }
    searchInput.current?.focus();
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

        {settings?.showDeckTemplates && (
          <select
            value={deck.templateId ?? ''}
            onChange={(e) =>
              apply(() => updateDeck(deck.id, { templateId: e.target.value ? Number(e.target.value) : null }))}
            style={{ width: 190 }}
            title="Track this deck against a template — a starting point, not a rule"
          >
            <option value="">No template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}

        <span className={`verdict-chip ${deck.validation.isLegal ? 'ok' : 'bad'}`}>
          {deck.validation.isLegal ? 'Legal' : `${deck.validation.issues.filter((i) => i.severity === 'error').length} problems`}
        </span>
        <button
          className="btn secondary"
          onClick={() => apply(() => addRecommendedLands(deck.id), 'add lands')}
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

        {pickerFloating && (
          <button className="btn" onClick={() => { setPickerOpen(true); searchInput.current?.focus(); }}>
            Add cards
          </button>
        )}
        {statsFloating && (
          <button className="btn secondary" onClick={() => setStatsOpen(true)}>Stats</button>
        )}

        <UndoRedo
          canUndo={undoStack.canUndo}
          canRedo={undoStack.canRedo}
          undoLabel={undoStack.undoLabel}
          redoLabel={undoStack.redoLabel}
          busy={undoStack.busy || busy}
          // A failed replay has already put its reason in the error banner.
          onUndo={() => { undoStack.undo().catch(() => undefined); }}
          onRedo={() => { undoStack.redo().catch(() => undefined); }}
        />
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
        cardSort={cardSort}
        setCardSort={setCardSort}
        categoryLabels={categoryLabels}
        density={density}
        onDensity={onDensity}
        listRef={listRef}
        setArtFor={setArtFor}
        setError={setError}
        jumpToCard={jumpToCard}
        onFilterShortfall={filterPickerByCategory}
        showTemplates={Boolean(settings?.showDeckTemplates)}
        onResolveCategories={() => {
          // Fire and re-read: resolution runs in the sync worker, so the deck
          // is refetched once it has had time to write.
          setError(null);
          resolveCategories()
            .then(() => setTimeout(load, 4000))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        }}
        pickerFloating={pickerFloating && pickerOpen}
        statsFloating={statsFloating && statsOpen}
        onRequestPicker={() => pickerFloating && setPickerOpen(true)}
        onClosePicker={() => setPickerOpen(false)}
        onCloseStats={() => setStatsOpen(false)}
        paneWidths={paneWidths}
        onPaneResize={resizePane}
        onPaneCommit={(pane, width) => { resizePane(pane, width); savePaneWidth(pane, width); }}
        picker={{
          query, setQuery, ownedOnly, setOwnedOnly,
          pickerColors, setPickerColors, pickerGold, setPickerGold, pickerHybrid, setPickerHybrid,
          results, resultsTotal, searching, pickingCommander, setPickingCommander, searchInput,
          preview, setPreview, coverNote, setCoverNote,
          pickerCategory, clearPickerCategory: () => setPickerCategory(null),
          categoryLabels,
        }}
      />
    </div>
  );
}
