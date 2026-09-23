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
  /**
   * Phase 23's collection numbers, on every row so badges render from the
   * result set rather than a request per card. All computed server-side by
   * allocation.ts — the client never subtracts anything itself.
   */
  availableQuantity?: number;
  /** Copies decks in a reserving status have claimed. */
  reservedQuantity?: number;
  tradeListedQuantity?: number;
  /** Decks that reference this card, and their names. */
  deckCount?: number;
  deckNames?: string[];
  /** False for a basic land outside allocation: render no owned badge at all. */
  allocationTracked?: boolean;
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
  isPromo: boolean;
  promoTypes: string[];
  ownedQuantity: number;
}

export interface CardLegality {
  format: string;
  displayName: string;
  status: string;
  playable: boolean;
}

export interface CardRuling {
  source: 'wotc' | 'scryfall';
  publishedAt: string;
  comment: string;
}

export interface CardDetail extends CardSummary {
  layout: string;
  oracleText: string | null;
  flavorText: string | null;
  artist: string | null;
  keywords: string[];
  isReserved: boolean;
  canBeCommander: boolean;
  /**
   * The card's own per-deck copy cap, from its rules text: -1 for "a deck can
   * have any number of cards named ...", a positive number for printed caps
   * like Nazgûl's nine, null for ordinary cards bound by the format's limit.
   */
  deckCopyLimit: number | null;
  /** True when the art was chosen by hand rather than picked by the sync. */
  artIsPinned?: boolean;
  edhrecRank: number | null;
  frontImage: string | null;
  backImage: string | null;
  faces: CardFace[];
  printings: CardPrinting[];
  legalities: CardLegality[];
  rulings: CardRuling[];
}

export interface SearchResponse {
  cards: CardSummary[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Things the query said that could not be honoured — `loc:Binderrr`. Shown
   * above the results: an empty screen with no explanation is the failure mode
   * these exist to prevent.
   */
  warnings?: string[];
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
  /** Server-owned display names for the tag categories — the client keeps no
   *  copy of its own, so the two can never drift. */
  categoryLabels: Record<string, string>;
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
  /** 1 when one copy of a card is the limit. The picker reads it here rather
   *  than keeping a list of which formats those are. */
  isSingleton?: number;
  /**
   * 1 for draft and sealed: no published legalities to filter a picker by, and
   * adding a card to such a deck also puts it in the collection. Resolved by
   * the server so this stays one list, on the side that owns the rules.
   */
  isLimited?: number;
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
  /** Phase 7 shortfall links: cards resolved into this card_categories value. */
  category?: string;
  /**
   * The deck this search runs from. Makes `available` mean "available to this
   * deck" — its own reservation excluded, so a deck never competes with itself.
   */
  deckId?: number;
  sort?: string;
  limit?: number;
  offset?: number;
  /** Sent when paging so the server reuses the first page's count. */
  knownTotal?: number;
}

/**
 * What a page says beside the thing that failed when the server never
 * answered. Deliberately just the fact: the diagnosis and the fix ("turn on
 * Tailscale", "be on your home wifi") belong to the one app-level banner,
 * which chooses them by how the page was reached (`reachability.ts`, Phase
 * 31). Before that banner existed this sentence carried the advice too — and
 * told a phone on the home wifi to check the tailnet.
 */
export const CONNECTIVITY_MESSAGE = "Couldn't reach the MTG Library server.";

/**
 * Told each time a request finds the server unreachable — the signal the
 * reconnect banner is raised on. Every path through this module that builds
 * a connectivity `ApiError` reports here first, so a page never has to; a
 * page catching the error and showing `CONNECTIVITY_MESSAGE` is the local
 * half, this is the global half. Returns the unsubscribe.
 */
export function onServerUnreachable(listener: () => void): () => void {
  unreachableListeners.add(listener);
  return () => { unreachableListeners.delete(listener); };
}

const unreachableListeners = new Set<() => void>();

function reportUnreachable(): void {
  for (const listener of unreachableListeners) listener();
}

/**
 * One health round-trip, true when the server answered. The banner polls
 * this while it is up; a plain `fetch` on purpose, so a probe that fails does
 * not itself report unreachable and re-raise the banner it is trying to
 * clear. `/api/*` is never touched by the service worker, so a true here
 * means the server, not a cache.
 */
export async function probeHealth(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/health', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * A request that did not succeed, and whether that is the server's doing.
 *
 * `isConnectivity` is the flag pages branch on: true means nothing answered,
 * so a page must show this error rather than its empty state — an empty
 * collection and an unreachable server both come back as "no rows", and only
 * one of them is true.
 */
export class ApiError extends Error {
  /** HTTP status, or null when the request never got a response. */
  status: number | null;
  isConnectivity: boolean;
  constructor(message: string, status: number | null, isConnectivity: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.isConnectivity = isConnectivity;
  }
}

/** True when the failure means the server never answered. */
export const isConnectivityError = (error: unknown): boolean =>
  error instanceof ApiError && error.isConnectivity;

/**
 * `fetch` with the one failure a browser reports by throwing — no response at
 * all (refused, DNS, offline) — turned into the connectivity message. It throws
 * a bare `TypeError`, whose text ("Failed to fetch", "Load failed") names
 * nothing the user can act on. An abort is the caller's own doing and passes
 * through untouched, so `e.name === 'AbortError'` checks keep working.
 */
async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause;
    reportUnreachable();
    throw new ApiError(CONNECTIVITY_MESSAGE, null, true, cause);
  }
}

