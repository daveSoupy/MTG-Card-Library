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
}

export interface SearchParams {
  q?: string;
  ownedOnly?: boolean;
  colors?: string[];
  colorsExact?: boolean;
  rarities?: string[];
  set?: string;
  format?: string;
  minCmc?: number;
  maxCmc?: number;
  includeDigital?: boolean;
  includeExtras?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
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
  if (params.rarities?.length) query.set('rarities', params.rarities.join(','));
  if (params.set) query.set('set', params.set);
  if (params.format) query.set('format', params.format);
  if (params.minCmc !== undefined) query.set('minCmc', String(params.minCmc));
  if (params.maxCmc !== undefined) query.set('maxCmc', String(params.maxCmc));
  if (params.includeDigital) query.set('includeDigital', 'true');
  if (params.includeExtras) query.set('includeExtras', 'true');
  if (params.sort) query.set('sort', params.sort);
  query.set('limit', String(params.limit ?? 60));
  if (params.offset) query.set('offset', String(params.offset));
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
export function imageUrl(printingId: string, size: 'small' | 'normal' | 'large', face = 0): string {
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
  legality: string | null;
  ownedQuantity: number;
  availableQuantity: number;
  printingId: string | null;
  setCode: string | null;
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

export interface DeckValidation {
  formatCode: string | null;
  formatName: string | null;
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
  changes: { quantity?: number; fromCollection?: number; board?: Board },
) => send<{ deck: Deck }>(`/api/v1/decks/${deckId}/cards/${cardId}`, 'PATCH', changes).then((r) => r.deck);

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
