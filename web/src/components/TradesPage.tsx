import { useCallback, useEffect, useState } from 'react';
import {
  addTradeItem, completeTrade, createTrade, deleteTrade, fetchCollectionCard,
  fetchLocations, fetchTrade, fetchTrades, removeTradeItem, updateTrade, updateTradeItem,
  ApiError, type CompleteTradeResult, type StorageLocation, type Trade, type TradeSummary,
} from '../api.ts';
import { CardPicker } from './CardPicker.tsx';
import { TradeItemDialog } from './TradeItemDialog.tsx';
import { BackToTop } from './BackToTop.tsx';
import { UndoToast } from './UndoToast.tsx';
import { useUndoShortcuts, useUndoStack } from '../undo.ts';

const money = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);
const sumValue = (items: Trade['items'], dir: 'out' | 'in') =>
  items.filter((i) => i.direction === dir).reduce((t, i) => t + (i.unitValueUsd ?? 0) * i.quantity, 0);

/**
 * An outgoing card the collection can't supply — its lot was edited or deleted
 * after the trade was drafted. Not a deck conflict: there is nothing to
 * "complete anyway" past, so the server refuses and this page says why.
 */
interface TradeShortfall { itemId?: number; oracleId: string; name: string; requested: number; found: number; }
type CompleteResult = CompleteTradeResult & { shortfalls?: TradeShortfall[] };

const isShort = (item: Trade['items'][number]) =>
  item.direction === 'out' && item.quantity > item.ownedQuantity;

