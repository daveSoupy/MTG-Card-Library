import { useEffect, useMemo, useState } from 'react';
import {
  fetchCard, fetchCollectionCard, updateTradeItem,
  type CardPrinting, type CollectionLot, type Trade, type TradeItem,
} from '../api.ts';
import { Combobox } from './Combobox.tsx';

const money = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);
const FINISHES = ['nonfoil', 'foil', 'etched'] as const;
const FINISH_LABEL: Record<string, string> = { nonfoil: 'Non-foil', foil: 'Foil', etched: 'Etched' };

const priceFor = (p: CardPrinting | undefined, finish: string): number | null =>
  !p ? null : finish === 'foil' ? p.priceUsdFoil : p.priceUsd;

/**
 * Choosing which printing (and finish) a trade item is — so a $1 Sol Ring and a
 * $60 foil Sol Ring aren't the same line. Incoming cards can be any printing;
 * outgoing ones are limited to the copies you actually own. Picking a printing
 * fills in its market price, which you can then edit to the agreed value.
 */
export function TradeItemDialog({ trade, item, onClose, onSaved }: {
  trade: Trade;
  item: TradeItem;
  onClose: () => void;
  onSaved: (deck: Trade) => void;
}) {
  const [printings, setPrintings] = useState<CardPrinting[]>([]);
  const [lots, setLots] = useState<CollectionLot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [printingId, setPrintingId] = useState(item.printingId);
  const [finish, setFinish] = useState(item.finish);
  const [value, setValue] = useState(item.unitValueUsd != null ? String(item.unitValueUsd) : '');

  const outgoing = item.direction === 'out';

  useEffect(() => {
    if (outgoing) {
      fetchCollectionCard(item.oracleId)
        .then((d) => setLots(d.lots.filter((l) => l.quantity > 0)))
        .catch((e) => setError(e.message));
    } else {
      fetchCard(item.oracleId)
        .then((c) => setPrintings(c.printings.filter((p) => !p.isDigital)))
        .catch((e) => setError(e.message));
    }
  }, [item.oracleId, outgoing]);

  // Incoming: a printing/finish change refills the value with that market price.
  const chosenPrinting = useMemo(() => printings.find((p) => p.id === printingId), [printings, printingId]);
  const setPrinting = (id: string) => {
    setPrintingId(id);
    const market = priceFor(printings.find((p) => p.id === id), finish);
    if (market != null) setValue(String(market));
  };
  const setFinishAndPrice = (next: string) => {
    setFinish(next);
    const market = priceFor(chosenPrinting, next);
    if (market != null) setValue(String(market));
  };

  // Outgoing: choosing an owned lot sets its printing, finish, condition, value.
  const chooseLot = (lotId: string) => {
    const lot = lots.find((l) => String(l.id) === lotId);
    if (!lot) return;
    setPrintingId(lot.printing_id);
    setFinish(lot.finish);
    if (lot.unit_value_usd != null) setValue(String(lot.unit_value_usd));
  };
  const currentLot = outgoing
    ? lots.find((l) => l.printing_id === printingId && l.finish === finish)
    : undefined;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const changes: Record<string, unknown> = {
        printingId,
        finish,
        unitValueUsd: value === '' ? null : Number(value),
      };
      if (outgoing && currentLot) {
        changes.condition = currentLot.condition;
        changes.sourceCollectionItemId = currentLot.id;
      }
      onSaved(await updateTradeItem(trade.id, item.id, changes));
      onClose();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="sync-overlay" onClick={onClose}>
      <div className="porting-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="syntax-head">
          <h3>{item.name}</h3>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>

        {error && <div className="error">{error}</div>}

        <label className="field">
          <span>Printing</span>
          {outgoing ? (
            lots.length === 0
              ? <p className="hint">No owned copies to choose from.</p>
              : <Combobox
                  value={currentLot ? String(currentLot.id) : ''}
                  onChange={chooseLot}
                  placeholder="Choose an owned copy…"
                  options={lots.map((l) => ({
                    value: String(l.id),
                    label: `${String(l.set_code).toUpperCase()} #${l.collector_number}`
                      + `${l.finish !== 'nonfoil' ? ` ${l.finish}` : ''} · ${l.condition}`
                      + ` · ×${l.quantity} · ${money(l.unit_value_usd)}`,
                  }))}
                />
          ) : (
            <Combobox
              value={printingId}
              onChange={setPrinting}
              placeholder="Search printings…"
              options={printings.map((p) => ({
                value: p.id,
                label: `${p.setName} #${p.collectorNumber} · ${money(priceFor(p, finish))}`,
              }))}
            />
          )}
        </label>

        {!outgoing && (
          <label className="field">
            <span>Finish</span>
            <select value={finish} onChange={(e) => setFinishAndPrice(e.target.value)}>
              {FINISHES.map((f) => <option key={f} value={f}>{FINISH_LABEL[f]}</option>)}
            </select>
          </label>
        )}

        <label className="field">
          <span>Value each (USD)</span>
          <input
            type="number" step="0.01" min="0" value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="market"
          />
        </label>

        <div className="btnrow">
          <button className="btn" onClick={save} disabled={saving}>Save</button>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
