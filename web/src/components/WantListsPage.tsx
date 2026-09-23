import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  addWantItem, createWantList, deleteWantList, fetchBuildability, fetchDeck, fetchWantLists,
  fetchWantList, imageUrl, removeWantItem, renameWantList, reorderWantItems, updateWantItem,
  type NamedList, type WantList, type WantListItem,
} from '../api.ts';
import { SubstitutesSheet } from './SubstitutesSheet.tsx';
import { performSwap, swapPlan } from '../substitutes.ts';
import { CardPicker } from './CardPicker.tsx';
import { CardDetailPane } from './CardDetailPane.tsx';
import { CustomizeView } from './CustomizeView.tsx';
import { BackToTop } from './BackToTop.tsx';
import { UndoToast } from './UndoToast.tsx';
import { useUndoShortcuts, useUndoStack } from '../undo.ts';
import type { Density, DensityPage } from '../density.ts';
import { useNarrow } from '../viewport.ts';
import { count, money } from '../format.ts';
import { nameMatches, sortWants, WANT_SORTS, WANT_SORT_LABEL, type WantSort } from '../listSort.ts';

const PRIORITY = ['—', 'Low', 'Medium', 'High'];

/** One pointer's drag, from pointerdown to release. `lift` is null until the
 *  hold registers (immediately for a mouse, after the long-press for touch). */
interface DragMeta {
  pointerId: number; startX: number; startY: number; rowHeight: number;
  lift: { id: number; startIndex: number; shift: number } | null;
  longPress: number | null;
  release: () => void;
}

/**
 * Want lists — cards you're looking for, in any number of named lists, each with
 * its own priority order. A deck-linked entry shows "needed for: Deck A ×2" as a
 * field, and target price / priority / notes are editable inline.
 */
