import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addCollectionLot, addTradeListItem, closeCostPool, createLocation, decrementCollectionCopy,
  deleteLocation, fetchCollection, fetchCollectionCard, fetchCollectionValue, fetchLocations,
  fetchOpenCostPool, fetchSetChecklist, fetchSetCompletion, fetchSets, fetchSettings,
  fetchTradeLists, imageUrl, openCostPool, removeCollectionLot, setCostPoolSet,
  undoImportBatch, updateCollectionLot, updateCostPoolTotal,
  type CollectionCard, type CollectionCardDetail, type CollectionValue, type CostMethod,
  type CostPool, type SetRecord, type StorageLocation,
} from '../api.ts';
import { AddCardsDialog } from './AddCardsDialog.tsx';
import { Combobox } from './Combobox.tsx';
import { WantListsPage } from './WantListsPage.tsx';
import { TradeListsPage } from './TradeListsPage.tsx';

type Tab = 'browse' | 'add' | 'sets' | 'value' | 'wants' | 'tradelists';

const TAB_LABEL: Record<Tab, string> = {
  browse: 'Browse', add: 'Add by set', sets: 'Set Completion', value: 'Value',
  wants: 'Wants', tradelists: 'For trade',
};

const money = (value: number | null | undefined) =>
  value == null ? '—' : `$${Number(value).toFixed(2)}`;

const KINDS = [
  ['binder', 'Binder'], ['box', 'Box'], ['deck_box', 'Deck box'],
  ['shoebox', 'Shoebox'], ['shelf', 'Shelf'], ['other', 'Other'],
] as const;

// ---------------------------------------------------------------- value

