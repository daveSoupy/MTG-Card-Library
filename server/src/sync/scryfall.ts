/**
 * Scryfall API client.
 *
 * Only two live endpoints are used — the bulk-data manifest and the set list,
 * one request each. Card data always comes from the bulk files, never from
 * per-card lookups, which is what Scryfall asks of applications.
 */

/** Scryfall asks every client to identify itself. */
export const USER_AGENT = 'MTGLibrary/1.0 (self-hosted; personal collection manager)';

const BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
};

export type BulkType = 'oracle_cards' | 'default_cards';

export const BULK_TYPES: Record<BulkType, { label: string; detail: string }> = {
  oracle_cards: {
    label: 'Cards only',
    detail:
      'One entry per card, around 24 MB compressed. Enough for search and deck building, with one representative printing each.',
  },
  default_cards: {
    label: 'Cards and every printing',
    detail:
      'Every printing of every card, around 78 MB compressed. Needed before the collection can price individual printings.',
  },
};

export interface BulkEntry {
  type: string;
  updatedAt: string;
  downloadUrl: string;
  compressedSize: number;
}

export interface SetRecord {
  code: string;
  scryfallId: string | null;
  name: string;
  setType: string | null;
  releasedAt: string | null;
  cardCount: number;
  parentSetCode: string | null;
  blockCode: string | null;
  blockName: string | null;
  digital: boolean;
  nonfoilOnly: boolean;
  foilOnly: boolean;
  iconSvgUri: string | null;
  scryfallUri: string | null;
}

export class ScryfallError extends Error {
  // Declared explicitly rather than as a constructor parameter property:
  // Node's --experimental-strip-types only erases types, and parameter
  // properties need real codegen.
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ScryfallError';
    this.status = status;
  }
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: BASE_HEADERS });
  if (!response.ok) {
    throw new ScryfallError(
      `Scryfall returned HTTP ${response.status} for ${url}. Try again in a moment.`,
      response.status,
    );
  }
  return response.json();
}

/** Looks up the currently published bulk file of the requested type. */
export async function fetchBulkEntry(type: BulkType): Promise<BulkEntry> {
  const body = await getJson('https://api.scryfall.com/bulk-data');
  const entries = body?.data;
  if (!Array.isArray(entries)) {
    throw new ScryfallError('The bulk-data listing had no "data" array.');
  }

  const entry = entries.find((e: any) => e?.type === type);
  if (!entry) {
    throw new ScryfallError(`Scryfall is not currently publishing a "${type}" bulk file.`);
  }

  // Scryfall publishes JSON Lines — one card per line — which streams far more
  // simply than the single-array form.
  const downloadUrl: string | undefined = entry.jsonl_download_uri ?? entry.download_uri;
  if (!downloadUrl) {
    throw new ScryfallError(`The "${type}" bulk entry had no download URI.`);
  }

  return {
    type,
    updatedAt: entry.updated_at ?? '',
    downloadUrl,
    compressedSize: Number(entry.compressed_size ?? entry.size ?? 0),
  };
}

/**
 * The full set list.
 *
 * Must be imported before cards: `card_printings.set_code` has a RESTRICT
 * foreign key onto `sets`, and the official `card_count` here is the
 * denominator for set-completion percentages.
 */
export async function fetchSets(): Promise<SetRecord[]> {
  const results: SetRecord[] = [];
  let next: string | null = 'https://api.scryfall.com/sets';

  while (next) {
    const body: any = await getJson(next);
    if (!Array.isArray(body?.data)) {
      throw new ScryfallError('The set listing had no "data" array.');
    }

    for (const raw of body.data) {
      if (!raw?.code || !raw?.name) continue;
      results.push({
        code: String(raw.code).toLowerCase(),
        scryfallId: raw.id ?? null,
        name: raw.name,
        setType: raw.set_type ?? null,
        releasedAt: raw.released_at ?? null,
        cardCount: Number(raw.card_count ?? 0),
        parentSetCode: raw.parent_set_code ? String(raw.parent_set_code).toLowerCase() : null,
        blockCode: raw.block_code ?? null,
        blockName: raw.block ?? null,
        digital: Boolean(raw.digital),
        nonfoilOnly: Boolean(raw.nonfoil_only),
        foilOnly: Boolean(raw.foil_only),
        iconSvgUri: raw.icon_svg_uri ?? null,
        scryfallUri: raw.scryfall_uri ?? null,
      });
    }

    next = body.has_more === true && body.next_page ? body.next_page : null;
    // Stay well inside Scryfall's ~10 requests/second guidance.
    if (next) await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return results;
}

/**
 * Streams the gzipped JSONL bulk file, yielding one parsed card at a time.
 *
 * Node's `DecompressionStream('gzip')` replaces the hand-written inflater the
 * macOS build needed. The file expands to several hundred megabytes, so nothing
 * here ever holds more than a chunk plus one line.
 */
export async function* streamBulkCards(
  entry: BulkEntry,
  onBytes?: (compressedBytesRead: number) => void,
): AsyncGenerator<Record<string, unknown>> {
  const response = await fetch(entry.downloadUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new ScryfallError(
      `Downloading the bulk file failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  let compressedRead = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      compressedRead += chunk.byteLength;
      onBytes?.(compressedRead);
      controller.enqueue(chunk);
    },
  });

  // DecompressionStream is declared as accepting BufferSource while the byte
  // stream is typed as Uint8Array, which TypeScript treats as incompatible even
  // though it is exactly the intended pairing at runtime.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const decode = new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>;

  const lines = response.body
    .pipeThrough(counting)
    .pipeThrough(gunzip)
    .pipeThrough(decode);

  let buffer = '';
  for await (const chunk of lines as unknown as AsyncIterable<string>) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) yield JSON.parse(line);
    }
  }
  const tail = buffer.trim();
  if (tail.length > 0) yield JSON.parse(tail);
}
