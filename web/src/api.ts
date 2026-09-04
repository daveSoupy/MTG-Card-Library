/**
 * Thin client over the server API.
 *
 * Deliberately thin: all the rules — search syntax, legality, allocation — live
 * on the server, so this only shapes requests and hands back JSON. That is what
 * keeps a future native client from having to reimplement any of it.
 */

export interface CardSummary {
  oracleId: string;
  name: string;
  manaCost: string | null;
  cmc: number;
  typeLine: string;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  colors: string;
  colorIdentity: string;
  rarity: string | null;
  setCode: string | null;
  setName: string | null;
  collectorNumber: string | null;
  imageSmall: string | null;
  imageNormal: string | null;
  priceUsd: number | null;
  priceUsdFoil: number | null;
  printingId: string | null;
  ownedQuantity: number;
  /** Total quantity on any active want list; 0 when not wanted. */
  wantedQuantity?: number;
  printingCount: number;
}

export interface CardFace {
  index: number;
  name: string;
  manaCost: string | null;
  typeLine: string | null;
  oracleText: string | null;
  powerToughness: string | null;
  imageNormal: string | null;
}

export interface CardPrinting {
  id: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  rarity: string | null;
  releasedAt: string | null;
  priceUsd: number | null;
  priceUsdFoil: number | null;
  imageNormal: string | null;
  scryfallUri: string | null;
  tcgplayerId: number | null;
  isDigital: boolean;
  ownedQuantity: number;
}

export interface CardLegality {
  format: string;
  displayName: string;
  status: string;
  playable: boolean;
}

export interface CardDetail extends CardSummary {
  layout: string;
  oracleText: string | null;
  flavorText: string | null;
  artist: string | null;
  keywords: string[];
  isReserved: boolean;
  canBeCommander: boolean;
  /** True when the art was chosen by hand rather than picked by the sync. */
  artIsPinned?: boolean;
  edhrecRank: number | null;
  frontImage: string | null;
  backImage: string | null;
  faces: CardFace[];
  printings: CardPrinting[];
  legalities: CardLegality[];
}