/** Value over time, as a plain SVG line — no chart library for one sparkline. */
function ValueChart({ history }: { history: CollectionValue['history'] }) {
  if (history.length < 2) {
    return (
      <p className="note">
        One data point so far. A snapshot is taken after each price sync, so the trend
        fills in over the coming days.
      </p>
    );
  }

  const width = 640;
  const height = 160;
  const pad = 4;
  const values = history.map((h) => h.total_value_usd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const point = (index: number, value: number) => {
    const x = pad + (index / (history.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  const line = history.map((h, i) => point(i, h.total_value_usd)).join(' ');
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;

  return (
    <>
      <svg className="value-chart" viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Collection value from ${money(min)} to ${money(max)} over ${history.length} days`}>
        <polygon points={area} fill="var(--accent)" opacity="0.14" />
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2"
                  strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="chart-axis">
        <span>{history[0].captured_on}</span>
        <span>{money(min)} – {money(max)}</span>
        <span>{history.at(-1)!.captured_on}</span>
      </div>
    </>
  );
}

// ---------------------------------------------------------- card detail

function CardLots({
  oracleId,
  locations,
  onChanged,
}: {
  oracleId: string;
  locations: StorageLocation[];
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<CollectionCardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tradeListId, setTradeListId] = useState<number | null>(null);
  const [listed, setListed] = useState<number | null>(null);

  const load = useCallback(() => {
    fetchCollectionCard(oracleId).then(setDetail).catch((e) => setError(e.message));
  }, [oracleId]);
  useEffect(load, [load]);

  // The default trade list is where the "For trade" button lists a copy.
  useEffect(() => {
    fetchTradeLists()
      .then((lists) => setTradeListId((lists.find((l) => l.is_default) ?? lists[0])?.id ?? null))
      .catch(() => {});
  }, []);

  const listForTrade = async (lotId: number, quantity: number) => {
    if (tradeListId == null) return;
    setError(null);
    try {
      await addTradeListItem(tradeListId, lotId, { quantity });
      setListed(lotId);
      setTimeout(() => setListed((current) => (current === lotId ? null : current)), 1600);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const apply = async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="loading">Loading…</p>;

  return (
    <>
      {detail.availability && (
        <div className="fgroup">
          <h3>Availability</h3>
          <div className="kv"><span>Owned</span><span>{detail.availability.owned_qty}</span></div>
          <div className="kv"><span>Claimed by decks</span><span>{detail.availability.allocated_qty}</span></div>
          <div className="kv"><span>Free</span><span>{detail.availability.available_qty}</span></div>
        </div>
      )}

      {detail.decks.length > 0 && (
        <div className="fgroup">
          <h3>In decks</h3>
          {detail.decks.map((deck) => (
            <div className="kv" key={`${deck.deck_id}-${deck.board}`}>
              <span>{deck.deck_name}</span>
              <span>
                ×{deck.qty_from_collection}
                {deck.deck_home_location && ` · ${deck.deck_home_location}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="fgroup">
        <h3>Copies ({detail.lots.length} {detail.lots.length === 1 ? 'lot' : 'lots'})</h3>
        {detail.lots.map((lot) => (
          <div className="lot" key={lot.id}>
            <div className="lot-head">
              <strong>{lot.quantity}×</strong>
              <span>{lot.set_name ?? lot.set_code?.toUpperCase()} #{lot.collector_number}</span>
              {lot.finish !== 'nonfoil' && <span className="tag ok">{lot.finish}</span>}
              <span className="lot-value">{money(lot.line_value_usd)}</span>
            </div>
            <div className="lot-meta">
              <select
                value={lot.condition}
                onChange={(e) => apply(() => updateCollectionLot(lot.id, { condition: e.target.value }))}
                aria-label="Change condition"
              >
                {['NM', 'M', 'LP', 'MP', 'HP', 'DMG', 'unknown'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <span>·</span>
              <select
                value={lot.location_id}
                onChange={(e) => apply(() => updateCollectionLot(lot.id, { locationId: Number(e.target.value) }))}
                aria-label="Move to another location"
              >
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              {lot.acquired_unit_cost != null
                ? <span>paid {money(lot.acquired_unit_cost)} each</span>
                : <span className="note-inline">cost unknown</span>}
              {lot.is_overridden ? <span className="tag warn">override</span> : null}
            </div>
            <div className="lot-actions">
              <button className="linkish"
                      onClick={() => apply(() => updateCollectionLot(lot.id, { quantity: lot.quantity + 1 }))}>
                +1
              </button>
              <button className="linkish"
                      onClick={() => apply(() => updateCollectionLot(lot.id, { quantity: lot.quantity - 1 }))}>
                −1
              </button>
              <button className="linkish" disabled={tradeListId == null}
                      onClick={() => listForTrade(lot.id, lot.quantity)}>
                {listed === lot.id ? 'Listed ✓' : 'For trade'}
              </button>
              <button className="linkish danger" onClick={() => apply(() => removeCollectionLot(lot.id))}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------- set entry

/**
 * Set-scoped entry.
 *
 * Pick a set once, then work through it in collector-number order, which is the
 * order the cards sit in a binder. The set stays chosen after each add, so
 * filling a page is one click per card rather than a fresh search each time.
 */
function SetEntry({
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
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [toastRemoving, setToastRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cost basis for this add session. Starts from the app default, but is
  // switchable inline so a booster box, a draft, or single cards at FNM can each
  // assume cost differently without leaving the screen. 'draft' pools like 'box'
  // but its total defaults to 3× the booster pack price.
  const [costMethod, setCostMethod] = useState<CostMethod | 'draft'>('unknown');
  const [fixedAmount, setFixedAmount] = useState('');
  const [boosterPrice, setBoosterPrice] = useState(4);
  // The open cost pool (box/draft) lives on the server, so it survives leaving
  // this screen, a reload, or a break, and only ends when you finish it.
  const [pool, setPool] = useState<CostPool | null>(null);
  const [poolTotalStr, setPoolTotalStr] = useState('');
  const pooled = costMethod === 'box' || costMethod === 'draft';

  // Seed from the saved defaults, then resume any pool the server still has open.
  useEffect(() => {
    (async () => {
      let settings: Awaited<ReturnType<typeof fetchSettings>> | null = null;
      try { settings = await fetchSettings(); } catch { /* keep safe defaults */ }
      if (settings) {
        setBoosterPrice(settings.draftBoosterPriceUsd);
        setFixedAmount(settings.defaultCostFixedUsd ? String(settings.defaultCostFixedUsd) : '');
      }
      let open: CostPool | null = null;
      try { open = await fetchOpenCostPool(); } catch { /* ignore */ }
      if (open) {
        setPool(open);
        setCostMethod(open.label === 'Draft' ? 'draft' : 'box');
        setPoolTotalStr(String(open.totalCostUsd));
        if (open.setCode) setSetCode(open.setCode); // reopen the set it was working through
      } else if (settings) {
        setCostMethod(settings.defaultCostMethod);
      }
    })();
  }, []);

  // While a pool is open, remember the last set the session actually opened, so
  // resuming reopens it. Clearing the field is not "forget" — the pool keeps the
  // set so the banner can offer to reopen it.
  useEffect(() => {
    if (!pool || !setCode || setCode === pool.setCode) return;
    setCostPoolSet(pool.id, setCode).then((p) => { if (p) setPool(p); }).catch(() => {});
  }, [setCode, pool]);

  // Switching the pooled method (with nothing open yet) pre-fills a sensible
  // starting total: 3× a booster for a draft, blank for a box.
  const pickMethod = (m: CostMethod | 'draft') => {
    setCostMethod(m);
    if (!pool) setPoolTotalStr(m === 'draft' ? (boosterPrice * 3).toFixed(2) : m === 'box' ? '' : poolTotalStr);
  };

  // Editing the total of an open pool re-splits it; with none open it's just the
  // amount the next pool will start with.
  const commitTotal = async () => {
    if (!pool) return;
    try { setPool(await updateCostPoolTotal(pool.id, Number(poolTotalStr) || 0)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const finishPool = async () => {
    try { await closeCostPool(); } catch { /* ignore */ }
    setPool(null);
    setPoolTotalStr(costMethod === 'draft' ? (boosterPrice * 3).toFixed(2) : '');
  };

  // Cancel abandons the session and removes every card it added — the opposite
  // of Finish, which keeps them.
  const cancelPool = async () => {
    if (!pool) return;
    const n = pool.cardCount;
    if (n > 0 && !confirm(`Discard this ${pool.label.toLowerCase()} and remove the ${n} card${n === 1 ? '' : 's'} it added?`)) return;
    setError(null);
    try {
      if (n > 0) await undoImportBatch(pool.id);
      await closeCostPool();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setPool(null);
    setPoolTotalStr(costMethod === 'draft' ? (boosterPrice * 3).toFixed(2) : '');
    load();
    onChanged();
  };

  const setName = (code: string) => sets.find((s) => s.code === code)?.name ?? code.toUpperCase();

  const load = useCallback(() => {
    if (!setCode) { setCards([]); return; }
    setLoading(true);
    fetchSetChecklist(setCode)
      .then(setCards)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [setCode]);
  useEffect(load, [load]);

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
      let current = pool;
      if (pooled && !current) {
        current = await openCostPool(Math.max(0, Number(poolTotalStr) || 0), costMethod === 'draft' ? 'Draft' : 'Box split', setCode || undefined);
        setPool(current);
      }
      await addCollectionLot({
        printingId, locationId, quantity: 1, finish, condition,
        costMethod: pooled ? 'box' : costMethod,
        fixedAmount: costMethod === 'fixed' ? Number(fixedAmount) || 0 : undefined,
        batchId: pooled && current ? current.id : undefined,
      });
      if (pooled) { try { setPool(await fetchOpenCostPool()); } catch { /* keep prior */ } }
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

  const shown = hideOwned ? cards.filter((c) => c.owned_qty === 0) : cards;
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
        <label>
          <span>Cost</span>
          <select value={costMethod} onChange={(e) => pickMethod(e.target.value as CostMethod | 'draft')}>
            <option value="unknown">Unknown</option>
            <option value="free">Free ($0)</option>
            <option value="market">Market price</option>
            <option value="fixed">Fixed each</option>
            <option value="draft">Draft</option>
            <option value="box">Box split</option>
          </select>
        </label>
        {costMethod === 'fixed' && (
          <label style={{ width: 96 }}>
            <span>$ each</span>
            <input
              type="number" min="0" step="0.01" placeholder="0.00"
              value={fixedAmount} onChange={(e) => setFixedAmount(e.target.value)}
            />
          </label>
        )}
        {pooled && (
          <label style={{ width: 120 }}>
            <span>{costMethod === 'draft' ? 'Draft cost $' : 'Box total $'}</span>
            <input
              type="number" min="0" step="0.01" placeholder={costMethod === 'draft' ? 'e.g. 12' : 'e.g. 120'}
              value={poolTotalStr}
              onChange={(e) => setPoolTotalStr(e.target.value)}
              onBlur={commitTotal}
            />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={hideOwned} onChange={(e) => setHideOwned(e.target.checked)} />
          Hide ones I have
        </label>
      </div>

      {pool ? (
        <div className="pool-banner">
          <span>
            <strong>{pool.label} open</strong> · {money(pool.totalCostUsd)} · {pool.cardCount}{' '}
            {pool.cardCount === 1 ? 'card' : 'cards'} · {money(pool.perCopy)} each
            {pool.setCode && (
              <>
                {' · '}
                <button
                  className="linkish"
                  onClick={() => setSetCode(pool.setCode!)}
                  title="Reopen this set"
                >
                  {setName(pool.setCode)}{pool.setCode === setCode ? '' : ' ↩'}
                </button>
              </>
            )}
          </span>
          <span className="pool-actions">
            <button className="btn secondary small" onClick={finishPool} title="Keep these cards and close the pool">Finish</button>
            <button className="btn secondary small cancel" onClick={cancelPool} title="Remove every card this pool added and close it">Cancel</button>
          </span>
        </div>
      ) : pooled && (
        <p className="hint">
          The first card you add opens a pool — the {costMethod === 'draft' ? 'draft cost' : 'box total'} is
          split evenly across everything you add and keeps re-dividing as you go. It stays open
          (even if you leave and come back) until you tap <strong>Finish</strong>.
          {costMethod === 'draft' && ' The total defaults to 3× the booster pack price from Data → Settings.'}
        </p>
      )}

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

// ------------------------------------------------------------------ page

export function CollectionPage() {
  const [tab, setTab] = useState<Tab>('browse');
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [sets, setSets] = useState<SetRecord[]>([]);
  const [value, setValue] = useState<CollectionValue | null>(null);
  const [setStats, setSetStats] = useState<Awaited<ReturnType<typeof fetchSetCompletion>>>([]);

  const [cards, setCards] = useState<CollectionCard[]>([]);
  const [totals, setTotals] = useState({ distinctCards: 0, totalCards: 0, totalValue: 0 });
  const [locationFilter, setLocationFilter] = useState<number | undefined>();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [selected, setSelected] = useState<{ oracleId: string; printingId: string | null; finish: string } | null>(null);
  const [adding, setAdding] = useState<{ oracleId: string; printingId?: string | null } | null>(null);
  const [newLocation, setNewLocation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reloadLocations = useCallback(() => {
    fetchLocations().then(setLocations).catch((e) => setError(e.message));
  }, []);

  const reloadValue = useCallback(() => {
    fetchCollectionValue().then(setValue).catch(() => undefined);
  }, []);

  useEffect(() => {
    reloadLocations();
    reloadValue();
    fetchSets().then(setSets).catch(() => undefined);
  }, [reloadLocations, reloadValue]);

  useEffect(() => {
    if (tab === 'sets') fetchSetCompletion().then(setSetStats).catch(() => undefined);
  }, [tab]);

  const reloadCards = useCallback(() => {
    setLoading(true);
    fetchCollection({ location: locationFilter, q: query || undefined, sort, limit: 120 })
      .then((result) => {
        setCards(result.cards);
        setTotals({
          distinctCards: result.distinctCards,
          totalCards: result.totalCards,
          totalValue: result.totalValue,
        });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [locationFilter, query, sort]);

  useEffect(() => {
    if (tab !== 'browse') return;
    const timer = setTimeout(reloadCards, 180);
    return () => clearTimeout(timer);
  }, [tab, reloadCards]);

  const refreshAll = () => { reloadCards(); reloadLocations(); reloadValue(); };

  const removeLocation = async (location: StorageLocation) => {
    setError(null);
    try {
      const fallback = locations.find((l) => l.is_default && l.id !== location.id)
        ?? locations.find((l) => l.id !== location.id);
      // Only offer to relocate when there is somewhere to put things.
      const moveTo = location.card_count > 0 ? fallback?.id : undefined;
      if (location.card_count > 0 && !moveTo) {
        setError('Create another location first so these cards have somewhere to go.');
        return;
      }
      setLocations(await deleteLocation(location.id, moveTo));
      if (locationFilter === location.id) setLocationFilter(undefined);
      refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const totalValue = value?.value.total_value_usd ?? 0;
  const totalCost = value?.value.total_cost_basis_usd ?? null;
  const gain = value?.value.unrealized_gain_usd ?? null;

  return (
    <div className="deck-shell">
      <div className="deck-header">
        <div className="brand" style={{ marginRight: 8 }}>Collection</div>
        <nav className="tabs small">
          {(['browse', 'add', 'sets', 'value', 'wants', 'tradelists'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        {tab !== 'wants' && tab !== 'tradelists' && (
          <span className="count">
            {value?.value.total_cards ?? 0} cards · {money(totalValue)}
            {gain != null && (
              <span className={Number(gain) >= 0 ? 'gain-up' : 'gain-down'}>
                {' '}{Number(gain) >= 0 ? '+' : ''}{money(gain)}
              </span>
            )}
          </span>
        )}
      </div>

      {error && <div className="error" style={{ margin: 12 }}>{error}</div>}

      {tab === 'browse' && (
        <div className="panes">
          <aside className="filters">
            <div className="fgroup">
              <h3>Locations</h3>
              <button
                className={`loc${locationFilter === undefined ? ' on' : ''}`}
                onClick={() => setLocationFilter(undefined)}
              >
                <span>Everywhere</span>
                <span className="count">{value?.value.total_cards ?? 0}</span>
              </button>
              {locations.map((location) => (
                <div className="loc-row" key={location.id}>
                  <button
                    className={`loc${locationFilter === location.id ? ' on' : ''}`}
                    onClick={() => setLocationFilter(location.id)}
                  >
                    <span>{location.name}</span>
                    <span className="count">{location.card_count}</span>
                  </button>
                  {!location.is_default && (
                    <button className="loc-del" onClick={() => removeLocation(location)}
                            aria-label={`Delete ${location.name}`}>×</button>
                  )}
                </div>
              ))}
              <div className="preset-save" style={{ marginTop: 8 }}>
                <input
                  value={newLocation}
                  placeholder="New location"
                  onChange={(e) => setNewLocation(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key !== 'Enter' || !newLocation.trim()) return;
                    try {
                      setLocations(await createLocation(newLocation.trim(), 'binder'));
                      setNewLocation('');
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                />
                <p className="note">
                  Deleting a location moves its cards to another one rather than
                  discarding them.
                </p>
              </div>
            </div>

            <div className="fgroup">
              <h3>Sort</h3>
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="name">Name</option>
                <option value="value">Value</option>
                <option value="quantity">Quantity</option>
                <option value="setNumber">Set and number</option>
                <option value="recent">Recently added</option>
              </select>
            </div>
          </aside>

          <main className="results">
            <div className="searchbox" style={{ marginBottom: 10 }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a card in your collection"
                aria-label="Search the collection"
              />
            </div>

            <div className="results-head">
              <span className="count">
                {loading ? 'Loading…' : `${totals.distinctCards} cards · ${totals.totalCards} copies · ${money(totals.totalValue)}`}
              </span>
            </div>

            {!loading && cards.length === 0 && (
              <p className="empty">
                Nothing here yet. Use <strong>Add by set</strong> to work through a binder,
                or add cards from the Browse tab.
              </p>
            )}

            <div className="grid">
              {cards.map((card) => (
                <button
                  className={`card${card.finish !== 'nonfoil' ? ' is-foil' : ''}`}
                  key={`${card.printingId ?? card.oracleId}:${card.finish}`}
                  aria-selected={selected?.printingId === card.printingId && selected?.finish === card.finish}
                  onClick={() => setSelected({ oracleId: card.oracleId, printingId: card.printingId, finish: card.finish })}
                  title={`${card.name} — ${card.setName ?? card.setCode?.toUpperCase()} #${card.collectorNumber}`}
                >
                  <span className="card-art">
                    {card.printingId && card.imageSmall
                      ? <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
                      : <div className="placeholder">{card.name}</div>}
                    {card.finish !== 'nonfoil' && <span className="foil-overlay" aria-hidden="true" />}
                  </span>
                  <span className="owned-badge">{card.ownedQuantity}</span>
                  {card.finish !== 'nonfoil' && (
                    <span className="foil-badge" title={card.finish}>{card.finish === 'etched' ? 'etched' : 'foil'}</span>
                  )}
                  {card.locationCount > 1 && (
                    <span className="split-badge" title={`Split across ${card.locationCount} locations`}>
                      {card.locationCount} places
                    </span>
                  )}
                  <div className="cname">{card.name}</div>
                  <div className="cset">{(card.setCode?.toUpperCase() ?? '')} · #{card.collectorNumber}</div>
                  <div className="cvalue">{money(card.valueUsd)}</div>
                </button>
              ))}
            </div>
          </main>

          <aside className="detail-pane">
            {selected ? (
              <>
                <div className="btnrow" style={{ marginBottom: 10 }}>
                  <button className="btn" onClick={() => setAdding({ oracleId: selected.oracleId, printingId: selected.printingId })}>
                    Add more
                  </button>
                  <button className="btn secondary" onClick={() => setSelected(null)}>Close</button>
                </div>
                <CardLots oracleId={selected.oracleId} locations={locations} onChanged={refreshAll} />
              </>
            ) : (
              <p className="empty">Select a card to see where its copies live.</p>
            )}
          </aside>
        </div>
      )}

      {tab === 'add' && (
        <div className="results">
          <SetEntry sets={sets} locations={locations} onChanged={refreshAll} />
        </div>
      )}

      {tab === 'sets' && (
        <div className="results">
          <h3 className="section-title">Set Completion</h3>
          {setStats.length === 0 && <p className="empty">Add some cards to see set progress.</p>}
          {setStats.map((s) => (
            <div className="setrow" key={s.set_code}>
              <span className="setrow-name">{s.set_name}</span>
              <div className="colorbar-track">
                <div className="colorbar-fill cG" style={{ width: `${s.percent_complete ?? 0}%` }} />
              </div>
              <span className="count">{s.owned_printings}/{s.total_cards} · {s.percent_complete ?? 0}%</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'value' && (
        <div className="results">
          <div className="value-summary">
            <div className="stat"><b>{money(totalValue)}</b><span>market value</span></div>
            <div className="stat"><b>{money(totalCost)}</b><span>what you paid</span></div>
            <div className="stat">
              <b className={Number(gain) >= 0 ? 'gain-up' : 'gain-down'}>{money(gain)}</b>
              <span>unrealised</span>
            </div>
            <div className="stat"><b>{value?.value.total_cards ?? 0}</b><span>cards</span></div>
          </div>
          {value && <ValueChart history={value.history} />}
          <p className="note">
            Cost covers only the {value?.value.cost_known_cards ?? 0} copies with a known
            purchase price; the rest are recorded as unknown rather than free, so the
            unrealised figure is not inflated.
          </p>
        </div>
      )}

      {tab === 'wants' && <WantListsPage />}
      {tab === 'tradelists' && <TradeListsPage />}

      {adding && (
        <AddCardsDialog
          oracleId={adding.oracleId}
          printingId={adding.printingId}
          locations={locations}
          onClose={() => setAdding(null)}
          onAdded={refreshAll}
        />
      )}
    </div>
  );
}
