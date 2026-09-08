import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addCollectionLot, decrementCollectionCopy, fetchSetChecklist, imageUrl,
  type CostMethod, type SetRecord, type StorageLocation,
} from '../api.ts';
import { Combobox } from './Combobox.tsx';
import { CostPoolBanner, CostPoolFields, useCostPool } from './CostPoolControls.tsx';

/**
 * Set-scoped entry.
 *
 * Pick a set once, then work through it in collector-number order, which is the
 * order the cards sit in a binder. The set stays chosen after each add, so
 * filling a page is one click per card rather than a fresh search each time.
 */
export function AddBySetTab({
  sets,
  locations,
  onChanged,
}: {
  sets: SetRecord[];
  locations: StorageLocation[];
  onChanged: () => void;
}) {
  const [setCode, setSetCode] = useState('');
  const [cards, setCards] = useState<Awaited<ReturnType<typeof fetchSetChecklist>>>([]);
  const [loading, setLoading] = useState(false);
  const [locationId, setLocationId] = useState(locations.find((l) => l.is_default)?.id ?? locations[0]?.id ?? 0);
  const [finish, setFinish] = useState('nonfoil');
  const [condition, setCondition] = useState('NM');
  const [hideOwned, setHideOwned] = useState(false);
  // "Hide ones I have" hides a snapshot of what you owned when it was switched on
  // (re-taken on each set load), not a live filter — so a card you add during
  // the session stays put and you can keep adding copies of it.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const hideOwnedRef = useRef(false);
  hideOwnedRef.current = hideOwned;
  const snapshotHidden = (list: { printing_id: string; owned_qty: number }[]) =>
    setHiddenIds(new Set(list.filter((c) => c.owned_qty > 0).map((c) => c.printing_id)));
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [toastRemoving, setToastRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setName = (code: string) => sets.find((s) => s.code === code)?.name ?? code.toUpperCase();

  const load = useCallback(() => {
    if (!setCode) { setCards([]); return; }
    setLoading(true);
    fetchSetChecklist(setCode)
      .then((list) => { setCards(list); if (hideOwnedRef.current) snapshotHidden(list); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [setCode]);
  useEffect(load, [load]);

  const costPool = useCostPool({ setCode, setSetCode, setError, reloadCards: load, onChanged });
  const { costMethod, fixedAmount, pooled, ensurePoolOpen, refreshPool } = costPool;

  /** Shows a floating confirmation for ~1.4s — red when it's a removal. */
  const flash = (message: string, removing = false) => {
    setToastRemoving(removing);
    setJustAdded(message);
    setTimeout(() => setJustAdded((current) => (current === message ? null : current)), 1400);
  };

  const add = async (printingId: string, name: string) => {
    setError(null);
    try {
      // Box split and Draft both pool. Open the server-side pool on the first
      // add (so it survives a break), reuse it after, and refresh its running
      // count/per-card afterward.
      const current = await ensurePoolOpen();
      await addCollectionLot({
        printingId, locationId, quantity: 1, finish, condition,
        costMethod: (pooled ? 'box' : costMethod) as CostMethod,
        fixedAmount: costMethod === 'fixed' ? Number(fixedAmount) || 0 : undefined,
        batchId: pooled && current ? current.id : undefined,
      });
      if (pooled) await refreshPool();
      flash(`Added ${name}`);
      // Bump just this card's owned count in place — no full reload, so the grid
      // doesn't flash or jump to the top, and you can click the same card again
      // to add another copy.
      setCards((prev) => prev.map((c) =>
        c.printing_id === printingId ? { ...c, owned_qty: c.owned_qty + 1 } : c));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Undo — remove one copy of a card you just added (long-press a tile). */
  const removeOne = async (printingId: string, name: string) => {
    setError(null);
    try {
      const result = await decrementCollectionCopy({ printingId, locationId, finish, condition });
      if (!result.removed) return; // nothing plainly-added here to take back
      flash(`Removed ${name}`, true);
      setCards((prev) => prev.map((c) =>
        c.printing_id === printingId ? { ...c, owned_qty: Math.max(0, c.owned_qty - 1) } : c));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Tap adds a copy; press-and-hold removes one. One press at a time, so a
  // single timer and flag are enough for the whole grid.
  const pressTimer = useRef<number | null>(null);
  const longFired = useRef(false);
  const startPress = (printingId: string, name: string) => {
    longFired.current = false;
    pressTimer.current = window.setTimeout(() => { longFired.current = true; removeOne(printingId, name); }, 500);
  };
  const endPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };
  const tapTile = (printingId: string, name: string) => {
    if (longFired.current) { longFired.current = false; return; } // the hold already handled it
    add(printingId, name);
  };

  const shown = hideOwned ? cards.filter((c) => !hiddenIds.has(c.printing_id)) : cards;
  const ownedCount = cards.filter((c) => c.owned_qty > 0).length;

  return (
    <div className="set-entry">
      {/* The settings stay put while you work through a stack, so each card is
          one click rather than a re-pick of every attribute. */}
      <div className="entry-bar">
        <label>
          <span>Set</span>
          <Combobox
            options={sets.map((s) => ({ value: s.code, label: `${s.name} (${s.code.toUpperCase()})` }))}
            value={setCode}
            onChange={setSetCode}
            placeholder="Search sets…"
          />
        </label>
        <label>
          <span>Into</span>
          <select value={locationId} onChange={(e) => setLocationId(Number(e.target.value))}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </label>
        <label>
          <span>Finish</span>
          <select value={finish} onChange={(e) => setFinish(e.target.value)}>
            <option value="nonfoil">Non-foil</option>
            <option value="foil">Foil</option>
            <option value="etched">Etched</option>
          </select>
        </label>
        <label>
          <span>Condition</span>
          <select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {['NM', 'M', 'LP', 'MP', 'HP', 'DMG'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <CostPoolFields state={costPool} />
        <label className="check">
          <input
            type="checkbox"
            checked={hideOwned}
            onChange={(e) => {
              const on = e.target.checked;
              setHideOwned(on);
              if (on) snapshotHidden(cards); else setHiddenIds(new Set());
            }}
          />
          Hide ones I have
        </label>
      </div>

      <CostPoolBanner state={costPool} setCode={setCode} setSetCode={setSetCode} setName={setName} />

      {error && <div className="error">{error}</div>}
      {/* Floats over the grid rather than sitting in the flow, so a rapid string
          of adds doesn't shove the card list up and down. */}
      {justAdded && <div className={`add-toast${toastRemoving ? ' removed' : ''}`} role="status">{justAdded}</div>}

      {!setCode && (
        <p className="empty">
          Pick a set to work through it in collector-number order — the order the cards
          sit in a binder.
        </p>
      )}
      {loading && <p className="loading">Loading set…</p>}

      {setCode && !loading && (
        <>
          <div className="results-head">
            <span className="count">
              {ownedCount} of {cards.length} owned · showing {shown.length}
            </span>
            <span className="hint">Tap to add · press and hold to remove one</span>
          </div>
          <div className="entry-grid">
            {shown.map((card) => (
              <button
                className={`entry-tile${card.owned_qty > 0 ? ' owned' : ''}`}
                key={card.printing_id}
                onClick={() => tapTile(card.printing_id, card.name)}
                onPointerDown={() => startPress(card.printing_id, card.name)}
                onPointerUp={endPress}
                onPointerLeave={endPress}
                onContextMenu={(e) => e.preventDefault()}
                title={`Tap to add ${card.name} · hold to remove one`}
              >
                {card.image_small
                  ? <img src={imageUrl(card.printing_id, 'small')} alt={card.name} loading="lazy" decoding="async" draggable={false} />
                  : <div className="placeholder">{card.name}</div>}
                <span className="entry-number">#{card.collector_number}</span>
                {card.owned_qty > 0 && <span className="tile-owned">{card.owned_qty}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