export interface SearchResponse {
  cards: CardSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface LibraryStatus {
  hasCardData: boolean;
  oracleCards: number;
  printings: number;
  sets: number;
  lastSyncedAt: string | null;
  loadedBulkType: string | null;
  loadedBulkUpdatedAt: string | null;
}

export interface SyncProgress {
  phase: string;
  message: string;
  fraction: number | null;
  cardsImported?: number;
  setsImported?: number;
  error?: string;
}

export interface SyncState {
  running: boolean;
  progress: SyncProgress | null;
  lastError: string | null;
}

export interface StatusResponse {
  library: LibraryStatus;
  sync: SyncState;
  bulkTypes: Record<string, { label: string; detail: string }>;
}

export interface SetRecord {
  code: string;
  name: string;
  released_at: string | null;
  card_count: number;
}

export interface FormatRecord {
  code: string;
  display_name: string;
  /** 1 when the format has a command zone. Drives the deck builder's slot. */
  requiresCommander?: number;
}

export interface SearchParams {
  q?: string;
  ownedOnly?: boolean;
  colors?: string[];
  colorsExact?: boolean;
  gold?: boolean;
  hybrid?: boolean;
  rarities?: string[];
  set?: string;
  format?: string;
  minCmc?: number;
  maxCmc?: number;
  includeDigital?: boolean;
  includeExtras?: boolean;
  includeUnplayable?: boolean;
  excludeUniversesBeyond?: boolean;
  /** Restrict to cards that could lead a deck in this format. */
  commanderFor?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  /** Sent when paging so the server reuses the first page's count. */
  knownTotal?: number;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    let detail = `Request failed with status ${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) detail = body.detail ? `${body.error} ${body.detail}` : body.error;
    } catch {
      // Non-JSON error body; the status line is all we have.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export function searchCards(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.ownedOnly) query.set('ownedOnly', 'true');
  if (params.colors?.length) query.set('colors', params.colors.join(','));
  if (params.colorsExact) query.set('colorsExact', 'true');
  if (params.gold) query.set('gold', 'true');
  if (params.hybrid) query.set('hybrid', 'true');
  if (params.rarities?.length) query.set('rarities', params.rarities.join(','));
  if (params.set) query.set('set', params.set);
  if (params.format) query.set('format', params.format);
  if (params.minCmc !== undefined) query.set('minCmc', String(params.minCmc));
  if (params.maxCmc !== undefined) query.set('maxCmc', String(params.maxCmc));
  if (params.includeDigital) query.set('includeDigital', 'true');
  if (params.includeExtras) query.set('includeExtras', 'true');
  if (params.includeUnplayable) query.set('includeUnplayable', 'true');
  if (params.excludeUniversesBeyond) query.set('excludeUniversesBeyond', 'true');
  if (params.commanderFor) query.set('commanderFor', params.commanderFor);
  if (params.sort) query.set('sort', params.sort);
  query.set('limit', String(params.limit ?? 60));
  if (params.offset) query.set('offset', String(params.offset));
  if (params.offset && params.knownTotal !== undefined) {
    query.set('knownTotal', String(params.knownTotal));
  }
  return getJson<SearchResponse>(`/api/v1/cards?${query}`, signal);
}

export const fetchCard = (oracleId: string, signal?: AbortSignal) =>
  getJson<CardDetail>(`/api/v1/cards/${encodeURIComponent(oracleId)}`, signal);

export const fetchStatus = (signal?: AbortSignal) =>
  getJson<StatusResponse>('/api/v1/status', signal);

export const fetchSets = (signal?: AbortSignal) =>
  getJson<{ sets: SetRecord[] }>('/api/v1/sets', signal).then((r) => r.sets);

export const fetchFormats = (signal?: AbortSignal) =>
  getJson<{ formats: FormatRecord[] }>('/api/v1/formats', signal).then((r) => r.formats);

export async function startSync(bulkType?: string, force = false): Promise<void> {
  const response = await fetch('/api/v1/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bulkType, force }),
  });
  if (!response.ok && response.status !== 409) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error ?? `Could not start the sync (HTTP ${response.status}).`);
  }
}

/** Card art proxied through the server, which caches it to disk. */
export function imageUrl(
  printingId: string,
  size: 'small' | 'normal' | 'large' | 'art_crop' | 'png',
  face = 0,
): string {
  return `/api/v1/images/${printingId}/${size}${face ? `?face=${face}` : ''}`;
}

/**
 * Subscribes to sync progress. Returns an unsubscribe function.
 * EventSource reconnects on its own if the server restarts mid-sync.
 */
export function subscribeToSync(
  onProgress: (progress: SyncProgress) => void,
  onFinished: () => void,
): () => void {
  const source = new EventSource('/api/v1/sync/events');
  const progressHandler = (event: MessageEvent) => onProgress(JSON.parse(event.data));
  const stateHandler = (event: MessageEvent) => {
    const state: SyncState = JSON.parse(event.data);
    if (state.progress) onProgress(state.progress);
  };
  source.addEventListener('progress', progressHandler as EventListener);
  source.addEventListener('state', stateHandler as EventListener);
  source.addEventListener('finished', onFinished as EventListener);
  return () => source.close();
}

// ---------------------------------------------------------------- decks

export type Board = 'main' | 'side' | 'command' | 'maybe';

export interface DeckCard {
  id: number;
  oracleId: string;
  name: string;
  board: Board;
  quantity: number;
  quantityFromCollection: number;
  commanderRole: string | null;
  cmc: number;
  typeLine: string;
  manaCost: string | null;
  colorIdentity: string;
  isBasicLand: boolean;
  canBeCommander: boolean;
  category: string | null;
  producedMana: string[];
  partnerKind: string | null;
  legality: string | null;
  ownedQuantity: number;
  availableQuantity: number;
  printingId: string | null;
  setCode: string | null;
  rarity: string | null;
  imageSmall: string | null;
  priceUsd: number | null;
}

export interface DeckIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  oracleId?: string;
  cardName?: string;
}

export interface ColorRequirement {
  color: string;
  colorName: string;
  pips: number;
  pipShare: number;
  sources: number;
  sourceShare: number;
  isShort: boolean;
}

export interface ManaBase {
  requirements: ColorRequirement[];
  totalPips: number;
  totalSources: number;
  landCount: number;
  nonLandSources: number;
  colorlessSources: number;
}

export interface DeckValidation {
  formatCode: string | null;
  formatName: string | null;
  commanderIdentity: string | null;
  countedTotal: number;
  mainCount: number;
  sideboardCount: number;
  commandCount: number;
  maybeCount: number;
  requiredExactSize: number | null;
  requiredMinSize: number | null;
  sideboardLimit: number | null;
  issues: DeckIssue[];
  isLegal: boolean;
}

export interface DeckStats {
  totalCards: number;
  mainCount: number;
  sideboardCount: number;
  commandCount: number;
  uniqueCards: number;
  averageManaValue: number | null;
  manaCurve: Array<{ cmc: number; label: string; count: number }>;
  colorDistribution: Array<{ color: string; count: number }>;
  colorIdentity: string;
  typeDistribution: Array<{ type: string; count: number }>;
  estimatedValueUsd: number | null;
  ownedCount: number;
  needToBuyCount: number;
}

export interface Deck {
  id: number;
  name: string;
  formatCode: string | null;
  description: string | null;
  notes: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  cards: DeckCard[];
  validation: DeckValidation;
  stats: DeckStats;
  manaBase: ManaBase;
}

export interface DeckSummary {
  id: number;
  name: string;
  formatCode: string | null;
  formatName: string | null;
  cardCount: number;
  uniqueCards: number;
  colorIdentity: string;
  commanderNames: string[];
  isArchived: boolean;
  updatedAt: string;
  tags: string[];
  /** Chosen if you picked one, otherwise worked out from the deck's contents. */
  coverPrintingId: string | null;
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail?.error ?? `Request failed with status ${response.status}`);
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

export const fetchDecks = (signal?: AbortSignal) =>
  getJson<{ decks: DeckSummary[] }>('/api/v1/decks', signal).then((r) => r.decks);

export const fetchDeck = (id: number, signal?: AbortSignal) =>
  getJson<{ deck: Deck }>(`/api/v1/decks/${id}`, signal).then((r) => r.deck);

export const createDeck = (name: string, formatCode: string | null) =>
  send<{ deck: Deck }>('/api/v1/decks', 'POST', { name, formatCode }).then((r) => r.deck);

export const updateDeck = (id: number, changes: Partial<Pick<Deck, 'name' | 'formatCode' | 'description' | 'notes' | 'isArchived'>>) =>
  send<{ deck: Deck }>(`/api/v1/decks/${id}`, 'PATCH', changes).then((r) => r.deck);

export const duplicateDeck = (id: number) =>
  send<{ deck: Deck }>(`/api/v1/decks/${id}/duplicate`, 'POST', {}).then((r) => r.deck);

export const deleteDeck = (id: number) => send<void>(`/api/v1/decks/${id}`, 'DELETE');

export const addDeckCard = (
  deckId: number,
  oracleId: string,
  options: { board?: Board; quantity?: number } = {},
) => send<{ deck: Deck }>(`/api/v1/decks/${deckId}/cards`, 'POST', { oracleId, ...options }).then((r) => r.deck);

export const updateDeckCard = (
  deckId: number,
  cardId: number,
  changes: {
    quantity?: number; fromCollection?: number; board?: Board;
    commanderRole?: string | null;
    category?: string | null; preferredPrintingId?: string | null;
  },
) => send<{ deck: Deck }>(`/api/v1/decks/${deckId}/cards/${cardId}`, 'PATCH', changes).then((r) => r.deck);

export const addRecommendedLands = (deckId: number) =>
  send<{ deck: Deck }>(`/api/v1/decks/${deckId}/recommended-lands`, 'POST', {}).then((r) => r.deck);

export const fetchDeckCategories = (deckId: number, signal?: AbortSignal) =>
  getJson<{ categories: string[] }>(`/api/v1/decks/${deckId}/categories`, signal)
    .then((r) => r.categories);

export type CostMethod = 'unknown' | 'free' | 'market' | 'fixed' | 'box';

export interface AppSettings {
  autoMaintainLands: boolean;
  /** Cost basis assumed when adding cards without a typed-in price. */
  defaultCostMethod: Exclude<CostMethod, 'box'>;
  defaultCostFixedUsd: number;
  /** Price of one booster pack; the Draft cost defaults to 3× this. */
  draftBoosterPriceUsd: number;
}

export const fetchSettings = (signal?: AbortSignal) =>
  getJson<{ settings: AppSettings }>('/api/v1/settings', signal).then((r) => r.settings);

export const updateSettings = (changes: Partial<AppSettings>) =>
  send<{ settings: AppSettings }>('/api/v1/settings', 'PUT', changes).then((r) => r.settings);

export interface StorageInfo {
  database: { bytes: number };
  imageCache: { bytes: number; count: number; limitBytes: number };
  cards: { oracleCards: number; printings: number; sets: number };
  coverage: { referenced: number; cached: number };
  fullEstimateBytes: number;
}

export type ImageDownloadScope = 'referenced' | 'all';

export interface ImageDownloadStatus {
  running: boolean;
  scope: ImageDownloadScope | null;
  total: number;
  processed: number;
  downloaded: number;
  skipped: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  canceled: boolean;
}

export const fetchStorage = (signal?: AbortSignal) =>
  getJson<StorageInfo>('/api/v1/storage', signal);

export const setCacheLimit = (bytes: number) =>
  send<{ limitBytes: number }>('/api/v1/storage/cache-limit', 'PUT', { bytes });

/** Raised when a full download would exceed the cache cap; carries the numbers. */
export class CacheTooSmallError extends Error {
  estimateBytes: number;
  limitBytes: number;
  constructor(message: string, estimateBytes: number, limitBytes: number) {
    super(message);
    this.name = 'CacheTooSmallError';
    this.estimateBytes = estimateBytes;
    this.limitBytes = limitBytes;
  }
}

/** Starts a download; throws CacheTooSmallError (with the numbers) on a 413. */
export async function startImageDownload(scope: ImageDownloadScope): Promise<ImageDownloadStatus> {
  const response = await fetch('/api/v1/images/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 413) {
    throw new CacheTooSmallError(body.error ?? 'Cache too small.', body.estimateBytes, body.limitBytes);
  }
  if (!response.ok) throw new Error(body?.error ?? `Request failed with status ${response.status}`);
  return body.status as ImageDownloadStatus;
}

export const fetchImageDownloadStatus = (signal?: AbortSignal) =>
  getJson<{ status: ImageDownloadStatus }>('/api/v1/images/download/status', signal)
    .then((r) => r.status);

export const cancelImageDownload = () =>
  send<{ status: ImageDownloadStatus }>('/api/v1/images/download/cancel', 'POST', {})
    .then((r) => r.status);

export const removeDeckCard = (deckId: number, cardId: number) =>
  send<{ deck: Deck }>(`/api/v1/decks/${deckId}/cards/${cardId}`, 'DELETE').then((r) => r.deck);

// ------------------------------------------------------- filter presets

export interface FilterPreset {
  id: number;
  name: string;
  filters: Record<string, unknown>;
  queryText: string | null;
  sortOrder: number;
  updatedAt: string;
}

export const fetchPresets = (signal?: AbortSignal) =>
  getJson<{ presets: FilterPreset[] }>('/api/v1/filter-presets', signal).then((r) => r.presets);

/** Saving over an existing name updates that preset rather than duplicating it. */
export const savePreset = (name: string, filters: unknown, queryText: string | null) =>
  send<{ presets: FilterPreset[] }>('/api/v1/filter-presets', 'POST', { name, filters, queryText })
    .then((r) => r.presets);

export const deletePreset = (id: number) =>
  send<{ presets: FilterPreset[] }>(`/api/v1/filter-presets/${id}`, 'DELETE').then((r) => r.presets);

// ------------------------------------------------------------ collection

export interface StorageLocation {
  id: number;
  name: string;
  kind: string;
  notes: string | null;
  is_default: number;
  is_archived: number;
  card_count: number;
  distinct_printings: number;
  value_usd: number;
}

export interface CollectionCard {
  oracleId: string;
  name: string;
  manaCost: string | null;
  cmc: number;
  typeLine: string;
  colorIdentity: string;
  ownedQuantity: number;
  allocatedQuantity: number;
  availableQuantity: number;
  valueUsd: number;
  costUsd: number | null;
  gainUsd: number | null;
  printingCount: number;
  locationCount: number;
  lotCount: number;
  printingId: string | null;
  finish: string;
  setCode: string | null;
  setName: string | null;
  collectorNumber: string | null;
  imageSmall: string | null;
}

export interface CollectionLot {
  id: number;
  printing_id: string;
  quantity: number;
  finish: string;
  condition: string;
  language: string;
  unit_value_usd: number | null;
  line_value_usd: number | null;
  is_overridden: number;
  price_override: number | null;
  acquired_unit_cost: number | null;
  acquired_at: string | null;
  acquisition_kind: string;
  acquired_from: string | null;
  notes: string | null;
  unrealized_gain_usd: number | null;
  location_id: number;
  location_name: string;
  set_code: string;
  set_name: string | null;
  collector_number: string;
}

export interface CollectionCardDetail {
  printings: Array<{
    printing_id: string; finish: string; set_code: string; set_name: string | null;
    collector_number: string; rarity: string | null; price_usd: number | null;
    price_usd_foil: number | null; image_small: string | null;
    owned_qty: number; value_usd: number | null; cost_usd: number | null;
  }>;
  lots: CollectionLot[];
  decks: Array<{
    deck_id: number; deck_name: string; board: string;
    qty_from_collection: number; deck_home_location: string | null;
  }>;
  availability: { owned_qty: number; allocated_qty: number; available_qty: number } | null;
}

export interface CollectionValue {
  value: Record<string, number | null>;
  history: Array<{
    captured_on: string; total_value_usd: number; total_cost_basis_usd: number | null;
    realized_gain_to_date_usd: number | null; total_cards: number; distinct_cards: number;
  }>;
}

export interface ShoppingListEntry {
  oracleId: string; name: string; needed: number;
  unitPriceUsd: number | null; estimatedUsd: number | null;
  printingId: string | null; imageSmall: string | null; setCode: string | null;
  availableElsewhere: number;
}

export interface ShoppingList {
  deckId: number; deckName: string; entries: ShoppingListEntry[];
  totalCards: number; totalUsd: number; unpricedCards: number;
}

export interface WantListItem {
  id: number; oracleId: string; name: string; manaCost: string | null;
  colorIdentity: string; quantity: number; targetPriceUsd: number | null;
  priority: number; status: string; notes: string | null; priceUsd: number;
  printingId: string | null; imageSmall: string | null; ownedQuantity: number;
  neededFor: Array<{ deckId: number; deckName: string; quantity: number }>;
}

export interface AddLotInput {
  printingId: string;
  locationId: number;
  quantity: number;
  finish?: string;
  condition?: string;
  priceOverride?: number | null;
  acquiredAt?: string | null;
  acquiredUnitCost?: number | null;
  acquisitionKind?: string;
  acquiredFrom?: string | null;
  notes?: string | null;
  /** Assume the cost basis from a method when no explicit cost is given. */
  costMethod?: CostMethod;
  /** Amount for the 'fixed' method. */
  fixedAmount?: number | null;
  /** Cost pool (from openCostPool) to attach the lot to, for the 'box' method. */
  batchId?: number;
}

/** A box/draft cost pool that spreads one lump sum evenly across its cards. */
export interface CostPool {
  id: number;
  label: string;
  totalCostUsd: number;
  cardCount: number;
  perCopy: number;
}

/** Opens a cost pool and marks it the open one; returns its summary. */
export const openCostPool = (totalCostUsd: number, label?: string) =>
  send<{ batchId: number; pool: CostPool }>('/api/v1/collection/cost-pools', 'POST', { totalCostUsd, label })
    .then((r) => r.pool);

/** The pool currently accepting cards, or null. */
export const fetchOpenCostPool = (signal?: AbortSignal) =>
  getJson<{ pool: CostPool | null }>('/api/v1/collection/cost-pools/open', signal).then((r) => r.pool);

/** Changes an open pool's lump sum, re-dividing it across its cards. */
export const updateCostPoolTotal = (id: number, totalCostUsd: number) =>
  send<{ pool: CostPool | null }>(`/api/v1/collection/cost-pools/${id}`, 'PATCH', { totalCostUsd })
    .then((r) => r.pool);

/** Finishes the open pool (its cards keep their cost). */
export const closeCostPool = () =>
  send<{ pool: null }>('/api/v1/collection/cost-pools/close', 'POST', {}).then((r) => r.pool);

export const fetchLocations = (signal?: AbortSignal) =>
  getJson<{ locations: StorageLocation[] }>('/api/v1/locations', signal).then((r) => r.locations);

export const createLocation = (name: string, kind: string) =>
  send<{ locations: StorageLocation[] }>('/api/v1/locations', 'POST', { name, kind })
    .then((r) => r.locations);

export const updateLocation = (id: number, changes: { name?: string; kind?: string }) =>
  send<{ locations: StorageLocation[] }>(`/api/v1/locations/${id}`, 'PATCH', changes)
    .then((r) => r.locations);

/** `moveTo` relocates the contents first; without it a non-empty location 409s. */
export const deleteLocation = (id: number, moveTo?: number) =>
  send<{ locations: StorageLocation[] }>(
    `/api/v1/locations/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`, 'DELETE',
  ).then((r) => r.locations);

export interface CollectionQuery {
  location?: number; set?: string; q?: string;
  unallocatedOnly?: boolean; sort?: string; limit?: number; offset?: number;
}

export function fetchCollection(params: CollectionQuery = {}, signal?: AbortSignal) {
  const query = new URLSearchParams();
  if (params.location !== undefined) query.set('location', String(params.location));
  if (params.set) query.set('set', params.set);
  if (params.q) query.set('q', params.q);
  if (params.unallocatedOnly) query.set('unallocatedOnly', 'true');
  if (params.sort) query.set('sort', params.sort);
  query.set('limit', String(params.limit ?? 100));
  if (params.offset) query.set('offset', String(params.offset));
  return getJson<{
    cards: CollectionCard[]; distinctCards: number; totalCards: number;
    totalValue: number; limit: number; offset: number;
  }>(`/api/v1/collection?${query}`, signal);
}

export const fetchCollectionCard = (oracleId: string, signal?: AbortSignal) =>
  getJson<CollectionCardDetail>(`/api/v1/collection/cards/${encodeURIComponent(oracleId)}`, signal);

export const addCollectionLot = (input: AddLotInput) =>
  send<{ id: number }>('/api/v1/collection/items', 'POST', input);

export const updateCollectionLot = (id: number, changes: Record<string, unknown>) =>
  send<{ ok: true }>(`/api/v1/collection/items/${id}`, 'PATCH', changes);

export const removeCollectionLot = (id: number) =>
  send<void>(`/api/v1/collection/items/${id}`, 'DELETE');

/** Undo a tap-to-add: remove one plainly-added copy of a card. */
export const decrementCollectionCopy = (input: {
  printingId: string; locationId: number; finish?: string; condition?: string;
}) => send<{ removed: boolean; owned: number | null }>('/api/v1/collection/items/decrement', 'POST', input);

export const fetchCollectionValue = (signal?: AbortSignal) =>
  getJson<CollectionValue>('/api/v1/collection/value', signal);

export const fetchSetCompletion = (signal?: AbortSignal) =>
  getJson<{ sets: Array<{ set_code: string; set_name: string; total_cards: number; owned_printings: number; percent_complete: number | null }> }>(
    '/api/v1/collection/sets', signal).then((r) => r.sets);

export const fetchSetChecklist = (setCode: string, signal?: AbortSignal) =>
  getJson<{ cards: Array<{
    printing_id: string; collector_number: string; rarity: string | null;
    price_usd: number | null; image_small: string | null; oracle_id: string;
    name: string; mana_cost: string | null; owned_qty: number;
  }> }>(`/api/v1/collection/sets/${encodeURIComponent(setCode)}`, signal).then((r) => r.cards);

export const fetchShoppingList = (deckId: number, signal?: AbortSignal) =>
  getJson<ShoppingList>(`/api/v1/decks/${deckId}/shopping-list`, signal);

export const pushToWantList = (deckId: number, oracleIds?: string[]) =>
  send<{ added: number; updated: number; listName: string }>(
    `/api/v1/decks/${deckId}/shopping-list/want`, 'POST', { oracleIds });

export const fetchWantList = (id: number, signal?: AbortSignal) =>
  getJson<{ id: number; name: string; items: WantListItem[] }>(`/api/v1/want-lists/${id}`, signal);

// -- Phase 5: import, export and backup ---------------------------------------

export type ExportFormat = 'simple' | 'withSet' | 'arena' | 'mtgo';
export type ImportBoard = 'main' | 'side' | 'command' | 'maybe';

export interface ResolvedCard {
  oracleId: string;
  name: string;
  via: 'exact' | 'face' | 'fuzzy';
  confidence: number;
}

export interface DeckExport {
  format: ExportFormat;
  text: string;
  tcgplayerUrl: string | null;
  tcgplayerTooLong: boolean;
  cardKingdomUrl: string;
}

export interface PreviewLine {
  lineNumber: number;
  raw: string;
  quantity: number;
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  board: ImportBoard;
  match: ResolvedCard | null;
  candidates: ResolvedCard[];
}

export interface ImportCounts {
  total: number; resolved: number; uncertain: number; unresolved: number;
}

export interface DecklistPreview {
  lines: PreviewLine[];
  unparsed: Array<{ lineNumber: number; raw: string }>;
  counts: ImportCounts;
}

export type ColumnRole =
  | 'name' | 'setCode' | 'setName' | 'collectorNumber' | 'quantity'
  | 'finish' | 'condition' | 'language' | 'price' | 'ignore';

export interface CsvPreviewRow {
  lineNumber: number;
  name: string;
  quantity: number;
  setCode: string | null;
  collectorNumber: string | null;
  finish: 'nonfoil' | 'foil' | 'etched';
  condition: string;
  language: string;
  price: number | null;
  match: ResolvedCard | null;
  candidates: ResolvedCard[];
  printingId: string | null;
  printingExact: boolean;
}

export interface CsvPreview {
  headers: string[];
  mapping: ColumnRole[];
  rows: CsvPreviewRow[];
  skipped: Array<{ lineNumber: number; reason: string }>;
  counts: ImportCounts & { cards: number };
}

export interface ImportBatch {
  id: number;
  source: string;
  fileName: string | null;
  importedAt: string;
  rowsTotal: number | null;
  rowsImported: number | null;
  rowsUnmatched: number | null;
  totalCostUsd: number | null;
  cardsRemaining: number;
}

export interface RestoreReport {
  restored: Array<{ table: string; rows: number }>;
  skipped: Array<{ table: string; reason: string }>;
  totalRows: number;
  pendingCardReferences: number;
}

export interface ScheduledBackup { name: string; bytes: number; takenAt: string }

export const fetchDeckExport = (id: number, format: ExportFormat, signal?: AbortSignal) =>
  getJson<DeckExport>(`/api/v1/decks/${id}/export?format=${format}`, signal);

export const deckExportFileUrl = (id: number, format: ExportFormat) =>
  `/api/v1/decks/${id}/export.txt?format=${format}`;

export const previewDecklist = (text: string) =>
  send<DecklistPreview>('/api/v1/decks/import/preview', 'POST', { text });

export const importIntoDeck = (
  id: number,
  entries: Array<{ oracleId: string; quantity: number; board: ImportBoard }>,
) => send<{ added: number; cards: number; deck: Deck }>(`/api/v1/decks/${id}/import`, 'POST', { entries });

export const importAsNewDeck = (
  name: string,
  formatCode: string | null,
  entries: Array<{ oracleId: string; quantity: number; board: ImportBoard }>,
) => send<{ deck: Deck }>('/api/v1/decks/import', 'POST', { name, formatCode, entries });

export const previewCollectionCsv = (text: string, mapping?: ColumnRole[]) =>
  send<CsvPreview>('/api/v1/collection/import/preview', 'POST', { text, mapping });

export const importCollectionCsv = (input: {
  locationId: number;
  rows: Array<{
    printingId: string; quantity: number; finish: string;
    condition: string; language: string; acquiredUnitCost: number | null;
  }>;
  fileName: string | null;
  unmatched: number;
}) => send<{ batchId: number; lots: number; cards: number; value: CollectionValue }>(
  '/api/v1/collection/import', 'POST', input);

export const collectionCsvUrl = '/api/v1/collection/export.csv';

export const fetchImportBatches = (signal?: AbortSignal) =>
  getJson<{ batches: ImportBatch[] }>('/api/v1/imports', signal).then((r) => r.batches);

export const undoImportBatch = (id: number) =>
  send<{ removed: number; batches: ImportBatch[] }>(`/api/v1/imports/${id}/undo`, 'POST');

export const backupDownloadUrl = '/api/v1/backup';

export const fetchScheduledBackups = (signal?: AbortSignal) =>
  getJson<{ directory: string | null; backups: ScheduledBackup[] }>('/api/v1/backup/scheduled', signal);

export const takeScheduledBackup = () =>
  send<{ backups: ScheduledBackup[] }>('/api/v1/backup/scheduled', 'POST');

/** Uploads the file as a raw body; the server writes it to a temp file. */
export async function restoreBackup(file: File): Promise<RestoreReport> {
  const response = await fetch('/api/v1/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail?.error ?? `Restore failed with status ${response.status}`);
  }
  return response.json() as Promise<RestoreReport>;
}

/** Pins which printing's art a card shows, or clears the pin with null. */
export const setCardArt = (oracleId: string, printingId: string | null) =>
  send<CardDetail>(`/api/v1/cards/${encodeURIComponent(oracleId)}/art`, 'PUT', { printingId });

/** A random card matching the current filters. */
export function fetchRandomCard(params: SearchParams = {}, signal?: AbortSignal): Promise<CardDetail> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.colors?.length) query.set('colors', params.colors.join(','));
  if (params.colorsExact) query.set('colorsExact', 'true');
  if (params.gold) query.set('gold', 'true');
  if (params.hybrid) query.set('hybrid', 'true');
  if (params.rarities?.length) query.set('rarities', params.rarities.join(','));
  if (params.set) query.set('set', params.set);
  if (params.format) query.set('format', params.format);
  if (params.ownedOnly) query.set('ownedOnly', 'true');
  if (params.includeDigital) query.set('includeDigital', 'true');
  if (params.includeExtras) query.set('includeExtras', 'true');
  if (params.includeUnplayable) query.set('includeUnplayable', 'true');
  if (params.excludeUniversesBeyond) query.set('excludeUniversesBeyond', 'true');
  if (params.commanderFor) query.set('commanderFor', params.commanderFor);
  return getJson<CardDetail>(`/api/v1/cards/random?${query}`, signal);
}

// -- deck covers, tags and history --------------------------------------------

export interface DeckTag { tag: string; deckCount: number }

export interface DeckSnapshot {
  id: number; deckId: number; name: string; note: string | null;
  createdAt: string; cardCount: number; uniqueCards: number;
}

export interface DeckDiffEntry {
  oracleId: string; name: string; board: string; from: number; to: number;
}

export interface DeckDiff {
  added: DeckDiffEntry[]; removed: DeckDiffEntry[];
  changed: DeckDiffEntry[]; unchanged: number;
}

export const setDeckCover = (deckId: number, printingId: string | null) =>
  send<{ decks: DeckSummary[] }>(`/api/v1/decks/${deckId}/cover`, 'PUT', { printingId });

export const fetchDeckTags = (signal?: AbortSignal) =>
  getJson<{ tags: DeckTag[] }>('/api/v1/deck-tags', signal).then((r) => r.tags);

export const addDeckTag = (deckId: number, tag: string) =>
  send<{ tags: string[]; allTags: DeckTag[] }>(`/api/v1/decks/${deckId}/tags`, 'POST', { tag });

export const removeDeckTag = (deckId: number, tag: string) =>
  send<{ tags: string[]; allTags: DeckTag[] }>(
    `/api/v1/decks/${deckId}/tags/${encodeURIComponent(tag)}`, 'DELETE');

export const fetchSnapshots = (deckId: number, signal?: AbortSignal) =>
  getJson<{ snapshots: DeckSnapshot[] }>(`/api/v1/decks/${deckId}/snapshots`, signal)
    .then((r) => r.snapshots);

export const createSnapshot = (deckId: number, name?: string, note?: string) =>
  send<{ snapshots: DeckSnapshot[] }>(`/api/v1/decks/${deckId}/snapshots`, 'POST', { name, note });

export const fetchSnapshotDiff = (snapshotId: number, signal?: AbortSignal) =>
  getJson<DeckDiff>(`/api/v1/snapshots/${snapshotId}/diff`, signal);

export const restoreSnapshot = (snapshotId: number) =>
  send<{ deck: Deck; snapshots: DeckSnapshot[] }>(`/api/v1/snapshots/${snapshotId}/restore`, 'POST');

export const deleteSnapshot = (snapshotId: number) =>
  send<void>(`/api/v1/snapshots/${snapshotId}`, 'DELETE');

// ---------------------------------------------------------------------------
// Phase 6 — trades, want lists, trade lists, alerts
// ---------------------------------------------------------------------------

export type TradeStatus = 'draft' | 'completed' | 'cancelled';

export interface TradeItem {
  id: number; direction: 'out' | 'in'; printingId: string; oracleId: string;
  name: string; setCode: string | null; collectorNumber: string | null; manaCost: string | null;
  quantity: number; ownedQuantity: number; finish: string; condition: string; language: string;
  sourceCollectionItemId: number | null; destinationLocationId: number | null;
  unitValueUsd: number | null; marketUsd: number | null; imageSmall: string | null; notes: string | null;
}

export interface TradeSummary {
  id: number; counterpartyName: string; counterpartyContact: string | null; status: TradeStatus;
  tradeDate: string | null; completedAt: string | null; locationNote: string | null; notes: string | null;
  valueOutUsd: number | null; valueInUsd: number | null; createdAt: string; updatedAt: string;
}

export interface Trade extends TradeSummary { items: TradeItem[]; }

export interface TradeConflict { oracleId: string; name: string; owned: number; allocated: number; tradingAway: number; }
export interface CompleteTradeResult {
  completed: boolean; needsConfirmation?: boolean; conflicts?: TradeConflict[];
  fulfilledWants?: Array<{ name: string }>; clampedTradeListItems?: number; resolvedConflicts?: TradeConflict[];
}

export const fetchTrades = (status?: TradeStatus, signal?: AbortSignal) =>
  getJson<{ trades: TradeSummary[] }>(`/api/v1/trades${status ? `?status=${status}` : ''}`, signal).then((r) => r.trades);
export const fetchTrade = (id: number, signal?: AbortSignal) =>
  getJson<{ trade: Trade }>(`/api/v1/trades/${id}`, signal).then((r) => r.trade);
export const createTrade = (input: { counterpartyName: string; counterpartyContact?: string | null; tradeDate?: string | null; locationNote?: string | null; notes?: string | null }) =>
  send<{ trade: Trade }>('/api/v1/trades', 'POST', input).then((r) => r.trade);
export const updateTrade = (id: number, changes: Record<string, unknown>) =>
  send<{ trade: Trade }>(`/api/v1/trades/${id}`, 'PATCH', changes).then((r) => r.trade);
export const deleteTrade = (id: number) => send<void>(`/api/v1/trades/${id}`, 'DELETE');
export const cancelTrade = (id: number) => send<{ trade: Trade }>(`/api/v1/trades/${id}/cancel`, 'POST', {}).then((r) => r.trade);
export const addTradeItem = (id: number, item: Record<string, unknown>) =>
  send<{ trade: Trade }>(`/api/v1/trades/${id}/items`, 'POST', item).then((r) => r.trade);
export const updateTradeItem = (id: number, itemId: number, changes: Record<string, unknown>) =>
  send<{ trade: Trade }>(`/api/v1/trades/${id}/items/${itemId}`, 'PATCH', changes).then((r) => r.trade);
export const removeTradeItem = (id: number, itemId: number) =>
  send<{ trade: Trade }>(`/api/v1/trades/${id}/items/${itemId}`, 'DELETE').then((r) => r.trade);
export const completeTrade = (id: number, force = false) =>
  send<{ result: CompleteTradeResult; trade: Trade }>(`/api/v1/trades/${id}/complete`, 'POST', { force });

export interface NamedList { id: number; name: string; description: string | null; is_default: number; sort_order: number; active_count?: number; item_count?: number; }
export interface WantList { id: number; name: string; items: WantListItem[]; }

export const fetchWantLists = (signal?: AbortSignal) =>
  getJson<{ lists: NamedList[] }>('/api/v1/want-lists', signal).then((r) => r.lists);
export const createWantList = (name: string, description?: string) =>
  send<{ id: number; lists: NamedList[] }>('/api/v1/want-lists', 'POST', { name, description });
export const renameWantList = (id: number, name: string) =>
  send<{ lists: NamedList[] }>(`/api/v1/want-lists/${id}`, 'PATCH', { name });
export const deleteWantList = (id: number) => send<{ lists: NamedList[] }>(`/api/v1/want-lists/${id}`, 'DELETE');
export const addWantItem = (listId: number, oracleId: string, fields: Record<string, unknown> = {}) =>
  send<WantList>(`/api/v1/want-lists/${listId}/items`, 'POST', { oracleId, ...fields });
export const updateWantItem = (listId: number, itemId: number, changes: Record<string, unknown>) =>
  send<WantList>(`/api/v1/want-lists/${listId}/items/${itemId}`, 'PATCH', changes);
export const removeWantItem = (listId: number, itemId: number) =>
  send<WantList>(`/api/v1/want-lists/${listId}/items/${itemId}`, 'DELETE');
export const reorderWantItems = (listId: number, orderedIds: number[]) =>
  send<WantList>(`/api/v1/want-lists/${listId}/reorder`, 'POST', { orderedIds });

export interface TradeListItem {
  id: number; collectionItemId: number; oracleId: string; name: string;
  setCode: string | null; collectorNumber: string | null; finish: string; condition: string;
  locationName: string | null; quantity: number; askingPriceUsd: number | null; marketUsd: number | null;
  imageSmall: string | null; notes: string | null; ownedQuantity: number; availableOverall: number;
  exceedsOwned: boolean; conflictsWithDeck: boolean;
}
export interface TradeList { id: number; name: string; items: TradeListItem[]; }

export const fetchTradeLists = (signal?: AbortSignal) =>
  getJson<{ lists: NamedList[] }>('/api/v1/trade-lists', signal).then((r) => r.lists);
export const fetchTradeList = (id: number, signal?: AbortSignal) =>
  getJson<TradeList>(`/api/v1/trade-lists/${id}`, signal);
export const createTradeList = (name: string, description?: string) =>
  send<{ id: number; lists: NamedList[] }>('/api/v1/trade-lists', 'POST', { name, description });
export const renameTradeList = (id: number, name: string) =>
  send<{ lists: NamedList[] }>(`/api/v1/trade-lists/${id}`, 'PATCH', { name });
export const deleteTradeList = (id: number) => send<{ lists: NamedList[] }>(`/api/v1/trade-lists/${id}`, 'DELETE');
export const addTradeListItem = (listId: number, collectionItemId: number, fields: Record<string, unknown> = {}) =>
  send<TradeList>(`/api/v1/trade-lists/${listId}/items`, 'POST', { collectionItemId, ...fields });
export const updateTradeListItem = (listId: number, itemId: number, changes: Record<string, unknown>) =>
  send<TradeList>(`/api/v1/trade-lists/${listId}/items/${itemId}`, 'PATCH', changes);
export const removeTradeListItem = (listId: number, itemId: number) =>
  send<TradeList>(`/api/v1/trade-lists/${listId}/items/${itemId}`, 'DELETE');
export const tradeListExportUrl = (id: number) => `/api/v1/trade-lists/${id}/export`;

export interface Alert {
  id: number; kind: string; state: 'active' | 'acknowledged' | 'resolved';
  subjectType: string | null; subjectId: number | null; title: string; message: string | null;
  payload: unknown; createdAt: string; acknowledgedAt: string | null;
}
export const fetchAlerts = (state?: string, signal?: AbortSignal) =>
  getJson<{ alerts: Alert[]; activeCount: number }>(`/api/v1/alerts${state ? `?state=${state}` : ''}`, signal);
export const acknowledgeAlert = (id: number) =>
  send<{ activeCount: number }>(`/api/v1/alerts/${id}/acknowledge`, 'POST', {});
export const resolveAlert = (id: number) =>
  send<{ activeCount: number }>(`/api/v1/alerts/${id}/resolve`, 'POST', {});
