import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addRecommendedLands, fetchBuildability, fetchDeck, fetchDeckGames, fetchLocations,
  fetchRunHistory, fetchSettings, fetchSheet, fetchTemplates, formatRecord,
  imageUrl, resolveCategories, searchCards, startAssembly, startDisassembly, updateDeck,
  type AppSettings, type AssemblyRun, type AssemblySheet, type Board, type BuildabilityDetail,
  type BuildabilityRow, type Deck, type DeckCard, type DeckTemplate, type FormatRecord,
  type MatchRecord, type StorageLocation,
} from '../api.ts';
import { effectivePickerColors } from '../pickerColors.ts';
import { withScope } from '../searchScope.ts';
import { DeckPanes } from './DeckPanes.tsx';
import { DeckExportDialog } from './DeckExportDialog.tsx';
import { DeckHistoryPanel } from './DeckHistoryPanel.tsx';
import { DeckImportDialog } from './DeckImportDialog.tsx';
import { PlaytestPanel } from './PlaytestPanel.tsx';
import { ShoppingListPanel } from './ShoppingListPanel.tsx';
import { BuildabilityStrip } from './Buildability.tsx';
import { AssemblyPanel } from './AssemblyPanel.tsx';
import { ContentionPanel } from './ContentionPanel.tsx';
import { MissingCardsPanel } from './MissingCardsPanel.tsx';
import { SubstitutesSheet } from './SubstitutesSheet.tsx';
import { hasSwappableSlot, performSwap, swapPlan } from '../substitutes.ts';
import { DeckGamesPanel } from './DeckGamesPanel.tsx';
import { DeckArtDialog } from './DeckArtDialog.tsx';
import { DeckStatusPill } from './DeckStatusPill.tsx';
import { UndoRedo } from './UndoRedo.tsx';
import {
  loadPaneWidths, loadSortPreference, savePaneWidth, saveSortPreference,
  type DeckSort, type PaneWidths,
} from '../deckView.ts';
import { restoreSnapshot, snapshotDeck } from '../deckHistory.ts';
import { notFoundNotice } from '../assembly.ts';
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
  const [buildability, setBuildability] = useState<BuildabilityDetail | null>(null);
  const [missing, setMissing] = useState(false);
  // Phase 27. The card a "Swap for something I own" sheet is open for, and the
  // board it was asked from — so the copies leave and arrive on the same board.
  const [swapFor, setSwapFor] = useState<{ oracleId: string; name: string; board?: Board } | null>(null);
  // Phase 25. The sheet is only held here while it is on screen; its ticks live
  // on the server, so being interrupted costs nothing.
  const [sheet, setSheet] = useState<AssemblySheet | null>(null);
  const [contention, setContention] = useState(false);
  const [runs, setRuns] = useState<AssemblyRun[]>([]);
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState(false);
  const [games, setGames] = useState(false);
  // The deck's lifetime record, shown on the chip beside Playtest. Kept here
  // rather than in the panel so it is visible without opening anything.
  const [record, setRecord] = useState<MatchRecord | null>(null);
  const [coverNote, setCoverNote] = useState<string | null>(null);

  // Mirrors the two deck-builder breakpoints in styles.css: below 860px the
  // picker is an overlay rather than a column, below 1200px so is the stats
  // pane. The overlays are opened from buttons in the header.
  const pickerFloating = useNarrow(860);
  const statsFloating = useNarrow(1200);
  // A phone: the header keeps to two rows and everything else moves behind
  // More…. The breakpoint is the one styles.css uses for the filter sheet.
  const compactHeader = useNarrow(760);
  const [moreOpen, setMoreOpen] = useState(false);
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
  // Draft and sealed. The server decides which formats these are and says so on
  // the format record, so the client keeps no list of its own.
  const limitedFormat = Boolean(
    formats.find((f) => f.code === deck?.formatCode)?.isLimited,
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
    // Its own fetch rather than a field on the deck: buildability depends on
    // the whole collection and on every *other* deck's status, so it changes
    // for reasons that have nothing to do with this deck being edited. A
    // failure here leaves the deck perfectly usable, so it is swallowed.
    fetchBuildability(deckId).then(setBuildability).catch(() => setBuildability(null));
    // Run history, and whether one is still open — the header offers to resume
    // it rather than silently opening a second sheet over a half-pulled deck.
    fetchRunHistory(deckId).then(setRuns).catch(() => setRuns([]));
  }, [deckId]);

  useEffect(load, [load]);

  const coverage = useMemo(() => {
    const map = new Map<string, BuildabilityRow>();
    for (const row of buildability?.rows ?? []) map.set(row.oracleId, row);
    return map;
  }, [buildability]);

  // The record is its own fetch: it changes when a game is logged, not when a
  // card moves, so it does not belong on the deck payload every edit reloads.
  // Skipped entirely while the game log is parked — nothing would show it.
  const showGameLog = Boolean(settings?.showGameLog);
  const loadRecord = useCallback(() => {
    if (!showGameLog) return;
    fetchDeckGames(deckId).then((r) => setRecord(r.record)).catch(() => undefined);
  }, [deckId, showGameLog]);

  useEffect(loadRecord, [loadRecord]);

  // Global on/off (settings.showDeckTemplates) alongside the per-deck picker;
  // the template list is small and rarely changes, so one fetch per visit is
  // plenty.
  useEffect(() => {
    fetchSettings().then(setSettings).catch(() => undefined);
    fetchTemplates().then(setTemplates).catch(() => undefined);
    // For the home-location picker: where this deck physically lives, which is
    // where an assembly run moves its cards.
    fetchLocations().then(setLocations).catch(() => undefined);
  }, []);

  // Phase 23: the picker opens in whichever scope the setting names, by
  // writing that term into the query box — the same thing tapping the chip
  // does, so there is no second, invisible source of the filter. Applied once,
  // and never over anything already typed: settings arrive asynchronously and
  // must not overwrite a search in progress.
  const scopeSeeded = useRef(false);
  useEffect(() => {
    if (scopeSeeded.current || !settings) return;
    scopeSeeded.current = true;
    if (settings.deckbuilderDefaultScope === 'all') return;
    setQuery((current) => (current ? current : withScope('', settings.deckbuilderDefaultScope)));
  }, [settings]);

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

  /**
   * Opens (or resumes) a pull sheet.
   *
   * The server returns the run already in progress if there is one, so this is
   * safe to press twice — the second press picks the half-ticked sheet back up
   * rather than throwing it away.
   */
  const openSheet = async (kind: 'assemble' | 'disassemble') => {
    setBusy(true);
    setError(null);
    try {
      setSheet(await (kind === 'assemble' ? startAssembly(deckId) : startDisassembly(deckId)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resumeRun = async (runId: number) => {
    setBusy(true);
    setError(null);
    try {
      setSheet(await fetchSheet(runId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openRun = runs.find((run) => run.status === 'open') ?? null;
  // Cards the last pull could not find. Read from the run: the deck's claim is
  // recomputed from the collection on every edit and cannot remember this.
  const shortfall = deck ? notFoundNotice(runs, deck.status) : null;

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
      if (!query && !pickingCommander && !colorFilterActive && !pickerCategory) {
        setResults([]);
        setResultsTotal(0);
        return;
      }
      setSearching(true);
      searchCards(
        {
          q: query,
          // `available` here means available *to this deck* — its own claim on
          // its own cards is not competition.
          deckId,
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
  }, [query, deckId, deck?.formatCode, identity, pickingCommander,
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
      {/* Every control is built once and then placed: inline at desktop
          width, or split between the two header rows and the More… sheet on
          a phone. One element per control means the two layouts cannot
          disagree about what a button does. */}
      {(() => {
        const formatSelect = (
          <select
            value={deck.formatCode ?? ''}
            onChange={(e) => apply(() => updateDeck(deck.id, { formatCode: e.target.value || null }))}
            style={{ width: 190 }}
            aria-label="Format"
          >
            <option value="">No format</option>
            {formats.map((f) => (
              <option key={f.code} value={f.code}>{f.display_name}</option>
            ))}
          </select>
        );
        const templateSelect = settings?.showDeckTemplates && (
          <select
            value={deck.templateId ?? ''}
            onChange={(e) =>
              apply(() => updateDeck(deck.id, { templateId: e.target.value ? Number(e.target.value) : null }))}
            style={{ width: 190 }}
            title="Track this deck against a template — a starting point, not a rule"
            aria-label="Template"
          >
            <option value="">No template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        );
        // Where the physical deck lives. Only meaningful once you have more
        // than one place to keep cards, so it stays out of the way until then.
        const homeSelect = locations.length > 1 && (
          <select
            value={deck.homeLocationId ?? ''}
            onChange={(e) => apply(() => updateDeck(deck.id, {
              homeLocationId: e.target.value ? Number(e.target.value) : null,
            }))}
            style={{ width: 170 }}
            title="Where this deck physically lives — an assembly run moves its cards here"
            aria-label="Home location"
          >
            <option value="">No home location</option>
            {locations.filter((location) => !location.is_archived).map((location) => (
              <option key={location.id} value={location.id}>{location.name}</option>
            ))}
          </select>
        );
        // The button this phase is really about. Prominent when the deck is
        // close to buildable, quiet when it is not: offering to go and pull a
        // deck you are twenty cards short of is offering the wrong job.
        const resumeButton = openRun && (
          <button
            className="btn"
            onClick={() => resumeRun(openRun.id)}
            disabled={busy}
            title="You have a sheet part-way through — pick it back up"
          >
            Resume {openRun.kind === 'assemble' ? 'pull sheet' : 'put-away'}
            <span className="record-chip">{openRun.pickedCount}/{openRun.cardCount}</span>
          </button>
        );
        const assembleButtons = !openRun && (
          <>
            <button
              className={(buildability?.summary.buildablePct ?? 0) >= 0.9 ? 'btn' : 'btn secondary'}
              onClick={() => openSheet('assemble')}
              disabled={busy}
              title="Which binder to open, in what order"
            >
              Assemble
            </button>
            {deck.status === 'assembled' && (
              <button
                className="btn secondary"
                onClick={() => openSheet('disassemble')}
                disabled={busy}
                title="Put every card back where it came from"
              >
                Put away
              </button>
            )}
          </>
        );
        const toolButtons = (
          <>
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
            {showGameLog && (
              <button
                className="btn secondary"
                onClick={() => setGames(true)}
                title="Games played with this deck, and its lifetime record"
              >
                Games
                {record && record.games > 0 && <span className="record-chip">{formatRecord(record)}</span>}
              </button>
            )}
            <button className="btn secondary" onClick={() => setShopping(true)}>
              Shopping list
              {deck.stats.needToBuyCount > 0 && ` (${deck.stats.needToBuyCount})`}
            </button>
            <button className="btn secondary" onClick={() => setHistory(true)}>History</button>
            <button className="btn secondary" onClick={() => setExporting(true)}>Export</button>
            <button className="btn secondary" onClick={() => setImporting(true)}>Import</button>
          </>
        );
        const addCardsButton = pickerFloating && (
          <button className="btn" onClick={() => { setPickerOpen(true); searchInput.current?.focus(); }}>
            Add cards
          </button>
        );
        const statsButton = statsFloating && (
          <button className="btn secondary" onClick={() => setStatsOpen(true)}>Stats</button>
        );
        const undoRedo = (
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
        );
        const title = renaming ? (
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
        );
        const statusPill = (
          <DeckStatusPill
            status={deck.status}
            disabled={busy}
            // No undo label: undo replays card slots, and a status change edits
            // none of them. Putting it on the stack would make Undo look like it
            // had done nothing.
            onChange={(status) => apply(() => updateDeck(deck.id, { status }))}
          />
        );
        const verdict = (
          <span className={`verdict-chip ${deck.validation.isLegal ? 'ok' : 'bad'}`}>
            {deck.validation.isLegal ? 'Legal' : `${deck.validation.issues.filter((i) => i.severity === 'error').length} problems`}
          </span>
        );
        // Whether the deck is legal and whether you can physically build it
        // are different questions; they sit side by side because you need
        // both before sleeving anything.
        const strip = (
          <BuildabilityStrip
            figures={buildability?.summary}
            onShowMissing={() => setMissing(true)}
            onShowContention={() => setContention(true)}
          />
        );
        // Distinct from "missing": these are cards the collection says you own
        // and the last pull sheet could not find. Nothing else on this screen
        // can say that, because every other figure is derived from the
        // collection, which still counts them.
        const shortfallChip = shortfall && (
          <button
            className="shortfall-chip"
            title={shortfall.title}
            onClick={() => setHistory(true)}
          >
            {shortfall.text}
          </button>
        );
        const saving = busy && <span className="count">saving…</span>;

        if (!compactHeader) {
          return (
            <div className="deck-header">
              <button className="btn secondary" onClick={onBack}>← Decks</button>
              {title}
              {statusPill}
              {formatSelect}
              {templateSelect}
              {verdict}
              {strip}
              {shortfallChip}
              {homeSelect}
              {resumeButton}
              {assembleButtons}
              {toolButtons}
              {addCardsButton}
              {statsButton}
              {undoRedo}
              {saving}
            </div>
          );
        }

        // Two rows: what you look at and undo on the first, what the deck
        // needs on the second. The pickers and the flows that open their own
        // panel wait in the sheet — a phone is for checking a list and
        // adding a card, not for re-templating a deck. Resume stays out
        // here because it is a job half done, and one the phone is usually
        // what you are holding for.
        return (
          <div className="deck-header compact">
            <div className="deck-header-row">
              <button className="btn secondary" onClick={onBack} aria-label="Back to decks" title="Back to decks">←</button>
              {title}
              {statusPill}
              {undoRedo}
              <button
                className="btn secondary"
                aria-label="More deck actions"
                aria-expanded={moreOpen}
                title="More"
                onClick={() => setMoreOpen(true)}
              >
                ⋯
              </button>
            </div>
            <div className="deck-header-row">
              {verdict}
              {strip}
              {shortfallChip}
              {resumeButton}
              {addCardsButton}
              {saving}
            </div>
            {moreOpen && (
              <div className="deck-more-backdrop" onClick={() => setMoreOpen(false)}>
                <div
                  className="deck-more"
                  role="dialog"
                  aria-label="Deck actions"
                  // Any button in here opens a panel or runs an action, and
                  // either way the sheet's job is done. The pickers are
                  // selects, which fall through and keep it open.
                  onClick={(e) => {
                    e.stopPropagation();
                    if ((e.target as HTMLElement).closest('button')) setMoreOpen(false);
                  }}
                >
                  <div className="floating-head">
                    <span className="count">{deck.name}</span>
                    <button className="btn secondary">Close</button>
                  </div>
                  <div className="deck-more-fields">
                    <label className="field"><span>Format</span>{formatSelect}</label>
                    {templateSelect && <label className="field"><span>Template</span>{templateSelect}</label>}
                    {homeSelect && <label className="field"><span>Home location</span>{homeSelect}</label>}
                  </div>
                  <div className="deck-more-actions">
                    {assembleButtons}
                    {toolButtons}
                    {statsButton}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })()}

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
      {missing && buildability && (
        <MissingCardsPanel
          detail={buildability}
          onClose={() => { setMissing(false); load(); }}
          onSwap={(row) => setSwapFor({ oracleId: row.oracleId, name: row.name })}
          swappable={(row) => hasSwappableSlot(deck, row.oracleId)}
        />
      )}
      {swapFor && (
        <SubstitutesSheet
          oracleId={swapFor.oracleId}
          targetName={swapFor.name}
          deckId={deck.id}
          onClose={() => setSwapFor(null)}
          actions={[{
            label: 'Swap it in',
            title: 'Take the missing copies out and put this card in their place',
            // An ordinary edit through the ordinary routes, recorded as one
            // undo step. Only the copies the deck cannot field move.
            run: async (candidate) => {
              const plan = swapPlan(
                deck, swapFor.oracleId, coverage.get(swapFor.oracleId)?.missing, swapFor.board,
              );
              await apply(
                () => performSwap(deck.id, plan, candidate.oracleId, candidate.printingId),
                `swapping ${swapFor.name} for ${candidate.name}`,
              );
              setSwapFor(null);
              load();
            },
          }]}
        />
      )}
      {contention && (
        <ContentionPanel onClose={() => { setContention(false); load(); }} onChanged={load} />
      )}
      {sheet && (
        <AssemblyPanel
          sheet={sheet}
          onClose={() => { setSheet(null); load(); }}
          // Completing a run rewrites the deck's status and its declared
          // allocation, so everything on this screen is stale until it reloads.
          onFinished={load}
        />
      )}
      {games && showGameLog && (
        <DeckGamesPanel
          deckId={deck.id}
          onChanged={loadRecord}
          onClose={() => setGames(false)}
        />
      )}
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
        limitedFormat={limitedFormat}
        identity={identity}
        cardSort={cardSort}
        setCardSort={setCardSort}
        categoryLabels={categoryLabels}
        coverage={coverage}
        onSwap={(card) => setSwapFor({ oracleId: card.oracleId, name: card.name, board: card.board })}
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
          query, setQuery,
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
