import { useCallback, useEffect, useState } from 'react';
import {
  addTradeItem, completeTrade, createTrade, deleteTrade, fetchCollectionCard,
  fetchLocations, fetchTrade, fetchTrades, removeTradeItem, updateTrade, updateTradeItem,
  type CompleteTradeResult, type StorageLocation, type Trade, type TradeSummary,
} from '../api.ts';
import { CardPicker } from './CardPicker.tsx';

const money = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);
const sumValue = (items: Trade['items'], dir: 'out' | 'in') =>
  items.filter((i) => i.direction === dir).reduce((t, i) => t + (i.unitValueUsd ?? 0) * i.quantity, 0);

export function TradesPage({ onAlertsChanged }: { onAlertsChanged?: () => void }) {
  const [trades, setTrades] = useState<TradeSummary[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchTrades().then(setTrades).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const start = async () => {
    const name = prompt('Who are you trading with?');
    if (!name?.trim()) return;
    try { const t = await createTrade({ counterpartyName: name.trim() }); setOpenId(t.id); load(); }
    catch (e: any) { setError(e.message); }
  };

  if (openId != null) {
    return <TradeEditor
      tradeId={openId}
      onClose={() => { setOpenId(null); load(); }}
      onCompleted={() => { onAlertsChanged?.(); }}
    />;
  }

  const drafts = trades.filter((t) => t.status === 'draft');
  const history = trades.filter((t) => t.status !== 'draft');

  return (
    <div className="list-page">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      <div className="list-head">
        <h2>Trades</h2>
        <button className="btn" onClick={start}>New trade</button>
      </div>

      {drafts.length > 0 && <h3 className="section-label">Drafts</h3>}
      {drafts.map((t) => (
        <button key={t.id} className="trade-row draft" onClick={() => setOpenId(t.id)}>
          <span className="trade-who">{t.counterpartyName}</span>
          <span className="dim">draft{t.tradeDate ? ` · ${t.tradeDate}` : ''}</span>
        </button>
      ))}

      {history.length > 0 && <h3 className="section-label">History</h3>}
      {history.map((t) => (
        <button key={t.id} className="trade-row" onClick={() => setOpenId(t.id)}>
          <span className="trade-who">{t.counterpartyName}</span>
          <span className="dim">{t.status === 'cancelled' ? 'cancelled' : (t.completedAt?.slice(0, 10) ?? t.tradeDate)}</span>
          {t.status === 'completed' && (
            <span className="trade-value">out {money(t.valueOutUsd)} · in {money(t.valueInUsd)}</span>
          )}
        </button>
      ))}
      {trades.length === 0 && <p className="empty">No trades yet. Start one when you're at the table.</p>}
    </div>
  );
}

function TradeEditor({ tradeId, onClose, onCompleted }: {
  tradeId: number; onClose: () => void; onCompleted: () => void;
}) {
  const [trade, setTrade] = useState<Trade | null>(null);
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [addingOut, setAddingOut] = useState(false);
  const [addingIn, setAddingIn] = useState(false);
  const [confirm, setConfirm] = useState<CompleteTradeResult | null>(null);
  const [done, setDone] = useState<CompleteTradeResult | null>(null);

  useEffect(() => { fetchTrade(tradeId).then(setTrade).catch((e) => setError(e.message)); }, [tradeId]);
  useEffect(() => { fetchLocations().then(setLocations).catch(() => {}); }, []);

  const readOnly = trade?.status !== 'draft';

  /**
   * Picking a card drops it straight into the giving-away list at quantity 1 —
   * no separate "which copies" step. The lot is chosen automatically (the
   * largest owned lot); completion draws copies FIFO across lots anyway. The
   * quantity is then edited in the list, capped at what you own.
   */
  const pickOut = async (oracleId: string, name: string) => {
    const detail = await fetchCollectionCard(oracleId);
    const owned = detail.lots.filter((l) => l.quantity > 0)
      .sort((a, b) => b.quantity - a.quantity);
    if (owned.length === 0) { setError(`You don't own any ${name} to trade away.`); return; }
    const lot = owned[0];
    setTrade(await addTradeItem(tradeId, {
      direction: 'out', printingId: lot.printing_id, quantity: 1,
      finish: lot.finish, condition: lot.condition, language: lot.language,
      sourceCollectionItemId: lot.id, unitValueUsd: lot.unit_value_usd,
    }));
  };

  const setItemQty = async (item: Trade['items'][number], next: number) => {
    const capped = item.direction === 'out' ? Math.min(next, item.ownedQuantity) : next;
    setTrade(await updateTradeItem(tradeId, item.id, { quantity: Math.max(1, capped) }));
  };

  const complete = async (force: boolean) => {
    try {
      const { result } = await completeTrade(tradeId, force);
      if (result.needsConfirmation) { setConfirm(result); return; }
      setConfirm(null); setDone(result);
      setTrade(await fetchTrade(tradeId));
      onCompleted();
    } catch (e: any) { setError(e.message); }
  };

  if (!trade) return <div className="list-page"><p className="loading">Loading…</p></div>;

  const out = trade.items.filter((i) => i.direction === 'out');
  const incoming = trade.items.filter((i) => i.direction === 'in');
  const valueOut = sumValue(trade.items, 'out');
  const valueIn = sumValue(trade.items, 'in');

  return (
    <div className="list-page trade-editor">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <div className="list-head">
        <button className="btn secondary" onClick={onClose}>← Trades</button>
        <input className="trade-name-input" value={trade.counterpartyName} disabled={readOnly}
          onChange={(e) => setTrade({ ...trade, counterpartyName: e.target.value })}
          onBlur={(e) => !readOnly && updateTrade(tradeId, { counterpartyName: e.target.value })} />
        {!readOnly && (
          <input type="date" value={trade.tradeDate ?? ''}
            onChange={(e) => { setTrade({ ...trade, tradeDate: e.target.value }); updateTrade(tradeId, { tradeDate: e.target.value || null }); }} />
        )}
        <span className={`verdict-chip ${trade.status === 'completed' ? 'ok' : ''}`}>{trade.status}</span>
      </div>

      {done && (
        <div className="trade-summary">
          Trade completed. {done.fulfilledWants?.length ? `${done.fulfilledWants.length} want(s) fulfilled. ` : ''}
          {done.clampedTradeListItems ? `${done.clampedTradeListItems} trade-list item(s) clamped. ` : ''}
          {done.resolvedConflicts?.length ? `${done.resolvedConflicts.length} deck claim(s) reduced.` : ''}
        </div>
      )}

      <div className="trade-columns">
        <section className="trade-col">
          <h3>Giving away <span className="trade-value">{money(valueOut)}</span></h3>
          {out.map((item) => (
            <div className="trade-item" key={item.id}>
              {!readOnly ? (
                <span className="qty">
                  <button onClick={() => setItemQty(item, item.quantity - 1)} disabled={item.quantity <= 1} aria-label="One fewer">−</button>
                  <span>{item.quantity}</span>
                  <button onClick={() => setItemQty(item, item.quantity + 1)} disabled={item.quantity >= item.ownedQuantity} aria-label="One more">+</button>
                </span>
              ) : <span className="dim">{item.quantity}×</span>}
              <span className="want-name">{item.name} <span className="dim">{String(item.setCode).toUpperCase()} · {item.condition} · own {item.ownedQuantity}</span></span>
              <span className="trade-value">{money((item.unitValueUsd ?? 0) * item.quantity)}</span>
              {!readOnly && <button className="row-remove" onClick={async () => setTrade(await removeTradeItem(tradeId, item.id))}>×</button>}
            </div>
          ))}
          {!readOnly && (addingOut
            ? <>
                <CardPicker ownedOnly placeholder="Find an owned card to give…" onPick={(c) => pickOut(c.oracleId, c.name)} />
                <button className="btn secondary small" onClick={() => setAddingOut(false)}>Done adding</button>
              </>
            : <button className="btn secondary small" onClick={() => setAddingOut(true)}>+ Add outgoing card</button>)}
        </section>

        <section className="trade-col">
          <h3>Receiving <span className="trade-value">{money(valueIn)}</span></h3>
          {incoming.map((item) => (
            <div className="trade-item" key={item.id}>
              {!readOnly ? (
                <span className="qty">
                  <button onClick={() => setItemQty(item, item.quantity - 1)} disabled={item.quantity <= 1} aria-label="One fewer">−</button>
                  <span>{item.quantity}</span>
                  <button onClick={() => setItemQty(item, item.quantity + 1)} aria-label="One more">+</button>
                </span>
              ) : <span className="dim">{item.quantity}×</span>}
              <span className="want-name">{item.name}</span>
              {!readOnly ? (
                <select value={item.destinationLocationId ?? ''}
                  onChange={async (e) => setTrade(await updateTradeItem(tradeId, item.id, { destinationLocationId: e.target.value ? Number(e.target.value) : null }))}>
                  <option value="">Unsorted</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              ) : <span className="dim">{item.condition}</span>}
              <span className="trade-value">{money((item.unitValueUsd ?? 0) * item.quantity)}</span>
              {!readOnly && <button className="row-remove" onClick={async () => setTrade(await removeTradeItem(tradeId, item.id))}>×</button>}
            </div>
          ))}
          {!readOnly && (addingIn
            ? <>
                <CardPicker placeholder="Find a card you're getting…" onPick={async (c) => {
                  if (!c.printingId) { setError(`No printing for ${c.name}.`); return; }
                  // Keep the picker open so several incoming cards can be added.
                  setTrade(await addTradeItem(tradeId, { direction: 'in', printingId: c.printingId, quantity: 1 }));
                }} />
                <button className="btn secondary small" onClick={() => setAddingIn(false)}>Done adding</button>
              </>
            : <button className="btn secondary small" onClick={() => setAddingIn(true)}>+ Add incoming card</button>)}
        </section>
      </div>

      {confirm?.needsConfirmation && (
        <div className="conflict-panel">
          <strong>Some cards you're trading away are used by a deck:</strong>
          <ul>{confirm.conflicts?.map((c) => (
            <li key={c.oracleId}>{c.name} — trading {c.tradingAway}, own {c.owned}, {c.allocated} claimed by decks.</li>
          ))}</ul>
          <div className="btnrow">
            <button className="btn" onClick={() => complete(true)}>Complete anyway (reduce deck claims)</button>
            <button className="btn secondary" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {!readOnly && !confirm && (
        <div className="trade-actions">
          <button className="btn primary" onClick={() => complete(false)} disabled={out.length === 0 && incoming.length === 0}>
            Complete trade
          </button>
          <button className="btn secondary" onClick={async () => { if (confirmDelete()) { await deleteTrade(tradeId); onClose(); } }}>Delete draft</button>
        </div>
      )}
    </div>
  );
}

const confirmDelete = () => confirm('Delete this draft trade? It has not touched your collection.');
