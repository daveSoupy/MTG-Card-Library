import { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import {
  addCollectionLot, addTradeListItem, deleteLocation, fetchCollection,
  restoreLocation,
  fetchCollectionCard, fetchCollectionValue, fetchLocations, fetchSetCompletion, fetchSets,
  fetchTradeList, fetchTradeLists, removeCollectionLot, removeTradeListItem, updateCollectionLot,
  updateTradeListItem, DECK_STATUS_HINT, type NamedList,
  type CollectionCard, type CollectionCardDetail, type CollectionLot, type CollectionValue,
  type LocationRestore, type SetCompletion, type SetRecord, type StorageLocation,
} from '../api.ts';
import { LocationList } from './LocationList.tsx';
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
import { nameMatches } from '../listSort.ts';

/** "draft_innovation" → "Draft innovation". */
const setTypeLabel = (type: string) => {
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const TAB_LABEL: Record<CollectionTab, string> = {
  browse: 'Cards', add: 'Add by set', sets: 'Set Completion', value: 'Value',
  wants: 'Wants', tradelists: 'For trade',
};


/** Rows fetched per page, and per request when a whole span is re-read. The
 *  route allows up to 300; a page stays small so the first paint is quick. */
export const COLLECTION_PAGE = 120;
const SPAN_CHUNK = 300;

const cardKey = (card: CollectionCard) => `${card.printingId ?? card.oracleId}:${card.finish}`;

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
                  : 'Every copy is claimed by a deck that is building or assembled.'}
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
              {/* A claim and a place are different facts. "×2 · Deck box" read
                  as two copies sitting in the deck box while the only lot said
                  Bulk Box E — so the claim is worded as a claim, and the home
                  as where the deck lives. */}
              <span>
                {!detail.availability?.is_tracked
                  ? 'not tracked'
                  : deck.holds_copies
                    ? `claims ${deck.qty_from_collection}`
                    : 'holds none'}
                {deck.qty_proxied > 0 && ` · ${deck.qty_proxied} proxied`}
                {deck.holds_copies && deck.deck_home_location && ` · deck lives in ${deck.deck_home_location}`}
              </span>
            </div>
          ))}
          {detail.decks.some((deck) => deck.holds_copies) && !detail.copies_move_with_deck && (
            <p className="hint">
              A claim is a count, not a move: claimed copies are still filed where their
              lots below say until you take them out.
            </p>
          )}
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
                {/* Archived ones stay — a lot may be in one — and say so. */}
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}{l.is_archived ? ' (archived)' : ''}</option>
                ))}
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
  const [setStats, setSetStats] = useState<SetCompletion[]>([]);
  // Set Completion's filters, and the set "Add by set" should open on when
  // reached from a row there.
  const [setType, setSetType] = useState<string>('all');
  const [setSearch, setSetSearch] = useState('');
  const [addSet, setAddSet] = useState<string | undefined>();
  const setTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of setStats) counts.set(s.set_type ?? 'other', (counts.get(s.set_type ?? 'other') ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [setStats]);
  const shownSets = useMemo(() => setStats.filter((s) =>
    (setType === 'all' || (s.set_type ?? 'other') === setType)
    && (nameMatches(s.set_name, setSearch) || s.set_code.toLowerCase() === setSearch.trim().toLowerCase())),
  [setStats, setType, setSearch]);

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

  /**
   * The grid is paged: the first 120 rows, then 120 more each time the end
   * comes into view (or "Load more" is pressed). Three kinds of load:
   *
   * - a new filter, search or sort starts again from row 0;
   * - `loadMore` appends the next page at `offset = rows loaded`;
   * - `refreshLoaded`, after an edit, re-reads every row already loaded, so a
   *   lot changed at row 3,000 does not snap the grid back to the first page.
   *
   * `generation` ties each response to the query that asked for it: a page
   * that lands after the filter has changed is dropped, not appended to rows
   * it was never part of.
   */
  const generation = useRef(0);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const [loadingMore, setLoadingMore] = useState(false);
  // The page request in flight, if any. A second call while one is running
  // waits on it rather than returning at once — "Load all" loops on this, and
  // an immediate answer would spin without ever letting the fetch land.
  const inFlight = useRef<Promise<boolean> | null>(null);
  const filterParams = useMemo(
    () => ({ location: locationFilter, q: query || undefined, sort }),
    [locationFilter, query, sort],
  );
  const exhausted = cards.length >= totals.distinctCards;

  const applyTotals = (result: Awaited<ReturnType<typeof fetchCollection>>) => setTotals({
    distinctCards: result.distinctCards,
    totalCards: result.totalCards,
    totalValue: result.totalValue,
  });

  const reloadCards = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    inFlight.current = null;
    setLoadingMore(false);
    fetchCollection({ ...filterParams, limit: COLLECTION_PAGE })
      .then((result) => {
        if (mine !== generation.current) return;
        setCards(result.cards);
        applyTotals(result);
        setLoadError(null);
      })
      .catch((e) => {
        if (mine !== generation.current) return;
        setCards([]); setLoadError(e.message);
      })
      .finally(() => { if (mine === generation.current) setLoading(false); });
  }, [filterParams]);

  /** Appends the next `size` rows. Returns whether more remain. */
  const loadMore = useCallback((size = COLLECTION_PAGE): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const mine = generation.current;
    const offset = cardsRef.current.length;
    setLoadingMore(true);
    const page = async () => {
      try {
        const result = await fetchCollection({ ...filterParams, limit: size, offset });
        if (mine !== generation.current) return false;
        // An edit between pages can shift a row across the boundary; one that
        // is already here is not shown twice.
        const seen = new Set(cardsRef.current.map(cardKey));
        const next = [...cardsRef.current, ...result.cards.filter((card) => !seen.has(cardKey(card)))];
        cardsRef.current = next;
        setCards(next);
        applyTotals(result);
        return result.cards.length > 0 && next.length < result.distinctCards;
      } catch (e) {
        if (mine === generation.current) setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        if (mine === generation.current) setLoadingMore(false);
      }
    };
    const request: Promise<boolean> = page().finally(() => {
      if (inFlight.current === request) inFlight.current = null;
    });
    inFlight.current = request;
    return request;
  }, [filterParams]);

  /** Everything, for grouping over the whole collection rather than a page of it. */
  const [loadingAll, setLoadingAll] = useState(false);
  const loadAll = async () => {
    setLoadingAll(true);
    try { while (await loadMore(SPAN_CHUNK)); } finally { setLoadingAll(false); }
  };

  /** Re-reads the rows already loaded, in route-sized chunks, and swaps them in at once. */
  const refreshLoaded = useCallback(() => {
    const span = Math.max(cardsRef.current.length, COLLECTION_PAGE);
    const mine = ++generation.current;
    inFlight.current = null;
    setLoadingMore(false);
    const offsets = Array.from({ length: Math.ceil(span / SPAN_CHUNK) }, (_, i) => i * SPAN_CHUNK);
    Promise.all(offsets.map((offset) => fetchCollection({
      ...filterParams, offset, limit: Math.min(SPAN_CHUNK, span - offset),
    })))
      .then((pages) => {
        if (mine !== generation.current) return;
        const seen = new Set<string>();
        const next = pages.flatMap((page) => page.cards).filter((card) => {
          const key = cardKey(card);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        cardsRef.current = next;
        setCards(next);
        applyTotals(pages[pages.length - 1]);
        setLoadError(null);
      })
      .catch((e) => { if (mine === generation.current) setLoadError(e.message); });
  }, [filterParams]);

  useEffect(() => {
    if (tab !== 'browse') return;
    const timer = setTimeout(reloadCards, 180);
    return () => clearTimeout(timer);
  }, [tab, reloadCards]);

  // The end of the grid coming into view loads the next page. The button
  // beside it does the same for a keyboard, and where there is no observer.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined' || loading || exhausted) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) loadMore(); },
      { rootMargin: '800px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, loading, exhausted, cards.length]);

  const refreshAll = () => { refreshLoaded(); reloadLocations(); reloadValue(); };

  /**
   * After the confirm's delete: the undo goes on the collection stack with the
   * toast. Undo recreates the location from the record the delete returned —
   * its lots, name, kind and deck homes — and redo deletes it again, taking a
   * fresh record, since the location may have come back under a new id.
   */
  const locationDeleted = (name: string, result: { locations: StorageLocation[]; restore: LocationRestore }) => {
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
            <LocationList
              locations={locations}
              selected={locationFilter}
              onSelect={setLocationFilter}
              everywhereCount={value ? value.value.total_cards ?? 0 : null}
              onLocations={setLocations}
              onDeleted={locationDeleted}
              record={undoStack.record}
              onError={setError}
            />
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
                    : `${exhausted ? '' : `Showing ${count(cards.length)} of `}${count(totals.distinctCards)} printings · ${count(totals.totalCards)} copies · ${money(totals.totalValue)}`}
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

            {/* Grouping is over the rows loaded so far. While that is short of
                the whole, it says so, the counts say "loaded", and one press
                loads the rest so the groups are the collection's own. */}
            {groupBy !== 'none' && !exhausted && !loading && (
              <p className="note group-partial">
                Grouped over the {count(cards.length)} loaded of {count(totals.distinctCards)} printings,
                so the groups grow as you scroll.{' '}
                <button className="linkish" onClick={loadAll} disabled={loadingAll}>
                  {loadingAll ? 'Loading…' : `Load all ${count(totals.distinctCards)} to group everything`}
                </button>
              </p>
            )}
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
            {!loading && !loadError && !exhausted && (
              <div className="load-more" ref={sentinel}>
                <button className="btn secondary" onClick={() => loadMore()} disabled={loadingMore}>
                  {loadingMore
                    ? 'Loading…'
                    : `Load ${count(Math.min(COLLECTION_PAGE, totals.distinctCards - cards.length))} more`}
                </button>
                <span className="count">
                  {count(cards.length)} of {count(totals.distinctCards)} shown
                </span>
              </div>
            )}
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
            initialSet={addSet}
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
          {setStats.length > 0 && (
            <div className="list-tools">
              <input
                type="search"
                value={setSearch}
                onChange={(e) => setSetSearch(e.target.value)}
                placeholder="Find a set by name or code"
                aria-label="Find a set"
              />
              <label className="list-sort">
                <span>Type</span>
                <select value={setType} onChange={(e) => setSetType(e.target.value)} aria-label="Set type">
                  <option value="all">All types ({count(setStats.length)})</option>
                  {setTypes.map(([type, n]) => (
                    <option key={type} value={type}>{setTypeLabel(type)} ({count(n)})</option>
                  ))}
                </select>
              </label>
              <span className="count list-totals">
                {shownSets.length === setStats.length
                  ? `${count(setStats.length)} sets`
                  : `${count(shownSets.length)} of ${count(setStats.length)} sets`}
              </span>
            </div>
          )}
          {/* One grid of fixed columns, so every bar starts at the same x
              whatever the length of the set's name or its count. */}
          <div className="setgrid">
            {shownSets.map((s) => (
              <div className="setrow" key={s.set_code}>
                <span className="setrow-code" title={s.set_type ? setTypeLabel(s.set_type) : undefined}>
                  {s.set_code.toUpperCase()}
                </span>
                <span className="setrow-name" title={`${s.set_name}${s.released_at ? ` · ${s.released_at.slice(0, 4)}` : ''}`}>
                  {s.set_name}
                </span>
                <div className="colorbar-track">
                  <div className="colorbar-fill cG" style={{ width: `${s.percent_complete ?? 0}%` }} />
                </div>
                <span className="setrow-pct">{s.percent_complete ?? 0}%</span>
                <span className="count setrow-of">{count(s.owned_printings)} of {count(s.total_cards)}</span>
                <button
                  className="linkish"
                  onClick={() => { setAddSet(s.set_code); onTabChange('add'); }}
                  title={`Open ${s.set_name} in Add by set`}
                >
                  Add by set
                </button>
              </div>
            ))}
          </div>
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
