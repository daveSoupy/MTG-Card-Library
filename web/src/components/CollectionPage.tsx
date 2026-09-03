import { useCallback, useEffect, useState } from 'react';
import {
  addCollectionLot, createLocation, deleteLocation, fetchCollection, fetchCollectionCard,
  fetchCollectionValue, fetchLocations, fetchSetChecklist, fetchSetCompletion, fetchSets,
  imageUrl, removeCollectionLot, updateCollectionLot,
  type CollectionCard, type CollectionCardDetail, type CollectionValue,
  type SetRecord, type StorageLocation,
} from '../api.ts';
import { AddCardsDialog } from './AddCardsDialog.tsx';

type Tab = 'browse' | 'add' | 'sets' | 'value';

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

  const load = useCallback(() => {
    fetchCollectionCard(oracleId).then(setDetail).catch((e) => setError(e.message));
  }, [oracleId]);
  useEffect(load, [load]);

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
              <span className="lot-value">{money(lot.line_value_usd)}</span>
            </div>
            <div className="lot-meta">
              {lot.finish !== 'nonfoil' && <span className="tag ok">{lot.finish}</span>}
              <span>{lot.condition}</span>
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!setCode) { setCards([]); return; }
    setLoading(true);
    fetchSetChecklist(setCode)
      .then(setCards)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [setCode]);
  useEffect(load, [load]);

  const add = async (printingId: string, name: string) => {
    setError(null);
    try {
      await addCollectionLot({ printingId, locationId, quantity: 1, finish, condition });
      setJustAdded(name);
      setTimeout(() => setJustAdded((current) => (current === name ? null : current)), 1400);
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
          <select value={setCode} onChange={(e) => setSetCode(e.target.value)}>
            <option value="">Choose a set…</option>
            {sets.map((s) => (
              <option key={s.code} value={s.code}>{s.name} ({s.code.toUpperCase()})</option>
            ))}
          </select>
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
        <label className="check">
          <input type="checkbox" checked={hideOwned} onChange={(e) => setHideOwned(e.target.checked)} />
          Hide ones I have
        </label>
      </div>

      {error && <div className="error">{error}</div>}
      {justAdded && <div className="verdict ok">Added {justAdded}.</div>}

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
          </div>
          <div className="entry-grid">
            {shown.map((card) => (
              <button
                className={`entry-tile${card.owned_qty > 0 ? ' owned' : ''}`}
                key={card.printing_id}
                onClick={() => add(card.printing_id, card.name)}
                title={`Add ${card.name} to ${locations.find((l) => l.id === locationId)?.name}`}
              >
                {card.image_small
                  ? <img src={imageUrl(card.printing_id, 'small')} alt={card.name} loading="lazy" decoding="async" />
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
  const [selected, setSelected] = useState<string | null>(null);
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
          {(['browse', 'add', 'sets', 'value'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'browse' ? 'Browse' : t === 'add' ? 'Add by set' : t === 'sets' ? 'Sets' : 'Value'}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <span className="count">
          {value?.value.total_cards ?? 0} cards · {money(totalValue)}
          {gain != null && (
            <span className={Number(gain) >= 0 ? 'gain-up' : 'gain-down'}>
              {' '}{Number(gain) >= 0 ? '+' : ''}{money(gain)}
            </span>
          )}
        </span>
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
                  className="card"
                  key={card.oracleId}
                  aria-selected={card.oracleId === selected}
                  onClick={() => setSelected(card.oracleId)}
                  title={`${card.name} — ${card.typeLine}`}
                >
                  {card.printingId && card.imageSmall
                    ? <img src={imageUrl(card.printingId, 'small')} alt={card.name} loading="lazy" decoding="async" />
                    : <div className="placeholder">{card.name}</div>}
                  <span className="owned-badge">{card.ownedQuantity}</span>
                  {card.locationCount > 1 && (
                    <span className="split-badge" title={`Split across ${card.locationCount} locations`}>
                      {card.locationCount} places
                    </span>
                  )}
                  <div className="cname">{card.name}</div>
                  <div className="cvalue">{money(card.valueUsd)}</div>
                </button>
              ))}
            </div>
          </main>

          <aside className="detail-pane">
            {selected ? (
              <>
                <div className="btnrow" style={{ marginBottom: 10 }}>
                  <button className="btn" onClick={() => setAdding({ oracleId: selected })}>
                    Add more
                  </button>
                  <button className="btn secondary" onClick={() => setSelected(null)}>Close</button>
                </div>
                <CardLots oracleId={selected} locations={locations} onChanged={refreshAll} />
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
          <h3 className="section-title">Set completion</h3>
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
