import { useCallback, useEffect, useState } from 'react';
import {
  createEvent, deleteEvent, deleteGame, fetchDecks, fetchEvent, fetchEvents, fetchGames,
  fetchImportBatches, formatRecord, updateEvent,
  type DeckSummary, type EventDetail, type EventFields, type EventSummary, type FormatRecord,
  type Game, type GameQuery, type ImportBatch, type MatchRecord,
} from '../api.ts';
import { GameLogDialog } from './GameLogDialog.tsx';
import { BackToTop } from './BackToTop.tsx';
import { money } from '../format.ts';


const dayOf = (timestamp: string) => timestamp.slice(0, 10);

/** "Dave, Sam" — or a plain dash, because a solitaire goldfish is still a game. */
const opponentsOf = (game: Game) => game.opponents || '—';

/**
 * Events and the game log.
 *
 * Two tabs because they answer two different questions. **Events** is "what
 * happened on that night" — the spend, the deck built from it and the round
 * results, all read back through the links rather than copied. **Record** is
 * the flat log across everything, narrowed by format, deck, event or dates.
 */
export function GamesPage({ formats }: { formats: FormatRecord[] }) {
  const [tab, setTab] = useState<'events' | 'record'>('events');
  const [openEvent, setOpenEvent] = useState<number | null>(null);

  if (openEvent != null) {
    return (
      <EventPage
        eventId={openEvent}
        formats={formats}
        onBack={() => setOpenEvent(null)}
      />
    );
  }

  return (
    <div className="list-page">
      <div className="list-head">
        <h2>Games</h2>
      </div>
      <div className="list-tabs">
        <button className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>Events</button>
        <button className={tab === 'record' ? 'on' : ''} onClick={() => setTab('record')}>Record</button>
      </div>

      {tab === 'events'
        ? <EventList formats={formats} onOpen={setOpenEvent} />
        : <RecordView formats={formats} onOpenEvent={setOpenEvent} />}

      <BackToTop label="Back to the top" />
    </div>
  );
}

// -- events -------------------------------------------------------------------

function EventList({ formats, onOpen }: {
  formats: FormatRecord[];
  onOpen: (id: number) => void;
}) {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    fetchEvents().then(setEvents).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      <div className="list-head">
        <span className="count">{events.length} event{events.length === 1 ? '' : 's'}</span>
        <button className="btn" onClick={() => setCreating(true)}>New event</button>
      </div>

      {events.map((event) => (
        <button key={event.id} className="trade-row" onClick={() => onOpen(event.id)}>
          <span className="trade-who">{event.name}</span>
          <span className="dim">
            {event.eventDate ?? dayOf(event.createdAt)}
            {event.formatName ? ` · ${event.formatName}` : ''}
          </span>
          <span className="trade-value">
            {event.record.games > 0 ? formatRecord(event.record) : 'no games'}
            {event.spendUsd != null ? ` · ${money(event.spendUsd)}` : ''}
          </span>
        </button>
      ))}

      {events.length === 0 && (
        <p className="empty">
          No events yet. Start one for a draft night, a prerelease or a sealed pool — then link
          the cost pool that bought the cards and the deck you built from them.
        </p>
      )}

      {creating && (
        <EventDialog
          formats={formats}
          onClose={() => setCreating(false)}
          onSaved={(event) => { setCreating(false); load(); onOpen(event.id); }}
        />
      )}
    </>
  );
}

