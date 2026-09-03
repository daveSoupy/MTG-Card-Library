/**
 * CSV collection imports.
 *
 * Deckbox, ManaBox, TCGplayer and Moxfield all export collections with
 * different headers, so rather than supporting a fixed list of tools this
 * recognises columns by what they are called and lets the user correct the
 * mapping before anything is written.
 */

export type ColumnRole =
  | 'name' | 'setCode' | 'setName' | 'collectorNumber' | 'quantity'
  | 'finish' | 'condition' | 'language' | 'price' | 'ignore';

/**
 * Header spellings seen in the wild, lowercased. Order matters: the first role
 * whose patterns match a header wins, so more specific ones come first.
 */
const HEADER_PATTERNS: Array<[ColumnRole, RegExp]> = [
  ['collectorNumber', /^(collector ?number|card ?number|number|cn)$/],
  ['setCode', /^(set ?code|edition ?code|set_?id|expansion ?code)$/],
  ['setName', /^(set|set ?name|edition|expansion)$/],
  ['quantity', /^(quantity|count|qty|amount|have)$/],
  ['finish', /^(foil|finish|printing|is ?foil|foiling)$/],
  ['condition', /^(condition|cond|card ?condition)$/],
  ['language', /^(language|lang)$/],
  ['price', /^(price|purchase ?price|paid|my ?price|purchase ?price ?each)$/],
  ['name', /^(name|card ?name|card|title|simple ?name)$/],
];

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/**
 * A CSV reader that handles quoting, because card names contain commas —
 * "Atraxa, Praetors' Voice" splits into two fields under a naive `split(',')`.
 */
export function parseCsv(text: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Strip a UTF-8 BOM, which spreadsheet exports frequently carry and which
  // would otherwise become part of the first header's name.
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }  // escaped quote
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; }
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows };
}

/** Best-guess role for each column, which the user can then correct. */
export function guessMapping(headers: string[]): ColumnRole[] {
  const taken = new Set<ColumnRole>();
  return headers.map((header) => {
    const normalized = header.trim().toLowerCase().replace(/[_-]+/g, ' ');
    for (const [role, pattern] of HEADER_PATTERNS) {
      // Each role is claimed once; a second "name"-ish column is left alone
      // rather than overwriting the first.
      if (taken.has(role) || !pattern.test(normalized)) continue;
      taken.add(role);
      return role;
    }
    return 'ignore';
  });
}

export interface MappedRow {
  name: string;
  setCode: string | null;
  setName: string | null;
  collectorNumber: string | null;
  quantity: number;
  finish: 'nonfoil' | 'foil' | 'etched';
  condition: string;
  language: string;
  price: number | null;
  lineNumber: number;
}

/** Values that mean "this is a foil", across the various exporters. */
const FOIL_WORDS = /^(foil|yes|true|1|y|premium)$/i;
const ETCHED_WORDS = /^(etched|etched ?foil)$/i;

const CONDITION_ALIASES: Record<string, string> = {
  m: 'M', mint: 'M',
  nm: 'NM', 'near mint': 'NM', 'near mint foil': 'NM', nearmint: 'NM',
  lp: 'LP', 'lightly played': 'LP', 'slightly played': 'LP', sp: 'LP', excellent: 'LP',
  mp: 'MP', 'moderately played': 'MP', 'played': 'MP', good: 'MP',
  hp: 'HP', 'heavily played': 'HP', poor: 'HP',
  dmg: 'DMG', damaged: 'DMG',
};

export function normalizeCondition(value: string): string {
  const key = value.trim().toLowerCase();
  return CONDITION_ALIASES[key] ?? (key === '' ? 'unknown' : 'unknown');
}

/**
 * Scryfall's language codes, against the spellings exporters use. Left
 * unnormalised, "English" and "en" would become two separate lots of the same
 * card, which is exactly the duplication the collection is meant to avoid.
 */
const LANGUAGES: Record<string, string> = {
  en: 'en', english: 'en',
  es: 'es', spanish: 'es', 'español': 'es',
  fr: 'fr', french: 'fr', 'français': 'fr',
  de: 'de', german: 'de', deutsch: 'de',
  it: 'it', italian: 'it', italiano: 'it',
  pt: 'pt', portuguese: 'pt', 'português': 'pt',
  ja: 'ja', japanese: 'ja', jp: 'ja',
  ko: 'ko', korean: 'ko',
  ru: 'ru', russian: 'ru',
  zhs: 'zhs', 'simplified chinese': 'zhs', chinese: 'zhs',
  zht: 'zht', 'traditional chinese': 'zht',
  he: 'he', hebrew: 'he', la: 'la', latin: 'la',
  grc: 'grc', ar: 'ar', arabic: 'ar', sa: 'sa', ph: 'ph',
};

export function normalizeLanguage(value: string): string {
  const key = value.trim().toLowerCase();
  if (key === '') return 'en';
  // An unrecognised language is kept as written rather than forced to English,
  // which would be a silent lie about what the card is.
  return LANGUAGES[key] ?? key;
}

export function normalizeFinish(value: string): 'nonfoil' | 'foil' | 'etched' {
  const key = value.trim();
  if (ETCHED_WORDS.test(key)) return 'etched';
  if (FOIL_WORDS.test(key)) return 'foil';
  return 'nonfoil';
}

export function applyMapping(table: CsvTable, mapping: ColumnRole[]): {
  rows: MappedRow[];
  skipped: Array<{ lineNumber: number; reason: string }>;
} {
  const indexOf = (role: ColumnRole) => mapping.indexOf(role);
  const nameIndex = indexOf('name');

  const rows: MappedRow[] = [];
  const skipped: Array<{ lineNumber: number; reason: string }> = [];

  table.rows.forEach((row, index) => {
    // +2: one for the header line, one because humans count from 1.
    const lineNumber = index + 2;
    const at = (role: ColumnRole) => {
      const column = indexOf(role);
      return column === -1 ? '' : (row[column] ?? '').trim();
    };

    const name = nameIndex === -1 ? '' : (row[nameIndex] ?? '').trim();
    if (!name) {
      skipped.push({ lineNumber, reason: 'No card name in this row.' });
      return;
    }

    const quantityText = at('quantity');
    const quantity = quantityText === '' ? 1 : Number.parseInt(quantityText, 10);
    if (!Number.isFinite(quantity) || quantity < 1) {
      skipped.push({ lineNumber, reason: `Quantity "${quantityText}" is not a positive number.` });
      return;
    }

    const priceText = at('price').replace(/[^0-9.]/g, '');
    const price = priceText === '' ? null : Number.parseFloat(priceText);

    rows.push({
      name,
      setCode: at('setCode') ? at('setCode').toLowerCase() : null,
      setName: at('setName') || null,
      collectorNumber: at('collectorNumber') || null,
      quantity,
      finish: normalizeFinish(at('finish')),
      condition: normalizeCondition(at('condition')),
      language: normalizeLanguage(at('language')),
      price: price !== null && Number.isFinite(price) ? price : null,
      lineNumber,
    });
  });

  return { rows, skipped };
}
