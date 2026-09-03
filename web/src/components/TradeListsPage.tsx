import { useCallback, useEffect, useState } from 'react';
import {
  addTradeListItem, createTradeList, deleteTradeList, fetchCollectionCard, fetchTradeList,
  fetchTradeLists, removeTradeListItem, renameTradeList, tradeListExportUrl, updateTradeListItem,
  type CollectionLot, type NamedList, type TradeList,
} from '../api.ts';
import { CardPicker } from './CardPicker.tsx';

const money = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);

/**
 * Trade lists — specific owned copies flagged as available to trade away, with
 * their own quantity and asking price. Flags copies a deck is using, and exports
 * as plaintext for pasting into a trade thread.
 */
export function TradeListsPage() {
  const [lists, setLists] = useState<NamedList[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [list, setList] = useState<TradeList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [lots, setLots] = useState<{ name: string; lots: CollectionLot[] } | null>(null);
  const [copied, setCopied] = useState(false);

  const loadLists = useCallback(() => {
    fetchTradeLists().then((ls) => {
      setLists(ls);
      setActiveId((current) => current ?? ls.find((l) => l.is_default)?.id ?? ls[0]?.id ?? null);
    }).catch((e) => setError(e.message));
  }, []);
  useEffect(loadLists, [loadLists]);

  useEffect(() => {
    if (activeId == null) return;
    fetchTradeList(activeId).then(setList).catch((e) => setError(e.message));
  }, [activeId]);

  const newList = async () => {
    const name = prompt('Name the new trade list (e.g. "Bulk trades", "High value")');
    if (!name?.trim()) return;
    try { const r = await createTradeList(name.trim()); setActiveId(r.id); loadLists(); }
    catch (e: any) { setError(e.message); }
  };
  const rename = async () => {
    if (activeId == null) return;
    const name = prompt('Rename this list', list?.name);
    if (!name?.trim()) return;
    try { await renameTradeList(activeId, name.trim()); loadLists(); fetchTradeList(activeId).then(setList); }
    catch (e: any) { setError(e.message); }
  };
  const remove = async () => {
    if (activeId == null || !confirm(`Delete "${list?.name}"?`)) return;
    try { await deleteTradeList(activeId); setActiveId(null); loadLists(); }
    catch (e: any) { setError(e.message); }
  };

  const pickCard = async (oracleId: string, name: string) => {
    const detail = await fetchCollectionCard(oracleId);
    const owned = detail.lots.filter((l) => l.quantity > 0);
    if (owned.length === 0) { setError(`You don't own any copies of ${name}.`); return; }
    setLots({ name, lots: owned });
  };

  const addLot = async (lot: CollectionLot) => {
    if (activeId == null) return;
    setList(await addTradeListItem(activeId, lot.id, { quantity: lot.quantity }));
    setLots(null); setAdding(false); loadLists();
  };

  const copyExport = async () => {
    if (activeId == null) return;
    const text = await fetch(tradeListExportUrl(activeId)).then((r) => r.text());
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setError('Could not reach the clipboard — open the export URL to copy manually.'); }
  };

  return (
    <div className="list-page">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <div className="list-tabs">
        {lists.map((l) => (
          <button key={l.id} className={l.id === activeId ? 'on' : ''} onClick={() => setActiveId(l.id)}>
            {l.name}{typeof l.item_count === 'number' ? <span className="count">{l.item_count}</span> : null}
          </button>
        ))}
        <button className="list-new" onClick={newList} title="New trade list">+ list</button>
      </div>

      {list && (
        <div className="list-body">
          <div className="list-head">
            <h2>{list.name}</h2>
            <div className="btnrow">
              <button className="btn secondary small" onClick={() => { setAdding((v) => !v); setLots(null); }}>{adding ? 'Done' : 'Add card'}</button>
              <button className="btn secondary small" onClick={copyExport} disabled={list.items.length === 0}>{copied ? 'Copied' : 'Copy export'}</button>
              <button className="btn secondary small" onClick={rename}>Rename</button>
              <button className="btn secondary small" onClick={remove}>Delete list</button>
            </div>
          </div>

          {adding && (
            <div className="add-panel">
              {!lots
                ? <CardPicker placeholder="Find an owned card to list…" onPick={(c) => pickCard(c.oracleId, c.name)} />
                : (
                  <div className="lot-choices">
                    <div className="lot-choices-head">Which copies of {lots.name}?</div>
                    {lots.lots.map((lot) => (
                      <button key={lot.id} className="lot-choice" onClick={() => addLot(lot)}>
                        {lot.quantity}× {String(lot.set_code).toUpperCase()} #{lot.collector_number}
                        {lot.finish !== 'nonfoil' ? ` ${lot.finish}` : ''} · {lot.condition} · {lot.location_name} · {money(lot.unit_value_usd)}
                      </button>
                    ))}
                    <button className="btn secondary small" onClick={() => setLots(null)}>Back</button>
                  </div>
                )}
            </div>
          )}

          {list.items.length === 0 && <p className="empty">Nothing listed. Add an owned card you're happy to trade away.</p>}

          <div className="want-rows">
            {list.items.map((item) => (
              <div className={`want-row${item.conflictsWithDeck || item.exceedsOwned ? ' warn' : ''}`} key={item.id}>
                {item.imageSmall
                  ? <img className="want-thumb" src={item.imageSmall} alt="" loading="lazy" />
                  : <div className="want-thumb placeholder" />}
                <div className="want-main">
                  <div className="want-name">
                    {item.name}
                    <span className="dim"> {String(item.setCode).toUpperCase()} #{item.collectorNumber}{item.finish !== 'nonfoil' ? ` · ${item.finish}` : ''} · {item.condition}</span>
                  </div>
                  <div className="dim">{item.locationName} · own {item.ownedQuantity} · market {money(item.marketUsd)}</div>
                  {item.conflictsWithDeck && <div className="conflict-flag">⚠ a deck is using some of these copies</div>}
                  {item.exceedsOwned && <div className="conflict-flag">⚠ lists more than you own</div>}
                </div>
                <label className="want-field" title="Quantity available to trade">
                  <span>qty</span>
                  <input type="number" min="1" value={item.quantity}
                    onChange={async (e) => { if (activeId != null) setList(await updateTradeListItem(activeId, item.id, { quantity: Math.max(1, Number(e.target.value) || 1) })); }} />
                </label>
                <label className="want-field" title="Asking price">
                  <span>ask</span>
                  <input type="number" step="0.01" placeholder={money(item.marketUsd)} value={item.askingPriceUsd ?? ''}
                    onChange={async (e) => { if (activeId != null) setList(await updateTradeListItem(activeId, item.id, { askingPriceUsd: e.target.value === '' ? null : Number(e.target.value) })); }} />
                </label>
                <button className="row-remove" onClick={async () => { if (activeId != null) { setList(await removeTradeListItem(activeId, item.id)); loadLists(); } }}
                  aria-label={`Remove ${item.name}`}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
