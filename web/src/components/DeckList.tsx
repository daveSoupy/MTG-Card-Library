import { DeckImportDialog } from './DeckImportDialog.tsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addDeckTag, removeDeckTag, imageUrl,
  createDeck, deleteDeck, duplicateDeck, fetchDecks,
  BUILDABILITY_SORTS, BUILDABILITY_SORT_LABEL,
  DECK_STATUSES, DECK_STATUS_HINT, DECK_STATUS_LABEL, DECK_STATUS_RESERVES,
  type BuildabilitySort, type DeckStatus, type DeckSummary, type FormatRecord,
} from '../api.ts';
import { BackToTop } from './BackToTop.tsx';
import { BuildabilityBar } from './Buildability.tsx';
import { ContentionPanel } from './ContentionPanel.tsx';
import { WhatIfDialog } from './WhatIfDialog.tsx';
import { money, percent } from '../buildability.ts';
import { nameMatches } from '../listSort.ts';
import { useNarrow } from '../viewport.ts';

type DeckView = 'cards' | 'list';
const VIEW_KEY = 'mtg.decks.view';

/** Per device, like density: a phone reads the list, a desktop may want art. */
function loadView(phone: boolean): DeckView {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    if (stored === 'cards' || stored === 'list') return stored;
  } catch { /* private mode */ }
  return phone ? 'list' : 'cards';
}

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
  const phone = useNarrow(620);
  const [view, setViewState] = useState<DeckView>(() => loadView(phone));
  const setView = (next: DeckView) => {
    setViewState(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* private mode */ }
  };
  // Name, or a commander's name — what you remember a deck by.
  const [search, setSearch] = useState('');
  // On a phone the create form waits behind a button, so the first screen is
  // decks rather than an input, a select and two buttons.
  const [creating, setCreating] = useState(false);
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The list itself failing to load, apart from `error` for an action: while
  // set, the page shows neither "Loading…" nor "No decks yet" — the server
  // did not say there are none, it did not answer.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagging, setTagging] = useState<number | null>(null);
  const [contention, setContention] = useState(false);
  const [whatIf, setWhatIf] = useState<number | null>(null);
  // Taken-apart decks are still decks — they keep their lists — but they are
  // not what you came to the page for, so they start out of the way.
  const [statuses, setStatuses] = useState<DeckStatus[]>(
    () => DECK_STATUSES.filter((status) => status !== 'disassembled'),
  );
  // Resolved server-side, so the order matches the numbers on the rows. Null is
  // the store's own ordering — the one the rest of the app shows decks in.
  const [sort, setSort] = useState<BuildabilitySort | null>(null);

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

  const statusCounts = useMemo(() => {
    const counts = new Map<DeckStatus, number>();
    for (const deck of decks ?? []) counts.set(deck.status, (counts.get(deck.status) ?? 0) + 1);
    return counts;
  }, [decks]);

  // A deck has to carry every selected tag, so stacking them narrows. Status is
  // the other way round — the chips are the set of statuses shown.
  const shown = useMemo(
    () => (decks ?? []).filter((deck) => statuses.includes(deck.status)
      && activeTags.every((tag) => deck.tags.includes(tag))
      && (nameMatches(deck.name, search) || deck.commanderNames.some((c) => nameMatches(c, search)))),
    [decks, activeTags, statuses, search],
  );
  const [name, setName] = useState('');
  const [formatCode, setFormatCode] = useState('commander');
  const [confirming, setConfirming] = useState<number | null>(null);

  const contestedDecks = useMemo(
    () => (decks ?? []).filter((deck) => (deck.buildability?.contestedCount ?? 0) > 0).length,
    [decks],
  );

  const load = useCallback(() => {
    fetchDecks({ buildability: true, sort })
      .then((next) => { setDecks(next); setLoadError(null); })
      .catch((e) => { setDecks(null); setLoadError(e.message); });
  }, [sort]);

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
        {phone && !creating && (
          <button className="btn" onClick={() => setCreating(true)}>New deck</button>
        )}
        {(!phone || creating) && (
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
          {phone && <button className="btn secondary" onClick={() => setCreating(false)}>Cancel</button>}
        </div>
        )}
      </div>

      {decks !== null && decks.length > 0 && (
        <div className="list-tools deck-tools">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Find a deck (${decks.length})`}
            aria-label="Find a deck by name or commander"
          />
          <div className="pills" role="group" aria-label="Deck view">
            <button className="pill" aria-pressed={view === 'cards'} onClick={() => setView('cards')}>Cards</button>
            <button className="pill" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
          </div>
        </div>
      )}

      {loadError && <div className="error">{loadError}</div>}
      {error && error !== loadError && <div className="error">{error}</div>}

      {decks === null && !loadError && <p className="loading">Loading…</p>}
      {decks !== null && decks.length > 0 && shown.length === 0 && (
        <p className="empty">No decks match those filters.</p>
      )}
      {decks?.length === 0 && (
        <p className="empty">No decks yet. Name one above and start building.</p>
      )}

      {decks !== null && decks.length > 0 && (
        <div className="deck-status-filter">
          {DECK_STATUSES.map((status) => (
            <button
              key={status}
              className="status-chip"
              data-status={status}
              aria-pressed={statuses.includes(status)}
              title={DECK_STATUS_HINT[status]}
              onClick={() => setStatuses((current) => current.includes(status)
                ? current.filter((s) => s !== status)
                : [...current, status])}
            >
              {DECK_STATUS_LABEL[status]}
              <span className="dim">{statusCounts.get(status) ?? 0}</span>
            </button>
          ))}
          {/* Phase 26's door. The count is decks with a fight on, which is the
              figure already on their tiles; the screen behind it is per card. */}
          {contestedDecks > 0 && (
            <button
              className="status-chip contested"
              onClick={() => setContention(true)}
              // Counts built decks short of a card another built deck holds —
              // brews are never in a fight, so they no longer inflate it.
              title="Built decks short of a card another built deck holds. Tap to see who has what."
            >
              Contested
              <span className="dim">{contestedDecks}</span>
            </button>
          )}
        </div>
      )}

      {decks !== null && decks.length > 1 && (
        <div className="deck-sort">
          <label htmlFor="deck-sort">Sort</label>
          <select
            id="deck-sort"
            value={sort ?? ''}
            onChange={(e) => setSort((e.target.value || null) as BuildabilitySort | null)}
          >
            <option value="">Recently edited</option>
            {BUILDABILITY_SORTS.map((option) => (
              <option key={option} value={option}>{BUILDABILITY_SORT_LABEL[option]}</option>
            ))}
          </select>
        </div>
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

      {view === 'list' && shown.length > 0 && <DeckTable decks={shown} onOpen={onOpen} />}

      <div className="deck-cards">
        {view === 'cards' && shown.map((deck) => (
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
                <span>
                  {deck.name}
                  <span className="status-dot" data-status={deck.status}
                        title={DECK_STATUS_HINT[deck.status]} />
                </span>
                <span className="pips">
                  {[...deck.colorIdentity].map((c) => (
                    <span key={c} className={`pip ${COLOR_PIP[c] ?? ''}`}>{c}</span>
                  ))}
                </span>
              </div>
              <div className="deck-card-meta">
                {DECK_STATUS_LABEL[deck.status]} · {deck.formatName ?? 'No format'} ·{' '}
                {deck.cardCount} cards · {deck.uniqueCards} distinct
              </div>
              {deck.commanderNames.length > 0 && (
                <div className="deck-card-meta commander">{deck.commanderNames.join(' & ')}</div>
              )}
              <div className="deck-card-meta subtle">Edited {relativeDate(deck.updatedAt)}</div>
              <BuildabilityBar figures={deck.buildability} />
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
              {/* Only a deck that holds cards has anything to free. */}
              {DECK_STATUS_RESERVES[deck.status] && (
                <button
                  className="linkish"
                  onClick={() => setWhatIf(deck.id)}
                  title="What would breaking this deck up free for the others?"
                >
                  What if…
                </button>
              )}
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
          Only decks that are building or assembled hold on to copies. A brew or a
          taken-apart deck keeps its list without claiming any cardboard — and deleting
          a deck immediately frees whatever it had claimed.
        </p>
      )}

      {contention && (
        <ContentionPanel onClose={() => { setContention(false); load(); }} onChanged={load} />
      )}
      {whatIf !== null && <WhatIfDialog deckId={whatIf} onClose={() => setWhatIf(null)} />}

      <BackToTop label="Back to the top of the deck list" />
    </main>
  );
}

/**
 * The compact view: one line per deck with the figures you compare decks by.
 * Every number is the server's buildability, rendered as the bar renders it;
 * the order is the page's sort. Actions (tag, duplicate, delete) stay on the
 * Cards view — this one is for finding and opening.
 */
function DeckTable({ decks, onOpen }: { decks: DeckSummary[]; onOpen: (id: number) => void }) {
  return (
    <table className="deck-table">
      <thead>
        <tr>
          <th>Deck</th>
          <th className="dt-status">Status</th>
          <th className="dt-format">Format</th>
          <th className="num">Buildable</th>
          <th className="num">Missing</th>
          <th className="num">To finish</th>
        </tr>
      </thead>
      <tbody>
        {decks.map((deck) => {
          const b = deck.buildability;
          return (
            <tr key={deck.id} onClick={() => onOpen(deck.id)}>
              <td className="dt-name">
                {/* Ahead of the name, so a long name cut short never takes it with it. */}
                <span className="status-dot" data-status={deck.status} title={DECK_STATUS_HINT[deck.status]} />
                <button className="linkish" onClick={(e) => { e.stopPropagation(); onOpen(deck.id); }}
                        title={deck.commanderNames.length > 0 ? deck.commanderNames.join(' & ') : deck.name}>
                  {deck.name}
                </button>
                <span className="pips">
                  {[...deck.colorIdentity].map((c) => (
                    <span key={c} className={`pip ${COLOR_PIP[c] ?? ''}`}>{c}</span>
                  ))}
                </span>
              </td>
              <td className="dt-status">{DECK_STATUS_LABEL[deck.status]}</td>
              <td className="dt-format">{deck.formatName ?? '—'}</td>
              <td className="num">{b?.buildablePct == null ? '—' : percent(b.buildablePct)}</td>
              <td className="num">{b ? b.missingCards : '—'}</td>
              <td className="num">
                {!b || b.buildablePct == null ? '—'
                  : b.missingCards === 0 ? <span className="good">ready</span>
                    : `${money(b.costToCompleteUsd)}${b.unpricedCount > 0 ? ` + ${b.unpricedCount}` : ''}`}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
