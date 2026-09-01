/** Where a card sits in a deck. Mirrors `deck_cards.board` in schema.sql. */
export type Board = 'main' | 'side' | 'command' | 'maybe';

export const BOARDS: Board[] = ['main', 'side', 'command', 'maybe'];

export type CommanderRole = 'commander' | 'partner' | 'background' | 'companion';

/** The rules for one format, read from the seeded `formats` table. */
export interface FormatRules {
  code: string;
  displayName: string;
  minDeckSize: number | null;
  exactDeckSize: number | null;
  maxCopies: number;
  basicsExempt: boolean;
  isSingleton: boolean;
  sideboardSize: number | null;
  requiresCommander: boolean;
  enforcesColorIdentity: boolean;
}

/** One card slot in a deck, joined with everything validation and stats need. */
export interface DeckCard {
  id: number;
  oracleId: string;
  name: string;
  board: Board;
  quantity: number;
  quantityFromCollection: number;
  commanderRole: CommanderRole | null;
  category: string | null;
  sortOrder: number;

  cmc: number;
  typeLine: string;
  manaCost: string | null;
  colorIdentity: string;
  colorIdentityMask: number;
  colorsMask: number;
  isBasicLand: boolean;
  isLegendary: boolean;
  canBeCommander: boolean;

  /** Legality in *this deck's* format; null when the deck has no format set. */
  legality: string | null;

  ownedQuantity: number;
  /** Copies free across the whole collection, before this deck's own claim. */
  availableQuantity: number;

  printingId: string | null;
  setCode: string | null;
  rarity: string | null;
  imageSmall: string | null;
  priceUsd: number | null;
}

export interface Deck {
  id: number;
  name: string;
  formatCode: string | null;
  homeLocationId: number | null;
  description: string | null;
  notes: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeckWithCards extends Deck {
  cards: DeckCard[];
}

export type IssueSeverity = 'error' | 'warning';

export interface DeckIssue {
  severity: IssueSeverity;
  code:
    | 'deck_size_exact'
    | 'deck_size_min'
    | 'sideboard_size'
    | 'copy_limit'
    | 'singleton'
    | 'banned'
    | 'restricted'
    | 'not_legal'
    | 'missing_commander'
    | 'too_many_commanders'
    | 'over_allocated'
    | 'no_format';
  message: string;
  oracleId?: string;
  cardName?: string;
}

export interface DeckValidation {
  formatCode: string | null;
  formatName: string | null;
  /** Counts the boards the format's size rule actually measures. */
  countedTotal: number;
  mainCount: number;
  sideboardCount: number;
  commandCount: number;
  maybeCount: number;
  requiredExactSize: number | null;
  requiredMinSize: number | null;
  sideboardLimit: number | null;
  issues: DeckIssue[];
  /** No errors. Warnings (like over-allocation) do not make a deck illegal. */
  isLegal: boolean;
}

export interface ManaCurveBucket {
  /** 0..6, then 7 meaning "7 or more". */
  cmc: number;
  label: string;
  count: number;
}

export interface DeckStats {
  totalCards: number;
  mainCount: number;
  sideboardCount: number;
  commandCount: number;
  uniqueCards: number;
  /** Lands are excluded, the way players quote an average mana value. */
  averageManaValue: number | null;
  manaCurve: ManaCurveBucket[];
  colorDistribution: Array<{ color: string; count: number }>;
  colorIdentity: string;
  typeDistribution: Array<{ type: string; count: number }>;
  estimatedValueUsd: number | null;
  ownedCount: number;
  needToBuyCount: number;
}
