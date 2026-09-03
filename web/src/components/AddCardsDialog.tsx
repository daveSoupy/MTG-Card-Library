import { useEffect, useState } from 'react';
import {
  addCollectionLot, fetchCard, imageUrl,
  type CardDetail, type CardPrinting, type StorageLocation,
} from '../api.ts';

const CONDITIONS = [
  ['NM', 'Near Mint'], ['M', 'Mint'], ['LP', 'Lightly Played'],
  ['MP', 'Moderately Played'], ['HP', 'Heavily Played'], ['DMG', 'Damaged'],
  ['unknown', 'Unknown'],
] as const;

const FINISHES = [['nonfoil', 'Non-foil'], ['foil', 'Foil'], ['etched', 'Etched']] as const;

const KINDS = [
  ['purchase', 'Bought'], ['trade', 'Traded for'], ['gift', 'Gift'],
  ['pull', 'Opened in a pack'], ['unknown', "Don't know"],
] as const;

/**
 * Adds copies to the collection.
 *
 * The printing matters as much as the card — price varies enormously between
 * printings — so the printing is chosen explicitly rather than assumed, and
 * defaults to the one already on screen.
 */
export function AddCardsDialog({
  oracleId,
  printingId,
  locations,
  onClose,
  onAdded,
}: {
  oracleId: string;
  printingId?: string | null;
  locations: StorageLocation[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [card, setCard] = useState<CardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedPrinting, setSelectedPrinting] = useState<string | null>(printingId ?? null);
  const [locationId, setLocationId] = useState<number>(
    locations.find((l) => l.is_default)?.id ?? locations[0]?.id ?? 0,
  );
  const [quantity, setQuantity] = useState('1');
  const [finish, setFinish] = useState('nonfoil');
  const [condition, setCondition] = useState('NM');
  const [cost, setCost] = useState('');
  const [acquiredAt, setAcquiredAt] = useState('');
  const [kind, setKind] = useState('purchase');
  const [override, setOverride] = useState('');
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    fetchCard(oracleId)
      .then((detail) => {
        setCard(detail);
        setSelectedPrinting((current) => current ?? detail.printings[0]?.id ?? null);
      })
      .catch((e) => setError(e.message));
  }, [oracleId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const printing: CardPrinting | undefined =
    card?.printings.find((p) => p.id === selectedPrinting) ?? card?.printings[0];

  const submit = async () => {
    if (!selectedPrinting || !locationId) return;
    setBusy(true);
    setError(null);
    try {
      await addCollectionLot({
        printingId: selectedPrinting,
        locationId,
        quantity: Math.max(1, Number(quantity) || 1),
        finish,
        condition,
        acquiredUnitCost: cost === '' ? null : Number(cost),
        acquiredAt: acquiredAt || null,
        acquisitionKind: kind,
        priceOverride: override === '' ? null : Number(override),
      });
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="add-card-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h2>{card?.name ?? 'Add cards'}</h2>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
        </div>

        {error && <div className="error">{error}</div>}
        {!card && !error && <p className="loading">Loading…</p>}

        {card && (
          <div className="add-card-body">
            <div className="add-card-art">
              {printing && (
                <img src={imageUrl(printing.id, 'normal')} alt={card.name} loading="lazy" />
              )}
            </div>

            <div className="add-card-form">
              <label>
                <span>Printing</span>
                <select
                  value={selectedPrinting ?? ''}
                  onChange={(e) => setSelectedPrinting(e.target.value)}
                >
                  {card.printings.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.setName} #{p.collectorNumber}
                      {p.priceUsd != null ? ` — $${p.priceUsd.toFixed(2)}` : ''}
                      {p.ownedQuantity > 0 ? ` (own ${p.ownedQuantity})` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <div className="row">
                <label style={{ flex: 1 }}>
                  <span>Where</span>
                  <select value={locationId} onChange={(e) => setLocationId(Number(e.target.value))}>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </label>
                <label style={{ width: 84 }}>
                  <span>How many</span>
                  <input
                    type="number" min="1" value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                </label>
              </div>

              <div className="row">
                <label style={{ flex: 1 }}>
                  <span>Finish</span>
                  <select value={finish} onChange={(e) => setFinish(e.target.value)}>
                    {FINISHES.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  <span>Condition</span>
                  <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                    {CONDITIONS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <button className="linkish" onClick={() => setShowDetail((v) => !v)}>
                {showDetail ? 'Hide' : 'Add'} purchase details
              </button>

              {showDetail && (
                <>
                  <div className="row">
                    <label style={{ flex: 1 }}>
                      <span>Paid each</span>
                      <input
                        type="number" min="0" step="0.01" placeholder="—"
                        value={cost} onChange={(e) => setCost(e.target.value)}
                      />
                    </label>
                    <label style={{ flex: 1 }}>
                      <span>When</span>
                      <input
                        type="date" value={acquiredAt}
                        onChange={(e) => setAcquiredAt(e.target.value)}
                      />
                    </label>
                  </div>
                  <label>
                    <span>How you got it</span>
                    <select value={kind} onChange={(e) => setKind(e.target.value)}>
                      {KINDS.map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Value override</span>
                    <input
                      type="number" min="0" step="0.01" placeholder="use market price"
                      value={override} onChange={(e) => setOverride(e.target.value)}
                    />
                  </label>
                  <p className="note">
                    Leave the price blank if you do not know it — an unknown cost is
                    recorded as unknown rather than as free, so it never inflates your gain.
                  </p>
                </>
              )}

              <div className="btnrow">
                <button className="btn" onClick={submit} disabled={busy || !selectedPrinting}>
                  {busy ? 'Adding…' : `Add ${quantity || 1}`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
