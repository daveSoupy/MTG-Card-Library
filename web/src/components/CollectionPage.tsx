import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import {
  addCollectionLot, addTradeListItem, createLocation, deleteLocation, fetchCollection,
  restoreLocation,
  fetchCollectionCard, fetchCollectionValue, fetchLocations, fetchSetCompletion, fetchSets,
  fetchTradeList, fetchTradeLists, removeCollectionLot, removeTradeListItem, updateCollectionLot,
  updateTradeListItem, DECK_STATUS_HINT, type NamedList,
  type CollectionCard, type CollectionCardDetail, type CollectionLot, type CollectionValue,
  type LocationRestore, type SetRecord, type StorageLocation,
} from '../api.ts';
import { LocationDeleteConfirm } from './LocationDeleteConfirm.tsx';
import { ListForTradeForm } from './ListForTradeForm.tsx';
import { useUndoShortcuts, useUndoStack, type UndoEntry } from '../undo.ts';
import { AddCardsDialog } from './AddCardsDialog.tsx';
import { WantListsPage } from './WantListsPage.tsx';
import { TradeListsPage } from './TradeListsPage.tsx';
import { CollectionValuePanel } from './CollectionValuePanel.tsx';
import { AddBySetTab } from './AddBySetTab.tsx';
import { OwnedGrid, type OwnedGridSelection } from './OwnedGrid.tsx';
import { BackToTop } from './BackToTop.tsx';
import { UndoToast } from './UndoToast.tsx';
import { CustomizeView } from './CustomizeView.tsx';
import { groupByField, type GroupBy } from '../deckView.ts';
import type { Density, DensityPage } from '../density.ts';
import { COLLECTION_TABS, type CollectionTab } from '../router.ts';
import { count, money } from '../format.ts';

const TAB_LABEL: Record<CollectionTab, string> = {
  browse: 'Cards', add: 'Add by set', sets: 'Set Completion', value: 'Value',
  wants: 'Wants', tradelists: 'For trade',
};


const COLLECTION_SORTS = [
  ['name', 'Name'],
  ['value', 'Value'],
  ['quantity', 'Quantity'],
  ['setNumber', 'Set and number'],
  ['recent', 'Recently added'],
] as const;

/**
 * A collection row carries neither `rarity` nor `colors` — the browse endpoint
 * has both, this one aggregates lots — so those two groupings are left off
 * here rather than filing every card into one bucket. Adding them is an API
 * change, which Phase 10 puts out of scope.
 */
const COLLECTION_GROUPS: GroupBy[] = ['none', 'type', 'subtype', 'colorIdentity', 'mana', 'set'];

// ---------------------------------------------------------- card detail

/** Everything needed to put a deleted lot back exactly as it was. */
const lotFields = (lot: CollectionLot) => ({
  printingId: lot.printing_id,
  locationId: lot.location_id,
  quantity: lot.quantity,
  finish: lot.finish,
  condition: lot.condition,
  priceOverride: lot.price_override,
  acquiredAt: lot.acquired_at,
  acquiredUnitCost: lot.acquired_unit_cost,
  acquisitionKind: lot.acquisition_kind,
  acquiredFrom: lot.acquired_from,
  notes: lot.notes,
});