/** One event: what it cost, what was built, and how the night went. */
function EventPage({ eventId, formats, onBack }: {
  eventId: number;
  formats: FormatRecord[];
  onBack: () => void;
}) {
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);

  const load = useCallback(() => {
    fetchEvent(eventId).then(setEvent).catch((e) => setError(e.message));
  }, [eventId]);
  useEffect(load, [load]);

  const remove = async () => {
    if (!event) return;
    if (!confirm(`Delete "${event.name}"? Its games stay on their deck's record.`)) return;
    try { await deleteEvent(event.id); onBack(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (!event) {
    return (
      <div className="list-page">
        <div className="list-head">
          <button className="btn secondary" onClick={onBack}>← Games</button>
        </div>
        {error ? <div className="error">{error}</div> : <p className="loading">Loading event…</p>}
      </div>
    );
  }

  const perCard = event.spendUsd != null && event.poolCardCount > 0
    ? event.spendUsd / event.poolCardCount
    : null;

  return (
    <div className="list-page">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      <div className="list-head">
        <button className="btn secondary" onClick={onBack}>← Games</button>
        <h2>{event.name}</h2>
        <button className="btn secondary" onClick={() => setEditing(true)}>Edit</button>
        <button className="btn secondary cancel" onClick={remove}>Delete</button>
      </div>

      <div className="event-summary">
        <div>
          <span className="dim">When</span>
          <strong>{event.eventDate ?? dayOf(event.createdAt)}</strong>
        </div>
        <div>
          <span className="dim">Format</span>
          <strong>{event.formatName ?? 'None'}</strong>
        </div>
        <div>
          <span className="dim">Spend</span>
          <strong>{money(event.spendUsd)}</strong>
          {event.poolCardCount > 0 && (
            <span className="dim">
              {event.poolCardCount} card{event.poolCardCount === 1 ? '' : 's'}
              {perCard != null ? ` · ${money(perCard)} each` : ''}
            </span>
          )}
        </div>
        <div>
          <span className="dim">Deck</span>
          <strong>{event.deckName ?? 'Not linked'}</strong>
          {event.deckId != null && (
            <span className="dim">
              {event.deckCardCount} card{event.deckCardCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div>
          <span className="dim">Record</span>
          <strong>{formatRecord(event.record)}</strong>
        </div>
      </div>

      {event.notes && <p className="hint">{event.notes}</p>}

      <div className="list-head">
        <h3 className="section-label">Games</h3>
        <button className="btn" onClick={() => setLogging(true)}>Log a game</button>
      </div>

      <GameRows
        games={event.games}
        showDeck={false}
        // Every row here belongs to this event; repeating its name on each
        // would be the one thing on the row that never varies.
        showEvent={false}
        onChanged={load}
        onError={setError}
      />
      {event.games.length === 0 && (
        <p className="empty">
          {event.deckId == null
            ? 'Link a deck first, then log each round against it.'
            : 'No rounds logged yet.'}
        </p>
      )}

      {editing && (
        <EventDialog
          event={event}
          formats={formats}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}
      {logging && (
        <GameLogDialog
          deckId={event.deckId}
          eventId={event.id}
          onClose={() => setLogging(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}

/**
 * Creating or editing an event.
 *
 * The two links are the point of the form: a cost pool (any past cost-pool
 * import batch) and the deck built from it. Both are optional and both can be
 * set later — a draft is usually created before either exists.
 */
function EventDialog({ event, formats, onClose, onSaved }: {
  event?: EventDetail;
  formats: FormatRecord[];
  onClose: () => void;
  onSaved: (event: { id: number }) => void;
}) {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [pools, setPools] = useState<ImportBatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState(event?.name ?? '');
  const [formatCode, setFormatCode] = useState(event?.formatCode ?? 'draft');
  const [date, setDate] = useState(event?.eventDate ?? new Date().toISOString().slice(0, 10));
  const [deckId, setDeckId] = useState<number | ''>(event?.deckId ?? '');
  const [batchId, setBatchId] = useState<number | ''>(event?.importBatchId ?? '');
  const [notes, setNotes] = useState(event?.notes ?? '');

  useEffect(() => {
    fetchDecks().then(setDecks).catch(() => undefined);
    // Only cost pools: an ordinary CSV import batch never bought a draft.
    fetchImportBatches()
      .then((batches) => setPools(batches.filter((b) => b.totalCostUsd != null)))
      .catch(() => undefined);
  }, []);

  const save = async () => {
    if (!name.trim()) { setError('An event needs a name.'); return; }
    setSaving(true);
    setError(null);
    const fields: EventFields & { name: string } = {
      name: name.trim(),
      formatCode: formatCode || null,
      eventDate: date || null,
      deckId: deckId === '' ? null : Number(deckId),
      importBatchId: batchId === '' ? null : Number(batchId),
      notes: notes.trim() || null,
    };
    try {
      const saved = event ? await updateEvent(event.id, fields) : await createEvent(fields);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="porting-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h3>{event ? 'Edit event' : 'New event'}</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}

        <label className="field">
          <span>Name</span>
          <input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="FDN Draft Night"
          />
        </label>

        <div className="game-fields">
          <label className="field">
            <span>Format</span>
            <select value={formatCode ?? ''} onChange={(e) => setFormatCode(e.target.value)}>
              <option value="">No format</option>
              {formats.map((f) => (
                <option key={f.code} value={f.code}>{f.display_name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span>Cost pool</span>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Not linked</option>
            {pools.map((pool) => (
              <option key={pool.id} value={pool.id}>
                {pool.fileName ?? 'Cost pool'} · {dayOf(pool.importedAt)} · {money(pool.totalCostUsd)}
                {` · ${pool.cardsRemaining} cards`}
              </option>
            ))}
          </select>
          <span className="hint">
            The draft or box pool that bought the cards — opened from Collection → Add by set.
            Spend is read from it, never copied here.
          </span>
        </label>

        <label className="field">
          <span>Deck</span>
          <select value={deckId} onChange={(e) => setDeckId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Not linked</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}{d.formatName ? ` · ${d.formatName}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Notes</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="trade-actions">
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : event ? 'Save event' : 'Create event'}
          </button>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// -- the record view ----------------------------------------------------------

function RecordView({ formats, onOpenEvent }: {
  formats: FormatRecord[];
  onOpenEvent: (id: number) => void;
}) {
  const [query, setQuery] = useState<GameQuery>({});
  const [games, setGames] = useState<Game[]>([]);
  const [record, setRecord] = useState<MatchRecord>({ wins: 0, losses: 0, draws: 0, games: 0 });
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);

  const load = useCallback(() => {
    fetchGames(query)
      .then((result) => { setGames(result.games); setRecord(result.record); })
      .catch((e) => setError(e.message));
  }, [query]);
  useEffect(load, [load]);

  useEffect(() => {
    fetchDecks().then(setDecks).catch(() => undefined);
    fetchEvents().then(setEvents).catch(() => undefined);
  }, []);

  const set = (changes: Partial<GameQuery>) => setQuery((current) => {
    const next = { ...current, ...changes };
    // An empty control means "no filter", not "filter on nothing".
    for (const key of Object.keys(next) as Array<keyof GameQuery>) {
      if (next[key] === undefined || next[key] === '') delete next[key];
    }
    return next;
  });

  return (
    <>
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <div className="game-filters">
        <label className="field">
          <span>Format</span>
          <select
            value={query.format ?? ''}
            onChange={(e) => set({ format: e.target.value || undefined })}
          >
            <option value="">Any</option>
            {formats.map((f) => <option key={f.code} value={f.code}>{f.display_name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Deck</span>
          <select
            value={query.deckId ?? ''}
            onChange={(e) => set({ deckId: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">Any</option>
            {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Event</span>
          <select
            value={query.eventId ?? ''}
            onChange={(e) => set({ eventId: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">Any</option>
            {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>From</span>
          <input type="date" value={query.from ?? ''} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="date" value={query.to ?? ''} onChange={(e) => set({ to: e.target.value })} />
        </label>
      </div>

      <div className="list-head">
        <span className="record-chip">{formatRecord(record)}</span>
        <span className="count">
          {record.games} game{record.games === 1 ? '' : 's'}
          {Object.keys(query).length > 0 ? ' matching' : ' logged'}
        </span>
        {Object.keys(query).length > 0 && (
          <button className="btn secondary small" onClick={() => setQuery({})}>Clear filters</button>
        )}
        <button className="btn" onClick={() => setLogging(true)}>Log a game</button>
      </div>

      <GameRows
        games={games}
        showDeck
        onChanged={load}
        onError={setError}
        onOpenEvent={onOpenEvent}
      />
      {games.length === 0 && (
        <p className="empty">
          No games here yet. Log one from a deck's page or with the button above — most games
          belong to no event at all.
        </p>
      )}

      {logging && (
        <GameLogDialog onClose={() => setLogging(false)} onSaved={load} />
      )}
    </>
  );
}

/** The game list itself, shared by an event's page and the record view. */
export function GameRows({
  games, showDeck, showEvent = true, onChanged, onError, onOpenEvent,
}: {
  games: Game[];
  showDeck: boolean;
  /** False inside one event's own page, where the name is on every row. */
  showEvent?: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
  onOpenEvent?: (id: number) => void;
}) {
  const [editing, setEditing] = useState<Game | null>(null);

  const remove = async (game: Game) => {
    if (!confirm(`Delete this ${game.result} against ${opponentsOf(game)}?`)) return;
    try { await deleteGame(game.id); onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="want-rows">
      {games.map((game) => (
        <div className={`game-row ${game.result}`} key={game.id}>
          <span className={`result-chip ${game.result}`}>{game.result}</span>
          <span className="game-main">
            <span className="game-opponents">{opponentsOf(game)}</span>
            {(game.gamesWon != null || game.gamesLost != null) && (
              <span className="dim">
                {game.gamesWon ?? 0}–{game.gamesLost ?? 0}
                {game.gamesDrawn ? `–${game.gamesDrawn}` : ''}
              </span>
            )}
            {showDeck && (
              // A deleted deck leaves the name it had behind, and says so —
              // otherwise the row reads as though the deck were still around.
              <span className="dim">
                {game.deckName ?? 'Unknown deck'}
                {game.deckId == null && <span className="deck-gone"> (deleted)</span>}
              </span>
            )}
            {game.roundNumber != null && <span className="dim">round {game.roundNumber}</span>}
            {showEvent && game.eventName && (
              onOpenEvent
                ? (
                  <button className="linkish" onClick={() => onOpenEvent(game.eventId!)}>
                    {game.eventName}
                  </button>
                )
                : <span className="dim">{game.eventName}</span>
            )}
            {game.notes && <span className="want-notes">{game.notes}</span>}
          </span>
          <span className="dim">{dayOf(game.playedAt)}</span>
          <button className="btn secondary small" onClick={() => setEditing(game)}>Edit</button>
          <button className="btn secondary small cancel" onClick={() => remove(game)}>Delete</button>
        </div>
      ))}

      {editing && (
        <GameLogDialog
          game={editing}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}
