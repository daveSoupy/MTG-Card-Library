import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  addWantItem, createWantList, deleteWantList, fetchBuildability, fetchDeck, fetchWantLists,
  fetchWantList, removeWantItem, renameWantList, reorderWantItems, updateWantItem,
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

const money = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);
const PRIORITY = ['—', 'Low', 'Medium', 'High'];

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

  // Drag-to-reorder. `drag` (state, drives rendering) tracks which row is
  // lifted, how many row-slots it has moved (`shift`, snapped for the actual
  // reorder), and the sub-slot pixel remainder (`offset`) so the row still
  // visually tracks the pointer between snaps instead of jumping in whole
  // row-height steps. `dragMeta` (ref) holds pointer bookkeeping that never
  // needs to trigger a render — including the long-press timer that, on
  // touch, gates a hold from an ordinary scroll: a touch that moves before
  // the timer fires cancels the drag rather than starting one.
  const [drag, setDrag] = useState<{ id: number; startIndex: number; shift: number; offset: number } | null>(null);
  const dragMeta = useRef<{
    pointerId: number; startX: number; startY: number; rowHeight: number;
    activated: boolean; longPress: number | null;
  } | null>(null);

  const displayItems = useMemo(() => {
    if (!drag) return active;
    const dragged = active.find((i) => i.id === drag.id);
    if (!dragged) return active;
    const rest = active.filter((i) => i.id !== drag.id);
    const targetIndex = Math.min(rest.length, Math.max(0, drag.startIndex + drag.shift));
    rest.splice(targetIndex, 0, dragged);
    return rest;
  }, [active, drag]);

  const beginDrag = (id: number, index: number, clientX: number, clientY: number, pointerId: number, rowHeight: number) => {
    dragMeta.current = { pointerId, startX: clientX, startY: clientY, rowHeight, activated: true, longPress: null };
    setDrag({ id, startIndex: index, shift: 0, offset: 0 });
  };

  const onDragPointerDown = (item: WantListItem, index: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const handle = event.currentTarget;
    const rowHeight = (handle.closest('.want-row') as HTMLElement | null)?.offsetHeight ?? 52;
    const clientX = event.clientX, clientY = event.clientY, pointerId = event.pointerId;
    if (event.pointerType === 'mouse') {
      handle.setPointerCapture(pointerId);
      beginDrag(item.id, index, clientX, clientY, pointerId, rowHeight + 4);
    } else {
      const timer = window.setTimeout(() => {
        handle.setPointerCapture(pointerId);
        beginDrag(item.id, index, clientX, clientY, pointerId, rowHeight + 4);
      }, 250);
      dragMeta.current = { pointerId, startX: clientX, startY: clientY, rowHeight: rowHeight + 4, activated: false, longPress: timer };
    }
  };

  const onDragPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const meta = dragMeta.current;
    if (!meta || meta.pointerId !== event.pointerId) return;
    if (!meta.activated) {
      // Moved before the hold registered — that's a scroll, not a drag.
      if (Math.hypot(event.clientX - meta.startX, event.clientY - meta.startY) > 8) {
        if (meta.longPress) clearTimeout(meta.longPress);
        dragMeta.current = null;
      }
      return;
    }
    event.preventDefault();
    const dy = event.clientY - meta.startY;
    const shift = Math.round(dy / meta.rowHeight);
    const offset = dy - shift * meta.rowHeight;
    setDrag((d) => (d ? { ...d, shift, offset } : d));
  };

  const finishDrag = (commit: boolean) => {
    const meta = dragMeta.current;
    dragMeta.current = null;
    if (meta?.longPress) clearTimeout(meta.longPress);
    if (commit && drag && meta?.activated && drag.shift !== 0 && activeId != null) {
      const ids = active.map((i) => i.id).filter((id) => id !== drag.id);
      const targetIndex = Math.min(ids.length, Math.max(0, drag.startIndex + drag.shift));
      ids.splice(targetIndex, 0, drag.id);
      reorderWantItems(activeId, ids).then(setList).catch((e) => setError(e.message));
    }
    setDrag(null);
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

          {active.length === 0 && <p className="empty">No active wants. Add a card, or push a deck's shopping list here.</p>}

          <div className="want-rows">
            {displayItems.map((item) => {
              const index = active.findIndex((a) => a.id === item.id);
              const isDragging = drag?.id === item.id;
              const targetOpen = openTarget.has(item.id);
              const dragHandle = (
                <button
                  type="button"
                  className="want-drag"
                  aria-label={`Reorder ${item.name} — drag, or use the up/down arrow keys`}
                  onPointerDown={onDragPointerDown(item, index)}
                  onPointerMove={onDragPointerMove}
                  onPointerUp={() => finishDrag(true)}
                  onPointerCancel={() => finishDrag(false)}
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
                        {item.imageSmall
                          ? <img className="want-thumb" src={item.imageSmall} alt="" loading="lazy" />
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
