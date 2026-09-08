import { useCallback, useEffect, useState } from 'react';
import {
  addTradeListItem, createLocation, deleteLocation, fetchCollection, fetchCollectionCard,
  fetchCollectionValue, fetchLocations, fetchSetCompletion, fetchSets, fetchTradeLists,
  removeCollectionLot, updateCollectionLot,
  type CollectionCard, type CollectionCardDetail, type CollectionValue, type SetRecord,
  type StorageLocation,
} from '../api.ts';
import { AddCardsDialog } from './AddCardsDialog.tsx';
import { WantListsPage } from './WantListsPage.tsx';
import { TradeListsPage } from './TradeListsPage.tsx';
import { CollectionValuePanel } from './CollectionValuePanel.tsx';
import { AddBySetTab } from './AddBySetTab.tsx';
import { OwnedGrid, type OwnedGridSelection } from './OwnedGrid.tsx';

type Tab = 'browse' | 'add' | 'sets' | 'value' | 'wants' | 'tradelists';

const TAB_LABEL: Record<Tab, string> = {
  browse: 'Browse', add: 'Add by set', sets: 'Set Completion', value: 'Value',
  wants: 'Wants', tradelists: 'For trade',
};

const money = (value: number | null | undefined) =>
  value == null ? '—' : `$${Number(value).toFixed(2)}`;

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
              <span className="lot-paid">
                paid $
                <input
                  key={`paid-${lot.id}-${lot.acquired_unit_cost ?? ''}`}
                  type="number" min="0" step="0.01" placeholder="unknown"
                  defaultValue={lot.acquired_unit_cost ?? ''}
                  aria-label="What you paid for each copy"
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    const next = raw === '' ? null : Number(raw);
                    if (next === (lot.acquired_unit_cost ?? null)) return;
                    apply(() => updateCollectionLot(lot.id, { acquiredUnitCost: next }));
                  }}
                />
                each
              </span>
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
  const [selected, setSelected] = useState<OwnedGridSelection | null>(null);
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

            <OwnedGrid
              cards={cards}
              selected={selected}
              onSelect={(card) => setSelected({ oracleId: card.oracleId, printingId: card.printingId, finish: card.finish })}
            />
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
          <AddBySetTab sets={sets} locations={locations} onChanged={refreshAll} />
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

      {tab === 'value' && <CollectionValuePanel value={value} />}

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
