import { useCallback, useEffect, useState } from 'react';
import {
  addWantItem, createWantList, deleteWantList, fetchWantLists, fetchWantList, removeWantItem,
  renameWantList, reorderWantItems, updateWantItem,
  type NamedList, type WantList, type WantListItem,
} from '../api.ts';
import { CardPicker } from './CardPicker.tsx';

const money = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);
const PRIORITY = ['—', 'Low', 'Medium', 'High'];

/**
 * Want lists — cards you're looking for, in any number of named lists, each with
 * its own priority order. A deck-linked entry shows "needed for: Deck A ×2" as a
 * field, and target price / priority / notes are editable inline.
 */
export function WantListsPage() {
  const [lists, setLists] = useState<NamedList[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [list, setList] = useState<WantList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const loadLists = useCallback(() => {
    fetchWantLists().then((ls) => {
      setLists(ls);
      setActiveId((current) => current ?? ls.find((l) => l.is_default)?.id ?? ls[0]?.id ?? null);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(loadLists, [loadLists]);

  useEffect(() => {
    if (activeId == null) return;
    fetchWantList(activeId).then(setList).catch((e) => setError(e.message));
  }, [activeId]);

  const reload = () => { if (activeId != null) fetchWantList(activeId).then(setList); loadLists(); };

  const newList = async () => {
    const name = prompt('Name the new want list (e.g. "Commander wants", "Grails")');
    if (!name?.trim()) return;
    try { const r = await createWantList(name.trim()); setActiveId(r.id); loadLists(); }
    catch (e: any) { setError(e.message); }
  };

  const rename = async () => {
    if (activeId == null) return;
    const name = prompt('Rename this list', list?.name);
    if (!name?.trim()) return;
    try { await renameWantList(activeId, name.trim()); loadLists(); reload(); }
    catch (e: any) { setError(e.message); }
  };

  const remove = async () => {
    if (activeId == null || !confirm(`Delete "${list?.name}" and its wants?`)) return;
    try { await deleteWantList(activeId); setActiveId(null); loadLists(); }
    catch (e: any) { setError(e.message); }
  };

  const patch = async (item: WantListItem, changes: Record<string, unknown>) => {
    if (activeId == null) return;
    setList(await updateWantItem(activeId, item.id, changes));
    loadLists();
  };

  const move = async (index: number, delta: number) => {
    if (activeId == null || !list) return;
    const ids = list.items.map((i) => i.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setList(await reorderWantItems(activeId, ids));
  };

  const active = list?.items.filter((i) => i.status === 'active') ?? [];
  const fulfilled = list?.items.filter((i) => i.status === 'fulfilled') ?? [];

  return (
    <div className="list-page">
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <div className="list-tabs">
        {lists.map((l) => (
          <button key={l.id} className={l.id === activeId ? 'on' : ''} onClick={() => setActiveId(l.id)}>
            {l.name}{typeof l.active_count === 'number' ? <span className="count">{l.active_count}</span> : null}
          </button>
        ))}
        <button className="list-new" onClick={newList} title="New want list">+ list</button>
      </div>

      {list && (
        <div className="list-body">
          <div className="list-head">
            <h2>{list.name}</h2>
            <div className="btnrow">
              <button className="btn secondary small" onClick={() => setAdding((v) => !v)}>{adding ? 'Done' : 'Add card'}</button>
              <button className="btn secondary small" onClick={rename}>Rename</button>
              <button className="btn secondary small" onClick={remove}>Delete list</button>
            </div>
          </div>

          {adding && (
            <div className="add-panel">
              <CardPicker
                placeholder="Add a card to this want list…"
                onPick={async (card) => { if (activeId != null) { setList(await addWantItem(activeId, card.oracleId)); loadLists(); } }}
              />
            </div>
          )}

          {active.length === 0 && <p className="empty">No active wants. Add a card, or push a deck's shopping list here.</p>}

          <div className="want-rows">
            {active.map((item, i) => (
              <div className="want-row" key={item.id}>
                <div className="reorder">
                  <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">▲</button>
                  <button onClick={() => move(i, 1)} disabled={i === active.length - 1} aria-label="Move down">▼</button>
                </div>
                {item.imageSmall
                  ? <img className="want-thumb" src={item.imageSmall} alt="" loading="lazy" />
                  : <div className="want-thumb placeholder" />}
                <div className="want-main">
                  <div className="want-name">
                    {item.name} <span className="mana">{item.manaCost}</span>
                    {item.ownedQuantity > 0 && <span className="tag ok">own {item.ownedQuantity}</span>}
                  </div>
                  {item.neededFor.length > 0 && (
                    <div className="needed-for">
                      needed for: {item.neededFor.map((n) => `${n.deckName} ×${n.quantity}`).join(', ')}
                    </div>
                  )}
                  {item.notes && <div className="want-notes">{item.notes}</div>}
                </div>
                <label className="want-field" title="Quantity wanted">
                  <span>qty</span>
                  <input type="number" min="1" value={item.quantity}
                    onChange={(e) => patch(item, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
                </label>
                <label className="want-field" title="Priority">
                  <span>pri</span>
                  <select value={item.priority} onChange={(e) => patch(item, { priority: Number(e.target.value) })}>
                    {PRIORITY.map((p, idx) => <option key={idx} value={idx}>{p}</option>)}
                  </select>
                </label>
                <label className="want-field" title="Alert me at or below this price">
                  <span>target</span>
                  <input type="number" step="0.01" placeholder={money(item.priceUsd)}
                    value={item.targetPriceUsd ?? ''}
                    onChange={(e) => patch(item, { targetPriceUsd: e.target.value === '' ? null : Number(e.target.value) })} />
                </label>
                <div className="want-price">{money(item.priceUsd)}</div>
                <button className="row-remove" onClick={async () => { if (activeId != null) { setList(await removeWantItem(activeId, item.id)); loadLists(); } }}
                  aria-label={`Remove ${item.name}`}>×</button>
              </div>
            ))}
          </div>

          {fulfilled.length > 0 && (
            <details className="fulfilled">
              <summary>{fulfilled.length} fulfilled</summary>
              {fulfilled.map((item) => (
                <div className="want-row done" key={item.id}>
                  <span className="want-name">{item.name}</span>
                  <button className="btn secondary small" onClick={() => patch(item, { status: 'active' })}>Reactivate</button>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}
