import { useCallback, useEffect, useState } from 'react';
import { fetchDeckGames, formatRecord, type Game, type MatchRecord } from '../api.ts';
import { GameLogDialog } from './GameLogDialog.tsx';
import { GameRows } from './GamesPage.tsx';

/**
 * A deck's own match log: its lifetime record and the games behind it.
 *
 * Event games and kitchen-table games sit in one list on purpose — the record
 * is the deck's, not the event's, and a Tuesday game against a friend counts
 * exactly as much toward it as round 3 of a draft.
 */
export function DeckGamesPanel({ deckId, onClose, onChanged }: {
  deckId: number;
  onClose: () => void;
  /** The header chip outside this panel tracks the same record. */
  onChanged: () => void;
}) {
  const [games, setGames] = useState<Game[]>([]);
  const [record, setRecord] = useState<MatchRecord>({ wins: 0, losses: 0, draws: 0, games: 0 });
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(false);

  const load = useCallback(() => {
    fetchDeckGames(deckId)
      .then((result) => { setGames(result.games); setRecord(result.record); })
      .catch((e) => setError(e.message));
    onChanged();
  }, [deckId, onChanged]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="playtest-card" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>Games <span className="record-chip">{formatRecord(record)}</span></h2>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

        <div className="list-head">
          <span className="count">
            {record.games} game{record.games === 1 ? '' : 's'} with this deck
          </span>
          <button className="btn" onClick={() => setLogging(true)}>Log a game</button>
        </div>

        <GameRows
          games={games}
          showDeck={false}
          onChanged={load}
          onError={setError}
        />
        {games.length === 0 && (
          <p className="empty">No games logged with this deck yet.</p>
        )}

        {logging && (
          <GameLogDialog
            deckId={deckId}
            lockDeck
            onClose={() => setLogging(false)}
            onSaved={load}
          />
        )}
      </div>
    </div>
  );
}
