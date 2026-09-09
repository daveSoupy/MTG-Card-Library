import { useEffect, useState } from 'react';
import {
  fetchDecks, fetchEvents, logGame, updateGame,
  type DeckSummary, type EventSummary, type Game, type GameResult,
} from '../api.ts';

const RESULTS: Array<[GameResult, string]> = [
  ['win', 'Win'],
  ['loss', 'Loss'],
  ['draw', 'Draw'],
];

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The date part of a `played_at`, and the timestamp to send back for it.
 *
 * Games are timestamped rather than dated because several are played in one
 * night and the round order has to survive a reload. The form only asks for a
 * day, so today keeps the actual clock time and a back-dated game is filed at
 * midday — early enough to sort before tonight's games, late enough to read as
 * "that day" in any timezone the log is looked at from.
 */
const timestampFor = (date: string) =>
  date === today() ? new Date().toISOString() : `${date}T12:00:00Z`;

const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

/**
 * Logging a game: opponents, result, and the optional detail underneath it.
 *
 * The same form logs the constructed game at the kitchen table — open the deck,
 * say who you played and how it went — and a round inside an event, where the
 * event and round number are filled in for you.
 */
export function GameLogDialog({
  deckId,
  eventId,
  game,
  lockDeck = false,
  onClose,
  onSaved,
}: {
  /** Pre-selected deck. Required for a new game unless one is picked here. */
  deckId?: number | null;
  /** Pre-selected event, when logging a round from an event's own page. */
  eventId?: number | null;
  /** An existing game to edit, rather than a new one. */
  game?: Game | null;
  /** True on a deck's own page, where the deck is not up for debate. */
  lockDeck?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deck, setDeck] = useState<number | ''>(game?.deckId ?? deckId ?? '');
  const [event, setEvent] = useState<number | ''>(game?.eventId ?? eventId ?? '');
  const [result, setResult] = useState<GameResult>(game?.result ?? 'win');
  const [opponents, setOpponents] = useState(game?.opponents ?? '');
  const [date, setDate] = useState(game?.playedAt?.slice(0, 10) ?? today());
  const [round, setRound] = useState(game?.roundNumber != null ? String(game.roundNumber) : '');
  const [won, setWon] = useState(game?.gamesWon != null ? String(game.gamesWon) : '');
  const [lost, setLost] = useState(game?.gamesLost != null ? String(game.gamesLost) : '');
  const [drawn, setDrawn] = useState(game?.gamesDrawn != null ? String(game.gamesDrawn) : '');
  const [notes, setNotes] = useState(game?.notes ?? '');

  useEffect(() => {
    if (!lockDeck) fetchDecks().then(setDecks).catch(() => undefined);
    fetchEvents().then(setEvents).catch(() => undefined);
  }, [lockDeck]);

  const save = async () => {
    if (deck === '') { setError('Which deck did you play?'); return; }
    setSaving(true);
    setError(null);
    const fields = {
      deckId: Number(deck),
      eventId: event === '' ? null : Number(event),
      result,
      opponents: opponents.trim() || null,
      playedAt: timestampFor(date),
      roundNumber: numberOrNull(round),
      gamesWon: numberOrNull(won),
      gamesLost: numberOrNull(lost),
      gamesDrawn: numberOrNull(drawn),
      notes: notes.trim() || null,
    };
    try {
      if (game) await updateGame(game.id, fields);
      else await logGame(fields);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="porting-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h3>{game ? 'Edit game' : 'Log a game'}</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}

        {!lockDeck && (
          <label className="field">
            <span>Deck</span>
            <select value={deck} onChange={(e) => setDeck(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose a deck…</option>
              {decks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}{d.formatName ? ` · ${d.formatName}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="field">
          <span>Result</span>
          <div className="result-picker">
            {RESULTS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`btn secondary${result === value ? ' on' : ''}`}
                aria-pressed={result === value}
                onClick={() => setResult(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span>Opponents</span>
          <input
            value={opponents}
            onChange={(e) => setOpponents(e.target.value)}
            placeholder="Dave, Sam, Priya"
          />
          <span className="hint">
            One game, however many people were at the table — separate a pod with commas.
          </span>
        </label>

        <div className="game-fields">
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Event</span>
            <select value={event} onChange={(e) => setEvent(e.target.value ? Number(e.target.value) : '')}>
              <option value="">No event</option>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}{ev.eventDate ? ` · ${ev.eventDate}` : ''}
                </option>
              ))}
            </select>
          </label>
          {/* Round only means anything inside an event, so it only appears there. */}
          {event !== '' && (
            <label className="field" style={{ width: 90 }}>
              <span>Round</span>
              <input type="number" min="1" value={round} onChange={(e) => setRound(e.target.value)} />
            </label>
          )}
        </div>

        <div className="field">
          <span>Games (optional)</span>
          <div className="game-fields">
            <label className="field" style={{ width: 80 }}>
              <span>Won</span>
              <input type="number" min="0" value={won} onChange={(e) => setWon(e.target.value)} />
            </label>
            <label className="field" style={{ width: 80 }}>
              <span>Lost</span>
              <input type="number" min="0" value={lost} onChange={(e) => setLost(e.target.value)} />
            </label>
            <label className="field" style={{ width: 80 }}>
              <span>Drawn</span>
              <input type="number" min="0" value={drawn} onChange={(e) => setDrawn(e.target.value)} />
            </label>
          </div>
          <span className="hint">The Bo3 breakdown beneath the match result — 2–1, say.</span>
        </div>

        <label className="field">
          <span>Notes</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Mulliganed to five, flooded out…"
          />
        </label>

        <div className="trade-actions">
          <button className="btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : game ? 'Save game' : 'Log game'}
          </button>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
