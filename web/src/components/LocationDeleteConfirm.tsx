import { useEffect, useState } from 'react';
import {
  deleteLocation, fetchLocationImpact,
  type LocationImpact, type LocationRestore, type StorageLocation,
} from '../api.ts';

/**
 * The confirm under a location's ×, which says what the delete will do before
 * it does it: how many cards move, to where (the user picks; the default
 * location first), and which decks lose their home. Nothing is sent until
 * Delete is pressed.
 *
 * The delete hands back a restore record; `onDeleted` gets it so the page can
 * put the undo on its stack.
 */
export function LocationDeleteConfirm({ location, locations, onCancel, onBusy, onDeleted }: {
  location: StorageLocation;
  locations: StorageLocation[];
  onCancel: () => void;
  /** True while the delete runs, so the page can hold every other × still. */
  onBusy: (busy: boolean) => void;
  onDeleted: (result: { locations: StorageLocation[]; restore: LocationRestore }) => void;
}) {
  const others = locations.filter((l) => l.id !== location.id);
  const [moveTo, setMoveTo] = useState<number | null>(
    (others.find((l) => l.is_default) ?? others[0])?.id ?? null,
  );
  const [impact, setImpact] = useState<LocationImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLocationImpact(location.id).then(setImpact).catch((e) => setError(e.message));
  }, [location.id]);

  const holdsCards = (impact?.cards ?? location.card_count) > 0;
  const blocked = holdsCards && moveTo === null;

  const confirm = async () => {
    setBusy(true); onBusy(true); setError(null);
    try {
      onDeleted(await deleteLocation(location.id, holdsCards ? moveTo ?? undefined : undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); onBusy(false);
    }
  };

  const cards = impact?.cards ?? location.card_count;
  return (
    <div className="loc-confirm" role="group" aria-label={`Delete ${location.name}?`}>
      <p>
        <strong>Delete {location.name}?</strong>
        {' '}
        {holdsCards ? (
          <>
            Its {cards.toLocaleString()} card{cards === 1 ? '' : 's'}
            {impact && ` (${impact.lots.toLocaleString()} lot${impact.lots === 1 ? '' : 's'})`} move to
          </>
        ) : 'It holds no cards.'}
      </p>
      {holdsCards && (
        others.length > 0 ? (
          <select
            aria-label="Move its cards to"
            value={moveTo ?? ''}
            disabled={busy}
            onChange={(e) => setMoveTo(Number(e.target.value))}
          >
            {others.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        ) : <p className="hint bad">Create another location first so these cards have somewhere to go.</p>
      )}
      {impact && impact.homeOf.length > 0 && (
        <p className="note">
          {impact.homeOf.map((d) => d.name).join(', ')}
          {impact.homeOf.length === 1 ? ' loses its' : ' lose their'} home location.
        </p>
      )}
      {error && <p className="hint bad">{error}</p>}
      <div className="btnrow">
        <button className="btn danger" onClick={confirm} disabled={busy || blocked || !impact}>
          {busy ? 'Deleting…' : 'Delete'}
        </button>
        <button className="btn secondary" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