export function WantListsPage({
  page, density, onDensity, densityOverridden, onResetDensity,
}: {
  page: DensityPage;
  density: Density;
  onDensity: (density: Density) => void;
  densityOverridden: boolean;
  onResetDensity: () => void;
}) {
  const ultra = density === 'ultra';
  // Mirrors the 620px breakpoint in styles.css. A Full row on a phone splits
  // its toolbar in two: the price and the remove ✕ move up onto the name line,
  // which leaves quantity, priority and the alert bell fitting on exactly one
  // line beneath it. Keeping all five together needed 265px of a 227px column,
  // so something had to move — and the price and ✕ are the two that read as
  // belonging to the card rather than to the fields. Ultra rows are one line
  // already and are left alone.
  const compactRow = useNarrow(620) && !ultra;
  const [lists, setLists] = useState<NamedList[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [list, setList] = useState<WantList | null>(null);
  // Same as the trade list beside it: a want removed by a misplaced tap was
  // gone for good.
  const undoStack = useUndoStack();
  useUndoShortcuts(undoStack);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Phase 27. The want a "something I own" sheet is open for. The deck behind
  // the want (its first, if several) supplies colour and format, and is where
  // the stand-in goes if you choose to play it.
  const [substituting, setSubstituting] = useState<WantListItem | null>(null);

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

  /**
   * Removes a want, and remembers how to put it back. Re-adding makes a new
   * row, so redo follows whatever id the add returned.
   */
  const removeItem = async (item: WantListItem) => {
    if (activeId === null) return;
    const listId = activeId;
    setError(null);
    try {
      const without = await removeWantItem(listId, item.id);
      setList(without);
      loadLists();

      const remaining = new Set(without.items.map((i) => i.id));
      let id = item.id;
      const fields = {
        quantity: item.quantity, targetPriceUsd: item.targetPriceUsd,
        priority: item.priority, notes: item.notes,
      };
      undoStack.record({
        label: `Removed ${item.name}`,
        undo: async () => {
          const next = await addWantItem(listId, item.oracleId, fields);
          id = next.items.find((i) => !remaining.has(i.id))?.id ?? id;
          setList(next);
          loadLists();
        },
        redo: async () => { setList(await removeWantItem(listId, id)); loadLists(); },
      });
    } catch (e: any) {
      setError(e.message);
    }
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

  const active = useMemo(() => list?.items.filter((i) => i.status === 'active') ?? [], [list]);
  const fulfilled = list?.items.filter((i) => i.status === 'fulfilled') ?? [];

  // Find and order. Both are views over the rows already here; the drag
  // handles only exist in the list's own order with nothing filtered out,
  // since dragging a row among a subset has no honest meaning for the rest.
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<WantSort>('manual');
  const reorderable = sort === 'manual' && query.trim() === '';
  const shown = useMemo(
    () => sortWants(active.filter((item) => nameMatches(item.name, query)), sort),
    [active, query, sort],
  );

  /**
   * Persists a new order of the active rows. The server gets the whole list
   * every time — the active ids as reordered, then the fulfilled ones as they
   * were — so it never has to guess where the rows the drag did not show go.
   */
  const persistOrder = (activeIds: number[]) => {
    if (activeId == null || !list) return;
    const ids = [...activeIds, ...fulfilled.map((i) => i.id)];
    // Shown in the new order straight away, so a dropped row does not snap
    // back to its old place for the round trip; the server's answer replaces it.
    const byId = new Map(list.items.map((i) => [i.id, i]));
    setList({ ...list, items: ids.map((id) => byId.get(id)!).filter(Boolean) });
    reorderWantItems(activeId, ids).then(setList).catch((e) => setError(e.message));
  };

  /** Arrow-key reorder. `index` is a position in `active` — the rows that have
   *  handles — not in `list.items`, which also holds the fulfilled ones. */
  const move = (index: number, delta: number) => {
    const ids = active.map((i) => i.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    persistOrder(ids);
  };

  // Drag-to-reorder. `drag` (state, drives rendering) tracks which row is
  // lifted, how many row-slots it has moved (`shift`, snapped for the actual
  // reorder), and the sub-slot pixel remainder (`offset`) so the row still
  // visually tracks the pointer between snaps instead of jumping in whole
  // row-height steps. `dragMeta` (ref) holds the pointer bookkeeping that never
  // needs to trigger a render — including the long-press timer that, on
  // touch, gates a hold from an ordinary scroll: a touch that moves before
  // the timer fires cancels the drag rather than starting one.
  //
  // The pointer is followed from the window, not the handle. Reordering moves
  // the lifted row's DOM node, and a moved node loses any pointer capture it
  // held — so a handle that captured the pointer would stop hearing it the
  // moment the row first changed place, and the pointerup that ends the drag
  // would land on whatever was under it instead. The window hears every
  // pointer event wherever it lands; the handle's only job is to start one.
  // The snapped shift is kept on the ref as well as in state because a
  // pointerup can arrive before React has rendered the last pointermove, and
  // the commit must use where the row actually is, not where it was last drawn.
  const [drag, setDrag] = useState<{ id: number; startIndex: number; shift: number; offset: number } | null>(null);
  const dragMeta = useRef<DragMeta | null>(null);

  const displayItems = useMemo(() => {
    if (!reorderable) return shown;
    if (!drag) return active;
    const dragged = active.find((i) => i.id === drag.id);
    if (!dragged) return active;
    const rest = active.filter((i) => i.id !== drag.id);
    const targetIndex = Math.min(rest.length, Math.max(0, drag.startIndex + drag.shift));
    rest.splice(targetIndex, 0, dragged);
    return rest;
  }, [active, drag, reorderable, shown]);

  const trackDrag = (meta: DragMeta, clientY: number) => {
    if (!meta.lift) return;
    const dy = clientY - meta.startY;
    const shift = Math.round(dy / meta.rowHeight);
    meta.lift.shift = shift;
    setDrag((d) => (d ? { ...d, shift, offset: dy - shift * meta.rowHeight } : d));
  };

  const finishDrag = (commit: boolean) => {
    const meta = dragMeta.current;
    if (!meta) return;
    dragMeta.current = null;
    if (meta.longPress) clearTimeout(meta.longPress);
    meta.release();
    const lift = meta.lift;
    if (commit && lift && lift.shift !== 0) {
      const ids = active.map((i) => i.id).filter((id) => id !== lift.id);
      const targetIndex = Math.min(ids.length, Math.max(0, lift.startIndex + lift.shift));
      ids.splice(targetIndex, 0, lift.id);
      persistOrder(ids);
    }
    setDrag(null);
  };
  // The window listeners are attached once per drag and outlive several
  // renders; they reach the current closure (with this render's `active` and
  // `activeId`) through the ref rather than the one they were created in.
  const finishDragRef = useRef(finishDrag);
  finishDragRef.current = finishDrag;
  useEffect(() => () => dragMeta.current?.release(), []);

  const beginDrag = (meta: DragMeta, id: number, index: number) => {
    meta.lift = { id, startIndex: index, shift: 0 };
    setDrag({ id, startIndex: index, shift: 0, offset: 0 });
  };

  const onDragPointerDown = (item: WantListItem, index: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (dragMeta.current) return; // a second finger while one is already down
    const rowHeight = ((event.currentTarget.closest('.want-row') as HTMLElement | null)?.offsetHeight || 52) + 4;
    const meta: DragMeta = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rowHeight,
      lift: null, longPress: null, release: () => {},
    };
    const mine = (e: PointerEvent) => e.pointerId === meta.pointerId;
    const onMove = (e: PointerEvent) => {
      if (!mine(e)) return;
      if (meta.lift) { trackDrag(meta, e.clientY); return; }
      // Moved before the hold registered — that's a scroll, not a drag.
      if (Math.hypot(e.clientX - meta.startX, e.clientY - meta.startY) > 8) finishDragRef.current(false);
    };
    const onUp = (e: PointerEvent) => { if (mine(e)) finishDragRef.current(true); };
    const onCancel = (e: PointerEvent) => { if (mine(e)) finishDragRef.current(false); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    meta.release = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    dragMeta.current = meta;
    if (event.pointerType === 'mouse') beginDrag(meta, item.id, index);
    else meta.longPress = window.setTimeout(() => beginDrag(meta, item.id, index), 250);
  };

  const [openTarget, setOpenTarget] = useState<Set<number>>(new Set());
  const toggleTarget = (id: number) => setOpenTarget((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Tapping a row's art/name opens the full card — the same big-image,
  // printings-and-prices view Browse uses — with the want-specific fields
  // (quantity, priority, alert target) as a toolbar above it. Tracked by id
  // rather than holding the item itself, so an edit made from the row below
  // (or from this sheet) is reflected immediately rather than going stale.
  const [detailId, setDetailId] = useState<number | null>(null);
  const detailItem = active.find((i) => i.id === detailId) ?? null;

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
              <CustomizeView
                page={page}
                density={density}
                onDensity={onDensity}
                densityOverridden={densityOverridden}
                onResetDensity={onResetDensity}
                showGroupSort={false}
              />
            </div>
          </div>

          {adding && (
            <div className="add-panel">
              <CardPicker
                placeholder="Add a card to this want list…"
                hideMana
                onPick={async (card) => { if (activeId != null) { setList(await addWantItem(activeId, card.oracleId)); loadLists(); } }}
              />
            </div>
          )}

          {active.length > 0 && (
            <div className="list-tools">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find in this list"
                aria-label="Find a card in this want list"
              />
              <label className="list-sort">
                <span>Sort</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as WantSort)}>
                  {WANT_SORTS.map((key) => <option key={key} value={key}>{WANT_SORT_LABEL[key]}</option>)}
                </select>
              </label>
              {/* The server's figures over the whole list, whatever is
                  filtered — the rows are the parts, this is their sum. */}
              {list.totals && (
                <span className="count list-totals" title="Active wants, each at the price shown on its row × the quantity wanted">
                  {query.trim() && `${count(shown.length)} of `}
                  {count(list.totals.activeCount)} {list.totals.activeCount === 1 ? 'want' : 'wants'}
                  {' · '}{count(list.totals.activeCopies)} {list.totals.activeCopies === 1 ? 'copy' : 'copies'}
                  {' · '}{money(list.totals.valueUsd)}
                  {list.totals.unpricedCount > 0 && ` + ${count(list.totals.unpricedCount)} unpriced`}
                </span>
              )}
            </div>
          )}
          {!reorderable && active.length > 1 && (
            <p className="note">Drag to reorder in <strong>Your order</strong> with the search cleared.</p>
          )}

          {active.length === 0 && <p className="empty">No active wants. Add a card, or send a deck's missing cards here.</p>}
          {active.length > 0 && shown.length === 0 && <p className="empty">No wants match “{query.trim()}”.</p>}

          <div className="want-rows">
            {displayItems.map((item) => {
              const index = active.findIndex((a) => a.id === item.id);
              const isDragging = drag?.id === item.id;
              const targetOpen = openTarget.has(item.id);
              const dragHandle = !reorderable ? null : (
                <button
                  type="button"
                  className="want-drag"
                  aria-label={`Reorder ${item.name} — drag, or use the up/down arrow keys`}
                  onPointerDown={onDragPointerDown(item, index)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp') { e.preventDefault(); move(index, -1); }
                    if (e.key === 'ArrowDown') { e.preventDefault(); move(index, 1); }
                  }}
                >⠿</button>
              );
              const removeButton = (
                <button className="row-remove" onClick={() => removeItem(item)}
                  aria-label={`Remove ${item.name}`}>×</button>
              );
              const controls = (
                <div className="want-controls">
                  <div className="want-controls-group">
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
                  </div>
                  <div className="want-controls-group">
                    {!compactRow && <div className="want-price">{money(item.priceUsd)}</div>}
                    <button
                      type="button"
                      className={`want-alert-toggle${item.targetPriceUsd != null ? ' active' : ''}`}
                      aria-expanded={targetOpen}
                      onClick={() => toggleTarget(item.id)}
                      title={item.targetPriceUsd != null
                        ? `Alert set at ${money(item.targetPriceUsd)} — click to edit`
                        : 'Set a price-drop alert'}
                    >🔔</button>
                    {targetOpen && (
                      <label className="want-field want-target-field" title="Alert me at or below this price">
                        <span>target</span>
                        <input type="number" step="0.01" placeholder={money(item.priceUsd)} autoFocus
                          value={item.targetPriceUsd ?? ''}
                          onChange={(e) => patch(item, { targetPriceUsd: e.target.value === '' ? null : Number(e.target.value) })} />
                      </label>
                    )}
                    {!compactRow && removeButton}
                  </div>
                </div>
              );
              return (
                <div
                  className={`want-row${ultra ? ' ultra' : ''}${isDragging ? ' dragging' : ''}`}
                  key={item.id}
                  style={isDragging ? { transform: `translateY(${drag.offset}px)` } : undefined}
                >
                  {dragHandle}
                  {ultra ? (
                    <>
                      <button
                        type="button"
                        className="want-name"
                        onClick={() => setDetailId(item.id)}
                        title={item.neededFor.length > 0
                          ? `needed for: ${item.neededFor.map((n) => `${n.deckName} ×${n.quantity}`).join(', ')}`
                          : undefined}
                      >
                        {item.name}
                        {item.ownedQuantity > 0 && <span className="tag ok">own {item.ownedQuantity}</span>}
                        {item.neededFor.length > 0 && <span className="tag">needed</span>}
                      </button>
                      {controls}
                    </>
                  ) : (
                    <>
                      <div
                        className="want-open"
                        role="button"
                        tabIndex={0}
                        aria-label={`View ${item.name}`}
                        onClick={() => setDetailId(item.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailId(item.id); } }}
                      >
                        {/* The proxy, not Scryfall: cached to disk on the
                            first request, like every other card image here. */}
                        {item.printingId && item.imageSmall
                          ? <img className="want-thumb" src={imageUrl(item.printingId, 'small')} alt="" loading="lazy" decoding="async" />
                          : <div className="want-thumb placeholder" />}
                      </div>
                      <div className="want-main">
                        {/* Name and price are one line: the two things a glance
                            down this list is actually reading. */}
                        <div className="want-headline">
                          <button type="button" className="want-name" onClick={() => setDetailId(item.id)}>
                            {item.name}
                            {item.ownedQuantity > 0 && <span className="tag ok">own {item.ownedQuantity}</span>}
                          </button>
                          {compactRow && <div className="want-price">{money(item.priceUsd)}</div>}
                          {compactRow && removeButton}
                        </div>
                        {controls}
                      </div>
                      {/* Outside `.want-main` deliberately — `.want-row` centers the
                          name+controls line against the thumbnail's height, and these
                          extra lines would pull that centering off if they counted
                          toward the same block. As their own full-width flex line
                          (below, via CSS) they add height to the row without moving
                          where the primary line sits. */}
                      {item.neededFor.length > 0 && (
                        <div className="needed-for">
                          needed for: {item.neededFor.map((n) => `${n.deckName} ×${n.quantity}`).join(', ')}
                        </div>
                      )}
                      {item.notes && <div className="want-notes">{item.notes}</div>}
                    </>
                  )}
                </div>
              );
            })}
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

      {detailItem && (
        <div className="want-detail-backdrop" onClick={() => setDetailId(null)}>
          <div className="want-detail-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="floating-head">
              <h2>{detailItem.name}</h2>
              <button className="btn secondary small" onClick={() => setDetailId(null)}>Close</button>
            </div>
            <div className="want-detail-controls">
              <label className="field" title="Quantity wanted">
                <span>Quantity wanted</span>
                <input type="number" min="1" value={detailItem.quantity}
                  onChange={(e) => patch(detailItem, { quantity: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
              <label className="field" title="Priority">
                <span>Priority</span>
                <select value={detailItem.priority} onChange={(e) => patch(detailItem, { priority: Number(e.target.value) })}>
                  {PRIORITY.map((p, idx) => <option key={idx} value={idx}>{p}</option>)}
                </select>
              </label>
              <label className="field" title="Alert me when the market price drops to or below this">
                <span>Alert me at or below</span>
                <input type="number" step="0.01" placeholder={money(detailItem.priceUsd)}
                  value={detailItem.targetPriceUsd ?? ''}
                  onChange={(e) => patch(detailItem, { targetPriceUsd: e.target.value === '' ? null : Number(e.target.value) })} />
              </label>
              <button className="btn secondary small" onClick={() => { removeItem(detailItem); setDetailId(null); }}>
                Remove from want list
              </button>
              {/* The alternative to waiting for a price drop: what you already
                  own that would do the same job. */}
              <button
                className="btn secondary small"
                onClick={() => setSubstituting(detailItem)}
                title={detailItem.neededFor.length > 0
                  ? `Owned cards that fit ${detailItem.neededFor[0].deckName}`
                  : 'Owned cards that play the same role'}
              >
                Find something I own
              </button>
            </div>
            <CardDetailPane oracleId={detailItem.oracleId} floating={false} onClose={() => setDetailId(null)} />
          </div>
        </div>
      )}

      {substituting && (() => {
        const need = substituting.neededFor[0] ?? null;
        /** Swaps the stand-in into the deck behind the want — an ordinary edit. */
        const playInDeck = async (oracleId: string, printingId: string | null) => {
          if (!need) return;
          const [deck, figures] = await Promise.all([fetchDeck(need.deckId), fetchBuildability(need.deckId)]);
          const missing = figures.rows.find((row) => row.oracleId === substituting.oracleId)?.missing;
          await performSwap(need.deckId, swapPlan(deck, substituting.oracleId, missing), oracleId, printingId);
        };
        return (
          <SubstitutesSheet
            oracleId={substituting.oracleId}
            targetName={substituting.name}
            deckId={need?.deckId ?? null}
            onClose={() => setSubstituting(null)}
            // With no deck behind the want there is nothing to swap into; the
            // list is still worth seeing, so the sheet opens with no buttons.
            actions={need ? [
              {
                label: 'Play this instead',
                title: `Put it in ${need.deckName} and take ${substituting.name} off the list`,
                run: async (candidate) => {
                  await playInDeck(candidate.oracleId, candidate.printingId);
                  await removeItem(substituting);
                  setSubstituting(null);
                  setDetailId(null);
                },
              },
              {
                label: 'Keep it on the list, play this for now',
                title: `Put it in ${need.deckName}; keep looking for ${substituting.name}`,
                run: async (candidate) => {
                  await playInDeck(candidate.oracleId, candidate.printingId);
                  setSubstituting(null);
                  reload();
                },
              },
            ] : []}
          />
        );
      })()}

      <UndoToast stack={undoStack} />
      <BackToTop label="Back to the top of the list" />
    </div>
  );
}