export function TradesPage({ openId, onOpen, onAlertsChanged }: {
  /** The trade being edited, or null for the list. Owned by the URL
   *  (`/trades/:id`), so App reads it from the route and `onOpen` navigates
   *  rather than setting local state — that is what lets Back close a trade
   *  and a reload keep it open. */
  openId: number | null;
  onOpen: (id: number | null) => void;
  onAlertsChanged?: () => void;
}) {
  const [trades, setTrades] = useState<TradeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchTrades().then(setTrades).catch((e) => setError(e.message));
  }, []);
  // Fetched each time the list comes into view — on mount at /trades, and on
  // the way back from a trade, whether by the back arrow or the browser's
  // Back — since the editor may have completed, renamed or deleted it.
  useEffect(() => { if (openId === null) load(); }, [load, openId]);

  const start = async () => {
    const name = prompt('Who are you trading with?');
    if (!name?.trim()) return;
    // Pushed only once the POST returns: there is no id to put in the URL
    // before then, and a failed create should leave the address bar alone.
    try { const t = await createTrade({ counterpartyName: name.trim() }); onOpen(t.id); }
    catch (e: any) { setError(e.message); }
  };

  if (openId != null) {
    return <TradeEditor
      tradeId={openId}
      onClose={() => onOpen(null)}
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
        <button key={t.id} className="trade-row draft" onClick={() => onOpen(t.id)}>
          <span className="trade-who">{t.counterpartyName}</span>
          <span className="dim">draft{t.tradeDate ? ` · ${t.tradeDate}` : ''}</span>
        </button>
      ))}

      {history.length > 0 && <h3 className="section-label">History</h3>}
      {history.map((t) => (
        <button key={t.id} className="trade-row" onClick={() => onOpen(t.id)}>
          <span className="trade-who">{t.counterpartyName}</span>
          <span className="dim">{t.status === 'cancelled' ? 'cancelled' : (t.completedAt?.slice(0, 10) ?? t.tradeDate)}</span>
          {t.status === 'completed' && (
            <span className="trade-value">out {money(t.valueOutUsd)} · in {money(t.valueInUsd)}</span>
          )}
        </button>
      ))}
      {trades.length === 0 && <p className="empty">No trades yet. Start one when you're at the table.</p>}

      <BackToTop label="Back to the top of the trades" />
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
  const [confirm, setConfirm] = useState<CompleteResult | null>(null);
  const [done, setDone] = useState<CompleteResult | null>(null);
  const [editingItem, setEditingItem] = useState<Trade['items'][number] | null>(null);
  // Taking a card back off a trade used to be final. One stack per open
  // trade, reached by ⌘Z and — the only undo a phone has — the toast.
  const undoStack = useUndoStack();
  useUndoShortcuts(undoStack);

  // Back/Forward between two open trades swaps the id under this component
  // without remounting it, so the previous trade's rows are cleared rather
  // than shown under the new URL until the fetch lands. A pasted link to an id
  // that does not exist reads as such, not as a page that never loads.
  useEffect(() => {
    setTrade(null); setError(null);
    fetchTrade(tradeId).then(setTrade).catch((e) => {
      setError(e instanceof ApiError && e.status === 404 ? 'No trade with that id.' : e.message);
    });
  }, [tradeId]);
  // A step recorded against one trade must never be replayed into another.
  useEffect(() => { undoStack.clear(); }, [tradeId, undoStack.clear]);

  /**
   * Removes an item, and remembers how to put it back.
   *
   * Re-adding makes a new row rather than restoring the old one, so a later
   * redo has to remove whatever id that add returned — the same reason the
   * collection's lot undo follows its own id from there on.
   */
  const removeItem = async (item: Trade['items'][number]) => {
    setError(null);
    try {
      const withoutIt = await removeTradeItem(tradeId, item.id);
      setTrade(withoutIt);

      // What the trade held once it was gone. The row that is not in this set
      // after a re-add is the restored one, whatever id the server gave it —
      // read from the response rather than from `trade`, which is whatever
      // this render captured and may be several steps stale by then.
      const remaining = new Set(withoutIt.items.map((i) => i.id));
      let id = item.id;
      const fields = {
        direction: item.direction, printingId: item.printingId, quantity: item.quantity,
        finish: item.finish, condition: item.condition, language: item.language,
        sourceCollectionItemId: item.sourceCollectionItemId,
        destinationLocationId: item.destinationLocationId,
        unitValueUsd: item.unitValueUsd, notes: item.notes,
      };

      undoStack.record({
        label: `Removed ${item.name}`,
        undo: async () => {
          const next = await addTradeItem(tradeId, fields);
          id = next.items.find((i) => !remaining.has(i.id))?.id ?? id;
          setTrade(next);
        },
        redo: async () => { setTrade(await removeTradeItem(tradeId, id)); },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
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
    setError(null);
    try {
      const { result } = await completeTrade(tradeId, force) as { result: CompleteResult };
      if (result.needsConfirmation || result.shortfalls?.length) { setConfirm(result); return; }
      setConfirm(null); setDone(result);
      setTrade(await fetchTrade(tradeId));
      onCompleted();
    } catch (e: any) {
      // A 409 from the server — including a shortfall it only found while
      // disposing — lands here with its message.
      setError(e.message);
      setConfirm(null);
      setTrade(await fetchTrade(tradeId).catch(() => trade));
    }
  };

  if (!trade) {
    return (
      <div className="list-page">
        {error
          ? <>
              <div className="error">{error}</div>
              <div className="list-head">
                <button className="btn secondary" onClick={onClose}>← Trades</button>
              </div>
            </>
          : <p className="loading">Loading…</p>}
      </div>
    );
  }

  const out = trade.items.filter((i) => i.direction === 'out');
  const incoming = trade.items.filter((i) => i.direction === 'in');
  const valueOut = sumValue(trade.items, 'out');
  const valueIn = sumValue(trade.items, 'in');
  // Rows asking for copies that aren't there. The server would refuse the
  // completion anyway; disabling the button says so before the attempt.
  const shortRows = out.filter(isShort);
  const shortReason = shortRows.length === 0 ? null
    : `Can't complete: you don't own ${shortRows.map((i) => `${i.quantity} ${i.name} (own ${i.ownedQuantity})`).join(', ')}.`;

  return (
    <div className="list-page trade-editor">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <div className="list-head">
        <button className="btn secondary" onClick={onClose}>← Trades</button>
        {readOnly ? (
          <span className="trade-name">{trade.counterpartyName}</span>
        ) : (
          <input className="trade-name-input" value={trade.counterpartyName}
            onChange={(e) => setTrade({ ...trade, counterpartyName: e.target.value })}
            onBlur={(e) => updateTrade(tradeId, { counterpartyName: e.target.value })} />
        )}
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
              <span className="want-name">
                {item.name}
                {!readOnly
                  ? <button className="printing-chip" onClick={() => setEditingItem(item)} title="Change printing / finish / value">
                      {String(item.setCode).toUpperCase()}{item.finish !== 'nonfoil' ? ` ${item.finish}` : ''} · {item.condition} · {money(item.unitValueUsd)}
                    </button>
                  : <span className="dim">{String(item.setCode).toUpperCase()} · {item.condition}</span>}
                {isShort(item)
                  ? <span className="conflict-flag" title="The lot this came from has changed since you drafted the trade."> only own {item.ownedQuantity}</span>
                  : <span className="dim"> own {item.ownedQuantity}</span>}
              </span>
              <span className="trade-value">{money((item.unitValueUsd ?? 0) * item.quantity)}</span>
              {!readOnly && <button className="row-remove" onClick={() => removeItem(item)}>×</button>}
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
              <span className="want-name">
                {item.name}
                {!readOnly && (
                  <button className="printing-chip" onClick={() => setEditingItem(item)} title="Change printing / finish / value">
                    {String(item.setCode).toUpperCase()}{item.finish !== 'nonfoil' ? ` ${item.finish}` : ''} · {money(item.unitValueUsd)}
                  </button>
                )}
              </span>
              {!readOnly ? (
                <select value={item.destinationLocationId ?? ''}
                  onChange={async (e) => setTrade(await updateTradeItem(tradeId, item.id, { destinationLocationId: e.target.value ? Number(e.target.value) : null }))}>
                  <option value="">Unsorted</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              ) : <span className="dim">{item.condition}</span>}
              <span className="trade-value">{money((item.unitValueUsd ?? 0) * item.quantity)}</span>
              {!readOnly && <button className="row-remove" onClick={() => removeItem(item)}>×</button>}
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

      {confirm?.shortfalls?.length ? (
        <div className="conflict-panel">
          <strong>You don't own some of the cards you're giving away:</strong>
          <ul>{confirm.shortfalls.map((s) => (
            <li key={s.itemId ?? s.oracleId}>
              {s.name} — giving {s.requested}, but only {s.found} in your collection.
              The lot it came from has changed or been removed since you drafted this trade.
            </li>
          ))}</ul>
          <p className="dim">Lower the quantity, pick a different lot, or remove the card. The trade can't complete as it stands.</p>
          <div className="btnrow">
            <button className="btn secondary" onClick={() => setConfirm(null)}>OK</button>
          </div>
        </div>
      ) : confirm?.needsConfirmation && (
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
          <button className="btn primary" onClick={() => complete(false)}
            disabled={(out.length === 0 && incoming.length === 0) || shortReason != null}
            title={shortReason ?? undefined}>
            Complete trade
          </button>
          {shortReason && <span className="conflict-flag">{shortReason}</span>}
          <button className="btn secondary" onClick={async () => { if (confirmDelete()) { await deleteTrade(tradeId); onClose(); } }}>Delete draft</button>
        </div>
      )}

      {editingItem && (
        <TradeItemDialog
          trade={trade}
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={(next) => setTrade(next)}
        />
      )}

      <UndoToast stack={undoStack} />
      <BackToTop label="Back to the top of the trade" />
    </div>
  );
}

const confirmDelete = () => confirm('Delete this draft trade? It has not touched your collection.');