/**
 * The error for a non-OK response.
 *
 * The server's own errors are always JSON with an `error` field — even its
 * 500s, from `errorHandler.ts` — so a 5xx *without* one is not the server
 * talking: it is the Vite dev proxy or a gateway answering on its behalf
 * because nothing was listening. That is connectivity, and it reads as such
 * rather than as "Request failed with status 500". Pass `body` when the
 * caller has already read it.
 */
export async function errorFromResponse(
  response: Response,
  body?: unknown,
  fallback?: string,
): Promise<ApiError> {
  const parsed = body !== undefined ? body : await response.json().catch(() => undefined);
  const serverError = (parsed as { error?: unknown; detail?: unknown } | undefined)?.error;
  if (typeof serverError === 'string' && serverError) {
    const detail = (parsed as { detail?: unknown }).detail;
    const message = typeof detail === 'string' && detail ? `${serverError} ${detail}` : serverError;
    return new ApiError(message, response.status, false);
  }
  if (response.status >= 500) {
    reportUnreachable();
    return new ApiError(CONNECTIVITY_MESSAGE, response.status, true);
  }
  return new ApiError(fallback ?? `Request failed with status ${response.status}`, response.status, false);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw await errorFromResponse(response);
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
  if (params.category) query.set('category', params.category);
  if (params.deckId !== undefined) query.set('deckId', String(params.deckId));
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

/**
 * Phase 33. Who this server is and where it is — what the pairing panel's QR
 * encodes and what a paired phone checks an address against. `addresses` is
 * empty on a loopback bind, which the panel reads as "sharing is off".
 */
export interface InstanceInfo {
  instanceId: string;
  /** The OS hostname. */
  name: string;
  version: string;
  port: number;
  /** Non-loopback addresses the server is bound on, home network first. */
  addresses: string[];
  /** `mtg-library-<first 4 of id>.local`. */
  mdnsName: string;
}

export const fetchInstance = (signal?: AbortSignal) =>
  getJson<InstanceInfo>('/api/v1/instance', signal);

export const fetchSets = (signal?: AbortSignal) =>
  getJson<{ sets: SetRecord[] }>('/api/v1/sets', signal).then((r) => r.sets);

export const fetchFormats = (signal?: AbortSignal) =>
  getJson<{ formats: FormatRecord[] }>('/api/v1/formats', signal).then((r) => r.formats);

export async function startSync(bulkType?: string, force = false): Promise<void> {
  const response = await apiFetch('/api/v1/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bulkType, force }),
  });
  if (!response.ok && response.status !== 409) {
    throw await errorFromResponse(response, undefined, `Could not start the sync (HTTP ${response.status}).`);
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

/**
 * Whether a deck lays claim to physical copies. Only 'building' and 'assembled'
 * do — the server's `decks/allocation.ts` is the authority, and no client
 * recomputes availability from this.
 */
export type DeckStatus = 'brew' | 'building' | 'assembled' | 'disassembled';

export const DECK_STATUSES: DeckStatus[] = ['brew', 'building', 'assembled', 'disassembled'];

export const DECK_STATUS_LABEL: Record<DeckStatus, string> = {
  brew: 'Brew',
  building: 'Building',
  assembled: 'Assembled',
  disassembled: 'Taken apart',
};

/** What the status means for your cards, shown under the picker. */
export const DECK_STATUS_HINT: Record<DeckStatus, string> = {
  brew: 'An idea. Holds a card list without claiming any copies.',
  building: 'Being put together — its copies are spoken for.',
  assembled: 'Sleeved and in a box. Its copies are spoken for.',
  disassembled: 'The cards went back. Keeps its list.',
};

export const DECK_STATUS_RESERVES: Record<DeckStatus, boolean> = {
  brew: false, building: true, assembled: true, disassembled: false,
};

export interface DeckCard {
  id: number;
  oracleId: string;
  name: string;
  board: Board;
  quantity: number;
  quantityFromCollection: number;
  /** Copies filled by a proxy: neither owned nor to-buy. */
  quantityProxied: number;
  commanderRole: string | null;
  cmc: number;
  typeLine: string;
  manaCost: string | null;
  colorIdentity: string;
  isBasicLand: boolean;
  canBeCommander: boolean;
  category: string | null;
  /** Phase 7: card_categories membership — the tag-derived categories this card matches. */
  categories: string[];
  producedMana: string[];
  partnerKind: string | null;
  legality: string | null;
  ownedQuantity: number;
  availableQuantity: number;
  /** Copies promised on a trade list — why a card you own can read as 0 free. */
  tradeListedQuantity: number;
  /** False for a basic land under the exemption: no owned/missing badge at all. */
  allocationTracked: boolean;
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
  proxiedCount: number;
  needToBuyCount: number;
}

export interface TemplateTargetRow {
  category: string;
  label: string;
  ideal: number;
  minCount: number | null;
  maxCount: number | null;
  note: string | null;
  sortOrder: number;
}

export interface TemplateProgressRow extends TemplateTargetRow {
  current: number;
  isShort: boolean;
  isOver: boolean;
}

export interface TemplateProgress {
  templateId: number;
  templateName: string;
  rows: TemplateProgressRow[];
  uncategorisedCount: number;
  countedTotal: number;
  /** False when Scryfall's tags have never been resolved — every tag-derived
   *  row then reads zero for a reason that has nothing to do with the deck. */
  tagDataAvailable: boolean;
}

export interface DeckTemplate {
  id: number;
  name: string;
  formatCode: string | null;
  archetype: string | null;
  description: string | null;
  isBuiltin: boolean;
  sortOrder: number;
  targets: TemplateTargetRow[];
}

export interface Deck {
  id: number;
  name: string;
  formatCode: string | null;
  /** Where the physical deck lives — an assembly run's destination. */
  homeLocationId: number | null;
  description: string | null;
  notes: string | null;
  status: DeckStatus;
  statusChangedAt: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  templateId: number | null;
  cards: DeckCard[];
  validation: DeckValidation;
  stats: DeckStats;
  manaBase: ManaBase;
  templateProgress: TemplateProgress | null;
  /** Chosen if you picked one, otherwise worked out from the deck's contents. */
  coverPrintingId: string | null;
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
  status: DeckStatus;
  statusChangedAt: string | null;
  isArchived: boolean;
  updatedAt: string;
  tags: string[];
  /** Chosen if you picked one, otherwise worked out from the deck's contents. */
  coverPrintingId: string | null;
  /** Only when the list was asked for `include=buildability`. */
  buildability?: DeckBuildability | null;
}

/**
 * Could this deck go on the table tonight, and what would finishing it cost?
 *
 * Computed by the server against the same allocation rules everything else
 * uses. The client renders these numbers and never derives one: a percentage
 * the client worked out for itself is a percentage that can disagree with the
 * deck it describes.
 */
export interface DeckBuildability {
  deckId: number;
  /** Null when the deck has nothing to count — read it as "empty", not 100%. */
  buildablePct: number | null;
  requiredCards: number;
  coveredCards: number;
  missingCards: number;
  costToCompleteUsd: number;
  /** Missing cards with no price at all, so "$23 + 2 unpriced" can be said. */
  unpricedCount: number;
  /** Missing cards another reserving deck is holding copies of. */
  contestedCount: number;
}

/** One card's story inside a deck's buildability breakdown. */
export interface BuildabilityRow {
  oracleId: string;
  name: string;
  required: number;
  owned: number;
  available: number;
  tradeListed: number;
  proxied: number;
  covered: number;
  missing: number;
  unitPriceUsd: number | null;
  extendedUsd: number | null;
  contested: boolean;
  holdingDecks: Array<{ deckId: number; deckName: string; status: DeckStatus; quantity: number }>;
}

export interface BuildabilityDetail {
  deckId: number;
  deckName: string;
  summary: DeckBuildability;
  rows: BuildabilityRow[];
}

export const BUILDABILITY_SORTS = ['buildable_desc', 'cost_to_complete_asc', 'missing_asc'] as const;
export type BuildabilitySort = (typeof BUILDABILITY_SORTS)[number];

export const BUILDABILITY_SORT_LABEL: Record<BuildabilitySort, string> = {
  buildable_desc: 'Closest to buildable',
  cost_to_complete_asc: 'Cheapest to finish',
  missing_asc: 'Fewest cards missing',
};

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await apiFetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

/**
 * The deck list.
 *
 * Buildability is opt-in: it is a real computation over the whole collection,
 * and the callers that only want deck names (the picker, the import dialog)
 * should not pay for it. Sorting by it implies asking for it.
 */
export const fetchDecks = (
  options: { buildability?: boolean; sort?: BuildabilitySort | null } = {},
  signal?: AbortSignal,
) => {
  const params = new URLSearchParams();
  if (options.buildability || options.sort) params.set('include', 'buildability');
  if (options.sort) params.set('sort', options.sort);
  const query = params.toString();
  return getJson<{ decks: DeckSummary[] }>(
    `/api/v1/decks${query ? `?${query}` : ''}`, signal,
  ).then((r) => r.decks);
};

export const fetchBuildability = (deckId: number, signal?: AbortSignal) =>
  getJson<BuildabilityDetail>(`/api/v1/decks/${deckId}/buildability`, signal);

/** Everything the collection could not cover, onto a want list. */
export const pushMissingToWantList = (deckId: number, wantListId?: number) =>
  send<{ added: number; updated: number; listName: string }>(
    `/api/v1/decks/${deckId}/buildability/want`, 'POST', { wantListId });


// -- assembly runs (Phase 25) -------------------------------------------------

export type RunKind = 'assemble' | 'disassemble';
export type RunStatus = 'open' | 'completed' | 'cancelled';

export interface AssemblyRun {
  id: number;
  deckId: number;
  kind: RunKind;
  status: RunStatus;
  movesLots: boolean;
  sourceRunId: number | null;
  startedAt: string;
  completedAt: string | null;
  notes: string | null;
  lineCount: number;
  cardCount: number;
  pickedCount: number;
  /**
   * Copies the sheet sent you for that were not where it said — un-ticked when
   * the assemble run was completed. Empty on an open run and on a disassembly.
   * The durable record of a shortfall: the deck's claim is recomputed from the
   * collection on every edit and cannot hold it, so the run does.
   */
  notFoundCount: number;
  notFound: Array<{ oracleId: string; name: string; quantity: number }>;
}

export interface SheetLine {
  id: number;
  oracleId: string;
  name: string;
  printingId: string | null;
  setCode: string | null;
  collectorNumber: string | null;
  finish: string | null;
  condition: string | null;
  language: string | null;
  quantity: number;
  picked: boolean;
  unavailable: boolean;
  notes: string | null;
  collectionItemId: number | null;
  fromLocationId: number | null;
  fromLocationName: string | null;
  toLocationId: number | null;
  toLocationName: string | null;
  /** Copies of this lot currently offered on a trade list; 0 when none. */
  tradeListed: number;
  unitPriceUsd: number | null;
  extendedUsd: number | null;
}

export interface SheetGroup {
  locationId: number | null;
  locationName: string;
  lines: SheetLine[];
  cardCount: number;
  pickedCount: number;
}

export interface AssemblySheet {
  run: AssemblyRun;
  deck: {
    id: number;
    name: string;
    status: DeckStatus;
    homeLocationId: number | null;
    homeLocationName: string | null;
  };
  groups: SheetGroup[];
  unavailable: SheetLine[];
  summary: {
    cardsToPull: number;
    pickedCards: number;
    lineCount: number;
    pickedLines: number;
    unavailableCards: number;
    unavailableCostUsd: number;
    unpricedCount: number;
    tradeListedLines: number;
    proxiedCards: number;
  };
  movesLots: boolean;
  movesLotsBlocked: string | null;
}

export interface AssemblyCompletion {
  runId: number;
  kind: RunKind;
  deckId: number;
  deckStatus: DeckStatus;
  pulledCards: number;
  notFoundCards: number;
  proxiedCards: number;
  stillMissingCards: number;
  stillMissingCostUsd: number;
  unpricedCount: number;
  movedLots: boolean;
  copiesMoved: number;
  tradeListAdjustments: Array<{
    listName: string; cardName: string; quantity: number; removed: boolean;
  }>;
  problems: string[];
}

/** Opens a run, or hands back the one already open on this deck. */
export const startAssembly = (deckId: number) =>
  send<AssemblySheet>(`/api/v1/decks/${deckId}/assembly`, 'POST');

export const startDisassembly = (deckId: number) =>
  send<AssemblySheet>(`/api/v1/decks/${deckId}/disassembly`, 'POST');

/** The run in progress, if any — so the deck header can offer to resume it. */
export const fetchRunHistory = (deckId: number, signal?: AbortSignal) =>
  getJson<{ runs: AssemblyRun[] }>(`/api/v1/decks/${deckId}/assembly/runs`, signal)
    .then((r) => r.runs);

export const fetchSheet = (runId: number, signal?: AbortSignal) =>
  getJson<AssemblySheet>(`/api/v1/assembly/${runId}`, signal);

/** Ticking a line off. The whole sheet comes back so the counts stay honest. */
export const setLinePicked = (runId: number, itemId: number, picked: boolean) =>
  send<AssemblySheet>(`/api/v1/assembly/${runId}/items/${itemId}`, 'PATCH', { picked });

export const completeAssembly = (runId: number) =>
  send<AssemblyCompletion>(`/api/v1/assembly/${runId}/complete`, 'POST');

export const cancelAssembly = (runId: number) =>
  send<{ run: AssemblyRun }>(`/api/v1/assembly/${runId}/cancel`, 'POST');


// -- allocation contention (Phase 26) ------------------------------------------

export interface HoldingDeck {
  deckId: number;
  deckName: string;
  status: DeckStatus;
  quantity: number;
}

export interface ShortDeck {
  deckId: number;
  deckName: string;
  status: DeckStatus;
  required: number;
  covered: number;
  missing: number;
}

export interface ContestedCard {
  oracleId: string;
  name: string;
  owned: number;
  tradeListed: number;
  /** Σ (required − proxied) across reserving decks. */
  wanted: number;
  /** Σ claims across reserving decks. */
  held: number;
  /** Copies that would have to appear for every reserving deck to be whole. */
  shortfall: number;
  unitPriceUsd: number | null;
  /** Stored claims exceed supply — the ground moved after a deck claimed. */
  overAllocated: boolean;
  holders: HoldingDeck[];
  shortDecks: ShortDeck[];
}

export interface ReassignResult {
  oracleId: string;
  quantity: number;
  from: DeckBuildability;
  to: DeckBuildability;
}

export interface WhatIfDelta {
  deckId: number;
  deckName: string;
  before: DeckBuildability;
  after: DeckBuildability;
}

export interface WhatIfResult {
  deckId: number;
  deckName: string;
  /** Decks whose figures would change, best improvement first. */
  changed: WhatIfDelta[];
  /** Contested cards this deck is currently holding copies of. */
  freedCards: Array<{ oracleId: string; name: string; quantity: number }>;
}

export interface CardHolders {
  oracleId: string;
  name: string;
  tracked: boolean;
  owned: number;
  reserved: number;
  tradeListed: number;
  available: number;
  decks: Array<{
    deckId: number; deckName: string; status: DeckStatus; quantity: number;
    reserving: boolean; homeLocationName: string | null;
  }>;
  locations: Array<{ locationId: number; name: string; quantity: number }>;
}

/** The contested set, worst first. */
export const fetchContention = (signal?: AbortSignal) =>
  getJson<{ cards: ContestedCard[] }>('/api/v1/allocation/contention', signal).then((r) => r.cards);

/** Moves a claim between two decks; both decks' figures come back with it. */
export const reassignClaim = (input: {
  oracleId: string; fromDeckId: number; toDeckId: number; quantity: number;
}) => send<ReassignResult>('/api/v1/allocation/reassign', 'POST', input);

/** What breaking a deck up would free. Reads only. */
export const fetchWhatIf = (deckId: number, signal?: AbortSignal) =>
  getJson<WhatIfResult>(`/api/v1/allocation/what-if?disassemble=${deckId}`, signal);

/** Who holds a card and where its copies physically live. */
export const fetchCardHolders = (oracleId: string, signal?: AbortSignal) =>
  getJson<CardHolders>(`/api/v1/allocation/holders/${encodeURIComponent(oracleId)}`, signal);

// -- owned substitutes (Phase 27) -----------------------------------------------

export type CategorySource = 'tagger' | 'heuristic';

export interface SharedCategory {
  category: string;
  label: string;
  source: CategorySource;
}

export interface SubstituteCandidate {
  oracleId: string;
  name: string;
  printingId: string | null;
  imageSmall: string | null;
  cmc: number;
  typeLine: string;
  manaCost: string | null;
  colorIdentity: string;
  primaryType: string | null;
  /** Roles shared with the target. Empty when the match is type and cost only. */
  sharedCategories: SharedCategory[];
  /** Free for this deck — its own claim excluded. */
  available: number;
  locations: Array<{ locationId: number; name: string; quantity: number }>;
  edhrecRank: number | null;
  score: {
    total: number; category: number; type: number; cmc: number; edhrec: number; availability: number;
  };
  /** The server's reason line, one phrase per signal. Rendered, never rewritten. */
  reasons: string[];
}

export interface SubstitutesResult {
  target: {
    oracleId: string; name: string; cmc: number; typeLine: string;
    primaryType: string | null; categories: SharedCategory[];
  };
  context: {
    deckId: number | null; deckName: string | null; formatCode: string | null;
    /** 'WU', '' for colourless, or null when unconstrained. */
    colorIdentity: string | null;
  };
  /** Null when the target has no role under any source: type and cost only. */
  categorySource: CategorySource | null;
  candidates: SubstituteCandidate[];
  /** Hard-filter survivors, before the relevance floor and the cut. */
  poolSize: number;
}

/** Owned stand-ins for a card, in a deck's colour identity and format. */
export const fetchDeckSubstitutes = (deckId: number, oracleId: string, signal?: AbortSignal) =>
  getJson<SubstitutesResult>(
    `/api/v1/decks/${deckId}/cards/${encodeURIComponent(oracleId)}/substitutes`, signal);

/** The same for a want, where the deck (if any) supplies the context. */
export const fetchSubstitutes = (oracleId: string, deckId: number | null, signal?: AbortSignal) => {
  const params = new URLSearchParams({ oracleId });
  if (deckId != null) params.set('deckId', String(deckId));
  return getJson<SubstitutesResult>(`/api/v1/substitutes?${params}`, signal);
};

export const fetchDeck = (id: number, signal?: AbortSignal) =>
  getJson<{ deck: Deck }>(`/api/v1/decks/${id}`, signal).then((r) => r.deck);

export const createDeck = (name: string, formatCode: string | null) =>
  send<{ deck: Deck }>('/api/v1/decks', 'POST', { name, formatCode }).then((r) => r.deck);

export const updateDeck = (id: number, changes: Partial<Pick<Deck, 'name' | 'formatCode' | 'description' | 'notes' | 'isArchived' | 'templateId' | 'status' | 'homeLocationId'>>) =>
  send<{ deck: Deck }>(`/api/v1/decks/${id}`, 'PATCH', changes).then((r) => r.deck);

export const duplicateDeck = (id: number) =>
  send<{ deck: Deck }>(`/api/v1/decks/${id}/duplicate`, 'POST', {}).then((r) => r.deck);

export const deleteDeck = (id: number) => send<void>(`/api/v1/decks/${id}`, 'DELETE');

export const addDeckCard = (
  deckId: number,
  oracleId: string,
  // fromCollection and commanderRole are what undo needs to put a removed slot
  // back exactly as it was, allocation and command-zone role included.
  options: {
    board?: Board; quantity?: number; fromCollection?: number;
    commanderRole?: string | null;
    /** The printing on screen — pins the slot's art, and is the printing a
     *  draft or sealed deck's add puts into the collection. */
    printingId?: string | null;
  } = {},
) => send<{ deck: Deck }>(`/api/v1/decks/${deckId}/cards`, 'POST', { oracleId, ...options }).then((r) => r.deck);

export const updateDeckCard = (
  deckId: number,
  cardId: number,
  changes: {
    quantity?: number; fromCollection?: number; quantityProxied?: number; board?: Board;
    commanderRole?: string | null;
    category?: string | null; preferredPrintingId?: string | null;
  },
) => send<{ deck: Deck }>(`/api/v1/decks/${deckId}/cards/${cardId}`, 'PATCH', changes).then((r) => r.deck);

export const addRecommendedLands = (deckId: number) =>
  send<{ deck: Deck }>(`/api/v1/decks/${deckId}/recommended-lands`, 'POST', {}).then((r) => r.deck);


// -------------------------------------------------------- deck templates

export const fetchTemplates = (signal?: AbortSignal) =>
  getJson<{ templates: DeckTemplate[] }>('/api/v1/deck-templates', signal).then((r) => r.templates);

export type CostMethod = 'unknown' | 'free' | 'market' | 'fixed' | 'box';

export interface AppSettings {
  autoMaintainLands: boolean;
  /** Global on/off for Phase 7 deck templates, alongside the per-deck picker. */
  showDeckTemplates: boolean;
  /** Global on/off for the Phase 11 game log: the Games tab and deck button. */
  showGameLog: boolean;
  /** Basic lands sit outside allocation entirely: never claimed, never missing. */
  allocationIgnoresBasics: boolean;
  /** Escape hatch: put brews back into the set of decks that reserve copies. */
  brewsReserveCopies: boolean;
  /** Subtract trade-listed copies from what is free to build with. */
  tradelistReducesAvailable: boolean;
  /** Cost basis assumed when adding cards without a typed-in price. */
  defaultCostMethod: Exclude<CostMethod, 'box'>;
  defaultCostFixedUsd: number;
  /** Price of one booster pack; the Draft cost defaults to 3× this. */
  draftBoosterPriceUsd: number;
  /** Phase 23: the scope the deck builder's search pane opens in. */
  deckbuilderDefaultScope: 'all' | 'owned' | 'available';
  /**
   * Phase 25. Off, an assembly run is a checklist and touches no data. On,
   * completing one physically relocates lots into the deck's home location.
   */
  assemblyMovesLots: boolean;
  /** Phase 27: how many owned stand-ins the substitute sheet offers. */
  substituteSuggestionCount: number;
  /**
   * Phase 17. The one-time welcome has been dismissed. App shows it while this
   * is false and card data exists; the Data page writes false to show it again.
   */
  welcomeSeen: boolean;
}

export const fetchSettings = (signal?: AbortSignal) =>
  getJson<{ settings: AppSettings }>('/api/v1/settings', signal).then((r) => r.settings);

export const updateSettings = (changes: Partial<AppSettings>) =>
  send<{ settings: AppSettings }>('/api/v1/settings', 'PUT', changes).then((r) => r.settings);

export interface StorageInfo {
  database: { bytes: number };
  imageCache: { bytes: number; count: number; limitBytes: number };
  cards: { oracleCards: number; printings: number; sets: number };
  /** Phase 7 tag coverage. `cards` is distinct cards; one card can hold several. */
  categories: { cards: number; rows: number; syncedAt: string | null; error: string | null };
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

/** Resolves Scryfall's tag categories on their own — seconds, rather than the
 *  ~17 seconds a full card re-import costs. */
export const resolveCategories = () =>
  send<{ sync: unknown }>('/api/v1/sync/categories', 'POST', {});

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
  const response = await apiFetch('/api/v1/images/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 413) {
    throw new CacheTooSmallError(body.error ?? 'Cache too small.', body.estimateBytes, body.limitBytes);
  }
  if (!response.ok) throw await errorFromResponse(response, body);
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
    qty_from_collection: number; qty_proxied: number;
    /** Only 'building' and 'assembled' actually hold the copies. */
    deck_status: DeckStatus;
    deck_home_location: string | null;
  }>;
  availability: {
    owned_qty: number;
    allocated_qty: number;
    available_qty: number;
    trade_listed_qty: number;
    is_tracked: boolean;
    is_over_allocated: boolean;
  } | null;
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
  /** Set the session was working through, so it can be reopened. */
  setCode: string | null;
}

/** Opens a cost pool and marks it the open one; returns its summary. */
export const openCostPool = (totalCostUsd: number, label?: string, setCode?: string) =>
  send<{ batchId: number; pool: CostPool }>('/api/v1/collection/cost-pools', 'POST', { totalCostUsd, label, setCode })
    .then((r) => r.pool);

/** The pool currently accepting cards, or null. */
export const fetchOpenCostPool = (signal?: AbortSignal) =>
  getJson<{ pool: CostPool | null }>('/api/v1/collection/cost-pools/open', signal).then((r) => r.pool);

/** Changes an open pool's lump sum, re-dividing it across its cards. */
export const updateCostPoolTotal = (id: number, totalCostUsd: number) =>
  send<{ pool: CostPool | null }>(`/api/v1/collection/cost-pools/${id}`, 'PATCH', { totalCostUsd })
    .then((r) => r.pool);

/** Remembers the set the open session is working through, for resume. */
export const setCostPoolSet = (id: number, setCode: string | null) =>
  send<{ pool: CostPool | null }>(`/api/v1/collection/cost-pools/${id}`, 'PATCH', { setCode })
    .then((r) => r.pool);

/** Finishes the open pool (its cards keep their cost). */
export const closeCostPool = () =>
  send<{ pool: null }>('/api/v1/collection/cost-pools/close', 'POST', {}).then((r) => r.pool);

/** Points the open pool back at a past batch, set scope and all. */
export const reopenCostPool = (id: number) =>
  send<{ pool: CostPool }>(`/api/v1/collection/cost-pools/${id}/reopen`, 'POST', {})
    .then((r) => r.pool);

export const fetchLocations = (signal?: AbortSignal) =>
  getJson<{ locations: StorageLocation[] }>('/api/v1/locations', signal).then((r) => r.locations);

export const createLocation = (name: string, kind: string) =>
  send<{ locations: StorageLocation[] }>('/api/v1/locations', 'POST', { name, kind })
    .then((r) => r.locations);

/**
 * What a location delete hands back: the record that undoes it. Opaque to the
 * client — `restoreLocation` sends it back unchanged.
 */
export interface LocationRestore {
  location: {
    id: number; name: string; kind: string; notes: string | null;
    isArchived: number; sortOrder: number; createdAt: string;
  };
  movedTo: number | null;
  lotIds: number[];
  references: Record<string, number[]>;
}

/** What deleting a location would do, for the confirm. */
export interface LocationImpact {
  cards: number;
  lots: number;
  homeOf: Array<{ id: number; name: string }>;
}

export const fetchLocationImpact = (id: number) =>
  getJson<LocationImpact>(`/api/v1/locations/${id}/impact`);

/** `moveTo` relocates the contents first; without it a non-empty location 409s. */
export const deleteLocation = (id: number, moveTo?: number) =>
  send<{ locations: StorageLocation[]; restore: LocationRestore }>(
    `/api/v1/locations/${id}${moveTo ? `?moveTo=${moveTo}` : ''}`, 'DELETE',
  );

/** Undoes a delete; `id` is the location's id now (its old one when that was free). */
export const restoreLocation = (restore: LocationRestore) =>
  send<{ locations: StorageLocation[]; id: number }>('/api/v1/locations/restore', 'POST', { restore });

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
  | 'finish' | 'condition' | 'language' | 'price' | 'scryfallId' | 'ignore';

/** An alternative for a CSV row, carrying the printing it would import as. */
export interface CsvCandidate extends ResolvedCard {
  printingId: string | null;
  printingExact: boolean;
}

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
  /** Empty for a settled match; otherwise the alternatives to pick from. */
  candidates: CsvCandidate[];
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
  const response = await apiFetch('/api/v1/backup/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) {
    throw await errorFromResponse(response, undefined, `Restore failed with status ${response.status}`);
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
/** Every active want for a card across every list, not just the default one. */
export const fetchWantItemsForOracle = (oracleId: string) =>
  getJson<{ items: Array<{ wantListId: number; itemId: number }> }>(
    `/api/v1/want-lists/items/by-oracle/${oracleId}`,
  ).then((r) => r.items);

export interface TradeListItem {
  id: number; collectionItemId: number; oracleId: string; name: string;
  printingId: string | null;
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

// -- events and the game log (Phase 11) --------------------------------------

export type GameResult = 'win' | 'loss' | 'draw';

/** Match wins/losses/draws — the "12–4" a deck or an event is quoted as. */
export interface MatchRecord {
  wins: number;
  losses: number;
  draws: number;
  games: number;
}

export interface EventSummary {
  id: number;
  name: string;
  formatCode: string | null;
  formatName: string | null;
  eventDate: string | null;
  notes: string | null;
  deckId: number | null;
  deckName: string | null;
  importBatchId: number | null;
  /** The linked cost pool's lump sum, read back through the link. */
  spendUsd: number | null;
  poolCardCount: number;
  deckCardCount: number;
  record: MatchRecord;
  createdAt: string;
  updatedAt: string;
}

export interface EventDetail extends EventSummary {
  games: Game[];
}

export interface Game {
  id: number;
  eventId: number | null;
  eventName: string | null;
  /** Null once the deck has been deleted — the game itself survives. */
  deckId: number | null;
  /** The live deck's name, or the one kept from it when it was deleted. */
  deckName: string | null;
  /** Null for a detached game: the format lived on the deck. */
  formatCode: string | null;
  playedAt: string;
  opponents: string | null;
  result: GameResult;
  gamesWon: number | null;
  gamesLost: number | null;
  gamesDrawn: number | null;
  roundNumber: number | null;
  notes: string | null;
}

export interface EventFields {
  name?: string;
  formatCode?: string | null;
  eventDate?: string | null;
  deckId?: number | null;
  importBatchId?: number | null;
  notes?: string | null;
}

export interface GameFields {
  deckId?: number;
  eventId?: number | null;
  playedAt?: string | null;
  opponents?: string | null;
  result?: GameResult;
  gamesWon?: number | null;
  gamesLost?: number | null;
  gamesDrawn?: number | null;
  roundNumber?: number | null;
  notes?: string | null;
}

/** The record view's filters. Everything is optional and independent. */
export interface GameQuery {
  deckId?: number;
  eventId?: number;
  format?: string;
  from?: string;
  to?: string;
}

export const fetchEvents = (signal?: AbortSignal) =>
  getJson<{ events: EventSummary[] }>('/api/v1/events', signal).then((r) => r.events);

export const fetchEvent = (id: number, signal?: AbortSignal) =>
  getJson<{ event: EventDetail }>(`/api/v1/events/${id}`, signal).then((r) => r.event);

export const createEvent = (fields: EventFields & { name: string }) =>
  send<{ event: EventDetail }>('/api/v1/events', 'POST', fields).then((r) => r.event);

export const updateEvent = (id: number, changes: EventFields) =>
  send<{ event: EventDetail }>(`/api/v1/events/${id}`, 'PATCH', changes).then((r) => r.event);

export const deleteEvent = (id: number) => send<void>(`/api/v1/events/${id}`, 'DELETE');

export const fetchGames = (query: GameQuery = {}, signal?: AbortSignal) => {
  const params = new URLSearchParams();
  if (query.deckId !== undefined) params.set('deckId', String(query.deckId));
  if (query.eventId !== undefined) params.set('eventId', String(query.eventId));
  if (query.format) params.set('format', query.format);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  const suffix = params.toString() ? `?${params}` : '';
  return getJson<{ games: Game[]; record: MatchRecord }>(`/api/v1/games${suffix}`, signal);
};

export const logGame = (fields: GameFields & { deckId: number; result: GameResult }) =>
  send<{ game: Game }>('/api/v1/games', 'POST', fields).then((r) => r.game);

export const updateGame = (id: number, changes: GameFields) =>
  send<{ game: Game }>(`/api/v1/games/${id}`, 'PATCH', changes).then((r) => r.game);

export const deleteGame = (id: number) => send<void>(`/api/v1/games/${id}`, 'DELETE');

/** A deck's lifetime record and the games behind it, event or not. */
export const fetchDeckGames = (deckId: number, signal?: AbortSignal) =>
  getJson<{ games: Game[]; record: MatchRecord }>(`/api/v1/decks/${deckId}/games`, signal);

/** "12–4", or "12–4–1" when there are draws. An empty record reads as "0–0". */
export function formatRecord(record: MatchRecord): string {
  const base = `${record.wins}\u2013${record.losses}`;
  return record.draws > 0 ? `${base}\u2013${record.draws}` : base;
}