function CardLots({
  oracleId,
  cardName,
  locations,
  onChanged,
  record,
}: {
  oracleId: string;
  cardName: string;
  locations: StorageLocation[];
  onChanged: () => void;
  /** Adds this edit to the collection session's undo stack. */
  record: (entry: UndoEntry) => void;
}) {
  const [detail, setDetail] = useState<CollectionCardDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tradeLists, setTradeLists] = useState<NamedList[]>([]);
  // The lot whose "For trade" form is open, and whether its listing is saving.
  const [tradingLot, setTradingLot] = useState<number | null>(null);
  const [listing, setListing] = useState(false);
  const [listed, setListed] = useState<number | null>(null);

  const load = useCallback(() => {
    fetchCollectionCard(oracleId).then(setDetail).catch((e) => setError(e.message));
  }, [oracleId]);
  useEffect(load, [load]);

  // The lists "For trade" can put a copy on; the form defaults to the default.
  useEffect(() => {
    fetchTradeLists().then(setTradeLists).catch(() => {});
  }, []);

  /**
   * Lists `quantity` copies of a lot, with an undo that puts the listing back
   * as it was. Adding is an upsert — a lot already on that list has its count
   * replaced — so what was there before is read first, and its asking price
   * and notes are carried through rather than wiped by the upsert.
   */
  const listForTrade = async (lot: CollectionLot, listId: number, quantity: number) => {
    setError(null);
    setListing(true);
    try {
      const prior = (await fetchTradeList(listId)).items.find((i) => i.collectionItemId === lot.id);
      const fields = {
        quantity,
        askingPriceUsd: prior?.askingPriceUsd ?? null,
        notes: prior?.notes ?? null,
      };
      const itemOf = (list: { items: Array<{ id: number; collectionItemId: number }> }) =>
        list.items.find((i) => i.collectionItemId === lot.id)?.id;
      let itemId = itemOf(await addTradeListItem(listId, lot.id, fields));
      setTradingLot(null);
      setListed(lot.id);
      setTimeout(() => setListed((current) => (current === lot.id ? null : current)), 1600);
      // The Availability block above reads this card's detail, which the
      // listing has just changed — reload it, not only the page around it.
      refresh();
      const list = tradeLists.find((l) => l.id === listId)?.name ?? 'a trade list';
      record({
        label: `listing ${quantity} ${cardName} on ${list}`,
        undo: async () => {
          if (itemId === undefined) return;
          if (prior) await updateTradeListItem(listId, itemId, { quantity: prior.quantity });
          else await removeTradeListItem(listId, itemId);
          refresh();
        },
        redo: async () => {
          itemId = itemOf(await addTradeListItem(listId, lot.id, fields));
          refresh();
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setListing(false);
    }
  };

  const apply = async (action: () => Promise<unknown>, undoable?: () => void) => {
    setError(null);
    try { await action(); undoable?.(); load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const refresh = () => { load(); onChanged(); };

  /**
   * Remembers how to reverse one lot edit.
   *
   * A quantity that reaches zero deletes the lot outright server-side, so the
   * inverse of those is a fresh add rather than a quantity — and the new lot's
   * id is what a later redo has to remove.
   *
   * Each entry follows its own lot's id from there on. Entries recorded before
   * a lot was deleted keep the id it had then, so undoing past a deletion of
   * the same lot does nothing rather than risk editing whatever row inherited
   * that id — SQLite reuses rowids.
   */
  const recordEdit = (
    lot: CollectionLot,
    label: string,
    changes: Record<string, unknown> | null,
    revert: Record<string, unknown>,
  ) => {
    const gone = changes === null
      || (changes.quantity !== undefined && Number(changes.quantity) <= 0);
    let id = lot.id;
    record({
      label,
      undo: async () => {
        if (gone) id = (await addCollectionLot(lotFields(lot))).id;
        else await updateCollectionLot(id, revert);
        refresh();
      },
      redo: async () => {
        if (gone) await removeCollectionLot(id);
        else await updateCollectionLot(id, changes);
        refresh();
      },
    });
  };

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="loading">Loading…</p>;

  return (
    <>
      {detail.availability && (
        <div className="fgroup">
          <h3>Availability</h3>
          <div className="kv"><span>Owned</span><span>{detail.availability.owned_qty}</span></div>
          {/* Only decks that are building or assembled show up here — a brew
              holds a card list without laying claim to cardboard. */}
          <div className="kv">
            <span>Claimed by decks</span><span>{detail.availability.allocated_qty}</span>
          </div>
          {detail.availability.trade_listed_qty > 0 && (
            <div className="kv">
              <span>On a trade list</span><span>{detail.availability.trade_listed_qty}</span>
            </div>
          )}
          <div className="kv"><span>Free</span><span>{detail.availability.available_qty}</span></div>
          {/* The whole point of the row above being 0 on a card sitting in your
              binder: say which of the two reasons it is. */}
          {detail.availability.available_qty === 0 && detail.availability.owned_qty > 0 && (
            <p className="hint">
              {detail.availability.trade_listed_qty > 0 && detail.availability.allocated_qty > 0
                ? 'Every copy is either in a deck or promised on a trade list.'
                : detail.availability.trade_listed_qty > 0
                  ? 'Every copy is promised on a trade list.'
                  : 'Every copy is in a deck that is building or assembled.'}
            </p>
          )}
          {!detail.availability.is_tracked && (
            <p className="hint">
              Basic lands are not tracked against decks — grab as many as you need.
            </p>
          )}
        </div>
      )}

      {detail.decks.length > 0 && (
        <div className="fgroup">
          <h3>In decks</h3>
          {detail.decks.map((deck) => (
            <div className="kv" key={`${deck.deck_id}-${deck.board}`}>
              <span>
                {deck.deck_name}
                <span className="status-dot" data-status={deck.deck_status}
                      title={DECK_STATUS_HINT[deck.deck_status]} />
              </span>
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
                onChange={(e) => {
                  const condition = e.target.value;
                  apply(
                    () => updateCollectionLot(lot.id, { condition }),
                    () => recordEdit(lot, `the condition of ${cardName}`,
                      { condition }, { condition: lot.condition }),
                  );
                }}
                aria-label="Change condition"
              >
                {['NM', 'M', 'LP', 'MP', 'HP', 'DMG', 'unknown'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <span>·</span>
              <select
                value={lot.location_id}
                onChange={(e) => {
                  const locationId = Number(e.target.value);
                  apply(
                    () => updateCollectionLot(lot.id, { locationId }),
                    () => recordEdit(lot, `moving ${cardName}`,
                      { locationId }, { locationId: lot.location_id }),
                  );
                }}
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
                    apply(
                      () => updateCollectionLot(lot.id, { acquiredUnitCost: next }),
                      () => recordEdit(lot, `what you paid for ${cardName}`,
                        { acquiredUnitCost: next },
                        { acquiredUnitCost: lot.acquired_unit_cost }),
                    );
                  }}
                />
                each
              </span>
              {lot.is_overridden ? <span className="tag warn">override</span> : null}
            </div>
            <div className="lot-actions">
              <button className="linkish"
                      onClick={() => apply(
                        () => updateCollectionLot(lot.id, { quantity: lot.quantity + 1 }),
                        () => recordEdit(lot, `adding a copy of ${cardName}`,
                          { quantity: lot.quantity + 1 }, { quantity: lot.quantity }),
                      )}>
                +1
              </button>
              <button className="linkish"
                      onClick={() => apply(
                        () => updateCollectionLot(lot.id, { quantity: lot.quantity - 1 }),
                        () => recordEdit(lot, `removing a copy of ${cardName}`,
                          { quantity: lot.quantity - 1 }, { quantity: lot.quantity }),
                      )}>
                −1
              </button>
              <button className="linkish" disabled={tradeLists.length === 0}
                      aria-expanded={tradingLot === lot.id}
                      onClick={() => setTradingLot(tradingLot === lot.id ? null : lot.id)}>
                {listed === lot.id ? 'Listed ✓' : 'For trade…'}
              </button>
              <button className="linkish danger"
                      onClick={() => apply(
                        () => removeCollectionLot(lot.id),
                        () => recordEdit(lot, `removing ${cardName} from ${lot.location_name}`, null, {}),
                      )}>
                Remove
              </button>
            </div>
            {tradingLot === lot.id && (
              <ListForTradeForm
                max={lot.quantity}
                lists={tradeLists}
                busy={listing}
                onSubmit={(listId, quantity) => listForTrade(lot, listId, quantity)}
                onCancel={() => setTradingLot(null)}
              />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ page

export function CollectionPage({
  tab,
  onTabChange,
  page,
  density,
  onDensity,
  densityOverridden,
  onResetDensity,
  wantsDensity,
}: {
  /** Which sub-tab is showing. Owned by the URL (`/collection/<tab>`), so a
   *  reload or a pasted link opens on the same one; App reads it from the
   *  route and `onTabChange` navigates rather than setting local state. */
  tab: CollectionTab;
  onTabChange: (tab: CollectionTab) => void;
  page: DensityPage;
  density: Density;
  onDensity: (density: Density) => void;
  densityOverridden: boolean;
  onResetDensity: () => void;
  wantsDensity: {
    page: DensityPage;
    density: Density;
    onDensity: (density: Density) => void;
    densityOverridden: boolean;
    onResetDensity: () => void;
  };
}) {
  const subtabs = useRef<HTMLElement>(null);
  useEffect(() => {
    // Optional chaining: jsdom has no scrollIntoView.
    subtabs.current?.querySelector<HTMLElement>('button.on')
      ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [tab]);
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [sets, setSets] = useState<SetRecord[]>([]);
  const [value, setValue] = useState<CollectionValue | null>(null);
  const [setStats, setSetStats] = useState<Awaited<ReturnType<typeof fetchSetCompletion>>>([]);

  const [cards, setCards] = useState<CollectionCard[]>([]);
  const [totals, setTotals] = useState({ distinctCards: 0, totalCards: 0, totalValue: 0 });
  const [locationFilter, setLocationFilter] = useState<number | undefined>();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');

  // Same reasoning as App.tsx: this was called inline in the JSX, over up to
  // 120 rows, in a component whose state changes on every keystroke.
  const cardGroups = useMemo(
    () => groupByField(cards, groupBy, (card) => card.ownedQuantity),
    [cards, groupBy],
  );
  const [selected, setSelected] = useState<OwnedGridSelection | null>(null);
  const [adding, setAdding] = useState<{ oracleId: string; printingId?: string | null } | null>(null);
  const [newLocation, setNewLocation] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A failed load, kept apart from `error` (which an action sets and the
  // next action clears) because it decides what the page is allowed to say:
  // while it is set, "Nothing here yet" would be a lie — nothing came back
  // because nothing answered, not because the collection is empty.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setStatsFailed, setSetStatsFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  // One stack per collection session, alongside the deck builder's. The
  // long-press undo on the add-by-set tiles stays as it is; this covers lot
  // edits, which had no undo at all. Reached by ⌘Z / ⌘⇧Z rather than by
  // buttons — the header has enough in it already.
  const undoStack = useUndoStack();
  useUndoShortcuts(undoStack);
  // The location whose delete confirm is open, and whether a delete is
  // running — while one is, every other × holds still.
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [deletingLocation, setDeletingLocation] = useState(false);

  const reloadLocations = useCallback(() => {
    fetchLocations().then(setLocations).catch((e) => setLoadError(e.message));
  }, []);

  const reloadValue = useCallback(() => {
    // Failure leaves `value` null, and the header shows no count rather than
    // "0 cards · $0.00" for a collection it could not read.
    fetchCollectionValue().then(setValue).catch(() => setValue(null));
  }, []);

  useEffect(() => {
    reloadLocations();
    reloadValue();
    fetchSets().then(setSets).catch(() => undefined);
  }, [reloadLocations, reloadValue]);

  useEffect(() => {
    if (tab !== 'sets') return;
    fetchSetCompletion()
      .then((stats) => { setSetStats(stats); setSetStatsFailed(false); })
      .catch((e) => { setSetStatsFailed(true); setLoadError(e.message); });
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
        setLoadError(null);
      })
      .catch((e) => { setCards([]); setLoadError(e.message); })
      .finally(() => setLoading(false));
  }, [locationFilter, query, sort]);

  useEffect(() => {
    if (tab !== 'browse') return;
    const timer = setTimeout(reloadCards, 180);
    return () => clearTimeout(timer);
  }, [tab, reloadCards]);

  const refreshAll = () => { reloadCards(); reloadLocations(); reloadValue(); };

  /**
   * After the confirm's delete: the undo goes on the collection stack with the
   * toast. Undo recreates the location from the record the delete returned —
   * its lots, name, kind and deck homes — and redo deletes it again, taking a
   * fresh record, since the location may have come back under a new id.
   */
  const locationDeleted = (name: string, result: { locations: StorageLocation[]; restore: LocationRestore }) => {
    setConfirmingDelete(null);
    setLocations(result.locations);
    if (locationFilter === result.restore.location.id) setLocationFilter(undefined);
    refreshAll();
    let restore = result.restore;
    let id = restore.location.id;
    undoStack.record({
      label: `deleting ${name}`,
      undo: async () => {
        const back = await restoreLocation(restore);
        id = back.id;
        setLocations(back.locations);
        refreshAll();
      },
      redo: async () => {
        const again = await deleteLocation(id, restore.movedTo ?? undefined);
        restore = again.restore;
        setLocations(again.locations);
        refreshAll();
      },
    });
  };

  const totalValue = value?.value.total_value_usd ?? 0;
  const gain = value?.value.unrealized_gain_usd ?? null;

  return (
    <div className="deck-shell">
      <div className="deck-header">
        <div className="brand" style={{ marginRight: 8 }}>Collection</div>
        {/* One scrolling row on a phone (the CSS), so the active tab may sit
            off the edge — bring it into view rather than leave "Wants" hidden
            behind the fold after a tap on it. */}
        <nav className="tabs small subtabs" ref={subtabs}>
          {COLLECTION_TABS.map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => onTabChange(t)}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        {tab !== 'wants' && tab !== 'tradelists' && value && (
          <span className="count">
            {count(value.value.total_cards ?? 0)} copies · {money(totalValue)}
            {gain != null && (
              <span className={Number(gain) >= 0 ? 'gain-up' : 'gain-down'} title="Market value minus what you paid, for copies with a known cost">
                {' '}{Number(gain) >= 0 ? '+' : ''}{money(gain)} unrealised
              </span>
            )}
          </span>
        )}
      </div>

      {loadError && <div className="error" style={{ margin: 12 }}>{loadError}</div>}
      {error && error !== loadError && <div className="error" style={{ margin: 12 }}>{error}</div>}

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
                <span className="count">{value ? count(value.value.total_cards ?? 0) : '—'}</span>
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
                    <button className="loc-del"
                            onClick={() => setConfirmingDelete(location.id)}
                            disabled={deletingLocation}
                            aria-expanded={confirmingDelete === location.id}
                            aria-label={`Delete ${location.name}`}>×</button>
                  )}
                  {confirmingDelete === location.id && (
                    <LocationDeleteConfirm
                      location={location}
                      locations={locations}
                      onCancel={() => setConfirmingDelete(null)}
                      onBusy={setDeletingLocation}
                      onDeleted={(result) => locationDeleted(location.name, result)}
                    />
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
                  discarding them, and can be undone.
                </p>
              </div>
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
                {loading
                  ? 'Loading…'
                  : loadError
                    ? 'Not loaded'
                    : `${count(totals.distinctCards)} printings · ${count(totals.totalCards)} copies · ${money(totals.totalValue)}`}
              </span>
              <CustomizeView
                page={page}
                density={density}
                onDensity={onDensity}
                densityOverridden={densityOverridden}
                onResetDensity={onResetDensity}
                groupBy={groupBy}
                onGroupBy={setGroupBy}
                groupOptions={COLLECTION_GROUPS}
                sort={sort}
                onSort={setSort}
                sortOptions={COLLECTION_SORTS}
                unavailableNote="Rarity and colour groupings need fields the collection endpoint does not return."
              />
            </div>

            {!loading && cards.length === 0 && !loadError && (
              <p className="empty">
                Nothing here yet. Use <strong>Add by set</strong> to work through a binder,
                or find cards in <strong>Browse</strong> at the top and add them from there.
              </p>
            )}

            {/* The collection browses one capped page (120 rows) with no
                "Load more", so grouping is over what came back — the counts
                say "loaded" whenever that is short of the real total. */}
            {cardGroups.map((group) => (
              <div key={group.key}>
                {group.key !== 'all' && (
                  <h4 className="group-head">
                    {group.label}
                    <span className="count">
                      {cards.length < totals.distinctCards ? `${group.count} loaded` : group.count}
                    </span>
                  </h4>
                )}
                <OwnedGrid
                  cards={group.cards}
                  selected={selected}
                  density={density}
                  onSelect={(card) => setSelected({ oracleId: card.oracleId, printingId: card.printingId, finish: card.finish })}
                />
              </div>
            ))}
            <BackToTop label="Back to the top of the collection" />
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
                <CardLots
                  oracleId={selected.oracleId}
                  cardName={cards.find((c) => c.oracleId === selected.oracleId)?.name ?? 'this card'}
                  locations={locations}
                  onChanged={refreshAll}
                  record={undoStack.record}
                />
              </>
            ) : (
              <p className="empty">Select a card to see where its copies live.</p>
            )}
          </aside>
        </div>
      )}

      {tab === 'add' && (
        <div className="results">
          <AddBySetTab
            sets={sets}
            locations={locations}
            onChanged={refreshAll}
            density={density}
            onDensity={onDensity}
          />
          <BackToTop />
        </div>
      )}

      {tab === 'sets' && (
        <div className="results">
          <h3 className="section-title">Set Completion</h3>
          {setStats.length === 0 && !setStatsFailed && (
            <p className="empty">Add some cards to see set progress.</p>
          )}
          {setStats.map((s) => (
            <div className="setrow" key={s.set_code}>
              <span className="setrow-name">{s.set_name}</span>
              <div className="colorbar-track">
                <div className="colorbar-fill cG" style={{ width: `${s.percent_complete ?? 0}%` }} />
              </div>
              <span className="count">{count(s.owned_printings)} of {count(s.total_cards)} printings · {s.percent_complete ?? 0}%</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'value' && <CollectionValuePanel value={value} />}

      {tab === 'wants' && <WantListsPage {...wantsDensity} />}
      {tab === 'tradelists' && <TradeListsPage />}

      <UndoToast stack={undoStack} />

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
