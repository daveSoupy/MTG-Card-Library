/**
 * Plain-text decklists: parsing them and writing them back out.
 *
 * Every site exports a slightly different dialect, and this accepts all of the
 * common ones because a decklist arrives from wherever the user copied it. Pure
 * functions with no database access, so the parsing — which is where the edge
 * cases live — can be tested directly.
 */

export type ParsedBoard = 'main' | 'side' | 'command' | 'maybe';

export interface ParsedEntry {
  quantity: number;
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  board: ParsedBoard;
  /** 1-indexed, so an unresolved line can be pointed at. */
  lineNumber: number;
  raw: string;
}

export interface ParsedDecklist {
  entries: ParsedEntry[];
  /** Lines that are neither blank, a comment, nor a recognisable entry. */
  unparsed: Array<{ lineNumber: number; raw: string }>;
}

/** Section headers, as the various exporters write them. */
const SECTION_HEADERS: Array<[RegExp, ParsedBoard]> = [
  [/^(deck|main ?board|main ?deck|maindeck)\b/i, 'main'],
  [/^(side ?board)\b/i, 'side'],
  [/^(commander|command ?zone)\b/i, 'command'],
  [/^(maybe ?board|considering)\b/i, 'maybe'],
];

/**
 * `1 Lightning Bolt`, `1x Lightning Bolt`, `1 Lightning Bolt (M10) 146`.
 *
 * The set and number are optional and may be bracketed or parenthesised. The
 * name is captured lazily so a trailing set annotation is not swallowed into it.
 */
const ENTRY = new RegExp(
  '^\\s*(\\d+)\\s*[xX]?\\s+' +          // quantity, optional trailing x
  '(.+?)' +                             // name, lazily
  '(?:\\s+[([]([A-Za-z0-9_]{2,6})[)\\]]' + // optional (SET) or [SET]
  '(?:\\s+([A-Za-z0-9\\-★]+))?)?' +   // optional collector number
  '\\s*$',
);

/** Trailing annotations some exporters add: *CMDR*, *F*, #tags. */
const ANNOTATIONS = /\s*(\*[^*]+\*|#[^\s#]+)\s*/g;

function stripAnnotations(name: string): { name: string; board: ParsedBoard | null } {
  let board: ParsedBoard | null = null;
  const cleaned = name.replace(ANNOTATIONS, (match) => {
    // Archidekt and Moxfield mark the commander inline rather than in a section.
    if (/\*\s*(cmdr|commander)\s*\*/i.test(match)) board = 'command';
    return ' ';
  });
  return { name: cleaned.replace(/\s+/g, ' ').trim(), board };
}

export function parseDecklist(text: string): ParsedDecklist {
  const entries: ParsedEntry[] = [];
  const unparsed: Array<{ lineNumber: number; raw: string }> = [];

  let board: ParsedBoard = 'main';
  // MTGO separates the sideboard with a blank line rather than a header, so a
  // blank line after entries have started is a hint — but only the first one,
  // and only when no explicit header has been seen.
  let sawExplicitHeader = false;
  let sawBlankAfterEntries = false;

  const lines = text.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trim();

    if (line === '') {
      if (entries.length > 0 && !sawExplicitHeader && !sawBlankAfterEntries) {
        sawBlankAfterEntries = true;
        board = 'side';
      }
      return;
    }

    // A comment marker only counts at the start of a line: "Fire // Ice" is a
    // card name, not a comment.
    if (line.startsWith('//') || line.startsWith('#')) return;

    const header = SECTION_HEADERS.find(([pattern]) => pattern.test(line));
    // "Deck" alone is a header; "Deck of the Dead" is a card, so only treat it
    // as a header when nothing follows it but a count.
    if (header && /^[a-z ]+:?\s*(\(\d+\))?$/i.test(line)) {
      board = header[1];
      sawExplicitHeader = true;
      return;
    }

    const match = ENTRY.exec(line);
    if (!match) {
      unparsed.push({ lineNumber, raw });
      return;
    }

    const [, quantityText, rawName, setCode, collectorNumber] = match;
    const { name, board: inlineBoard } = stripAnnotations(rawName);
    if (!name) {
      unparsed.push({ lineNumber, raw });
      return;
    }

    entries.push({
      quantity: Math.max(1, Number.parseInt(quantityText, 10)),
      name,
      setCode: setCode ? setCode.toLowerCase() : null,
      collectorNumber: collectorNumber ?? null,
      board: inlineBoard ?? board,
      lineNumber,
      raw,
    });
  });

  return { entries, unparsed };
}

// -- writing ------------------------------------------------------------------

export type ExportFormat = 'simple' | 'withSet' | 'arena' | 'mtgo';

export interface ExportCard {
  quantity: number;
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  board: ParsedBoard;
}

const BOARD_HEADER: Record<ExportFormat, Partial<Record<ParsedBoard, string>>> = {
  simple: {},
  withSet: {},
  arena: { main: 'Deck', side: 'Sideboard', command: 'Commander' },
  mtgo: {},
};

/**
 * Writes a decklist.
 *
 * `simple` is TCGplayer's mass-entry dialect; `withSet` adds the printing;
 * `arena` uses Arena's section headers; `mtgo` separates the sideboard with a
 * blank line, which is what MTGO expects.
 */
export function formatDecklist(cards: ExportCard[], format: ExportFormat = 'simple'): string {
  const includeSet = format === 'withSet' || format === 'arena';
  const line = (card: ExportCard) => {
    const base = `${card.quantity} ${card.name}`;
    if (!includeSet || !card.setCode) return base;
    const set = `(${card.setCode.toUpperCase()})`;
    return card.collectorNumber ? `${base} ${set} ${card.collectorNumber}` : `${base} ${set}`;
  };

  // The maybeboard is a scratch pad and is never part of an exported list.
  const order: ParsedBoard[] = ['command', 'main', 'side'];
  const blocks: string[] = [];

  for (const board of order) {
    const inBoard = cards.filter((c) => c.board === board);
    if (inBoard.length === 0) continue;

    const header = BOARD_HEADER[format][board];
    const body = inBoard.map(line).join('\n');

    // A blank line is not decoration in these dialects — it is how MTGO marks
    // where the sideboard starts, and this parser honours that. So it is
    // emitted only where it means that. Separating a commander from the deck
    // with one, in a format that has no commander header, would re-import the
    // entire deck as a sideboard.
    const blankBefore = blocks.length > 0 && (header !== undefined || board === 'side');
    blocks.push((blankBefore ? '\n' : '') + (header ? `${header}\n${body}` : body));
  }

  return blocks.join('\n');
}

/**
 * TCGplayer's mass-entry URL.
 *
 * Their form accepts a newline-separated list in the `c` parameter. Long lists
 * can exceed what a browser will send in a URL, so the caller is told when to
 * fall back to copying the text instead.
 */
export function tcgplayerMassEntryUrl(cards: ExportCard[]): { url: string; tooLong: boolean } {
  const list = cards
    .filter((c) => c.board !== 'maybe')
    .map((c) => `${c.quantity} ${c.name}`)
    .join('||');
  const url = `https://www.tcgplayer.com/massentry?productline=Magic&c=${encodeURIComponent(list)}`;
  return { url, tooLong: url.length > 8000 };
}

/** Card Kingdom takes a pasted list rather than a URL, so link to the page. */
export const CARD_KINGDOM_DECKBUILDER = 'https://www.cardkingdom.com/builder';
